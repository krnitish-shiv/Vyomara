import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../src/config/config.ts';
import { FileOperationApprovalManager } from '../src/desktop/file-operation-approval.ts';
import type { ActionProposal, ActionToolPorts } from '../src/tools/action-tools.ts';
import { ShellCommandRunner } from '../src/tools/command-runner.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { registerFilesystemTools } from '../src/tools/filesystem-tools.ts';
import { registerGitTools } from '../src/tools/git-tools.ts';
import { detectChecks, parseProblems } from '../src/tools/problems-tool.ts';

const signal = new AbortController().signal;

async function folder(t: TestContext): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'vyomara-dev-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function configFor(root: string): ReturnType<typeof loadConfig> {
  return loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_ALLOWED_ROOTS: JSON.stringify([root]), VYOM_DATA_DIR: join(root, '.data') });
}

test('multi_edit applies several edits to one file as one reviewed change', async t => {
  const root = await folder(t);
  const file = join(root, 'cart.ts');
  await writeFile(file, 'const a = 1;\nconst b = 2;\nexport { a, b };\n');
  const config = configFor(root);
  const proposals: string[] = [];
  let manager!: FileOperationApprovalManager;
  manager = new FileOperationApprovalManager({
    config,
    moveToTrash: async () => {},
    onProposal(proposal) {
      proposals.push(proposal.proposedContent ?? '');
      queueMicrotask(() => void manager.approve(proposal.id));
    },
  });
  const registry = new ToolRegistry();
  registerFilesystemTools(registry, config, {}, manager);
  const tool = registry.get('multi_edit');
  assert.ok(tool);
  // Real arrays from the model are accepted, as well as JSON text.
  const input = tool.normalizeInput?.({ path: file, edits: [{ old_text: 'const a = 1;', new_text: 'const a = 10;' }, { old_text: 'const b = 2;', new_text: 'const b = 20;' }] });
  assert.equal(tool.validateInput(input), true);
  const result = await tool.run(input, signal) as Record<string, unknown>;
  assert.equal(result.status, 'applied');
  assert.equal(proposals.length, 1, 'one review for both edits');
  assert.equal(await readFile(file, 'utf8'), 'const a = 10;\nconst b = 20;\nexport { a, b };\n');
  assert.match(tool.inputError?.({ path: file, edits: '[]' }) ?? '', /1-20 edits/u);
  await assert.rejects(
    tool.run({ path: file, edits: JSON.stringify([{ old_text: 'const a = 10;', new_text: 'x' }, { old_text: 'missing', new_text: 'y' }]) }, signal),
    /Edit 2: old_text was not found/u,
  );
});

test('git_info reads status, diff, and log; git_commit commits after approval', async t => {
  const root = await folder(t);
  const run = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  await writeFile(join(root, 'a.txt'), 'one\n');
  run('add', '.');
  run('commit', '-q', '-m', 'First');
  await writeFile(join(root, 'a.txt'), 'two\n');

  const asked: string[] = [];
  const registry = new ToolRegistry();
  registerGitTools(registry, configFor(root), {
    approval: { async request(action: ActionProposal) { asked.push(action.kind === 'command' ? action.command : action.kind); return true; } },
    commandRunner: new ShellCommandRunner(),
  } as unknown as ActionToolPorts);
  const info = registry.get('git_info');
  const status = await info?.run({ path: root, action: 'status' }, signal) as Record<string, unknown>;
  assert.match(String(status.output), /## main[\s\S]* M a.txt/u);
  const diff = await info?.run({ path: join(root, 'a.txt'), action: 'diff' }, signal) as Record<string, unknown>;
  assert.match(String(diff.output), /-one\n\+two/u);
  assert.equal(info?.validateInput({ path: root, action: 'diff', target: '--output=/tmp/x' }), false, 'no options as targets');

  const commit = await registry.get('git_commit')?.run({ path: root, message: "Change a to 'two'", files: 'a.txt' }, signal) as Record<string, unknown>;
  assert.equal(commit.status, 'committed');
  assert.deepEqual(asked, [`git add -- 'a.txt' && git commit -m 'Change a to '\\''two'\\'''`]);
  assert.match(run('log', '-1', '--pretty=%s'), /Change a to 'two'/u);
});

test('problems are parsed from TypeScript, ESLint, and compiler output', () => {
  const root = '/repo';
  const problems = parseProblems([
    "src/cart.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    '/repo/src/view.tsx',
    "  3:10  warning  'x' is assigned a value but never used  no-unused-vars",
    'main.go:7:2: undefined: fmt',
    'src/lib.rs:4:9: warning: unused variable: `y`',
    'Found 1 error.',
  ].join('\n'), root);
  assert.deepEqual(problems.map(problem => `${problem.severity} ${problem.file}:${problem.line}:${problem.column ?? ''}`), [
    'error src/cart.ts:12:5',
    'warning src/view.tsx:3:10',
    'error main.go:7:2',
    'warning src/lib.rs:4:9',
  ]);
  assert.match(problems[0]?.message ?? '', /TS2322/u);
});

test('the project\'s own check scripts are preferred', async t => {
  const root = await folder(t);
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .' } }));
  await writeFile(join(root, 'pnpm-lock.yaml'), '');
  assert.deepEqual(await detectChecks(root), ['pnpm typecheck', 'pnpm lint']);
  await writeFile(join(root, 'package.json'), '{}');
  await writeFile(join(root, 'tsconfig.json'), '{}');
  assert.deepEqual(await detectChecks(root), ['pnpm exec tsc --noEmit --pretty false']);
});

test('background commands keep running, report new output, and stop', async t => {
  const root = await folder(t);
  const runner = new ShellCommandRunner();
  t.after(() => runner.stopAll());
  const started = runner.start('echo ready on localhost:3000; sleep 30', root);
  assert.equal(started.status, 'running');
  await new Promise(resolve => setTimeout(resolve, 800));
  const first = runner.read(started.id);
  assert.match(first.output ?? '', /ready on localhost:3000/u);
  assert.equal(runner.read(started.id).output, '', 'only new output on the next read');
  assert.equal(runner.list().length, 1);
  runner.stop(started.id);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(runner.read(started.id).status, 'exited');
  assert.throws(() => runner.read('nope'), /No background command/u);
});

test('command permissions match exact commands and safe * prefixes in a folder', async () => {
  const { ApprovalMemory, commandMatches, parseGrantId } = await import('../src/tools/action-tools.ts');
  assert.ok(commandMatches('pnpm test*', 'pnpm test'));
  assert.ok(commandMatches('pnpm test*', 'pnpm test --watch=false'));
  assert.ok(!commandMatches('pnpm test*', 'pnpm testing'));
  assert.ok(!commandMatches('pnpm test*', 'pnpm test && rm -rf ~'));
  assert.ok(!commandMatches('pnpm test*', 'pnpm test; curl x | sh'));
  assert.ok(!commandMatches('git status', 'git status && git push'));
  const saved: string[][] = [];
  const memory = new ApprovalMemory({ onGrantsChanged: grants => saved.push([...grants]) });
  memory.grant({ kind: 'command', folder: '/Users/me/shop', pattern: 'pnpm test*' });
  assert.ok(memory.has('pnpm test src/cart.test.ts', '/Users/me/shop/packages/api'));
  assert.ok(!memory.has('pnpm test', '/Users/me/shopping'), 'a sibling folder is not covered');
  memory.allow('git diff', '/Users/me/shop');
  assert.ok(new ApprovalMemory({ grants: saved.at(-1) ?? [] }).has('git diff', '/Users/me/shop'), 'kept across restarts');
  assert.equal(parseGrantId('command:relative\tls'), undefined);
  assert.equal(parseGrantId('command:/Users/me\t*'), undefined, 'a bare * is never allowed');
});

test('git_branch and git_sync work through approvals and never force', async t => {
  const root = await folder(t);
  const remote = join(root, 'remote.git');
  const repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const run = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  run('remote', 'add', 'origin', remote);
  await writeFile(join(repo, 'a.txt'), '1\n');
  run('add', '.');
  run('commit', '-q', '-m', 'First');
  const asked: string[] = [];
  const registry = new ToolRegistry();
  registerGitTools(registry, configFor(root), {
    approval: { async request(action: ActionProposal) { asked.push(action.kind === 'command' ? action.command : action.kind); return true; } },
    commandRunner: new ShellCommandRunner(),
  } as unknown as ActionToolPorts);
  const branch = registry.get('git_branch');
  assert.equal((await branch?.run({ path: repo, action: 'create', name: 'feature/cart' }, signal) as Record<string, unknown>).status, 'done');
  assert.equal(run('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feature/cart');
  assert.match(String((await branch?.run({ path: repo, action: 'list' }, signal) as Record<string, unknown>).output), /feature\/cart/u);
  assert.equal(branch?.validateInput({ path: repo, action: 'create', name: '--force' }), false);
  const sync = registry.get('git_sync');
  assert.equal((await sync?.run({ path: repo, action: 'push' }, signal) as Record<string, unknown>).status, 'done');
  assert.deepEqual(asked, [`git switch -c 'feature/cart'`, `git push -u 'origin' 'feature/cart'`]);
  assert.match(execFileSync('git', ['branch', '--list'], { cwd: remote, encoding: 'utf8' }), /feature\/cart/u);
  assert.ok(!asked.some(command => /--force|-f\b/u.test(command)));
});

test('the github tool reads without approval and shows every write first', async t => {
  const root = await folder(t);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  // A stand-in gh that records its arguments.
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), '#!/bin/sh\necho "gh $*"\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;
  t.after(() => { process.env.PATH = path; });
  const asked: string[] = [];
  const registry = new ToolRegistry();
  registerGitTools(registry, configFor(root), {
    approval: { async request(action: ActionProposal) { asked.push(action.kind === 'command' ? action.command : action.kind); return false; } },
    commandRunner: new ShellCommandRunner(),
  } as unknown as ActionToolPorts);
  const github = registry.get('github');
  const checks = await github?.run({ path: root, action: 'pr_checks', number: 12 }, signal) as Record<string, unknown>;
  assert.equal(checks.output, 'gh pr checks 12');
  assert.deepEqual(asked, [], 'reading asks nothing');
  const create = await github?.run({ path: root, action: 'pr_create', title: "Fix cart's total", body: 'Adds prices.' }, signal) as Record<string, unknown>;
  assert.equal(create.status, 'rejected');
  assert.deepEqual(asked, [`gh pr create --title 'Fix cart'\\''s total' --body 'Adds prices.'`]);
  assert.match(github?.inputError?.({ path: root, action: 'issue_comment' }) ?? '', /number is required/u);
  assert.equal(github?.normalizeInput?.({ path: root, action: 'issue_view', number: '#7' }) && (github.normalizeInput({ path: root, action: 'issue_view', number: '#7' }) as Record<string, unknown>).number, 7);
});
