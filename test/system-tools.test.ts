import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../src/config/config.ts';
import { MacSystemControl } from '../src/desktop/mac-system-control.ts';
import { ApprovalMemory } from '../src/tools/action-tools.ts';
import type { ActionProposal, ActionToolPorts } from '../src/tools/action-tools.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { describeSystemAction, registerSystemTool } from '../src/tools/system-tool.ts';
import type { SystemAction } from '../src/tools/system-tool.ts';
import { registerVscodeTool } from '../src/tools/vscode-tool.ts';
import { approvalQuestion } from '../src/shared/voice-intents.ts';

const signal = new AbortController().signal;

async function folder(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'vyomara-sys-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('mac_control shows each action for approval, lists running apps without asking, and validates input', async () => {
  const asked: ActionProposal[] = [];
  const performed: SystemAction[] = [];
  const registry = new ToolRegistry();
  registerSystemTool(
    registry,
    { async perform(action) { performed.push(action); return { detail: 'ok', apps: ['Finder', 'Code'] }; } },
    { async request(action) { asked.push(action); return action.kind === 'system' && action.action !== 'sleep'; } },
  );
  const tool = registry.get('mac_control');
  assert.ok(tool);
  const apps = await tool.run({ action: 'running_apps' }, signal) as Record<string, unknown>;
  assert.deepEqual(apps.apps, ['Finder', 'Code']);
  assert.equal(asked.length, 0, 'listing apps changes nothing, so it asks nothing');
  const volume = await tool.run({ action: 'volume', level: 40 }, signal) as Record<string, unknown>;
  assert.equal(volume.status, 'done');
  assert.deepEqual(asked.at(-1), { kind: 'system', action: 'volume', detail: 'Set the output volume to 40%' });
  const sleep = await tool.run({ action: 'sleep' }, signal) as Record<string, unknown>;
  assert.equal(sleep.status, 'rejected');
  assert.deepEqual(performed, [{ kind: 'running_apps' }, { kind: 'volume', level: 40 }]);
  assert.equal(tool.inputError?.({ action: 'press_key', key: 'cmd+shift+p' }), undefined);
  assert.match(tool.inputError?.({ action: 'press_key', key: 'cmd+q+x' }) ?? '', /press_key needs key/u);
  assert.match(tool.inputError?.({ action: 'volume', level: 150 }) ?? '', /0–100/u);
  assert.match(tool.inputError?.({ action: 'wifi', state: 'maybe' }) ?? '', /on or off/u);
  assert.equal(describeSystemAction({ kind: 'type_text', text: 'hello' }), 'Type into the front app: "hello"');
  assert.equal(approvalQuestion({ kind: 'system', action: 'volume', detail: 'Set the output volume to 40%' }), 'Mac par ye karun: Set the output volume to 40%?');
});

test('MacSystemControl drives the system programs with arguments, never spliced scripts', async () => {
  const calls: { file: string; args: readonly string[]; stdin?: string }[] = [];
  const control = new MacSystemControl(async (file, args, _signal, stdin) => {
    calls.push({ file, args, ...(stdin === undefined ? {} : { stdin }) });
    if (args.includes('-listallhardwareports')) return 'Hardware Port: Ethernet\nDevice: en5\n\nHardware Port: Wi-Fi\nDevice: en0\n';
    if (args.some(item => item.includes('appearance preferences'))) return 'true\n';
    if (args.some(item => item.includes('application process'))) return 'Finder, Code, Google Chrome\n';
    return '';
  });
  await control.perform({ kind: 'press_key', key: 'cmd+shift+s' }, signal);
  assert.equal(calls.at(-1)?.file, '/usr/bin/osascript');
  assert.ok(calls.at(-1)?.args.includes('tell application "System Events" to keystroke (item 1 of argv) using {command down, shift down}'));
  assert.equal(calls.at(-1)?.args.at(-1), 's');
  await control.perform({ kind: 'press_key', key: 'enter' }, signal);
  assert.ok(calls.at(-1)?.args.includes('tell application "System Events" to key code 36'));
  await assert.rejects(control.perform({ kind: 'press_key', key: 'cmd+q+x' }, signal), /not a key combination/u);
  const wifi = await control.perform({ kind: 'wifi', state: 'off' }, signal);
  assert.deepEqual(calls.at(-1), { file: '/usr/sbin/networksetup', args: ['-setairportpower', 'en0', 'off'] });
  assert.equal(wifi.detail, 'Wi-Fi turned off.');
  assert.equal((await control.perform({ kind: 'dark_mode', state: 'toggle' }, signal)).detail, 'Dark mode is now on.');
  assert.deepEqual((await control.perform({ kind: 'running_apps' }, signal)).apps, ['Finder', 'Code', 'Google Chrome']);
  await control.perform({ kind: 'clipboard_set', text: 'copied text' }, signal);
  assert.deepEqual(calls.at(-1), { file: '/usr/bin/pbcopy', args: [], stdin: 'copied text' });
  await control.perform({ kind: 'notify', title: 'Build', text: 'Tests passed' }, signal);
  assert.deepEqual(calls.at(-1)?.args.slice(-2), ['Tests passed', 'Build']);
  await control.perform({ kind: 'open_settings', pane: 'wifi' }, signal);
  assert.deepEqual(calls.at(-1), { file: '/usr/bin/open', args: ['x-apple.systempreferences:com.apple.wifi-settings-extension'] });
});

test('vscode opens files at a line and compares files after approval, installs extensions as a shown command', async t => {
  const root = await folder(t);
  const cli = join(root, 'code');
  const log = join(root, 'code.log');
  await writeFile(cli, `#!/bin/sh\nif [ "$1" = --list-extensions ]; then echo dbaeumer.vscode-eslint@3.0.10; echo esbenp.prettier-vscode@11.0.0; else echo "$*" >> ${JSON.stringify(log)}; fi\n`, { mode: 0o755 });
  const file = join(root, 'cart.ts');
  const other = join(root, 'cart.old.ts');
  await writeFile(file, 'a\nb\nc\n');
  await writeFile(other, 'a\n');
  const config = loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_ALLOWED_ROOTS: JSON.stringify([root]), VYOM_DATA_DIR: join(root, '.data') });
  const asked: ActionProposal[] = [];
  const answers: Array<boolean | 'always'> = ['always', true, false];
  const registry = new ToolRegistry();
  registerVscodeTool(registry, config, {
    approval: { async request(action: ActionProposal) { asked.push(action); return answers.shift() ?? false; } },
    approvalMemory: new ApprovalMemory(),
  } as unknown as ActionToolPorts, { cli });
  const tool = registry.get('vscode');
  assert.ok(tool);
  const extensions = await tool.run({ action: 'list_extensions' }, signal) as Record<string, unknown>;
  assert.deepEqual(extensions.extensions, ['dbaeumer.vscode-eslint@3.0.10', 'esbenp.prettier-vscode@11.0.0']);
  assert.equal(asked.length, 0);
  const opened = await tool.run({ action: 'open', path: file, line: 3 }, signal) as Record<string, unknown>;
  assert.equal(opened.status, 'done');
  assert.deepEqual(asked[0], { kind: 'application', application: 'Visual Studio Code', target: file, line: 3 });
  // "Always allow" for VS Code covers the next open; the diff shows both files.
  const diff = await tool.run({ action: 'diff', path: file, other }, signal) as Record<string, unknown>;
  assert.equal(diff.approval, 'remembered');
  assert.equal(asked.length, 1);
  const install = await tool.run({ action: 'install_extension', extension: 'dbaeumer.vscode-eslint' }, signal) as Record<string, unknown>;
  assert.equal(install.status, 'done');
  assert.equal(asked[1]?.kind === 'command' && asked[1].command, 'code --install-extension dbaeumer.vscode-eslint');
  const rejected = await tool.run({ action: 'install_extension', extension: 'x.y' }, signal) as Record<string, unknown>;
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
    `-r -g ${file}:3`,
    `-r --diff ${file} ${other}`,
    '--install-extension dbaeumer.vscode-eslint',
  ]);
  await assert.rejects(tool.run({ action: 'open', path: '/etc/hosts' }, signal), /outside|allowed|not/u);
  assert.match(tool.inputError?.({ action: 'install_extension', extension: 'eslint' }) ?? '', /publisher|id/u);
});
