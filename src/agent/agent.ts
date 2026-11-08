import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import type { AppConfig } from '../config/config.ts';
import type { Logger } from '../types.ts';
import { ProviderError } from '../providers/provider.ts';
import type { ModelProvider, ProviderResponse } from '../providers/provider.ts';
import { OperationStoppedError, runBounded } from '../shared/bounded.ts';
import { Session } from '../session/session.ts';
import type { SessionMessage } from '../session/session.ts';
import { TaskRun } from '../tasks/task-run.ts';
import { ToolExecutionError, ToolExecutor } from '../tools/executor.ts';
import { TOOL_ID_PATTERN } from '../tools/contracts.ts';
import type { ModelToolDefinition } from '../tools/contracts.ts';
import { CHARS_PER_TOKEN, fitMessagesToBudget, summaryCut, transcriptForSummary } from './context.ts';
import { buildSystemPrompt, detectEnvironment, spokenRequestNote } from './system-prompt.ts';
import type { PersonaId } from '../shared/persona.ts';
import type { MemoryStore } from '../storage/memory-store.ts';
import { urlsIn, verifyLinks } from '../shared/link-check.ts';
import { LinkAliases } from '../shared/link-alias.ts';
import type { AgentEnvironment } from './system-prompt.ts';
import type { PlanStep } from '../tools/plan-tool.ts';

export class AgentError extends Error {
  readonly code: 'invalid-request' | 'timeout' | 'cancelled' | 'iteration-limit' | 'tool-limit' | 'policy-denied' | 'tool-failed' | 'invalid-provider-response';

  constructor(
    message: string,
    code: AgentError['code'],
  ) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
  }
}

/** A live, human-readable description of one tool call, for the UI or terminal. */
export interface ToolActivity {
  readonly id: string;
  readonly toolId: string;
  readonly label: string;
  readonly status: 'running' | 'done' | 'failed' | 'rejected';
  readonly detail?: string;
}

export interface AgentOptions {
  readonly provider: ModelProvider;
  readonly tools: ToolExecutor;
  readonly config: AppConfig;
  readonly session: Session;
  readonly logger: Logger;
  readonly onText?: (text: string) => void;
  readonly onToolActivity?: (activity: ToolActivity) => void;
  /** Receives the agent's checklist whenever it calls update_plan. */
  readonly onPlan?: (steps: readonly PlanStep[]) => void;
  /** Spoken request: ask for a short reply (fewer tokens, faster, and pleasant to hear). */
  readonly voice?: boolean;
  /** Plan mode: look around with read-only tools and reply with a plan; nothing is changed or run. */
  readonly planOnly?: boolean;
  /** Pictures attached to this request (base64), sent with it to a vision model. */
  readonly images?: readonly string[];
  /**
   * Only these tools may run (a helper such as explore). The model still sees
   * the full tool list, so the cached prompt matches; others are refused.
   */
  readonly allowedTools?: ReadonlySet<string>;
  /** Which assistant (name, gender) answers. */
  readonly persona?: PersonaId;
  /** Lasting facts from earlier conversations, shown in the system prompt. */
  readonly memory?: MemoryStore;
  /** Overrides environment discovery (used by tests). */
  readonly environment?: AgentEnvironment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Readable path for labels: `~` for home, and only the last segments of long paths. */
export function shortPath(path: unknown): string {
  if (typeof path !== 'string') return '';
  const home = homedir();
  const display = path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
  if (display.length <= 60) return display;
  return `…/${display.split('/').filter(Boolean).slice(-3).join('/')}`;
}

function clip(text: string, max = 80): string {
  const single = text.replace(/\s+/gu, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** Human-readable label for a tool call, e.g. "Reading ~/Projects/app/src/index.ts". */
export function describeToolCall(toolId: string, args: Readonly<Record<string, unknown>>): string {
  switch (toolId) {
    case 'read_file': {
      const range = typeof args.offset === 'number' ? ` (from line ${args.offset})` : '';
      return `Reading ${shortPath(args.path)}${range}`;
    }
    case 'list_directory':
      return `Listing ${shortPath(args.path)}`;
    case 'directory_tree':
      return `Mapping ${shortPath(args.path)}`;
    case 'find_files':
      return `Finding “${clip(String(args.query ?? ''), 40)}”${args.path ? ` in ${shortPath(args.path)}` : ''}`;
    case 'search_text':
      return `Searching “${clip(String(args.pattern ?? ''), 40)}” in ${shortPath(args.path)}`;
    case 'edit_file':
      return `Editing ${shortPath(args.path)}`;
    case 'multi_edit':
      return `Editing ${shortPath(args.path)} (several changes)`;
    case 'write_file':
      return `Writing ${shortPath(args.path)}`;
    case 'create_directory':
      return `Creating folder ${shortPath(args.path)}`;
    case 'delete_path':
      return `Moving ${shortPath(args.path)} to Trash`;
    case 'run_command':
      return `${args.background === true ? 'Starting in the background' : 'Running'} \`${clip(String(args.command ?? ''), 60)}\``;
    case 'open_application':
      return `Opening ${String(args.application ?? 'app')}${args.path ? ` with ${shortPath(args.path)}` : ''}`;
    case 'open_url':
      return `Opening ${clip(String(args.url ?? ''), 60)}`;
    case 'update_plan': {
      const steps = String(args.plan ?? '').split('\n').filter(line => line.trim() !== '');
      const done = steps.filter(line => /\[[xX]\]/u.test(line)).length;
      return `Updating plan (${done}/${steps.length} done)`;
    }
    case 'control_application':
      return `${String(args.action ?? 'Control').replace(/^./u, letter => letter.toUpperCase())} ${String(args.application ?? 'app')}`;
    case 'fetch_url':
      return `Reading ${clip(String(args.url ?? ''), 60)}`;
    case 'web_search':
      return `Searching the web for “${clip(String(args.query ?? ''), 50)}”`;
    case 'git_info':
      return `Git ${String(args.action ?? 'status')}${args.target ? ` ${clip(String(args.target), 40)}` : ''} in ${shortPath(args.path)}`;
    case 'explore':
      return `Asking a helper: ${clip(String(args.task ?? ''), 60)}`;
    case 'command_output':
      return args.action === 'stop' ? `Stopping background command ${String(args.id ?? '')}` : args.action === 'list' ? 'Listing background commands' : `Reading output of ${String(args.id ?? '')}`;
    case 'check_problems':
      return `Checking ${shortPath(args.path)} for problems`;
    case 'git_commit':
      return `Committing “${clip(String(args.message ?? '').split('\n')[0] ?? '', 50)}”`;
    case 'current_time':
      return args.timezone ? `Checking the time in ${clip(String(args.timezone), 30)}` : 'Checking the time';
    case 'calculate':
      return `Calculating ${clip(String(args.expression ?? ''), 50)}`;
    case 'convert_units':
      return `Converting ${clip(String(args.value ?? ''), 15)} ${clip(String(args.from ?? ''), 12)} to ${clip(String(args.to ?? ''), 12)}`;
    case 'date_math':
      return 'Working out dates';
    case 'system_info':
      return 'Checking this Mac';
    case 'weather':
      return `Getting the weather for ${clip(String(args.place ?? ''), 40)}`;
    case 'currency_convert':
      return `Converting ${clip(String(args.amount ?? ''), 15)} ${String(args.from ?? '').toUpperCase()} to ${String(args.to ?? '').toUpperCase()}`;
    case 'software_version':
      return `Checking the latest version of ${clip(String(args.name ?? ''), 40)}`;
    case 'news_headlines':
      return `Getting the news${args.topic ? ` about “${clip(String(args.topic), 40)}”` : ''}`;
    case 'browser': {
      const action = String(args.action ?? 'read');
      if (action === 'search') return `Searching Google in Chrome for “${clip(String(args.query ?? ''), 45)}”`;
      if (action === 'open') return `Opening ${clip(String(args.url ?? ''), 55)} in Chrome`;
      if (action === 'click') return `Clicking link ${String(args.link ?? '')} in Chrome`;
      if (action === 'scroll') return `Scrolling ${String(args.direction ?? 'down')} in Chrome`;
      if (action === 'back') return 'Going back in Chrome';
      return 'Reading the page in Chrome';
    }
    default:
      return toolId.startsWith('mcp_') ? `Using ${toolId.slice(4).replace(/_/u, ': ').replace(/_/gu, ' ')} (MCP)` : `Using ${toolId}`;
  }
}

/** A side effect confirmed (or refused) by a tool result — the only source for "done" claims. */
interface VerifiedAction {
  readonly ok: boolean;
  readonly text: string;
}

function verifiedAction(
  toolId: string,
  args: Readonly<Record<string, unknown>>,
  result: unknown,
): VerifiedAction | undefined {
  if (!isRecord(result)) return undefined;
  const path = `\`${shortPath(result.path ?? args.path)}\``;
  if (toolId === 'edit_file' || toolId === 'multi_edit' || toolId === 'write_file' || toolId === 'create_directory' || toolId === 'delete_path') {
    const verb = result.operation === 'create-file'
      ? 'Created'
      : result.operation === 'create-directory'
        ? 'Created folder'
        : result.operation === 'delete'
          ? 'Moved to Trash'
          : 'Edited';
    return result.status === 'applied'
      ? { ok: true, text: `${verb} ${path}` }
      : { ok: false, text: `You rejected: ${verb.toLowerCase()} ${path} (not changed)` };
  }
  if (toolId === 'remember' && result.ok === true) {
    return { ok: true, text: `Remembered: “${clip(String(result.remembered ?? ''), 120)}”` };
  }
  if (toolId === 'run_command') {
    const command = `\`${clip(String(result.command ?? args.command ?? ''), 70)}\``;
    if (result.status === 'rejected') return { ok: false, text: `You rejected running ${command}` };
    if (result.timedOut === true) return { ok: false, text: `Ran ${command} — timed out` };
    if (result.background === true) return { ok: result.state === 'running', text: `Started ${command} in the background (${String(result.id)})${result.state === 'running' ? '' : ' — it exited'}` };
    const remembered = result.approval === 'remembered' ? ' (always-allowed)' : '';
    return { ok: result.exitCode === 0, text: `Ran ${command}${remembered} — exit code ${String(result.exitCode)}` };
  }
  if (toolId === 'check_problems') {
    if (result.status === 'rejected') return { ok: false, text: `You rejected running \`${clip(String(result.command ?? ''), 60)}\`` };
    return { ok: result.exitCode === 0, text: `Checked for problems with \`${clip(String(result.command ?? ''), 60)}\` — ${String(result.summary ?? '')}` };
  }
  if (toolId.startsWith('mcp_')) {
    const what = `${String(result.tool ?? toolId)} on ${String(result.server ?? 'MCP')}`;
    if (result.status === 'rejected') return { ok: false, text: `You rejected ${what}` };
    return { ok: result.status === 'done', text: `Used ${what} (MCP)${result.status === 'error' ? ' — it reported an error' : ''}` };
  }
  if (toolId === 'git_commit') {
    if (result.status === 'rejected') return { ok: false, text: 'You rejected the commit' };
    return result.status === 'committed'
      ? { ok: true, text: `Committed ${clip(String(result.commit ?? ''), 90)}` }
      : { ok: false, text: `Commit failed — exit code ${String(result.exitCode)}` };
  }
  if (toolId === 'open_application') {
    const name = `${String(result.application)}${result.path ? ` (${shortPath(result.path)})` : ''}`;
    return result.status === 'opened'
      ? { ok: true, text: `Opened ${name}${result.approval === 'remembered' ? ' (always-allowed)' : ''}` }
      : { ok: false, text: `You rejected opening ${name}` };
  }
  if (toolId === 'open_url') {
    const url = clip(String(result.url), 90);
    return result.status === 'opened'
      ? { ok: true, text: `Opened ${url}${result.browser ? ` in ${String(result.browser)}` : ''}${result.approval === 'remembered' ? ' (always-allowed)' : ''}` }
      : { ok: false, text: `You rejected opening ${url}` };
  }
  if (toolId === 'control_application') {
    const what = `${String(result.action ?? args.action)} ${String(result.application ?? args.application)}`;
    return result.status === 'done'
      ? { ok: true, text: `Did ${what}${result.approval === 'remembered' ? ' (always-allowed)' : ''}` }
      : { ok: false, text: `You rejected: ${what}` };
  }
  if (toolId === 'fetch_url') {
    const url = clip(String(result.url ?? args.url), 90);
    return result.status === 'fetched'
      ? { ok: true, text: `Read ${url}` }
      : { ok: false, text: `You rejected reading ${url}` };
  }
  if (toolId === 'web_search') {
    const query = `“${clip(String(result.query ?? args.query), 60)}”`;
    return result.status === 'searched'
      ? { ok: true, text: `Searched the web for ${query}` }
      : { ok: false, text: `You rejected searching for ${query}` };
  }
  if (toolId === 'news_headlines') {
    return result.status === 'fetched'
      ? { ok: true, text: `Read the news${args.topic ? ` about “${clip(String(args.topic), 40)}”` : ''} (Google News)` }
      : { ok: false, text: 'You rejected reading the news' };
  }
  if (toolId === 'browser') {
    if (result.status !== 'done') return { ok: false, text: `You rejected using Chrome (${String(args.action ?? '')})` };
    const where = clip(String(result.title || result.url || ''), 70);
    const verb = args.action === 'search' ? `Searched Google for “${clip(String(args.query ?? ''), 40)}”` : args.action === 'open' ? 'Opened' : args.action === 'click' ? 'Clicked to' : args.action === 'scroll' ? 'Scrolled' : args.action === 'back' ? 'Went back to' : 'Read';
    return { ok: true, text: `${verb} ${where} in Chrome` };
  }
  return undefined;
}

const INVALID_CALL_CODES = new Set(['invalid-input', 'input-too-large', 'unknown-tool', 'policy-denied']);

const MUTATING_TOOLS = new Set([
  'edit_file', 'multi_edit', 'git_commit', 'check_problems', 'write_file', 'create_directory', 'delete_path', 'run_command', 'open_application', 'open_url',
  'fetch_url', 'web_search', 'control_application', 'news_headlines',
  // Scrolling or reading again is a real step, not a repeated mistake.
  'browser',
]);

const CONTINUE_NUDGE =
  'Continue the task now: call the tool for the step you just described. If the task is already complete, give your final answer instead.';

const APPLY_CHANGE_NUDGE =
  'You described a code change but did not apply it. Do not ask the user to paste code: make the change yourself with edit_file (the user reviews it before it is written), then verify it. If you have not reproduced the problem yet, do that first.';

/** Tools that change files; withheld when the user asked for no changes. */
const FILE_CHANGE_TOOLS = new Set(['edit_file', 'multi_edit', 'write_file', 'create_directory', 'delete_path', 'git_commit']);

/**
 * "don't change anything", "just tell me", "kuch mat badlo", "sirf batao":
 * the user wants an answer, not edits. Such a request gets no file-changing
 * tools at all, so a model that ignores the instruction still cannot edit.
 */
export function forbidsChanges(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(?:don'?t|do not|dont|never|without)\s+(?:change|changing|edit|editing|modify|modifying|touch|touching|fix|fixing|write|writing)\b/u.test(text) ||
    /\b(?:no|without)\s+(?:changes|edits)\b|\bread[- ]only\b|\bjust\s+(?:tell|explain|show)\b/u.test(text) ||
    /\bmat\s+(?:badlo|badalna|chhedo|chhuo|chhuna|chhona|karo\s+change|change\s+karo|edit\s+karo|fix\s+karo)\b|\b(?:change|edit|fix)\s+mat\s+karo\b|\b(?:sirf|bas|bus)\s+batao\b/u.test(text);
}

/** Tools that read the web in the background. */
const WEB_TOOLS = new Set(['web_search', 'fetch_url', 'news_headlines', 'browser', 'weather', 'currency_convert', 'software_version']);

const PLAN_MODE_NOTE =
  '(Plan mode: do not change, run, or open anything yet. Investigate with read-only tools as much as needed, then reply with a short numbered plan: each step names the file or command and what will change and why, followed by risks or questions. Then stop; the user will say go ahead.)';

/** Tools with side effects, refused in plan mode (they stay in the tool list so the cached prompt matches). */
const PLAN_MODE_BLOCKED = new Set([
  'edit_file', 'multi_edit', 'write_file', 'create_directory', 'delete_path', 'git_commit', 'run_command',
  'check_problems', 'open_application', 'open_url', 'control_application', 'browser', 'remember',
]);

const LOOK_IT_UP_NUDGE =
  'This question needs current information, and your own knowledge is out of date. Do not answer from memory: look it up now with the right tool (software_version for the latest version of a library or tool, weather, currency_convert, current_time, news_headlines, or web_search then fetch_url), then answer from what it returns, in the language of the user\'s message.';

const DO_NOT_ASK_NUDGE =
  'Do not ask the user whether to fetch, read, or search: they already asked for the answer. Do it now (fetch_url the most relevant result, or search again with better words), then answer with the facts and the source link.';

/** Questions whose answer changes over time: never answer them from the model's memory. */
export function asksForCurrentInfo(prompt: string): boolean {
  return /\b(?:latest|newest|recent(?:ly)?|today|tonight|right now|this (?:week|month|year)|current (?:version|price|rate|news|time|weather|score)|price|prices|(?:exchange|interest|gold|silver|petrol|diesel|dollar|share|stock) rates?|version|(?:live|match|cricket) score|weather|forecast|news|aaj|abhi ka|kal ka|mausam|daam|bhav|keemat)\b/iu.test(prompt);
}

/** "Would you like me to fetch/read/check…?" after the user already asked for the answer. */
export function offersToLookItUp(text: string): boolean {
  const tail = text.trim().split(/\n+/u).slice(-3).join(' ');
  if (/chrome|browser/iu.test(tail)) return false; // Offering the visible browser is intended; it needs the user's go-ahead.
  return /\b(?:would you like me to|do you want me to|shall i|should i|i can (?:also )?(?:attempt to |try to )?|if you(?:'d| would)? like,? i can|let me know if you(?:'d| would)? like me to)\s*(?:fetch|read|check|look|search|get|find|open the (?:article|page|link))/iu.test(tail)
    || /\b(?:kya main|main aapke liye)\b.{0,40}\b(?:fetch|padh|check|search|dhoondh)/iu.test(tail);
}

const USE_THE_WEB_NUDGE =
  'You do have web access without the browser: call web_search (or news_headlines for news, fetch_url for a known page) now, then answer the user\'s question from what you find. Do not repeat earlier errors. Reply in the language of the user\'s message.';

/**
 * True when a reply says it cannot reach the internet or current data
 * ("I'm not able to access real-time data", "internet access nahi hai").
 */
export function claimsNoWebAccess(text: string): boolean {
  return /\b(?:not able to|unable to|can(?:'|’)?t|cannot|don(?:'|’)?t have|do not have|no)\s+(?:directly\s+)?(?:access|browse|search|check|look up|retrieve|get|see|view|read)[^.?!]{0,60}\b(?:real[- ]time|internet|web|online|youtube|current|latest|live|browser|tabs?|chrome|screen)\b/iu.test(text) ||
    /\breal[- ]time (?:data|information)\b[^.?!]{0,40}\b(?:not|unable|can(?:'|’)?t|cannot)\b/iu.test(text) ||
    /\b(?:internet|real[- ]time|live data)\b[^.?!]{0,40}\b(?:access nahi|nahi hai|nahi kar sakta|nahi kar sakti|nahi dekh sakta|nahi dekh sakti)\b/iu.test(text) ||
    // Repeating an earlier browser error instead of searching another way.
    /Allow JavaScript from Apple Events|JavaScript (?:ko )?enable|enable JavaScript/iu.test(text);
}

/** Tools that open or drive the user's browser; offered only when the user asks for that. */
const BROWSER_TOOLS = new Set(['browser', 'open_url']);

/**
 * Whether the user asked to use, open, show, or act in the browser ("Chrome
 * mein dekho", "YouTube kholo", "jo khula hai padho", "scroll karo"). A plain
 * question ("trending song kya hai?") is answered in the background instead,
 * without touching the user's browser.
 */
export function asksForBrowser(prompt: string): boolean {
  const text = prompt.toLowerCase();
  return /\b(?:chrome|browser|safari|tab|tabs|website|site)\b/u.test(text) ||
    /\b(?:open|show me|show|visit|go to|navigate|play|scroll|click)\b/u.test(text) ||
    /\b(?:kholo|khol do|kholiye|kholna|dikhao|dikha do|dikhaiye|chalao|chala do|bajao|baja do|scroll|click|khula|khuli|khule)\b/u.test(text) ||
    /(?:खोलो|खोल दो|दिखाओ|चलाओ|बजाओ|खुला|खुली)/u.test(text);
}

/** Whether the request asks for code to be changed (English or Hinglish). */
export function asksForCodeChange(prompt: string): boolean {
  return /\b(?:fix|bug|implement|change|update|add|refactor|rename|remove|replace|edit|modify|write|create|make)\b|\b(?:karo|kar do|kardo|banao|bana do|likho|likh do|sudhaaro|sudharo|hatao|badlo|badal do|thik karo|theek karo)\b/iu.test(prompt);
}

const UNFINISHED_PLAN_NUDGE =
  'Your reply is a checklist with steps still open. Do not stop at the plan: carry out the next open step now with tools, then keep going until every step is done, and only then give your final answer.';

/**
 * True when a final answer is mostly a checklist with open steps ("- [ ] Fix
 * cartTotal") rather than a report of finished work.
 */
export function isUnfinishedPlan(text: string): boolean {
  const lines = text.trim().split(/\n+/u).filter(line => line.trim() !== '');
  const open = lines.filter(line => /^\s*(?:[-*]\s*)?\[\s*(?:>\s*)?\]/u.test(line)).length;
  return open >= 2 && open >= lines.length / 2;
}

/** True when a final answer only announces a next step ("Let me search…") instead of finishing. */
export function announcesNextStep(text: string): boolean {
  const tail = text.trim().split(/\n+/u).slice(-2).join(' ');
  // Offers to the user ("Let me know if…", "if you want I can…") are genuine endings.
  if (/\blet me know\b|\bif you (?:want|like|need|'d like)\b|\bshould i\b|\?\s*$/iu.test(tail)) return false;
  const intent = /\b(?:let me|let's|i'll|i will|i am going to|i'm going to|next,? i|now i(?:'ll| will)?)\b.{0,160}\b(?:search|check|look|read|open|run|try|find|inspect|examine|edit|fix|update|list|explore|verify|test|add|create|write|implement|change|modify|rename|refactor|apply|make|remove|install|build)\b/iu;
  const hinglishIntent = /\b(?:main|mai|ab main|ab mai)\b.{0,80}\b(?:dekhta|check karta|search karta|dhundhta|dhoondhta|padhta|chalata|karta|fix karta) (?:hoon|hu|hun|hu)\b/iu;
  return intent.test(tail) || hinglishIntent.test(tail);
}

/**
 * Remove footers that only the app may write ("Verified actions", the
 * chat-only notice). Models imitate them from history, which could fake
 * evidence of work, so they are stripped from model output and from history.
 */
export function stripAppFooters(text: string): string {
  const markers = [/\n*\s*(?:-{3,}\s*\n+\s*)?\**Verified actions\**[\s\S]*$/iu, /\n*\s*(?:-{3,}\s*\n+\s*)?⚠️\s*\**Chat-only model:[\s\S]*$/u];
  let result = text;
  for (const marker of markers) result = result.replace(marker, '');
  return result.trimEnd();
}

function actionsFooter(actions: readonly VerifiedAction[]): string {
  if (actions.length === 0) return '';
  return `\n\n---\n**Verified actions**\n${actions.map(action => `- ${action.ok ? '✅' : '⛔'} ${action.text}`).join('\n')}`;
}

function safeErrorCode(error: unknown, fallback = 'internal-error'): string {
  if (error instanceof AgentError || error instanceof ToolExecutionError || error instanceof ProviderError) {
    return error.code;
  }
  if (error instanceof OperationStoppedError) return error.reason;
  return fallback;
}

function parseProviderResponse(value: unknown, maxTextChars: number): ProviderResponse {
  if (!isRecord(value)) {
    throw new AgentError('The model returned an invalid response.', 'invalid-provider-response');
  }
  if (value.kind === 'final' && typeof value.text === 'string') {
    return { kind: 'final', text: value.text.slice(0, maxTextChars) };
  }
  if (value.kind === 'tool-calls' && Array.isArray(value.calls) && value.calls.length > 0) {
    const calls = value.calls.slice(0, 10).map(call => {
      if (
        !isRecord(call) ||
        typeof call.toolId !== 'string' ||
        !TOOL_ID_PATTERN.test(call.toolId) ||
        !isRecord(call.arguments)
      ) {
        throw new AgentError('The model returned an invalid tool call.', 'invalid-provider-response');
      }
      return { toolId: call.toolId, arguments: structuredClone(call.arguments) };
    });
    return {
      kind: 'tool-calls',
      content: typeof value.content === 'string' ? value.content.slice(0, maxTextChars) : '',
      calls,
    };
  }
  throw new AgentError('The model returned an invalid response.', 'invalid-provider-response');
}

/** Ask the provider whether the model can use tools, bounded so a stuck service cannot hang the request. */
async function checkToolSupport(provider: ModelProvider, config: AppConfig, signal: AbortSignal): Promise<boolean> {
  if (!provider.supportsTools) return true;
  try {
    return await runBounded(() => provider.supportsTools?.() ?? Promise.resolve(true), Math.min(10_000, config.requestTimeoutMs), signal);
  } catch (error) {
    if (error instanceof OperationStoppedError && error.reason === 'cancelled') {
      throw new AgentError('Operation cancelled.', 'cancelled');
    }
    return true;
  }
}

export async function runAgent(
  prompt: string,
  signal: AbortSignal,
  options: AgentOptions,
): Promise<string> {
  const task = new TaskRun(options.logger);
  try {
    const response = await runAgentTask(prompt, signal, options, task);
    if (task.state !== 'needs_attention') task.transition('completed');
    return response;
  } catch (error) {
    task.fail(safeErrorCode(error));
    throw error;
  }
}

/** Tools the explore helper may use: looking only. */
export const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
  'list_directory', 'directory_tree', 'find_files', 'search_text', 'read_file', 'git_info', 'current_time',
]);

const EXPLORE_BRIEF = 'You are a read-only research helper for another assistant. Answer the task below by searching and reading files yourself (find_files, search_text, read_file, directory_tree, git_info). Do not change anything. Finish with a compact report: the answer, then the key places as `path:line` with one line each on what is there. No greetings.';

/**
 * Run a read-only helper on a self-contained question, in its own context,
 * and return its report. Used by the explore tool so broad searches do not
 * fill the main conversation.
 */
export async function runExplorer(
  task: string,
  signal: AbortSignal,
  options: Pick<AgentOptions, 'provider' | 'tools' | 'config' | 'logger' | 'persona' | 'environment' | 'onToolActivity'>,
): Promise<string> {
  const config = { ...options.config, maxAgentIterations: Math.min(options.config.maxAgentIterations, 16), maxToolCalls: Math.min(options.config.maxToolCalls, 30) };
  const report = await runAgent(`${EXPLORE_BRIEF}\n\nTask: ${task}`, signal, {
    provider: options.provider,
    tools: options.tools,
    config,
    session: new Session(),
    logger: options.logger,
    allowedTools: EXPLORE_TOOLS,
    ...(options.persona ? { persona: options.persona } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.onToolActivity ? { onToolActivity: activity => options.onToolActivity?.({ ...activity, label: `Explorer: ${activity.label}` }) } : {}),
  });
  return stripAppFooters(report).slice(0, 8_000);
}

/** Summaries of early turns, per session and cut point, so later requests in the app reuse them. */
const summaryCache = new Map<string, string>();

const SUMMARY_REQUEST = 'Before continuing, summarise the conversation below for yourself, because its full text will no longer fit. Write at most 15 short bullet points in English: what the user asked for, decisions and preferences, the projects, files, and commands involved, what was changed or found, and anything still open. Do not call tools. Reply with the bullet points only.';

async function summarizeEarlierTurns(
  session: Session,
  budgetChars: number,
  system: string,
  tools: readonly ModelToolDefinition[],
  provider: ModelProvider,
  config: AppConfig,
  signal: AbortSignal,
): Promise<{ readonly cut: number; readonly message: SessionMessage } | undefined> {
  const messages = session.messages();
  const cut = summaryCut(messages, budgetChars);
  if (cut === 0) return undefined;
  const key = `${session.id}:${cut}`;
  let text = summaryCache.get(key);
  if (text === undefined) {
    try {
      // Same system prompt and tools as the real request, so Ollama's cached prefix stays valid.
      const raw = await runBounded(
        providerSignal => provider.complete(
          [{ role: 'user', content: `${SUMMARY_REQUEST}\n\n${transcriptForSummary(messages.slice(0, cut))}` }],
          providerSignal,
          tools,
          undefined,
          system,
        ),
        Math.min(config.requestTimeoutMs, 120_000),
        signal,
      );
      const response = parseProviderResponse(raw, config.maxResponseChars);
      text = response.kind === 'final' ? response.text.trim().slice(0, 4_000) : '';
    } catch (error) {
      if (error instanceof OperationStoppedError && error.reason === 'cancelled') throw new AgentError('Operation cancelled.', 'cancelled');
      text = '';
    }
    if (text) {
      summaryCache.set(key, text);
      if (summaryCache.size > 50) summaryCache.delete(summaryCache.keys().next().value as string);
    }
  }
  if (!text) return undefined;
  return {
    cut,
    message: { role: 'user', content: `[Summary of the earlier part of this conversation, written by you because the full text no longer fits]\n${text}` },
  };
}

/** The system prompt and tools a request gets. primeAgent must build exactly the same for a new chat. */
async function prepareTurn(
  prompt: string,
  signal: AbortSignal,
  options: Pick<AgentOptions, 'provider' | 'tools' | 'config' | 'session' | 'persona' | 'memory' | 'environment'>,
): Promise<{ readonly toolCapable: boolean; readonly modelTools: readonly ModelToolDefinition[]; readonly system: string }> {
  // Models without tool support still chat; they are told what they cannot do.
  const toolCapable = await checkToolSupport(options.provider, options.config, signal);
  const readOnlyRequest = forbidsChanges(prompt);
  const browserAllowed = asksForBrowser(prompt);
  const modelTools = (toolCapable ? options.tools.modelTools() : [])
    .filter(tool => !readOnlyRequest || !FILE_CHANGE_TOOLS.has(tool.id))
    // The user's browser is touched only when they ask for it.
    .filter(tool => browserAllowed || !BROWSER_TOOLS.has(tool.id));
  const detected = options.environment ?? detectEnvironment(options.session.messages());
  const memories = options.memory?.relevant(detected.activeProject) ?? [];
  const environment = memories.length > 0
    ? { ...detected, memories: memories.map(entry => ({ text: entry.text, ...(entry.project ? { project: entry.project } : {}) })) }
    : detected;
  const system = buildSystemPrompt(environment, modelTools, {
    chatOnly: !toolCapable,
    ...(options.persona ? { persona: options.persona } : {}),
  });
  return { toolCapable, modelTools, system };
}

/**
 * Have the model read the system prompt and tool list of a new chat ahead of
 * time. That part is ~4,000 tokens and takes ~25 s on a 14B model; Ollama
 * keeps what it read, so the user's first message then starts at once.
 */
export async function primeAgent(
  signal: AbortSignal,
  options: Pick<AgentOptions, 'provider' | 'tools' | 'config' | 'session' | 'persona' | 'memory' | 'environment'>,
): Promise<void> {
  if (!options.provider.prime) return;
  const { modelTools, system } = await prepareTurn('', signal, options);
  await options.provider.prime(system, modelTools, signal);
}

async function runAgentTask(
  prompt: string,
  signal: AbortSignal,
  options: AgentOptions,
  task: TaskRun,
): Promise<string> {
  const { config, session, logger, tools } = options;
  if (!prompt.trim() || prompt.length > config.maxInputChars) {
    throw new AgentError('Request is empty or exceeds the configured input limit.', 'invalid-request');
  }
  if (signal.aborted) throw new AgentError('Operation cancelled.', 'cancelled');
  session.add({ role: 'user', content: prompt });
  const start = Date.now();
  task.transition('planning');

  const { toolCapable, modelTools, system } = await prepareTurn(prompt, signal, options);
  const readOnlyRequest = forbidsChanges(prompt);
  const browserAllowed = asksForBrowser(prompt);
  const fixedChars = system.length + JSON.stringify(modelTools).length;
  const budgetChars = Math.max(
    8_000,
    (config.ollamaNumCtx - 4_096) * CHARS_PER_TOKEN - fixedChars,
  );

  const actions: VerifiedAction[] = [];
  const callCounts = new Map<string, number>();
  let toolCalls = 0;
  let malformedRetries = 0;
  let continuationNudges = 0;
  let pendingNudge: string | undefined;
  let attemptedEdit = false;
  let usedWebTool = false;
  const links = new LinkAliases();
  const images = options.images ?? [];
  // A long conversation keeps its early turns as a summary instead of losing them.
  const summary = await summarizeEarlierTurns(session, budgetChars, system, modelTools, options.provider, config, signal);
  const canEdit = modelTools.some(tool => tool.id === 'edit_file' || tool.id === 'write_file');
  let streamedSomething = false;
  const onText = options.onText;

  const finish = (text: string, iterations: number, needsAttention = false): string => {
    // Small models often ignore the system prompt and pretend to have read files;
    // the app states the limitation itself instead of trusting the model.
    const chatOnlyNote = toolCapable
      ? ''
      : '\n\n---\n⚠️ **Chat-only model:** it cannot read your files, run commands, open apps, or read web pages in Vyomara. Anything it says about your files or projects is not based on them. Choose a model marked “Tools” in the Models panel for that.';
    // Links must come from a tool result or the user; invented or garbled ones are removed.
    const sources = urlsIn(session.messages().filter(message => message.role === 'tool' || message.role === 'user').map(message => message.content));
    const checked = verifyLinks(links.expand(stripAppFooters(text)).trim(), sources).text;
    const response = `${checked || 'Done.'}${actionsFooter(actions)}${chatOnlyNote}`;
    session.add({ role: 'assistant', content: response });
    if (needsAttention) task.needsAttention();
    logger.emit({
      event: 'request.completed',
      taskId: task.taskId,
      runId: task.runId,
      durationMs: Date.now() - start,
      iterations,
    });
    return response;
  };

  if (images.length > 0 && options.provider.supportsVision && !await options.provider.supportsVision().catch(() => true)) {
    return finish('The selected model cannot see pictures. Choose a model marked **Vision** in the Models panel (for example `qwen2.5vl:7b` or `gemma3:12b`), then send the picture again.', 0, true);
  }

  for (let iteration = 1; iteration <= config.maxAgentIterations; iteration += 1) {
    if (signal.aborted) throw new AgentError('Operation cancelled.', 'cancelled');
    const visible = summary ? [summary.message, ...session.messages().slice(summary.cut)] : session.messages();
    const fitted = fitMessagesToBudget(visible, budgetChars).map(message =>
      message.role === 'assistant' && message.kind !== 'tool-call'
        ? { ...message, content: links.shorten(stripAppFooters(message.content)) }
        // The model sees long URLs as short aliases it can copy without mistakes.
        : message.role === 'tool' ? { ...message, content: links.shorten(message.content) } : message);
    // A spoken request carries its note in the message, keeping the system prompt cacheable.
    // Notes and pictures travel with this request's message, keeping the system prompt cacheable.
    const notes = [
      ...(options.voice ? [spokenRequestNote(options.persona)] : []),
      ...(options.planOnly ? [PLAN_MODE_NOTE] : []),
    ];
    let promptIndex = -1;
    if (notes.length > 0 || images.length > 0) {
      for (let index = fitted.length - 1; index >= 0; index -= 1) {
        const message = fitted[index];
        if (message?.role === 'user' && message.content === prompt) { promptIndex = index; break; }
      }
    }
    const withNote = promptIndex < 0
      ? fitted
      : fitted.map((message, index) => index === promptIndex
        ? { role: 'user' as const, content: [message.content, ...notes].join('\n\n'), ...(images.length > 0 ? { images } : {}) }
        : message);
    const messages = pendingNudge
      ? [...withNote, { role: 'user' as const, content: pendingNudge }]
      : withNote;
    pendingNudge = undefined;
    const toolsForTurn = toolCalls < config.maxToolCalls ? modelTools : [];
    let firstChunk = true;
    const iterationText = onText === undefined
      ? undefined
      : (text: string): void => {
        if (firstChunk && streamedSomething) onText('\n\n');
        firstChunk = false;
        streamedSomething = true;
        onText(links.expand(text));
      };

    let raw: unknown;
    try {
      raw = await runBounded(
        providerSignal => options.provider.complete(messages, providerSignal, toolsForTurn, iterationText, system),
        config.requestTimeoutMs,
        signal,
      );
    } catch (error) {
      if (error instanceof OperationStoppedError) {
        if (error.reason === 'cancelled') throw new AgentError('Operation cancelled.', 'cancelled');
        if (actions.length > 0 || toolCalls > 0) {
          return finish('The model took too long to respond, so I stopped here. The work done so far is listed below.', iteration, true);
        }
        throw new AgentError('The model took too long to respond. Try again, or choose a smaller/faster model.', 'timeout');
      }
      if (error instanceof ProviderError && error.code === 'malformed-response' && malformedRetries < 2) {
        malformedRetries += 1;
        continue;
      }
      throw error;
    }

    let response: ProviderResponse;
    try {
      response = parseProviderResponse(raw, config.maxResponseChars);
    } catch (error) {
      if (malformedRetries < 2) {
        malformedRetries += 1;
        continue;
      }
      throw error;
    }

    if (response.kind === 'final') {
      // Local models sometimes describe their next step and stop. Nudge them
      // (at most twice) to actually continue instead of ending the task early.
      // A plan is the expected answer in plan mode: no "keep going" nudges.
      const canNudge = !options.planOnly && continuationNudges < 2 &&
        iteration < config.maxAgentIterations &&
        toolCalls < config.maxToolCalls;
      const unappliedChange = canEdit &&
        !attemptedEdit &&
        asksForCodeChange(prompt) &&
        /```[\s\S]*\n[\s\S]*```/u.test(response.text);
      const unfinishedPlan = isUnfinishedPlan(response.text);
      // "I can't access real-time data" while web tools exist and none was tried.
      const hasWebTools = modelTools.some(tool => WEB_TOOLS.has(tool.id));
      const gaveUpOnWeb = !usedWebTool && hasWebTools && claimsNoWebAccess(response.text);
      // "Latest React Native version?" answered without a single tool call: from stale memory.
      const answeredFromMemory = toolCalls === 0 && hasWebTools && asksForCurrentInfo(prompt);
      const askedToLookItUp = hasWebTools && offersToLookItUp(response.text);
      if (canNudge && (unappliedChange || unfinishedPlan || gaveUpOnWeb || answeredFromMemory || askedToLookItUp || announcesNextStep(response.text))) {
        continuationNudges += 1;
        session.add({ role: 'assistant', content: response.text });
        pendingNudge = unappliedChange ? APPLY_CHANGE_NUDGE
          : unfinishedPlan ? UNFINISHED_PLAN_NUDGE
          : gaveUpOnWeb ? USE_THE_WEB_NUDGE
          : answeredFromMemory ? LOOK_IT_UP_NUDGE
          : askedToLookItUp ? DO_NOT_ASK_NUDGE
          : CONTINUE_NUDGE;
        continue;
      }
      return finish(response.text, iteration);
    }

    if (toolCalls >= config.maxToolCalls) {
      return finish(`${response.content ?? ''}\n\nI reached the limit of ${config.maxToolCalls} tool calls for one request and stopped. Ask me to continue if needed.`, iteration, true);
    }

    // Real URLs back in the arguments, so tools and history never see aliases.
    const calls = response.calls.slice(0, Math.max(1, config.maxToolCalls - toolCalls))
      .map(call => ({ ...call, arguments: links.expandArguments(call.arguments) }));
    session.add({
      role: 'assistant',
      kind: 'tool-call',
      content: response.content ?? '',
      toolCalls: calls.map(call => ({ toolId: call.toolId, arguments: call.arguments })),
    });
    if (task.state === 'planning') task.transition('running');

    for (const call of calls) {
      if (signal.aborted) throw new AgentError('Operation cancelled.', 'cancelled');
      toolCalls += 1;
      const toolCallId = randomUUID();
      const signature = `${call.toolId}:${JSON.stringify(call.arguments)}`;
      const attempt = (callCounts.get(signature) ?? 0) + 1;
      callCounts.set(signature, attempt);
      const context = task.context(toolCallId, attempt);
      const label = describeToolCall(call.toolId, call.arguments);
      logger.emit({
        event: 'tool.requested',
        ...context,
        toolId: call.toolId,
        argumentKeys: Object.keys(call.arguments).sort(),
      });

      if (attempt > 2 && !MUTATING_TOOLS.has(call.toolId) && !call.toolId.startsWith('mcp_')) {
        session.add({
          role: 'tool',
          toolId: call.toolId,
          content: JSON.stringify({
            ok: false,
            error: 'You already made this exact call. Use the earlier result above, or try a different approach.',
          }),
        });
        continue;
      }

      if (options.allowedTools && !options.allowedTools.has(call.toolId)) {
        session.add({
          role: 'tool',
          toolId: call.toolId,
          content: JSON.stringify({ ok: false, error: `You are a read-only helper: ${call.toolId} is not available to you. Use only ${[...options.allowedTools].join(', ')}, then report what you found.` }),
        });
        continue;
      }

      if (options.planOnly && PLAN_MODE_BLOCKED.has(call.toolId)) {
        session.add({
          role: 'tool',
          toolId: call.toolId,
          content: JSON.stringify({ ok: false, error: 'Plan mode: nothing may be changed, run, or opened yet. Finish investigating with read-only tools, then reply with the plan and wait for the user to say go ahead.' }),
        });
        continue;
      }

      if (!browserAllowed && BROWSER_TOOLS.has(call.toolId)) {
        session.add({
          role: 'tool',
          toolId: call.toolId,
          content: JSON.stringify({ ok: false, error: 'The user did not ask to open or use the browser. Find the answer with web_search, fetch_url, or news_headlines and reply in the chat; if that is not enough, say so and offer to look in Chrome.' }),
        });
        continue;
      }

      if (readOnlyRequest && FILE_CHANGE_TOOLS.has(call.toolId)) {
        session.add({
          role: 'tool',
          toolId: call.toolId,
          content: JSON.stringify({ ok: false, error: 'The user asked not to change anything in this request. Answer in words; describe the fix instead of making it.' }),
        });
        continue;
      }

      if (call.toolId === 'edit_file' || call.toolId === 'multi_edit' || call.toolId === 'write_file') attemptedEdit = true;
      if (WEB_TOOLS.has(call.toolId)) usedWebTool = true;
      options.onToolActivity?.({ id: toolCallId, toolId: call.toolId, label, status: 'running' });
      logger.emit({ event: 'tool.invoked', ...context, toolId: call.toolId });
      try {
        const result = await tools.execute(call.toolId, call.arguments, signal, context);
        if (call.toolId === 'update_plan' && isRecord(result) && Array.isArray(result.steps)) {
          options.onPlan?.(result.steps as PlanStep[]);
        }
        const action = verifiedAction(call.toolId, call.arguments, result);
        if (action) actions.push(action);
        const rejected = isRecord(result) && result.status === 'rejected';
        const content = JSON.stringify(rejected
          ? { ...result, note: 'The user declined this action. Do not retry it unchanged; adapt or ask the user.' }
          : result);
        session.add({ role: 'tool', toolId: call.toolId, content });
        options.onToolActivity?.({
          id: toolCallId,
          toolId: call.toolId,
          label,
          status: rejected ? 'rejected' : action && !action.ok ? 'failed' : 'done',
          ...(action ? { detail: action.text } : {}),
        });
      } catch (error) {
        if (signal.aborted || (error instanceof ToolExecutionError && error.code === 'cancelled')) {
          throw new AgentError('Operation cancelled.', 'cancelled');
        }
        const code = safeErrorCode(error, 'tool-failed');
        const message = error instanceof ToolExecutionError
          ? error.message
          : 'The tool failed unexpectedly; nothing is confirmed.';
        logger.emit({ event: 'tool.failed', ...context, toolId: call.toolId, code });
        // Invalid calls never reached the world, so they are not "actions"; the
        // model still sees the error and can correct the call.
        if (MUTATING_TOOLS.has(call.toolId) && !INVALID_CALL_CODES.has(code)) {
          actions.push({ ok: false, text: `${label} failed: ${clip(message, 140)}` });
        }
        session.add({
          role: 'tool',
          toolId: call.toolId,
          content: JSON.stringify({ ok: false, error: { code, message } }),
        });
        options.onToolActivity?.({ id: toolCallId, toolId: call.toolId, label, status: 'failed', detail: clip(message, 160) });
      }
    }
    if (task.state === 'running') task.transition('planning');
  }

  return finish(
    `I used all ${config.maxAgentIterations} steps allowed for one request before finishing. Ask me to continue and I will pick up from here.`,
    config.maxAgentIterations,
    true,
  );
}
