import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AppConfig } from '../config/config.ts';
import { VSCODE_CLI } from '../desktop/vscode-diff.ts';
import { ToolFailure, type Tool, type ToolRegistry } from './contracts.ts';
import type { ActionToolPorts } from './action-tools.ts';
import { resolveSafeFilesystemPath } from './filesystem-tools.ts';

const APPLICATION = 'Visual Studio Code';
const ACTIONS = ['open', 'diff', 'add_folder', 'install_extension', 'list_extensions'];
const KEYS = ['action', 'path', 'line', 'other', 'extension'];
const EXTENSION_ID = /^[\w-]+\.[\w-]+$/u;

interface VscodeInput {
  readonly action: string;
  readonly path?: string;
  readonly line?: number;
  readonly other?: string;
  readonly extension?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  if (Object.keys(value).some(key => !KEYS.includes(key))) return `Use only ${KEYS.join(', ')}.`;
  const action = value.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action)) return `action must be one of: ${ACTIONS.join(', ')}.`;
  if (['open', 'diff', 'add_folder'].includes(action) && (typeof value.path !== 'string' || !value.path.startsWith('/'))) return `${action} needs path (absolute).`;
  if (action === 'diff' && (typeof value.other !== 'string' || !value.other.startsWith('/'))) return 'diff needs other: the absolute path of the second file.';
  if (action === 'install_extension' && (typeof value.extension !== 'string' || !EXTENSION_ID.test(value.extension))) return 'install_extension needs extension: its id, e.g. "dbaeumer.vscode-eslint".';
  if (value.line !== undefined && (!Number.isInteger(value.line) || (value.line as number) < 1)) return 'line must be a positive integer.';
  return undefined;
}

function dropNulls(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

/** `code` from the app bundle, or on PATH. */
export function vscodeCli(): string | undefined {
  if (existsSync(VSCODE_CLI)) return VSCODE_CLI;
  const onPath = (process.env.PATH ?? '').split(':').map(dir => `${dir}/code`).find(candidate => candidate.length > 5 && existsSync(candidate));
  return onPath;
}

function code(cli: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cli, [...args], { timeout: 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } }, (error, stdout, stderr) => {
      if (error) reject(new ToolFailure(`VS Code could not do that: ${String(stderr || error.message).trim().slice(0, 300)}`, 'tool-failed'));
      else resolve(stdout);
    });
    signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
}

/**
 * vscode: open a file (at a line), compare two files, add a folder to the
 * window, install or list extensions. Opening shows the usual "Open Visual
 * Studio Code" card (one "Always allow" covers it); installing an extension
 * shows the exact command.
 */
export function registerVscodeTool(registry: ToolRegistry, config: AppConfig, ports: ActionToolPorts, options: { readonly cli?: string } = {}): void {
  const { approval, approvalMemory } = ports;
  const tool: Tool<VscodeInput, Record<string, unknown>> = {
    id: 'vscode',
    effect: 'launch',
    description: 'Visual Studio Code (after approval): open (path, line? — opens the file or folder in the current window, at that line), diff (path, other — compare two files side by side), add_folder (path — add a folder to the workspace), install_extension (extension id such as "dbaeumer.vscode-eslint"), list_extensions (no approval). Use this for "VS Code mein kholo", "ye file line 40 pe dikhao", "in dono files ka diff dikhao".',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'open, diff, add_folder, install_extension, or list_extensions.', maxLength: 17 },
        path: { type: 'string', description: 'Absolute path of the file or folder.', maxLength: 4_096 },
        line: { type: 'integer', description: 'open: line to jump to.', minimum: 1 },
        other: { type: 'string', description: 'diff: absolute path of the second file.', maxLength: 4_096 },
        extension: { type: 'string', description: 'install_extension: the extension id (publisher.name).', maxLength: 120 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    normalizeInput: dropNulls,
    validateInput: (value): value is VscodeInput => inputError(value) === undefined,
    inputError,
    validateOutput: (value): value is Record<string, unknown> => isRecord(value) && typeof value.status === 'string',
    async run(input, signal) {
      const cli = options.cli ?? vscodeCli();
      if (!cli) throw new ToolFailure('Visual Studio Code is not installed (or its "code" command is missing).', 'not-found');
      if (input.action === 'list_extensions') {
        const output = await code(cli, ['--list-extensions', '--show-versions'], signal);
        const extensions = output.split('\n').map(line => line.trim()).filter(Boolean).slice(0, 300);
        return { status: 'done', action: input.action, extensions };
      }
      if (input.action === 'install_extension') {
        const extension = input.extension ?? '';
        const command = `code --install-extension ${extension}`;
        const decision = await approval.request({ kind: 'command', command, cwd: homedir(), timeoutSeconds: 60 }, signal);
        if (!decision) return { status: 'rejected', action: input.action, extension };
        const output = await code(cli, ['--install-extension', extension], signal);
        return { status: 'done', action: input.action, extension, output: output.trim().slice(-2_000) };
      }
      // A file or a folder: whichever the path is.
      const target = await resolveSafeFilesystemPath(input.path ?? '', config, 'file', signal)
        .then(resolved => resolved.target)
        .catch(async () => (await resolveSafeFilesystemPath(input.path ?? '', config, 'directory', signal)).target);
      const other = input.action === 'diff' ? (await resolveSafeFilesystemPath(input.other ?? '', config, 'file', signal)).target : undefined;
      const remembered = approvalMemory?.hasGrant({ kind: 'app', application: APPLICATION }) === true;
      const decision = remembered || await approval.request({
        kind: 'application',
        application: APPLICATION,
        target: other ? `${target} ↔ ${other}` : target,
        ...(input.line === undefined ? {} : { line: input.line }),
      }, signal);
      if (!decision) return { status: 'rejected', action: input.action, path: target };
      if (decision === 'always') approvalMemory?.grant({ kind: 'app', application: APPLICATION });
      const args = input.action === 'diff'
        ? ['-r', '--diff', target, other ?? '']
        : input.action === 'add_folder'
          ? ['-r', '--add', target]
          : input.line === undefined ? ['-r', target] : ['-r', '-g', `${target}:${input.line}`];
      await code(cli, args, signal);
      return { status: 'done', action: input.action, path: target, ...(other ? { other } : {}), ...(input.line === undefined ? {} : { line: input.line }), approval: remembered ? 'remembered' : 'user' };
    },
  };
  registry.register(tool);
}
