import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readModelSettings, runRequest, withSavedModelSettings } from './app/application.ts';
import { AgentError } from './agent/agent.ts';
import type { ToolActivity } from './agent/agent.ts';
import type { PlanStep } from './tools/plan-tool.ts';
import { loadConfig, validateOllamaModel } from './config/config.ts';
import type { AppConfig } from './config/config.ts';
import type { FileOperationApprovalPort } from './desktop/contracts.ts';
import { FileOperationApprovalManager } from './desktop/file-operation-approval.ts';
import { MacApplicationLauncher } from './desktop/mac-application-launcher.ts';
import { formatUnifiedDiff } from './shared/diff.ts';
import { ApprovalMemory } from './tools/action-tools.ts';
import type { ActionApprovalPort } from './tools/action-tools.ts';
import { ShellCommandRunner } from './tools/command-runner.ts';
import { HttpWebClient } from './tools/web-client.ts';
import { createLogger } from './diagnostics/logger.ts';
import { ProviderError } from './providers/provider.ts';
import { PersistenceError, SqliteStore } from './storage/sqlite-store.ts';
import { ToolExecutionError } from './tools/executor.ts';

/**
 * One shared line reader for the whole process, so answers piped on stdin
 * (or typed at a TTY) are never lost between prompts.
 */
class TerminalInput {
  #lines: string[] = [];
  #waiters: ((line: string | undefined) => void)[] = [];
  #closed = false;
  #reader: ReturnType<typeof createInterface> | undefined;

  #ensure(): void {
    if (this.#reader) return;
    this.#reader = createInterface({ input: process.stdin, terminal: false });
    this.#reader.on('line', line => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(line);
      else this.#lines.push(line);
    });
    this.#reader.on('close', () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(undefined);
    });
  }

  async ask(question: string): Promise<string | undefined> {
    this.#ensure();
    process.stderr.write(question);
    // Piped answers are not echoed by a terminal; show them so the transcript reads correctly.
    const echo = (line: string | undefined): string | undefined => {
      if (!process.stdin.isTTY) process.stderr.write(`${line ?? ''}\n`);
      return line;
    };
    const buffered = this.#lines.shift();
    if (buffered !== undefined) return echo(buffered);
    if (this.#closed) return echo(undefined);
    return new Promise(resolve => this.#waiters.push(line => resolve(echo(line))));
  }

  close(): void {
    this.#reader?.close();
  }
}

const terminal = new TerminalInput();

const color = (code: number) => (text: string): string =>
  process.stderr.isTTY ? `\u001B[${code}m${text}\u001B[0m` : text;
const dim = color(2);
const bold = color(1);
const green = color(32);
const red = color(31);
const cyan = color(36);

async function confirmAction(message: string, confirmation: string): Promise<boolean> {
  const answer = await terminal.ask(`${message}\nType ${confirmation} to continue: `);
  return answer?.trim() === confirmation;
}

async function askYesNo(question: string): Promise<boolean> {
  const answer = await terminal.ask(`${question} ${dim('[y/N]')} `);
  return /^(?:y|yes|haan|ha|han)$/iu.test(answer?.trim() ?? '');
}

function printDiff(before: string, after: string): void {
  const diff = formatUnifiedDiff(before, after);
  for (const line of diff.split('\n')) {
    process.stderr.write(`${line.startsWith('+') ? green(line) : line.startsWith('-') ? red(line) : line.startsWith('@@') ? cyan(line) : dim(line)}\n`);
  }
}

function terminalFileApproval(config: AppConfig): FileOperationApprovalPort {
  const manager: FileOperationApprovalManager = new FileOperationApprovalManager({
    config,
    moveToTrash: path => moveToTrash(path),
    onProposal(proposal) {
      void (async () => {
        const title = proposal.operation === 'create-file'
          ? 'Create file'
          : proposal.operation === 'create-directory'
            ? 'Create folder'
            : proposal.operation === 'edit-file'
              ? 'Edit file'
              : 'Move to Trash';
        process.stderr.write(`\n${bold(`▶ ${title}:`)} ${proposal.path}\n`);
        if (proposal.operation === 'edit-file') {
          printDiff(proposal.currentContent ?? '', proposal.proposedContent ?? '');
        } else if (proposal.operation === 'create-file') {
          printDiff('', proposal.proposedContent ?? '');
        }
        try {
          if (proposal.operation === 'delete') {
            const answer = await terminal.ask('Type DELETE to move it to Trash (anything else rejects): ');
            if (answer?.trim() === 'DELETE') await manager.approve(proposal.id, 'DELETE');
            else manager.reject(proposal.id);
          } else if (await askYesNo('Apply this change?')) {
            await manager.approve(proposal.id);
          } else {
            manager.reject(proposal.id);
          }
        } catch (error) {
          process.stderr.write(`${red(error instanceof Error ? error.message : 'The change failed.')}\n`);
        }
      })();
    },
  });
  return manager;
}

function moveToTrash(path: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('/usr/bin/osascript', [
      '-e',
      'on run argv',
      '-e',
      'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
      '-e',
      'end run',
      path,
    ], { stdio: 'ignore' });
    child.once('error', rejectPromise);
    child.once('close', code => code === 0 ? resolvePromise() : rejectPromise(new Error('Moving to Trash failed.')));
  });
}

const terminalActionApproval: ActionApprovalPort = {
  async request(action) {
    if (action.kind === 'command') {
      process.stderr.write(`\n${bold('▶ Run command')} ${dim(`in ${action.cwd} (timeout ${action.timeoutSeconds}s)`)}\n  ${cyan(action.command)}\n`);
      const answer = (await terminal.ask(`Run it? ${dim('[y = once, a = always in this folder, N = no]')} `))?.trim() ?? '';
      if (/^(?:a|always)$/iu.test(answer)) return 'always';
      return /^(?:y|yes|haan|ha|han)$/iu.test(answer);
    }
    if (action.kind === 'application') {
      process.stderr.write(`\n${bold('▶ Open application')} ${action.application}${action.target ? ` with ${action.target}${action.line ? `:${action.line}` : ''}` : ''}\n`);
      return askYesNo('Open it?');
    }
    if (action.kind === 'app-control') {
      process.stderr.write(`\n${bold(`▶ ${action.action} ${action.application}`)}\n`);
      return askYesNo('Allow?');
    }
    if (action.kind === 'web') {
      process.stderr.write(action.operation === 'search'
        ? `\n${bold('▶ Search the web')} “${action.target}”\n${dim(`  ${action.host} receives these search words.`)}\n`
        : `\n${bold('▶ Read web page')} ${action.target}\n${dim(`  ${action.host} receives this request.`)}\n`);
      const answer = (await terminal.ask(`Allow? ${dim(`[y = once, a = always for ${action.host}, N = no]`)} `))?.trim() ?? '';
      if (/^(?:a|always)$/iu.test(answer)) return 'always';
      return /^(?:y|yes|haan|ha|han)$/iu.test(answer);
    }
    process.stderr.write(`\n${bold('▶ Open web page')} ${action.url}${action.application ? ` in ${action.application}` : ''}\n${dim('  The website receives this address (including any search query).')}\n`);
    return askYesNo('Open it?');
  },
};

function printPlan(steps: readonly PlanStep[]): void {
  process.stderr.write(`${bold('Plan')}\n`);
  for (const step of steps) {
    const mark = step.status === 'done' ? green('✓') : step.status === 'in_progress' ? cyan('▸') : dim('○');
    process.stderr.write(`  ${mark} ${step.status === 'done' ? dim(step.text) : step.text}\n`);
  }
}

function printActivity(activity: ToolActivity): void {
  if (activity.toolId === 'update_plan') return;
  if (activity.status === 'running') {
    process.stderr.write(`${dim('•')} ${activity.label}\n`);
  } else if (activity.status === 'failed' && activity.detail) {
    process.stderr.write(`  ${red('✗')} ${dim(activity.detail)}\n`);
  }
}

function printStorageUsage(): void {
  console.log([
    'Usage:',
    '  pnpm dev                       (interactive chat)',
    '  pnpm dev -- "your request"',
    '  pnpm dev -- --model qwen3:14b "your request"',
    '  pnpm dev -- --session <session-id> "your next turn"',
    '  pnpm dev -- --sessions list|show <session-id>|delete <session-id> [--confirm]',
    '  pnpm dev -- --memory list|show <memory-id>|save "content" --confirm|delete <memory-id> --confirm',
  ].join('\n'));
}

async function runStorageCommand(args: string[], dataDirectory: string): Promise<void> {
  const [group, action, id, ...remaining] = args;
  const store = new SqliteStore(dataDirectory);
  try {
    if (group === '--sessions' && action === 'list' && id === undefined) {
      const sessions = store.listSessions();
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }
    if (group === '--sessions' && action === 'show' && id !== undefined && remaining.length === 0) {
      console.log(JSON.stringify(store.getSession(id).messages(), null, 2));
      return;
    }
    if (group === '--sessions' && action === 'delete' && id !== undefined) {
      if (remaining.length !== 1 || remaining[0] !== '--confirm') {
        throw new PersistenceError(
          'Session deletion requires --confirm after reviewing the session ID.',
          'invalid-data',
        );
      }
      if (!await confirmAction(`Delete session ${id}?`, 'DELETE')) {
        console.log('Session was not deleted.');
        process.exitCode = 1;
        return;
      }
      if (!store.deleteSession(id)) {
        throw new PersistenceError('The requested session was not found.', 'not-found');
      }
      console.log(`Deleted session ${id}.`);
      return;
    }
    if (group === '--memory' && action === 'list' && id === undefined) {
      console.log(JSON.stringify(store.listMemories(), null, 2));
      return;
    }
    if (group === '--memory' && action === 'show' && id !== undefined && remaining.length === 0) {
      console.log(JSON.stringify(store.getMemory(id)));
      return;
    }
    if (group === '--memory' && action === 'save' && id !== undefined) {
      const confirmed = remaining.at(-1) === '--confirm';
      const contentParts = confirmed ? [id, ...remaining.slice(0, -1)] : [id, ...remaining];
      const content = contentParts.join(' ').trim();
      console.log(`Memory content to save:\n${JSON.stringify(content)}`);
      if (!confirmed) {
        throw new PersistenceError(
          'Memory was not saved. Review the content above and repeat the command with --confirm.',
          'invalid-data',
        );
      }
      if (!await confirmAction('Review the memory content above.', 'SAVE')) {
        console.log('Memory was not saved.');
        process.exitCode = 1;
        return;
      }
      const memoryId = store.saveMemory(content);
      console.log(`Saved explicit memory ${memoryId}.`);
      return;
    }
    if (group === '--memory' && action === 'delete' && id !== undefined) {
      if (remaining.length !== 1 || remaining[0] !== '--confirm') {
        throw new PersistenceError(
          'Memory deletion requires --confirm after reviewing the memory ID.',
          'invalid-data',
        );
      }
      if (!await confirmAction(`Delete memory ${id}?`, 'DELETE')) {
        console.log('Memory was not deleted.');
        process.exitCode = 1;
        return;
      }
      if (!store.deleteMemory(id)) {
        throw new PersistenceError('The requested memory was not found.', 'not-found');
      }
      console.log(`Deleted memory ${id}.`);
      return;
    }
    printStorageUsage();
    process.exitCode = 2;
  } finally {
    store.close();
  }
}

async function main(): Promise<void> {
  const debug = process.env.VYOM_DEBUG === '1';
  const logger = createLogger(debug ? undefined : () => undefined);
  let config: AppConfig;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    logger.failure(error);
    console.error(error instanceof Error ? error.message : 'Configuration is invalid.');
    process.exitCode = 2;
    return;
  }

  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  if (args[0] === '--sessions' || args[0] === '--memory') {
    try {
      await runStorageCommand(args, config.dataDirectory);
    } catch (error) {
      console.error(error instanceof PersistenceError
        ? error.message
        : 'Local data operation failed safely.');
      process.exitCode = 1;
    } finally {
      terminal.close();
    }
    return;
  }
  let sessionId: string | undefined;
  let modelOverride: string | undefined;
  while (args[0] === '--session' || args[0] === '--model') {
    const flag = args.shift();
    const value = args.shift();
    if (!value) {
      printStorageUsage();
      process.exitCode = 2;
      return;
    }
    if (flag === '--session') sessionId = value;
    else modelOverride = value;
  }
  try {
    // Settings saved from the app apply unless the environment sets them explicitly.
    const saved = readModelSettings(config);
    config = withSavedModelSettings(config, {
      ...(saved.model && !process.env.VYOM_OLLAMA_MODEL ? { model: validateOllamaModel(saved.model) } : {}),
      ...(saved.numCtx !== undefined && !process.env.VYOM_OLLAMA_NUM_CTX ? { numCtx: saved.numCtx } : {}),
      ...(saved.think !== undefined && !process.env.VYOM_OLLAMA_THINK ? { think: saved.think } : {}),
    });
    if (modelOverride) config = { ...config, ollamaModel: validateOllamaModel(modelOverride) };
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The model name is invalid.');
    process.exitCode = 2;
    return;
  }

  const actions = {
    approval: terminalActionApproval,
    approvalMemory: new ApprovalMemory(),
    commandRunner: new ShellCommandRunner(),
    web: new HttpWebClient(config.searxngUrl === undefined ? {} : { searxngUrl: config.searxngUrl }),
    ...(process.platform === 'darwin' ? { launcher: new MacApplicationLauncher() } : {}),
  };
  const fileOperationApproval = terminalFileApproval(config);
  console.error(dim(config.provider === 'ollama'
    ? `Vyom · local Ollama · ${config.ollamaModel} · ${config.ollamaNumCtx.toLocaleString()} token context`
    : 'Vyom · deterministic placeholder (no model service is contacted)'));

  const ask = async (prompt: string): Promise<boolean> => {
    const controller = new AbortController();
    const onInterrupt = () => controller.abort();
    process.once('SIGINT', onInterrupt);
    try {
      const result = await runRequest(prompt, controller.signal, config, logger, {
        ...(sessionId === undefined ? {} : { sessionId }),
        onToolActivity: printActivity,
        onPlan: printPlan,
        fileOperationApproval,
        actions,
      });
      sessionId = result.sessionId;
      console.log(`\n${result.response}\n`);
      console.error(dim(`Session ID: ${result.sessionId}`));
      return true;
    } catch (error) {
      if (
        error instanceof ProviderError ||
        error instanceof AgentError ||
        error instanceof ToolExecutionError ||
        error instanceof PersistenceError
      ) {
        console.error(red(error.message));
      } else {
        console.error(red('Request failed or was cancelled. No success is implied; review configuration and retry.'));
      }
      process.exitCode = 1;
      return false;
    } finally {
      process.removeListener('SIGINT', onInterrupt);
    }
  };

  const prompt = args.join(' ').trim();
  if (prompt) {
    await ask(prompt);
    terminal.close();
    return;
  }
  if (!process.stdin.isTTY) {
    printStorageUsage();
    process.exitCode = 2;
    terminal.close();
    return;
  }
  console.error(dim('Type a request. Empty line or "exit" to quit; Ctrl+C stops the current task.'));
  while (true) {
    const line = await terminal.ask(`${bold('you ›')} `);
    if (line === undefined || line.trim() === '' || /^(?:exit|quit)$/iu.test(line.trim())) break;
    await ask(line.trim());
  }
  terminal.close();
}

void main();
