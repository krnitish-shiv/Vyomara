import { decodeXmlText, parseFeed } from '../shared/rss.ts';
import { isAbsolute } from 'node:path';
import type { AppConfig } from '../config/config.ts';
import { ToolFailure, type Tool, type ToolRegistry } from './contracts.ts';
import { resolveSafeFilesystemPath } from './filesystem-tools.ts';

/** An action that changes something outside Vyomara and therefore needs the user's approval. */
export type ActionProposal =
  | {
    readonly kind: 'command';
    readonly command: string;
    readonly cwd: string;
    readonly timeoutSeconds: number;
  }
  | { readonly kind: 'application'; readonly application: string; readonly target?: string; readonly line?: number }
  | { readonly kind: 'url'; readonly url: string; readonly application?: string }
  | { readonly kind: 'app-control'; readonly application: string; readonly action: AppControlAction }
  | {
    /** Vyomara itself requests a page or a search; the host receives the URL or query. */
    readonly kind: 'web';
    readonly operation: 'fetch' | 'search';
    readonly target: string;
    readonly host: string;
  };

/**
 * The user's answer: `false` rejects, `true` approves once, and `'always'`
 * approves and remembers this exact command in this folder for the rest of the
 * app session (commands and web hosts only).
 */
export type ApprovalDecision = boolean | 'always';

export interface ActionApprovalPort {
  /** Resolve truthy only when the user explicitly approves this exact action. */
  request(action: ActionProposal, signal: AbortSignal): Promise<ApprovalDecision>;
}

/** A permission the user granted once, kept across restarts until revoked. */
export type StandingGrant =
  | { readonly kind: 'app'; readonly application: string }
  | { readonly kind: 'browser'; readonly browser: string }
  | { readonly kind: 'host'; readonly host: string };

/** The default browser in browser grants. */
export const DEFAULT_BROWSER = 'default browser';

export function grantId(grant: StandingGrant): string {
  switch (grant.kind) {
    case 'app': return `app:${grant.application}`;
    case 'browser': return `browser:${grant.browser}`;
    default: return `host:${grant.host.toLowerCase()}`;
  }
}

export function parseGrantId(id: string): StandingGrant | undefined {
  const separator = id.indexOf(':');
  const kind = id.slice(0, separator);
  const value = id.slice(separator + 1).trim();
  if (separator < 1 || value === '' || value.length > 253) return undefined;
  if (kind === 'app' && APPLICATION_NAME.test(value)) return { kind: 'app', application: value };
  if (kind === 'browser' && (value === DEFAULT_BROWSER || APPLICATION_NAME.test(value))) return { kind: 'browser', browser: value };
  if (kind === 'host' && /^[a-z0-9.-]+$/u.test(value)) return { kind: 'host', host: value };
  return undefined;
}

export interface ApprovalMemoryOptions {
  /** Grant IDs saved earlier (e.g. "app:Visual Studio Code"). */
  readonly grants?: readonly string[];
  /** Called with all grant IDs whenever they change, so the host can save them. */
  readonly onGrantsChanged?: (grants: readonly string[]) => void;
}

/**
 * What the user chose to "always allow":
 * - standing grants (open an app, open pages in a browser, read a web host),
 *   kept across restarts by the host until revoked;
 * - exact commands in exact folders, kept in memory only until the app quits.
 */
export class ApprovalMemory {
  readonly #commands = new Set<string>();
  readonly #grants = new Set<string>();
  readonly #onGrantsChanged: ((grants: readonly string[]) => void) | undefined;

  constructor(options: ApprovalMemoryOptions = {}) {
    for (const id of options.grants ?? []) {
      const grant = parseGrantId(id);
      if (grant) this.#grants.add(grantId(grant));
    }
    this.#onGrantsChanged = options.onGrantsChanged;
  }

  static key(command: string, cwd: string): string {
    return `${cwd}\n${command.trim()}`;
  }

  has(command: string, cwd: string): boolean {
    return this.#commands.has(ApprovalMemory.key(command, cwd));
  }

  allow(command: string, cwd: string): void {
    this.#commands.add(ApprovalMemory.key(command, cwd));
  }

  hasGrant(grant: StandingGrant): boolean {
    return this.#grants.has(grantId(grant));
  }

  grant(grant: StandingGrant): void {
    const id = grantId(grant);
    if (this.#grants.has(id)) return;
    this.#grants.add(id);
    this.#onGrantsChanged?.(this.grants());
  }

  revoke(id: string): boolean {
    const removed = this.#grants.delete(id);
    if (removed) this.#onGrantsChanged?.(this.grants());
    return removed;
  }

  grants(): string[] {
    return [...this.#grants].sort();
  }

  hasHost(host: string): boolean {
    return this.hasGrant({ kind: 'host', host });
  }

  allowHost(host: string): void {
    this.grant({ kind: 'host', host });
  }

  /** Forget session-only command approvals (standing grants stay). */
  clearCommands(): void {
    this.#commands.clear();
  }

  get size(): number {
    return this.#commands.size + this.#grants.size;
  }
}

export interface CommandResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly output: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface CommandRunnerPort {
  run(command: string, cwd: string, timeoutMs: number, signal: AbortSignal): Promise<CommandResult>;
}

/** Window-level control of a running app. */
export type AppControlAction = 'focus' | 'hide' | 'minimize' | 'restore' | 'maximize' | 'fullscreen' | 'quit' | 'scroll-down' | 'scroll-up' | 'read-page';
/** Actions control_application accepts ("read-page" is only asked for by the browser tool). */
export const APP_CONTROL_ACTIONS: readonly AppControlAction[] = ['focus', 'hide', 'minimize', 'restore', 'maximize', 'fullscreen', 'quit', 'scroll-down', 'scroll-up'];

export interface LauncherPort {
  /** Bring forward, hide, minimize all windows of, or quit a running app. */
  controlApplication?(application: string, action: AppControlAction, signal: AbortSignal): Promise<void>;
  /** `line` jumps to that line when the editor supports it (VS Code). */
  openApplication(application: string, target: string | undefined, signal: AbortSignal, line?: number): Promise<void>;
  openUrl(url: string, application: string | undefined, signal: AbortSignal): Promise<void>;
}

export interface ActionToolPorts {
  readonly approval: ActionApprovalPort;
  /** Remembers commands approved with "always allow"; without it every run asks. */
  readonly approvalMemory?: ApprovalMemory;
  readonly commandRunner?: CommandRunnerPort;
  readonly launcher?: LauncherPort;
  /** Enables fetch_url (and web_search when a search backend is configured). */
  readonly web?: WebClientPort;
  /** Enables browser: driving the user's own Chrome (search, open, read, click, scroll). */
  readonly browser?: BrowserPort;
}

export type BrowserAction =
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'open'; readonly url: string }
  | { readonly kind: 'read' }
  | { readonly kind: 'click'; readonly link: number }
  | { readonly kind: 'scroll'; readonly direction: 'down' | 'up' }
  | { readonly kind: 'back' };

/** What the live tab shows after an action. */
export interface BrowserPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly links: readonly { readonly n: number; readonly text: string; readonly url: string }[];
  /** Google result list, when the page is a Google search. */
  readonly results?: readonly { readonly title: string; readonly url: string; readonly snippet: string }[];
  readonly captcha?: boolean;
  readonly scroll?: number;
  readonly height?: number;
  readonly viewport?: number;
}

export interface BrowserPort {
  perform(action: BrowserAction, signal: AbortSignal): Promise<BrowserPage>;
}

interface BrowserInput {
  readonly action: BrowserAction['kind'];
  readonly query?: string;
  readonly url?: string;
  readonly link?: number;
  readonly direction?: 'down' | 'up';
  readonly offset?: number;
}

function browserInputError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  const actions = ['search', 'open', 'read', 'click', 'scroll', 'back'];
  if (typeof value.action !== 'string' || !actions.includes(value.action)) return `action must be one of: ${actions.join(', ')}.`;
  if (Object.keys(value).some(key => !['action', 'query', 'url', 'link', 'direction', 'offset'].includes(key))) return 'Use only action, query, url, link, direction, offset.';
  if (value.action === 'search' && (typeof value.query !== 'string' || value.query.trim() === '' || value.query.length > 400)) return 'search needs query (the search words).';
  if (value.action === 'open') {
    if (typeof value.url !== 'string') return 'open needs url.';
    try {
      const url = new URL(value.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'url must be http(s).';
      if (isPrivateHost(url.hostname)) return 'Local or private network addresses are not allowed.';
    } catch {
      return 'url must be a full http(s) address.';
    }
  }
  if (value.action === 'click' && (!Number.isInteger(value.link) || (value.link as number) < 1 || (value.link as number) > 200)) return 'click needs link: a link number from the last read.';
  if (value.action === 'scroll' && value.direction !== undefined && value.direction !== 'down' && value.direction !== 'up') return 'direction must be "down" or "up".';
  if (value.offset !== undefined && (!Number.isInteger(value.offset) || (value.offset as number) < 0)) return 'offset must be a non-negative integer.';
  return undefined;
}

export interface WebPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly links: readonly { readonly text: string; readonly url: string }[];
}

export interface WebSearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

interface NewsInput {
  readonly topic?: string;
  readonly language?: 'en' | 'hi';
  readonly count?: number;
}

function newsInputError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  if (Object.keys(value).some(key => !['topic', 'language', 'count'].includes(key))) return 'Use only topic, language, and count.';
  if (value.topic !== undefined && (typeof value.topic !== 'string' || value.topic.length > 120)) return 'topic must be short text.';
  if (value.language !== undefined && value.language !== 'en' && value.language !== 'hi') return 'language must be "en" or "hi".';
  if (value.count !== undefined && (!Number.isInteger(value.count) || (value.count as number) < 1 || (value.count as number) > 20)) return 'count must be 1 to 20.';
  return undefined;
}

export interface WebClientPort {
  /** The host that receives search queries, or undefined when search is not configured. */
  readonly searchHost: string | undefined;
  fetchPage(url: string, signal: AbortSignal): Promise<WebPage>;
  search(query: string, signal: AbortSignal): Promise<readonly WebSearchResult[]>;
  /** Raw feed/API text (RSS, JSON) from a public host; enables news and the built-in search. */
  fetchRaw?(url: string, signal: AbortSignal): Promise<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  return unknown.length > 0 ? `Unknown argument(s): ${unknown.join(', ')}. Use only: ${keys.join(', ')}.` : undefined;
}

/** Small models send `null` or `""` for options they mean to omit; treat both as omitted. */
function dropNulls(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) => candidate !== null && candidate !== ''));
}

/** Application names as shown in /Applications, e.g. "Visual Studio Code", "Google Chrome". */
const APPLICATION_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._&+'()-]{0,79}$/u;

const APPLICATION_ALIASES: Readonly<Record<string, string>> = {
  'vs code': 'Visual Studio Code',
  vscode: 'Visual Studio Code',
  code: 'Visual Studio Code',
  'visual studio code': 'Visual Studio Code',
  chrome: 'Google Chrome',
  'google chrome': 'Google Chrome',
  google: 'Google Chrome',
  safari: 'Safari',
  terminal: 'Terminal',
  finder: 'Finder',
  notes: 'Notes',
  calendar: 'Calendar',
  calculator: 'Calculator',
  calc: 'Calculator',
  settings: 'System Settings',
  'system settings': 'System Settings',
  'system preferences': 'System Settings',
  mail: 'Mail',
  music: 'Music',
  slack: 'Slack',
  iterm: 'iTerm',
  iterm2: 'iTerm',
  firefox: 'Firefox',
  cursor: 'Cursor',
};

export function normalizeApplicationName(value: string): string {
  const trimmed = value.trim().replace(/\.app$/iu, '');
  return APPLICATION_ALIASES[trimmed.toLocaleLowerCase()] ?? trimmed;
}

export function validateWebUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'url must be a complete web address such as https://www.google.com/search?q=…';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only http and https web addresses can be opened.';
  if (url.username !== '' || url.password !== '') return 'Web addresses with embedded credentials are not allowed.';
  return undefined;
}

interface CommandInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeout_seconds?: number;
}

interface CommandOutput {
  readonly status: 'completed' | 'rejected';
  readonly command: string;
  readonly cwd: string;
  /** How the run was approved: by the user now, or by an earlier "always allow". */
  readonly approval?: 'user' | 'remembered';
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly output?: string;
  readonly truncated?: boolean;
  readonly durationMs?: number;
}

interface ApplicationInput {
  readonly application: string;
  readonly path?: string;
  readonly line?: number;
}

interface ApplicationOutput {
  readonly status: 'opened' | 'rejected';
  readonly application: string;
  readonly path?: string;
  readonly approval?: 'user' | 'remembered';
}

interface UrlInput {
  readonly url: string;
  readonly browser?: string;
}

interface UrlOutput {
  readonly status: 'opened' | 'rejected';
  readonly url: string;
  readonly browser?: string;
  readonly approval?: 'user' | 'remembered';
}

function commandError(value: unknown, maxTimeoutSeconds: number): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  const keys = onlyKeys(value, ['command', 'cwd', 'timeout_seconds']);
  if (keys) return keys;
  if (typeof value.command !== 'string' || value.command.trim() === '') return 'command must be a non-empty shell command.';
  if (value.command.length > 8_000 || value.command.includes('\0')) return 'command is too long or contains invalid characters.';
  if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) return 'cwd must be the absolute directory to run the command in (usually the project root).';
  if (value.timeout_seconds !== undefined && (
    typeof value.timeout_seconds !== 'number' ||
    !Number.isSafeInteger(value.timeout_seconds) ||
    value.timeout_seconds < 1 ||
    value.timeout_seconds > maxTimeoutSeconds
  )) return `timeout_seconds must be an integer between 1 and ${maxTimeoutSeconds}.`;
  return undefined;
}

function applicationError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  const keys = onlyKeys(value, ['application', 'path', 'line']);
  if (keys) return keys;
  if (typeof value.application !== 'string' || !APPLICATION_NAME.test(normalizeApplicationName(value.application))) {
    return 'application must be a macOS application name such as "Visual Studio Code" or "Google Chrome".';
  }
  if (value.path !== undefined && (typeof value.path !== 'string' || !isAbsolute(value.path) || value.path.split('/').includes('..'))) {
    return 'path must be an absolute file or folder path to open in the application.';
  }
  if (value.line !== undefined && (typeof value.line !== 'number' || !Number.isSafeInteger(value.line) || value.line < 1)) {
    return 'line must be a positive line number.';
  }
  if (value.line !== undefined && value.path === undefined) return 'line needs a file path.';
  return undefined;
}

function controlError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  const keys = onlyKeys(value, ['application', 'action']);
  if (keys) return keys;
  if (typeof value.application !== 'string' || !APPLICATION_NAME.test(normalizeApplicationName(value.application))) {
    return 'application must be a macOS application name such as "Visual Studio Code".';
  }
  if (typeof value.action !== 'string' || !APP_CONTROL_ACTIONS.includes(value.action as AppControlAction)) {
    return `action must be one of: ${APP_CONTROL_ACTIONS.join(', ')}.`;
  }
  return undefined;
}

function urlError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  const keys = onlyKeys(value, ['url', 'browser']);
  if (keys) return keys;
  if (typeof value.url !== 'string' || value.url.length > 4_096) return 'url must be a web address.';
  const invalid = validateWebUrl(value.url);
  if (invalid) return invalid;
  if (value.browser !== undefined && (typeof value.browser !== 'string' || !APPLICATION_NAME.test(normalizeApplicationName(value.browser)))) {
    return 'browser must be an application name such as "Google Chrome" or "Safari".';
  }
  return undefined;
}

export function registerActionTools(
  registry: ToolRegistry,
  config: AppConfig,
  ports: ActionToolPorts,
): void {
  const { approval, commandRunner, approvalMemory, launcher } = ports;
  const maxTimeoutSeconds = Math.floor(config.commandTimeoutMs / 1_000);

  if (commandRunner) {
    const runCommand: Tool<CommandInput, CommandOutput> = {
      id: 'run_command',
      effect: 'shell',
      description: `Run a shell command (zsh) in a directory after the user approves it, e.g. tests, builds, git, package managers. Output (stdout+stderr) and exit code are returned. Commands must not wait for input. Default timeout ${Math.min(120, maxTimeoutSeconds)}s.`,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The exact shell command, e.g. "pnpm test" or "git status".', maxLength: 8_000 },
          cwd: { type: 'string', description: 'Absolute working directory, usually the project root.', maxLength: 4_096 },
          timeout_seconds: { type: 'integer', description: 'Optional timeout in seconds.', minimum: 1, maximum: maxTimeoutSeconds },
        },
        required: ['command', 'cwd'],
        additionalProperties: false,
      },
      normalizeInput: dropNulls,
      validateInput: (value): value is CommandInput => commandError(value, maxTimeoutSeconds) === undefined,
      inputError: value => commandError(value, maxTimeoutSeconds),
      validateOutput: (value): value is CommandOutput =>
        isRecord(value) && (value.status === 'completed' || value.status === 'rejected'),
      async run(input, signal) {
        const cwd = (await resolveSafeFilesystemPath(input.cwd, config, 'directory', signal)).target;
        const timeoutSeconds = input.timeout_seconds ?? Math.min(120, maxTimeoutSeconds);
        const remembered = approvalMemory?.has(input.command, cwd) === true;
        const decision = remembered || await approval.request(
          { kind: 'command', command: input.command, cwd, timeoutSeconds },
          signal,
        );
        if (!decision) return { status: 'rejected', command: input.command, cwd };
        if (decision === 'always') approvalMemory?.allow(input.command, cwd);
        const result = await commandRunner.run(input.command, cwd, timeoutSeconds * 1_000, signal);
        return {
          status: 'completed',
          command: input.command,
          cwd,
          approval: remembered ? 'remembered' : 'user',
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          output: result.output,
          truncated: result.truncated,
          durationMs: result.durationMs,
        };
      },
    };
    registry.register(runCommand);
  }

  if (launcher) {
    const openApplication: Tool<ApplicationInput, ApplicationOutput> = {
      id: 'open_application',
      effect: 'launch',
      description: 'Open a macOS application after the user approves, optionally with a file or folder (and, for VS Code, a line). Examples: {"application":"Visual Studio Code","path":"/Users/me/Projects/app"} opens a project; {"application":"Visual Studio Code","path":"/Users/me/Projects/app/src/cart.js","line":9} opens a file at line 9; {"application":"Google Chrome"}.',
      parameters: {
        type: 'object',
        properties: {
          application: { type: 'string', description: 'Application name, e.g. "Visual Studio Code", "Google Chrome", "Finder", "Notes".', maxLength: 80 },
          path: { type: 'string', description: 'Optional absolute file or folder to open in it.', maxLength: 4_096 },
          line: { type: 'integer', description: 'Optional line number to jump to in a file (VS Code).', minimum: 1 },
        },
        required: ['application'],
        additionalProperties: false,
      },
      normalizeInput: dropNulls,
      validateInput: (value): value is ApplicationInput => applicationError(value) === undefined,
      inputError: applicationError,
      validateOutput: (value): value is ApplicationOutput =>
        isRecord(value) && (value.status === 'opened' || value.status === 'rejected'),
      async run(input, signal) {
        const application = normalizeApplicationName(input.application);
        let target: string | undefined;
        if (input.path !== undefined) {
          try {
            target = (await resolveSafeFilesystemPath(input.path, config, 'directory', signal)).target;
          } catch {
            target = (await resolveSafeFilesystemPath(input.path, config, 'file', signal)).target;
          }
        }
        const line = target === undefined ? undefined : input.line;
        const remembered = approvalMemory?.hasGrant({ kind: 'app', application }) === true;
        const approved = remembered || await approval.request(
          {
            kind: 'application',
            application,
            ...(target === undefined ? {} : { target }),
            ...(line === undefined ? {} : { line }),
          },
          signal,
        );
        if (!approved) return { status: 'rejected', application, ...(target === undefined ? {} : { path: target }) };
        if (approved === 'always') approvalMemory?.grant({ kind: 'app', application });
        await launcher.openApplication(application, target, signal, line);
        return {
          status: 'opened',
          application,
          ...(target === undefined ? {} : { path: target }),
          approval: remembered ? 'remembered' : 'user',
        };
      },
    };
    registry.register(openApplication);

    const controlApplication = launcher.controlApplication?.bind(launcher);
    if (controlApplication) {
      const controlTool: Tool<{ readonly application: string; readonly action: AppControlAction }, Record<string, unknown>> = {
        id: 'control_application',
        effect: 'launch',
        description: 'Control a running macOS app\'s windows: "focus" brings it to the front, "hide" hides it, "minimize" sends its windows to the Dock, "restore" brings minimized windows back, "maximize" fills the screen with its front window, "fullscreen" toggles macOS full screen, "quit" closes the app (it may ask to save). Use this instead of AppleScript in run_command.',
        parameters: {
          type: 'object',
          properties: {
            application: { type: 'string', description: 'Application name, e.g. "Visual Studio Code".', maxLength: 80 },
            action: { type: 'string', description: 'One of: focus, hide, minimize, restore, maximize, fullscreen, quit, scroll-down, scroll-up.', maxLength: 16 },
          },
          required: ['application', 'action'],
          additionalProperties: false,
        },
        normalizeInput: dropNulls,
        validateInput: (value): value is { readonly application: string; readonly action: AppControlAction } => controlError(value) === undefined,
        inputError: controlError,
        validateOutput: (value): value is Record<string, unknown> => isRecord(value) && typeof value.status === 'string',
        async run(input, signal) {
          const application = normalizeApplicationName(input.application);
          const action = input.action;
          // A standing app grant covers harmless window actions; quitting always asks.
          const remembered = action !== 'quit' && approvalMemory?.hasGrant({ kind: 'app', application }) === true;
          const approved = remembered || await approval.request({ kind: 'app-control', application, action }, signal);
          if (!approved) return { status: 'rejected', application, action };
          if (approved === 'always' && action !== 'quit') approvalMemory?.grant({ kind: 'app', application });
          await controlApplication(application, action, signal);
          return { status: 'done', application, action, approval: remembered ? 'remembered' : 'user' };
        },
      };
      registry.register(controlTool);
    }

    const openUrl: Tool<UrlInput, UrlOutput> = {
      id: 'open_url',
      effect: 'network',
      description: 'Show a web page to the USER in their browser (after approval), e.g. "open YouTube", "Chrome mein … search karo". You cannot see the page afterwards. To read a page yourself and answer from it, use fetch_url instead. For a search the user wants to see, use https://www.google.com/search?q=<url-encoded query>. Optional browser, e.g. "Google Chrome" or "Safari".',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) address.', maxLength: 4_096 },
          browser: { type: 'string', description: 'Optional browser application name.', maxLength: 80 },
        },
        required: ['url'],
        additionalProperties: false,
      },
      normalizeInput: dropNulls,
      validateInput: (value): value is UrlInput => urlError(value) === undefined,
      inputError: urlError,
      validateOutput: (value): value is UrlOutput =>
        isRecord(value) && (value.status === 'opened' || value.status === 'rejected'),
      async run(input, signal) {
        const browser = input.browser === undefined ? undefined : normalizeApplicationName(input.browser);
        const url = new URL(input.url).toString();
        const browserGrant = { kind: 'browser', browser: browser ?? DEFAULT_BROWSER } as const;
        const remembered = approvalMemory?.hasGrant(browserGrant) === true;
        const approved = remembered || await approval.request(
          { kind: 'url', url, ...(browser === undefined ? {} : { application: browser }) },
          signal,
        );
        if (!approved) return { status: 'rejected', url, ...(browser === undefined ? {} : { browser }) };
        if (approved === 'always') approvalMemory?.grant(browserGrant);
        await launcher.openUrl(url, browser, signal);
        return { status: 'opened', url, ...(browser === undefined ? {} : { browser }), approval: remembered ? 'remembered' : 'user' };
      },
    };
    registry.register(openUrl);
  }

  const browser = ports.browser;
  if (browser) {
    const windowChars = Math.max(1_000, config.maxToolOutputChars - 5_000);
    const browserGrant = { kind: 'browser', browser: 'Google Chrome' } as const;
    const browserTool: Tool<BrowserInput, Record<string, unknown>> = {
      id: 'browser',
      effect: 'network',
      description: 'Use the user\'s Google Chrome like a person, visibly (after approval): "search" Google and read the results, "open" any site, "read" the page in the front tab (what the user is looking at, including pages they are signed in to), "click" a link by its number from the last read, "scroll" down/up, "back". Returns the page title, URL, text (long pages: read again with offset = nextOffset), and numbered links. Use it to browse for anything: research, prices, docs, comparisons, following links across pages. If a page asks for a CAPTCHA or sign-in, stop and tell the user; never try to get around it.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'search, open, read, click, scroll, or back.', maxLength: 8 },
          query: { type: 'string', description: 'For search: the search words.', maxLength: 400 },
          url: { type: 'string', description: 'For open: full http(s) address.', maxLength: 4_096 },
          link: { type: 'integer', description: 'For click: link number from the last read.', minimum: 1, maximum: 200 },
          direction: { type: 'string', description: 'For scroll: "down" (default) or "up".', maxLength: 4 },
          offset: { type: 'integer', description: 'For read: character offset from a previous truncated result.', minimum: 0 },
        },
        required: ['action'],
        additionalProperties: false,
      },
      normalizeInput: dropNulls,
      validateInput: (value): value is BrowserInput => browserInputError(value) === undefined,
      inputError: browserInputError,
      validateOutput: (value): value is Record<string, unknown> => isRecord(value) && typeof value.status === 'string',
      async run(input, signal) {
        const action: BrowserAction = input.action === 'search'
          ? { kind: 'search', query: (input.query ?? '').trim() }
          : input.action === 'open'
            ? { kind: 'open', url: new URL(input.url ?? '').href }
            : input.action === 'click'
              ? { kind: 'click', link: input.link ?? 1 }
              : input.action === 'scroll'
                ? { kind: 'scroll', direction: input.direction ?? 'down' }
                : { kind: input.action === 'back' ? 'back' : 'read' };
        // One "always allow" for Chrome covers browsing; otherwise each navigation asks.
        const remembered = approvalMemory?.hasGrant(browserGrant) === true;
        if (!remembered) {
          const target = action.kind === 'search'
            ? `https://www.google.com/search?q=${encodeURIComponent(action.query)}`
            : action.kind === 'open' ? action.url : undefined;
          const decision = target
            ? await approval.request({ kind: 'url', url: target, application: 'Google Chrome' }, signal)
            : await approval.request({ kind: 'app-control', application: 'Google Chrome', action: 'read-page' }, signal);
          if (!decision) return { status: 'rejected', action: input.action };
          if (decision === 'always') approvalMemory?.grant(browserGrant);
        }
        const page = await browser.perform(action, signal);
        const offset = Math.min(input.offset ?? 0, page.text.length);
        const text = page.text.slice(offset, offset + windowChars);
        const nextOffset = offset + text.length;
        return {
          status: 'done',
          action: input.action,
          url: page.url,
          title: page.title,
          ...(page.captcha ? { warning: 'The page shows a CAPTCHA or "unusual traffic" check. Stop and ask the user to deal with it in Chrome.' } : {}),
          ...(page.results && page.results.length > 0 ? { results: page.results } : {}),
          text,
          totalChars: page.text.length,
          ...(nextOffset < page.text.length ? { truncated: true, nextOffset } : {}),
          ...(offset === 0 ? { links: page.links.slice(0, 60) } : {}),
          ...(page.height !== undefined && page.scroll !== undefined && page.viewport !== undefined
            ? { scrolledTo: `${Math.round(((page.scroll + page.viewport) / Math.max(page.height, 1)) * 100)}% of the page` }
            : {}),
        };
      },
    };
    registry.register(browserTool);
  }
}

/** Hosts Vyomara must never fetch on the model's behalf (loopback, private, link-local). */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) {
    return /^(?:fc|fd|fe8|fe9|fea|feb)/u.test(host) || host.startsWith('::ffff:');
  }
  return false;
}

interface FetchInput {
  readonly url: string;
  readonly offset?: number;
}

interface SearchInput {
  readonly query: string;
}

function fetchInputError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  const keys = onlyKeys(value, ['url', 'offset']);
  if (keys) return keys;
  if (typeof value.url !== 'string' || value.url.length > 4_096) return 'url must be a web address.';
  const invalid = validateWebUrl(value.url);
  if (invalid) return invalid;
  if (isPrivateHost(new URL(value.url).hostname)) return 'Local and private network addresses cannot be fetched.';
  if (value.offset !== undefined && (typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0)) {
    return 'offset must be a non-negative integer (a character position from an earlier result).';
  }
  return undefined;
}

function searchInputError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  const keys = onlyKeys(value, ['query']);
  if (keys) return keys;
  if (typeof value.query !== 'string' || value.query.trim() === '' || value.query.length > 400) {
    return 'query must be non-empty search text of at most 400 characters.';
  }
  return undefined;
}

/** Register fetch_url and, when a search backend is configured, web_search. */
export function registerWebTools(
  registry: ToolRegistry,
  config: AppConfig,
  ports: ActionToolPorts,
): void {
  const { approval, approvalMemory, web } = ports;
  if (!web) return;
  const windowChars = Math.max(1_000, config.maxToolOutputChars - 4_000);

  const approve = async (operation: 'fetch' | 'search', target: string, host: string, signal: AbortSignal): Promise<boolean> => {
    if (approvalMemory?.hasHost(host)) return true;
    const decision = await approval.request({ kind: 'web', operation, target, host }, signal);
    if (decision === 'always') approvalMemory?.allowHost(host);
    return decision !== false;
  };

  const fetchUrl: Tool<FetchInput, Record<string, unknown>> = {
    id: 'fetch_url',
    effect: 'network',
    description: 'Read a public web page YOURSELF (after approval): returns its text, title, and links so you can answer from it. Use whenever the user wants information from a page or site ("padh ke batao", "check karo", "what does the docs say"). Long pages are split: call again with offset = nextOffset.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full http(s) address.', maxLength: 4_096 },
        offset: { type: 'integer', description: 'Optional character offset from a previous truncated result.', minimum: 0 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    normalizeInput: dropNulls,
    validateInput: (value): value is FetchInput => fetchInputError(value) === undefined,
    inputError: fetchInputError,
    validateOutput: (value): value is Record<string, unknown> => isRecord(value) && typeof value.status === 'string',
    async run(input, signal) {
      const url = new URL(input.url);
      if (!await approve('fetch', url.href, url.hostname, signal)) {
        return { status: 'rejected', url: url.href };
      }
      const page = await web.fetchPage(url.href, signal);
      const offset = Math.min(input.offset ?? 0, page.text.length);
      const content = page.text.slice(offset, offset + windowChars);
      const nextOffset = offset + content.length;
      return {
        status: 'fetched',
        url: page.url,
        title: page.title,
        content,
        totalChars: page.text.length,
        truncated: nextOffset < page.text.length,
        ...(nextOffset < page.text.length ? { nextOffset } : {}),
        ...(offset === 0 ? { links: page.links.slice(0, 25) } : {}),
      };
    },
  };
  registry.register(fetchUrl);

  const fetchRaw = web.fetchRaw?.bind(web);

  if (fetchRaw) {
    const newsTool: Tool<NewsInput, Record<string, unknown>> = {
      id: 'news_headlines',
      effect: 'network',
      description: 'Get current news headlines (after approval) from Google News: titles, publishers, times, and links. Use for "aaj ki news", "latest headlines", "what happened with X today". Optional topic narrows it (e.g. "cricket", "AI", "Delhi"); language "hi" gives Hindi news. Answer in chat with a short list, each headline as a Markdown link [headline](url) followed by publisher and time (never paste the long URL itself); fetch_url an article only if the user wants details.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Optional topic or search words.', maxLength: 120 },
          language: { type: 'string', description: 'Optional: "en" (default) or "hi".', maxLength: 2 },
          count: { type: 'integer', description: 'Optional number of headlines (default 10).', minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
      normalizeInput: dropNulls,
      validateInput: (value): value is NewsInput => newsInputError(value) === undefined,
      inputError: newsInputError,
      validateOutput: (value): value is Record<string, unknown> => isRecord(value) && typeof value.status === 'string',
      async run(input, signal) {
        const language = input.language ?? 'en';
        const locale = language === 'hi' ? 'hl=hi&gl=IN&ceid=IN:hi' : 'hl=en-IN&gl=IN&ceid=IN:en';
        const topic = input.topic?.trim();
        const url = topic
          ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&${locale}`
          : `https://news.google.com/rss?${locale}`;
        if (!await approve('fetch', url, 'news.google.com', signal)) return { status: 'rejected', url };
        const items = parseFeed(await fetchRaw(url, signal), input.count ?? 10);
        return { status: 'fetched', source: 'Google News', ...(topic ? { topic } : {}), fetchedAt: new Date().toISOString(), headlines: items };
      },
    };
    registry.register(newsTool);
  }

  const searchHost = web.searchHost;
  if (searchHost === undefined && !fetchRaw) return;
  const builtIn = searchHost === undefined;
  const webSearch: Tool<SearchInput, Record<string, unknown>> = {
    id: 'web_search',
    effect: 'network',
    description: builtIn
      ? 'Search the web (after the user approves): returns titles, URLs, and snippets from Wikipedia (facts, people, places, topics) and Google News (current events). Then use fetch_url to read the most relevant pages before answering, and cite the URLs you used.'
      : 'Search the web (after the user approves) and return result titles, URLs, and snippets. Then use fetch_url to read the most relevant pages before answering, and cite the URLs you used.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search words.', maxLength: 400 } },
      required: ['query'],
      additionalProperties: false,
    },
    normalizeInput: dropNulls,
    validateInput: (value): value is SearchInput => searchInputError(value) === undefined,
    inputError: searchInputError,
    validateOutput: (value): value is Record<string, unknown> => isRecord(value) && typeof value.status === 'string',
    async run(input, signal) {
      const query = input.query.trim();
      const host = searchHost ?? BUILT_IN_SEARCH_HOSTS;
      if (!await approve('search', query, host, signal)) return { status: 'rejected', query };
      const results = builtIn && fetchRaw ? await builtInSearch(query, fetchRaw, signal) : await web.search(query, signal);
      return { status: 'searched', query, results: results.slice(0, 10) };
    },
  };
  registry.register(webSearch);
}

/**
 * Words about recency or question phrasing ("latest", "version", "kya hai")
 * make Wikipedia's full-text search match the wrong articles; the subject
 * alone ("react native") finds its article. News search keeps the full query.
 */
const SEARCH_FILLER = /\b(?:what|which|who|when|where|is|are|was|the|a|an|of|for|in|on|about|tell|me|please|current|currently|latest|newest|new|recent|version|versions|release|released|today|now|available|right|kya|hai|hain|ka|ki|ke|batao|bataiye|abhi|aaj|20\d\d)\b/giu;

export function encyclopediaQuery(query: string): string {
  const subject = query.replace(SEARCH_FILLER, ' ').replace(/[?!.,]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return subject === '' ? query : subject;
}

/** The approval label for the built-in search, which asks two public sources. */
export const BUILT_IN_SEARCH_HOSTS = 'wikipedia.org + news.google.com';

/**
 * Search without a search engine of our own: Wikipedia's search API for
 * facts and Google News RSS for current events, both public interfaces
 * meant for programs. Results from each are interleaved.
 */
export async function builtInSearch(
  query: string,
  fetchRaw: (url: string, signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<WebSearchResult[]> {
  const wikiUrl = (words: string): string => `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srlimit=5&srsearch=${encodeURIComponent(words)}`;
  const news = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const subject = encyclopediaQuery(query);
  let [wikiText, newsText] = await Promise.all([
    fetchRaw(wikiUrl(subject), signal).catch(() => ''),
    fetchRaw(news, signal).catch(() => ''),
  ]);
  // A misspelt leftover word ("availble") can empty the subject search: try the whole query instead.
  if (subject !== query && !/"title"/u.test(wikiText)) wikiText = await fetchRaw(wikiUrl(query), signal).catch(() => wikiText);
  const wikiResults: WebSearchResult[] = [];
  try {
    const payload = JSON.parse(wikiText) as { query?: { search?: { title?: unknown; snippet?: unknown }[] } };
    for (const item of payload.query?.search ?? []) {
      if (typeof item.title !== 'string') continue;
      wikiResults.push({
        title: `${item.title} (Wikipedia)`,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /gu, '_'))}`,
        snippet: typeof item.snippet === 'string' ? decodeXmlText(item.snippet).slice(0, 300) : '',
      });
    }
  } catch {
    // No Wikipedia results.
  }
  const newsResults: WebSearchResult[] = parseFeed(newsText, 6).map(item => ({
    title: item.source ? `${item.title} (${item.source})` : item.title,
    url: item.url,
    snippet: item.published ? `News, ${item.published.slice(0, 10)}` : 'News',
  }));
  const merged: WebSearchResult[] = [];
  for (let index = 0; index < Math.max(wikiResults.length, newsResults.length); index += 1) {
    const fromWiki = wikiResults[index];
    const fromNews = newsResults[index];
    if (fromWiki) merged.push(fromWiki);
    if (fromNews) merged.push(fromNews);
  }
  if (merged.length === 0 && wikiText === '' && newsText === '') {
    throw new ToolFailure('The search sources could not be reached. Check the internet connection.', 'tool-failed');
  }
  return merged;
}
