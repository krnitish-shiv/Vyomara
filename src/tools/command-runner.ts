import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackgroundCommand, BackgroundCommandPort, CommandResult, CommandRunnerPort } from './action-tools.ts';
import { ToolFailure } from './contracts.ts';

const HEAD_CHARS = 6_000;
const TAIL_CHARS = 14_000;

/** Directories commonly holding developer tools; apps launched from Finder get a minimal PATH. */
function augmentedPath(current: string | undefined): string {
  const extras = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(homedir(), '.local', 'bin'),
    join(homedir(), 'Library', 'pnpm'),
    join(homedir(), '.bun', 'bin'),
    join(homedir(), '.cargo', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const parts = (current ?? '').split(':').filter(Boolean);
  for (const extra of extras) if (!parts.includes(extra)) parts.push(extra);
  return parts.join(':');
}

/**
 * Keeps the beginning and end of long output, which is where commands
 * usually print what matters (the invocation and the final errors/summary).
 */
class BoundedOutput {
  #head = '';
  #tail = '';
  #dropped = 0;

  append(text: string): void {
    if (this.#head.length < HEAD_CHARS) {
      const room = HEAD_CHARS - this.#head.length;
      this.#head += text.slice(0, room);
      text = text.slice(room);
    }
    if (text === '') return;
    this.#tail += text;
    if (this.#tail.length > TAIL_CHARS) {
      this.#dropped += this.#tail.length - TAIL_CHARS;
      this.#tail = this.#tail.slice(-TAIL_CHARS);
    }
  }

  get truncated(): boolean {
    return this.#dropped > 0;
  }

  toString(): string {
    return this.#dropped > 0
      ? `${this.#head}\n… [${this.#dropped} characters of output omitted] …\n${this.#tail}`
      : this.#head + this.#tail;
  }
}

function commandEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: augmentedPath(process.env.PATH),
    CI: process.env.CI ?? '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    TERM: 'dumb',
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  };
}

const stripAnsi = (chunk: Buffer): string => chunk.toString('utf8').replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');

interface RunningCommand {
  readonly id: string;
  readonly command: string;
  readonly cwd: string;
  readonly startedAt: number;
  readonly kill: () => void;
  /** Everything printed so far, trimmed to the last BACKGROUND_KEEP characters. */
  log: string;
  /** Characters dropped from the front of log, so read offsets stay valid. */
  dropped: number;
  /** Position up to which the agent has read. */
  readTo: number;
  exitCode: number | null | undefined;
}

const BACKGROUND_KEEP = 60_000;
const BACKGROUND_LIMIT = 5;

export class ShellCommandRunner implements CommandRunnerPort, BackgroundCommandPort {
  readonly #shell: string;
  readonly #background = new Map<string, RunningCommand>();

  constructor(shell = process.env.SHELL && /\/(?:zsh|bash)$/u.test(process.env.SHELL) ? process.env.SHELL : '/bin/zsh') {
    this.#shell = shell;
  }

  run(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<CommandResult> {
    if (signal.aborted) return Promise.reject(new ToolFailure('The command was cancelled before it started.', 'tool-failed'));
    const started = Date.now();
    return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
      // A login shell picks up the user's PATH setup (Homebrew, nvm, pnpm…).
      const child = spawn(this.#shell, ['-l', '-c', command], {
        cwd,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: commandEnvironment(),
      });
      const output = new BoundedOutput();
      let timedOut = false;
      let settled = false;
      const killGroup = (killSignal: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, killSignal);
        } catch {
          child.kill(killSignal);
        }
      };
      const stop = (): void => {
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 2_000).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      const onAbort = (): void => {
        stop();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectPromise(new ToolFailure('The command was stopped by the user.', 'tool-failed'));
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // ANSI escape sequences are removed so the model sees plain text.
      child.stdout.on('data', (chunk: Buffer) => output.append(stripAnsi(chunk)));
      child.stderr.on('data', (chunk: Buffer) => output.append(stripAnsi(chunk)));
      child.once('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        rejectPromise(new ToolFailure('The shell could not be started.', 'tool-failed'));
      });
      child.once('close', (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        let text = output.toString();
        if (timedOut) text += `\n[Command timed out after ${Math.round(timeoutMs / 1000)}s and was stopped.]`;
        resolvePromise({
          exitCode,
          signal: exitSignal,
          timedOut,
          output: text,
          truncated: output.truncated,
          durationMs: Date.now() - started,
        });
      });
    });
  }

  /**
   * Start a long-running command (dev server, watcher) that keeps running
   * after the request ends. Its output is kept for command_output; Vyomara
   * stops it on quit, or when asked.
   */
  start(command: string, cwd: string): BackgroundCommand {
    const running = [...this.#background.values()].filter(item => item.exitCode === undefined);
    if (running.length >= BACKGROUND_LIMIT) {
      throw new ToolFailure(`${BACKGROUND_LIMIT} background commands are already running. Stop one with command_output first.`, 'tool-failed');
    }
    const child = spawn(this.#shell, ['-l', '-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: commandEnvironment() });
    const id = randomUUID().slice(0, 8);
    const killGroup = (killSignal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, killSignal);
      } catch {
        child.kill(killSignal);
      }
    };
    const entry: RunningCommand = {
      id,
      command,
      cwd,
      startedAt: Date.now(),
      kill: () => {
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 2_000).unref();
      },
      log: '',
      dropped: 0,
      readTo: 0,
      exitCode: undefined,
    };
    const append = (chunk: Buffer): void => {
      entry.log += stripAnsi(chunk);
      if (entry.log.length > BACKGROUND_KEEP) {
        const cut = entry.log.length - BACKGROUND_KEEP;
        entry.log = entry.log.slice(cut);
        entry.dropped += cut;
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', () => { entry.exitCode = null; entry.log += '\n[The shell could not be started.]'; });
    child.once('close', code => { entry.exitCode = code; });
    this.#background.set(id, entry);
    return this.#describe(entry, false);
  }

  /** Output printed since the last read (or the latest output when `all`). */
  read(id: string, all = false): BackgroundCommand {
    const entry = this.#background.get(id);
    if (!entry) throw new ToolFailure(`No background command has id "${id}". Use action "list" to see them.`, 'not-found');
    return this.#describe(entry, all);
  }

  stop(id: string): BackgroundCommand {
    const entry = this.#background.get(id);
    if (!entry) throw new ToolFailure(`No background command has id "${id}".`, 'not-found');
    if (entry.exitCode === undefined) entry.kill();
    return { ...this.#describe(entry, false), status: 'stopped' };
  }

  list(): BackgroundCommand[] {
    return [...this.#background.values()].map(entry => ({ ...this.#describe(entry, false, true) }));
  }

  /** Stop every background command (on quit). */
  stopAll(): void {
    for (const entry of this.#background.values()) if (entry.exitCode === undefined) entry.kill();
  }

  #describe(entry: RunningCommand, all: boolean, summary = false): BackgroundCommand {
    const end = entry.dropped + entry.log.length;
    const from = all ? entry.dropped : Math.max(entry.readTo, entry.dropped);
    const output = summary ? '' : entry.log.slice(from - entry.dropped).slice(-TAIL_CHARS);
    if (!summary) entry.readTo = end;
    return {
      id: entry.id,
      command: entry.command,
      cwd: entry.cwd,
      status: entry.exitCode === undefined ? 'running' : 'exited',
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
      runningForSeconds: Math.round((Date.now() - entry.startedAt) / 1_000),
      ...(summary ? {} : { output }),
    };
  }
}
