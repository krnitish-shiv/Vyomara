import { execFile } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import type { AppConfig } from '../config/config.ts';
import type { ActionToolPorts } from './action-tools.ts';
import { ToolFailure, type Tool, type ToolRegistry } from './contracts.ts';
import { resolveSafeFilesystemPath } from './filesystem-tools.ts';

/**
 * Git without a shell: `git_info` runs read-only git commands (status, diff,
 * log, show, branches) with fixed arguments and needs no approval;
 * `git_commit` stages and commits after the user approves the exact command.
 * Nothing here pushes, resets, or rewrites history.
 */

type Action = 'status' | 'diff' | 'log' | 'show' | 'branches';
const ACTIONS = new Set<Action>(['status', 'diff', 'log', 'show', 'branches']);

interface InfoInput {
  readonly path: string;
  readonly action: Action;
  readonly target?: string;
  readonly staged?: boolean;
  readonly count?: number;
}

interface CommitInput {
  readonly path: string;
  readonly message: string;
  readonly files?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clean(value: unknown): unknown {
  return isRecord(value) ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== '')) : value;
}

/** Refs and paths only: no options smuggled in as "--output=…" and no shell characters. */
const SAFE_TARGET = /^(?!-)[\w./@~^:+-]{1,300}$/u;

function infoError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  const extra = Object.keys(value).find(key => !['path', 'action', 'target', 'staged', 'count'].includes(key));
  if (extra) return `Unknown argument "${extra}".`;
  if (typeof value.path !== 'string' || !isAbsolute(value.path)) return 'path must be the absolute path of a folder inside the repository.';
  if (typeof value.action !== 'string' || !ACTIONS.has(value.action as Action)) return 'action must be status, diff, log, show, or branches.';
  if (value.target !== undefined && (typeof value.target !== 'string' || !SAFE_TARGET.test(value.target))) return 'target must be a file path relative to the repository, a branch, or a commit (no spaces or options).';
  if (value.staged !== undefined && typeof value.staged !== 'boolean') return 'staged must be true or false.';
  if (value.count !== undefined && (!Number.isInteger(value.count) || (value.count as number) < 1 || (value.count as number) > 50)) return 'count must be 1-50.';
  return undefined;
}

function commitError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  const extra = Object.keys(value).find(key => !['path', 'message', 'files'].includes(key));
  if (extra) return `Unknown argument "${extra}".`;
  if (typeof value.path !== 'string' || !isAbsolute(value.path)) return 'path must be the absolute path of the repository.';
  if (typeof value.message !== 'string' || value.message.trim() === '' || value.message.length > 2_000) return 'message must be a commit message (1-2000 characters).';
  if (value.files !== undefined) {
    if (typeof value.files !== 'string') return 'files must be a list of paths, one per line.';
    const files = splitFiles(value.files);
    if (files.length === 0 || files.length > 200 || files.some(file => !SAFE_TARGET.test(file))) return 'files must be paths relative to the repository, one per line, without spaces or options.';
  }
  return undefined;
}

function splitFiles(files: string): string[] {
  return files.split(/[\n,]+/u).map(file => file.trim()).filter(file => file !== '');
}

function git(args: readonly string[], cwd: string, signal: AbortSignal): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    execFile('git', ['-c', 'core.pager=cat', '-c', 'color.ui=false', ...args], {
      cwd,
      signal,
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}` });
    });
  });
}

/** Single-quote for zsh, so the approved command is exactly what runs. */
function quote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export function registerGitTools(registry: ToolRegistry, config: AppConfig, ports?: ActionToolPorts): void {
  const window = Math.max(2_000, config.maxToolOutputChars - 2_000);

  async function repositoryRoot(path: string, signal: AbortSignal): Promise<string> {
    // A file inside the repository works too: git runs in its folder.
    const cwd = await resolveSafeFilesystemPath(path, config, 'directory', signal)
      .then(resolved => resolved.target)
      .catch(async () => dirname((await resolveSafeFilesystemPath(path, config, 'file', signal)).target));
    const root = await git(['rev-parse', '--show-toplevel'], cwd, signal);
    if (root.code !== 0) throw new ToolFailure(`${path} is not inside a git repository.`, 'not-found');
    return root.output.trim();
  }

  const info: Tool<InfoInput, Record<string, unknown>> = {
    id: 'git_info',
    effect: 'read',
    description: 'Read-only git for a repository (no approval): status (branch, ahead/behind, changed files), diff (unstaged changes, or staged with staged=true; target limits it to one file or compares with a branch/commit), log (recent commits; target = file or branch), show (one commit: target = hash), branches. Use it instead of run_command for git questions and before committing.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the repository or any folder/file inside it.', maxLength: 4_096 },
        action: { type: 'string', description: '"status", "diff", "log", "show", or "branches".', maxLength: 10 },
        target: { type: 'string', description: 'Optional: file path (relative to the repository), branch, or commit.', maxLength: 300 },
        staged: { type: 'boolean', description: 'diff only: show staged changes instead of unstaged.' },
        count: { type: 'integer', description: 'log only: number of commits (default 15).', minimum: 1, maximum: 50 },
      },
      required: ['path', 'action'],
      additionalProperties: false,
    },
    normalizeInput: clean,
    validateInput: (value): value is InfoInput => infoError(value) === undefined,
    inputError: infoError,
    validateOutput: (value): value is Record<string, unknown> => isRecord(value),
    async run(input, signal) {
      const root = await repositoryRoot(input.path, signal);
      const target = input.target;
      const args: Record<Action, string[]> = {
        status: ['status', '--short', '--branch', '--untracked-files=normal'],
        diff: ['diff', '--stat', '--patch', ...(input.staged ? ['--cached'] : []), ...(target ? (target.includes('/') || target.includes('.') ? ['--', target] : [target]) : [])],
        log: ['log', `-n${input.count ?? 15}`, '--date=short', '--pretty=format:%h %ad %an: %s', ...(target ? [target] : [])],
        show: ['show', '--stat', '--patch', '--date=short', target ?? 'HEAD'],
        branches: ['branch', '--all', '--verbose', '--no-abbrev'],
      };
      const result = await git(args[input.action], root, signal);
      if (result.code !== 0) throw new ToolFailure(result.output.trim().slice(0, 500) || `git ${input.action} failed.`, 'tool-failed');
      const output = result.output.trimEnd();
      return {
        repository: root,
        action: input.action,
        output: output === '' ? (input.action === 'diff' ? '(no changes)' : '(nothing)') : output.slice(0, window),
        truncated: output.length > window,
      };
    },
  };
  registry.register(info);

  const approval = ports?.approval;
  const runner = ports?.commandRunner;
  if (!approval || !runner) return;

  const commit: Tool<CommitInput, Record<string, unknown>> = {
    id: 'git_commit',
    effect: 'shell',
    description: 'Stage and commit changes after the user approves the exact command. Pass files (paths relative to the repository, one per line) to commit only those; without files every change is staged (git add -A). Look at git_info status and diff first, and write a short, clear message describing what changed and why. It never pushes.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the repository.', maxLength: 4_096 },
        message: { type: 'string', description: 'Commit message: a short summary line, optionally a blank line and details.', maxLength: 2_000 },
        files: { type: 'string', description: 'Optional paths to commit, one per line (default: all changes).', maxLength: 20_000 },
      },
      required: ['path', 'message'],
      additionalProperties: false,
    },
    normalizeInput: clean,
    validateInput: (value): value is CommitInput => commitError(value) === undefined,
    inputError: commitError,
    validateOutput: (value): value is Record<string, unknown> => isRecord(value),
    async run(input, signal) {
      const root = await repositoryRoot(input.path, signal);
      const files = input.files === undefined ? undefined : splitFiles(input.files);
      const stage = files ? `git add -- ${files.map(quote).join(' ')}` : 'git add -A';
      const command = `${stage} && git commit -m ${quote(input.message.trim())}`;
      const decision = await approval.request({ kind: 'command', command, cwd: root, timeoutSeconds: 60 }, signal);
      if (!decision) return { status: 'rejected', command };
      const result = await runner.run(command, root, 60_000, signal);
      const head = result.exitCode === 0 ? await git(['log', '-1', '--pretty=format:%h %s'], root, signal) : undefined;
      return {
        status: result.exitCode === 0 ? 'committed' : 'failed',
        command,
        exitCode: result.exitCode,
        ...(head ? { commit: head.output.trim() } : {}),
        output: result.output.slice(-4_000),
      };
    },
  };
  registry.register(commit);
}
