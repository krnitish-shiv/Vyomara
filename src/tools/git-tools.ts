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

  registerBranchAndSyncTools(registry, repositoryRoot, approval, runner, ports?.approvalMemory);
  registerGitHubTool(registry, repositoryRoot, approval, runner);
}

type Approval = NonNullable<ActionToolPorts['approval']>;
type Runner = NonNullable<ActionToolPorts['commandRunner']>;
type Memory = ActionToolPorts['approvalMemory'];
type RepositoryRoot = (path: string, signal: AbortSignal) => Promise<string>;

const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/u;

function stringField(value: Record<string, unknown>, key: string, max: number): string | undefined {
  const item = value[key];
  return typeof item === 'string' && item.trim() !== '' && item.length <= max ? item.trim() : undefined;
}

/** Ask once for the exact command (or reuse "always allow"), run it, and report. */
async function approvedRun(command: string, cwd: string, approval: Approval, runner: Runner, memory: Memory, signal: AbortSignal, timeoutSeconds = 120): Promise<Record<string, unknown>> {
  const remembered = memory?.has(command, cwd) === true;
  const decision = remembered || await approval.request({ kind: 'command', command, cwd, timeoutSeconds }, signal);
  if (!decision) return { status: 'rejected', command };
  if (decision === 'always') memory?.allow(command, cwd);
  const result = await runner.run(command, cwd, timeoutSeconds * 1_000, signal);
  return { status: result.exitCode === 0 ? 'done' : 'failed', command, exitCode: result.exitCode, output: result.output.slice(-6_000) };
}

function registerBranchAndSyncTools(registry: ToolRegistry, repositoryRoot: RepositoryRoot, approval: Approval, runner: Runner, memory: Memory): void {
  const branchActions = new Set(['list', 'create', 'switch', 'delete', 'stash', 'stash_pop']);
  const branchError = (value: unknown): string | undefined => {
    if (!isRecord(value)) return 'Arguments must be a JSON object.';
    if (Object.keys(value).some(key => !['path', 'action', 'name', 'from'].includes(key))) return 'Use only path, action, name, from.';
    if (typeof value.path !== 'string' || !isAbsolute(value.path)) return 'path must be the absolute path of the repository.';
    if (typeof value.action !== 'string' || !branchActions.has(value.action)) return 'action must be list, create, switch, delete, stash, or stash_pop.';
    const name = value.name;
    if (['create', 'switch', 'delete'].includes(value.action) && (typeof name !== 'string' || !BRANCH.test(name))) return 'name must be a branch name (letters, digits, / . - _).';
    if (value.from !== undefined && (typeof value.from !== 'string' || !BRANCH.test(value.from))) return 'from must be a branch or commit.';
    if (value.action === 'stash' && name !== undefined && (typeof name !== 'string' || name.length > 200 || /[\n'`]/u.test(name))) return 'name (the stash message) must be one short line.';
    return undefined;
  };
  registry.register({
    id: 'git_branch',
    effect: 'shell',
    description: 'Branches and stashes: "list" branches (no approval), "create" a branch (optionally from another branch/commit) and switch to it, "switch" to an existing branch, "delete" a merged branch (git branch -d, never forced), "stash" uncommitted changes (name = message) or "stash_pop" them back. Changes ask the user first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the repository.', maxLength: 4_096 },
        action: { type: 'string', description: '"list", "create", "switch", "delete", "stash", or "stash_pop".', maxLength: 10 },
        name: { type: 'string', description: 'Branch name (create, switch, delete) or stash message.', maxLength: 200 },
        from: { type: 'string', description: 'create only: start from this branch or commit.', maxLength: 200 },
      },
      required: ['path', 'action'],
      additionalProperties: false,
    },
    normalizeInput: clean,
    validateInput: (value): value is Record<string, unknown> => branchError(value) === undefined,
    inputError: branchError,
    validateOutput: (value): value is Record<string, unknown> => isRecord(value),
    async run(input, signal) {
      const root = await repositoryRoot(String(input.path), signal);
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (input.action === 'list') {
        const result = await git(['branch', '--list', '--verbose', '--all'], root, signal);
        return { repository: root, output: result.output.trim() };
      }
      const command = {
        create: `git switch -c ${quote(name)}${typeof input.from === 'string' ? ` ${quote(input.from)}` : ''}`,
        switch: `git switch ${quote(name)}`,
        delete: `git branch -d ${quote(name)}`,
        stash: `git stash push --include-untracked${name ? ` -m ${quote(name)}` : ''}`,
        stash_pop: 'git stash pop',
      }[input.action as 'create' | 'switch' | 'delete' | 'stash' | 'stash_pop'];
      return approvedRun(command, root, approval, runner, memory, signal, 60);
    },
  });

  const syncError = (value: unknown): string | undefined => {
    if (!isRecord(value)) return 'Arguments must be a JSON object.';
    if (Object.keys(value).some(key => !['path', 'action', 'remote', 'branch'].includes(key))) return 'Use only path, action, remote, branch.';
    if (typeof value.path !== 'string' || !isAbsolute(value.path)) return 'path must be the absolute path of the repository.';
    if (value.action !== 'fetch' && value.action !== 'pull' && value.action !== 'push') return 'action must be fetch, pull, or push.';
    if (value.remote !== undefined && (typeof value.remote !== 'string' || !/^[\w.-]{1,100}$/u.test(value.remote))) return 'remote must be a remote name like origin.';
    if (value.branch !== undefined && (typeof value.branch !== 'string' || !BRANCH.test(value.branch))) return 'branch must be a branch name.';
    return undefined;
  };
  registry.register({
    id: 'git_sync',
    effect: 'shell',
    description: 'Talk to the remote: "fetch" (no approval), "pull" (fast-forward only, never creates merge commits), or "push" the current branch (sets upstream the first time; never forced). Pull and push ask the user first. Push only when the user asked for it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the repository.', maxLength: 4_096 },
        action: { type: 'string', description: '"fetch", "pull", or "push".', maxLength: 5 },
        remote: { type: 'string', description: 'Remote name (default origin).', maxLength: 100 },
        branch: { type: 'string', description: 'Branch (default: the current one).', maxLength: 200 },
      },
      required: ['path', 'action'],
      additionalProperties: false,
    },
    normalizeInput: clean,
    validateInput: (value): value is Record<string, unknown> => syncError(value) === undefined,
    inputError: syncError,
    validateOutput: (value): value is Record<string, unknown> => isRecord(value),
    async run(input, signal) {
      const root = await repositoryRoot(String(input.path), signal);
      const remote = typeof input.remote === 'string' ? input.remote : 'origin';
      if (input.action === 'fetch') {
        const result = await git(['fetch', '--prune', remote], root, signal);
        const status = await git(['status', '--short', '--branch'], root, signal);
        return { status: result.code === 0 ? 'done' : 'failed', output: `${result.output.trim()}\n${status.output.split('\n')[0] ?? ''}`.trim() };
      }
      const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root, signal)).output.trim();
      const branch = typeof input.branch === 'string' ? input.branch : current;
      if (input.action === 'pull') return approvedRun(`git pull --ff-only ${quote(remote)} ${quote(branch)}`, root, approval, runner, memory, signal);
      const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root, signal);
      return approvedRun(`git push${upstream.code === 0 ? '' : ' -u'} ${quote(remote)} ${quote(branch)}`, root, approval, runner, memory, signal);
    },
  });
}

/** Run gh without a shell; read-only views need no approval. */
function gh(args: readonly string[], cwd: string, signal: AbortSignal): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    execFile('gh', args, {
      cwd, signal, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PATH: `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: 'cat' },
    }, (error, stdout, stderr) => {
      if (error && (error as { code?: unknown }).code === 'ENOENT') {
        resolve({ code: 127, output: 'GitHub CLI (gh) is not installed. Install it with "brew install gh", then run "gh auth login".' });
        return;
      }
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr ? `\n${stderr}` : ''}`.trim() });
    });
  });
}

const GITHUB_READ = new Set(['pr_list', 'pr_view', 'pr_checks', 'pr_diff', 'issue_list', 'issue_view', 'run_list', 'run_log']);
const GITHUB_WRITE = new Set(['pr_create', 'pr_comment', 'issue_create', 'issue_comment']);

function registerGitHubTool(registry: ToolRegistry, repositoryRoot: RepositoryRoot, approval: Approval, runner: Runner): void {
  const error = (value: unknown): string | undefined => {
    if (!isRecord(value)) return 'Arguments must be a JSON object.';
    if (Object.keys(value).some(key => !['path', 'action', 'number', 'title', 'body', 'base', 'draft', 'state'].includes(key))) return 'Use only path, action, number, title, body, base, draft, state.';
    if (typeof value.path !== 'string' || !isAbsolute(value.path)) return 'path must be the absolute path of the repository.';
    const action = value.action;
    if (typeof action !== 'string' || (!GITHUB_READ.has(action) && !GITHUB_WRITE.has(action))) return `action must be one of: ${[...GITHUB_READ, ...GITHUB_WRITE].join(', ')}.`;
    // PR views default to the current branch's PR; issues, comments, and run logs need a number.
    if (['issue_view', 'pr_comment', 'issue_comment', 'run_log'].includes(action) && !Number.isInteger(value.number)) return 'number is required (the PR, issue, or run number).';
    if ((action === 'pr_create' || action === 'issue_create') && !stringField(value, 'title', 256)) return 'title is required.';
    if ((action.endsWith('_comment') || action === 'issue_create') && !stringField(value, 'body', 60_000)) return 'body is required.';
    if (value.base !== undefined && (typeof value.base !== 'string' || !BRANCH.test(value.base))) return 'base must be a branch name.';
    if (value.state !== undefined && !['open', 'closed', 'merged', 'all'].includes(String(value.state))) return 'state must be open, closed, merged, or all.';
    if (value.draft !== undefined && typeof value.draft !== 'boolean') return 'draft must be true or false.';
    return undefined;
  };
  registry.register({
    id: 'github',
    effect: 'shell',
    description: 'GitHub for this repository through the user\'s GitHub CLI login. Reading needs no approval: pr_list, pr_view (number, or the current branch\'s PR), pr_checks (CI status), pr_diff, issue_list, issue_view, run_list (recent workflow runs), run_log (failed steps of run `number`). Writing asks first: pr_create (title, body, base?, draft?; push the branch first), pr_comment, issue_create, issue_comment.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the repository.', maxLength: 4_096 },
        action: { type: 'string', description: 'pr_list, pr_view, pr_checks, pr_diff, issue_list, issue_view, run_list, run_log, pr_create, pr_comment, issue_create, issue_comment.', maxLength: 14 },
        number: { type: 'integer', description: 'PR, issue, or workflow run number.', minimum: 1 },
        title: { type: 'string', description: 'Title for pr_create / issue_create.', maxLength: 256 },
        body: { type: 'string', description: 'Markdown body or comment.', maxLength: 60_000 },
        base: { type: 'string', description: 'pr_create: target branch (default: the repository default).', maxLength: 200 },
        draft: { type: 'boolean', description: 'pr_create: open as a draft.' },
        state: { type: 'string', description: 'pr_list / issue_list: open (default), closed, merged, or all.', maxLength: 6 },
      },
      required: ['path', 'action'],
      additionalProperties: false,
    },
    normalizeInput: value => {
      const cleaned = clean(value);
      if (isRecord(cleaned) && typeof cleaned.number === 'string' && /^\d+$/u.test(cleaned.number.replace(/^#/u, ''))) return { ...cleaned, number: Number(cleaned.number.replace(/^#/u, '')) };
      return cleaned;
    },
    validateInput: (value): value is Record<string, unknown> => error(value) === undefined,
    inputError: error,
    validateOutput: (value): value is Record<string, unknown> => isRecord(value),
    async run(input, signal) {
      const root = await repositoryRoot(String(input.path), signal);
      const action = String(input.action);
      const number = typeof input.number === 'number' ? String(input.number) : undefined;
      const state = typeof input.state === 'string' ? input.state : 'open';
      if (GITHUB_READ.has(action)) {
        const args: Record<string, string[]> = {
          pr_list: ['pr', 'list', '--state', state, '--limit', '20', '--json', 'number,title,author,headRefName,state,isDraft,updatedAt,url'],
          pr_view: ['pr', 'view', ...(number ? [number] : []), '--json', 'number,title,state,author,headRefName,baseRefName,body,url,reviewDecision,mergeable,comments,files'],
          pr_checks: ['pr', 'checks', ...(number ? [number] : [])],
          pr_diff: ['pr', 'diff', ...(number ? [number] : [])],
          issue_list: ['issue', 'list', '--state', state === 'merged' ? 'closed' : state, '--limit', '20', '--json', 'number,title,author,labels,state,updatedAt,url'],
          issue_view: ['issue', 'view', number ?? '', '--json', 'number,title,state,author,body,labels,comments,url'],
          run_list: ['run', 'list', '--limit', '10', '--json', 'databaseId,displayTitle,headBranch,status,conclusion,workflowName,createdAt,url'],
          run_log: ['run', 'view', number ?? '', '--log-failed'],
        };
        const result = await gh(args[action] as string[], root, signal);
        // gh pr checks exits 8 while checks are pending; that is still an answer.
        if (result.code !== 0 && !(action === 'pr_checks' && result.code === 8)) {
          return { status: 'failed', action, output: result.output.slice(0, 2_000) };
        }
        return { status: 'done', action, output: result.output.slice(-20_000) };
      }
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const command = {
        pr_create: `gh pr create --title ${quote(title)} --body ${quote(body)}${typeof input.base === 'string' ? ` --base ${quote(input.base)}` : ''}${input.draft === true ? ' --draft' : ''}`,
        pr_comment: `gh pr comment ${number ?? ''} --body ${quote(body)}`,
        issue_create: `gh issue create --title ${quote(title)} --body ${quote(body)}`,
        issue_comment: `gh issue comment ${number ?? ''} --body ${quote(body)}`,
      }[action as 'pr_create' | 'pr_comment' | 'issue_create' | 'issue_comment'];
      // Writes are never "always allowed": each one is shown.
      return approvedRun(command, root, approval, runner, undefined, signal, 90);
    },
  });
}

