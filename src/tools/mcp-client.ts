import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ToolFailure } from './contracts.ts';

/**
 * A small Model Context Protocol client for stdio servers, configured like
 * Claude Desktop in `<data dir>/mcp.json`:
 *
 *   { "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
 *                                 "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" } } } }
 *
 * Servers start when Vyomara starts; their tools are offered to the model,
 * and every call is approved by the user first (see mcp-tools.ts).
 */

export interface McpServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Set false to keep a server in the file without starting it. */
  readonly enabled?: boolean;
}

export interface McpTool {
  readonly server: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface McpServerStatus {
  readonly name: string;
  readonly state: 'starting' | 'ready' | 'failed' | 'stopped';
  readonly tools: number;
  readonly error?: string;
}

export interface McpPort {
  tools(): readonly McpTool[];
  call(server: string, tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<{ readonly text: string; readonly isError: boolean }>;
}

const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read and check mcp.json; a missing file means no servers. */
export async function readMcpConfig(dataDirectory: string): Promise<Record<string, McpServerConfig>> {
  let text: string;
  try {
    text = await readFile(join(dataDirectory, 'mcp.json'), 'utf8');
  } catch {
    return {};
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('mcp.json is not valid JSON.');
  }
  const servers = isRecord(value) && isRecord(value.mcpServers) ? value.mcpServers : undefined;
  if (!servers) throw new Error('mcp.json needs an "mcpServers" object.');
  const result: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(name)) throw new Error(`MCP server name "${name}" must use letters, digits, - or _ (up to 32).`);
    if (!isRecord(entry) || typeof entry.command !== 'string' || entry.command.trim() === '') throw new Error(`MCP server "${name}" needs a "command".`);
    if (entry.args !== undefined && (!Array.isArray(entry.args) || !entry.args.every(arg => typeof arg === 'string'))) throw new Error(`MCP server "${name}": "args" must be a list of strings.`);
    if (entry.env !== undefined && (!isRecord(entry.env) || !Object.values(entry.env).every(item => typeof item === 'string'))) throw new Error(`MCP server "${name}": "env" values must be strings.`);
    result[name] = {
      command: entry.command,
      ...(entry.args ? { args: entry.args as string[] } : {}),
      ...(entry.env ? { env: entry.env as Record<string, string> } : {}),
      ...(typeof entry.cwd === 'string' ? { cwd: entry.cwd } : {}),
      ...(entry.enabled === false ? { enabled: false } : {}),
    };
  }
  return result;
}

/** Apps opened from Finder get a minimal PATH; add the usual places for npx, uvx, node, python. */
function serverPath(): string {
  const extras = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), '.cargo', 'bin'), join(homedir(), 'Library', 'pnpm'), '/usr/bin', '/bin'];
  const parts = (process.env.PATH ?? '').split(':').filter(Boolean);
  for (const extra of extras) if (!parts.includes(extra)) parts.push(extra);
  return parts.join(':');
}

class McpServer {
  readonly name: string;
  state: McpServerStatus['state'] = 'starting';
  error: string | undefined;
  tools: McpTool[] = [];
  readonly #config: McpServerConfig;
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  #buffer = '';
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(name: string, config: McpServerConfig) {
    this.name = name;
    this.#config = config;
  }

  async start(): Promise<void> {
    const child = spawn(this.#config.command, [...(this.#config.args ?? [])], {
      cwd: this.#config.cwd ?? homedir(),
      env: { ...process.env, PATH: serverPath(), ...this.#config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2_000); });
    child.stdout.on('data', (chunk: Buffer) => this.#receive(chunk.toString('utf8')));
    const failed = (message: string): void => {
      if (this.state !== 'stopped') {
        this.state = 'failed';
        this.error = message;
      }
      for (const waiter of this.#pending.values()) waiter.reject(new Error(message));
      this.#pending.clear();
    };
    child.once('error', error => failed(`could not start: ${error.message}`));
    child.once('exit', code => failed(`exited (code ${String(code)})${stderr.trim() ? `: ${stderr.trim().split('\n').at(-1) ?? ''}` : ''}`));

    await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Vyomara', version: '1.0' },
    });
    this.#notify('notifications/initialized');
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#request('tools/list', cursor ? { cursor } : {});
      const items = isRecord(page) && Array.isArray(page.tools) ? page.tools : [];
      for (const item of items) {
        if (!isRecord(item) || typeof item.name !== 'string') continue;
        tools.push({
          server: this.name,
          name: item.name,
          description: typeof item.description === 'string' ? item.description : '',
          inputSchema: isRecord(item.inputSchema) ? item.inputSchema : { type: 'object', properties: {} },
        });
      }
      cursor = isRecord(page) && typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
    } while (cursor && tools.length < 200);
    this.tools = tools;
    this.state = 'ready';
  }

  async call(tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    if (this.state !== 'ready') throw new ToolFailure(`MCP server "${this.name}" is not running${this.error ? ` (${this.error})` : ''}.`, 'tool-failed');
    const result = await this.#request('tools/call', { name: tool, arguments: args }, signal);
    const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
    const parts = content.map(item => {
      if (!isRecord(item)) return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      if (item.type === 'resource' && isRecord(item.resource) && typeof item.resource.text === 'string') return item.resource.text;
      return `[${String(item.type)} content]`;
    });
    const structured = isRecord(result) && result.structuredContent !== undefined && parts.join('').trim() === ''
      ? JSON.stringify(result.structuredContent)
      : '';
    const text = (parts.join('\n') || structured).slice(0, MAX_OUTPUT_CHARS);
    return { text, isError: isRecord(result) && result.isError === true };
  }

  stop(): void {
    this.state = 'stopped';
    this.#child?.kill('SIGTERM');
  }

  #receive(text: string): void {
    this.#buffer += text;
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf('\n');
      if (line === '') continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Servers sometimes log to stdout; ignore non-JSON lines.
      }
      if (!isRecord(message) || typeof message.id !== 'number') continue;
      const waiter = this.#pending.get(message.id);
      if (!waiter) continue;
      this.#pending.delete(message.id);
      if (isRecord(message.error)) waiter.reject(new Error(typeof message.error.message === 'string' ? message.error.message : 'MCP error'));
      else waiter.resolve(message.result);
    }
  }

  #send(message: Record<string, unknown>): void {
    if (!this.#child || this.#child.stdin.destroyed) throw new ToolFailure(`MCP server "${this.name}" is not running.`, 'tool-failed');
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  #notify(method: string, params?: Record<string, unknown>): void {
    this.#send({ method, ...(params ? { params } : {}) });
  }

  #request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ToolFailure(`MCP server "${this.name}" did not answer ${method} in time.`, 'tool-failed'));
      }, REQUEST_TIMEOUT_MS);
      const done = (callback: () => void): void => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); callback(); };
      const onAbort = (): void => {
        this.#pending.delete(id);
        try { this.#notify('notifications/cancelled', { requestId: id, reason: 'Stopped by the user' }); } catch { /* already gone */ }
        done(() => reject(new ToolFailure('Stopped by the user.', 'tool-failed')));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(id, { resolve: value => done(() => resolve(value)), reject: error => done(() => reject(error)) });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        done(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }
}

/** Starts the configured servers and gives the agent their tools. */
export class McpManager implements McpPort {
  readonly #servers = new Map<string, McpServer>();

  /** Start every enabled server; failures are recorded per server, never thrown. */
  async start(configs: Readonly<Record<string, McpServerConfig>>): Promise<void> {
    await Promise.all(Object.entries(configs).map(async ([name, config]) => {
      if (config.enabled === false) return;
      const server = new McpServer(name, config);
      this.#servers.set(name, server);
      try {
        await server.start();
      } catch (error) {
        server.state = 'failed';
        server.error ??= error instanceof Error ? error.message : String(error);
        server.stop();
        server.state = 'failed';
      }
    }));
  }

  tools(): readonly McpTool[] {
    return [...this.#servers.values()].filter(server => server.state === 'ready').flatMap(server => server.tools);
  }

  status(): readonly McpServerStatus[] {
    return [...this.#servers.values()].map(server => ({
      name: server.name,
      state: server.state,
      tools: server.tools.length,
      ...(server.error ? { error: server.error } : {}),
    }));
  }

  async call(server: string, tool: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
    const entry = this.#servers.get(server);
    if (!entry) throw new ToolFailure(`No MCP server is called "${server}".`, 'not-found');
    return entry.call(tool, args, signal);
  }

  stopAll(): void {
    for (const server of this.#servers.values()) server.stop();
    this.#servers.clear();
  }
}
