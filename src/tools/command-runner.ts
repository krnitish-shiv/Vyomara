import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunnerPort } from './action-tools.ts';
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

export class ShellCommandRunner implements CommandRunnerPort {
  readonly #shell: string;

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
        env: {
          ...process.env,
          PATH: augmentedPath(process.env.PATH),
          CI: process.env.CI ?? '1',
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TERM: 'dumb',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          PAGER: 'cat',
        },
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
      const strip = (chunk: Buffer): string =>
        // Remove ANSI escape sequences so the model sees plain text.
        chunk.toString('utf8').replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '');
      child.stdout.on('data', (chunk: Buffer) => output.append(strip(chunk)));
      child.stderr.on('data', (chunk: Buffer) => output.append(strip(chunk)));
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
}
