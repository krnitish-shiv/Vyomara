import type { ActionApprovalPort } from './action-tools.ts';
import { TOOL_ID_PATTERN, type Tool, type ToolArgumentProperty, type ToolRegistry } from './contracts.ts';
import type { McpPort, McpTool } from './mcp-client.ts';

/**
 * Offer MCP server tools to the model as ordinary tools named
 * mcp_<server>_<tool>. Every call is shown to the user first (server, tool,
 * and arguments); "Always allow" lasts until Vyomara quits.
 *
 * The model-facing schema only has string, integer, and boolean fields, so
 * numbers are passed as text and lists/objects as JSON text; they are turned
 * back into real values before the call.
 */

type FieldKind = 'string' | 'integer' | 'boolean' | 'number' | 'json';

interface Converted {
  readonly properties: Record<string, ToolArgumentProperty>;
  readonly kinds: Record<string, FieldKind>;
  readonly required: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mcpToolId(server: string, name: string, taken: ReadonlySet<string>): string {
  const base = `mcp_${server}_${name}`.toLowerCase().replace(/[^a-z0-9_]+/gu, '_').replace(/_+/gu, '_').slice(0, 60);
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${base.slice(0, 57)}_${suffix}`;
  return TOOL_ID_PATTERN.test(id) ? id : `mcp_tool_${taken.size + 1}`;
}

export function convertSchema(schema: Readonly<Record<string, unknown>>): Converted {
  const source = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [];
  const properties: Record<string, ToolArgumentProperty> = {};
  const kinds: Record<string, FieldKind> = {};
  for (const [name, raw] of Object.entries(source).slice(0, 32)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(name)) continue;
    const field = isRecord(raw) ? raw : {};
    const type = Array.isArray(field.type) ? field.type.find(item => item !== 'null') : field.type;
    const kind: FieldKind = type === 'string' || type === 'integer' || type === 'boolean' || type === 'number' ? type : 'json';
    const notes = [
      typeof field.description === 'string' ? field.description : '',
      kind === 'number' ? '(a number, as text)' : '',
      kind === 'json' ? `(JSON ${type === 'array' ? 'array' : type === 'object' ? 'object' : 'value'}, as text)` : '',
      Array.isArray(field.enum) ? `One of: ${field.enum.map(item => JSON.stringify(item)).join(', ')}.` : '',
    ].filter(Boolean).join(' ').slice(0, 500);
    properties[name] = {
      type: kind === 'integer' || kind === 'boolean' ? kind : 'string',
      ...(notes ? { description: notes } : {}),
    };
    kinds[name] = kind;
  }
  return { properties, kinds, required: required.filter(name => name in properties) };
}

/** Model arguments → MCP arguments (numbers and JSON text parsed back). */
export function toMcpArguments(input: Readonly<Record<string, unknown>>, kinds: Readonly<Record<string, FieldKind>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input)) {
    const kind = kinds[name];
    if (kind === 'number' && typeof value === 'string') result[name] = Number(value);
    else if (kind === 'json' && typeof value === 'string') {
      try {
        result[name] = JSON.parse(value);
      } catch {
        result[name] = value;
      }
    } else result[name] = value;
  }
  return result;
}

function argumentError(value: unknown, converted: Converted): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  for (const name of converted.required) if (value[name] === undefined) return `${name} is required.`;
  for (const [name, item] of Object.entries(value)) {
    const kind = converted.kinds[name];
    if (!kind) return `Unknown argument "${name}". Use: ${Object.keys(converted.properties).join(', ') || 'no arguments'}.`;
    if ((kind === 'string' || kind === 'json') && typeof item !== 'string') return `${name} must be text.`;
    if (kind === 'number' && (typeof item !== 'string' || !Number.isFinite(Number(item)))) return `${name} must be a number.`;
    if (kind === 'integer' && !Number.isInteger(item)) return `${name} must be a whole number.`;
    if (kind === 'boolean' && typeof item !== 'boolean') return `${name} must be true or false.`;
    if (kind === 'json' && typeof item === 'string') {
      try { JSON.parse(item); } catch { return `${name} must be valid JSON.`; }
    }
  }
  return undefined;
}

export function registerMcpTools(registry: ToolRegistry, mcp: McpPort, approval: ActionApprovalPort, allowed: Set<string>, maxTools: number): void {
  const taken = new Set(registry.modelTools().map(tool => tool.id));
  for (const tool of mcp.tools().slice(0, Math.max(0, maxTools))) {
    const id = mcpToolId(tool.server, tool.name, taken);
    taken.add(id);
    registry.register(mcpTool(id, tool, mcp, approval, allowed));
  }
}

function mcpTool(id: string, tool: McpTool, mcp: McpPort, approval: ActionApprovalPort, allowed: Set<string>): Tool<Record<string, unknown>, Record<string, unknown>> {
  const converted = convertSchema(tool.inputSchema);
  const key = `${tool.server}/${tool.name}`;
  return {
    id,
    effect: 'shell',
    description: `[MCP server "${tool.server}", tool "${tool.name}"; the user approves each call] ${tool.description || 'No description.'}`.slice(0, 2_000),
    parameters: { type: 'object', properties: converted.properties, ...(converted.required.length > 0 ? { required: converted.required } : {}), additionalProperties: false },
    normalizeInput: value => {
      if (!isRecord(value)) return value;
      const result: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(value)) {
        if (item === null) continue;
        const kind = converted.kinds[name];
        // Models often send real numbers, lists, and objects: accept them.
        if ((kind === 'json' || kind === 'number' || kind === 'string') && typeof item !== 'string') result[name] = kind === 'string' ? String(item) : JSON.stringify(item);
        else if (kind === 'integer' && typeof item === 'string' && /^-?\d+$/u.test(item)) result[name] = Number(item);
        else if (kind === 'boolean' && (item === 'true' || item === 'false')) result[name] = item === 'true';
        else result[name] = item;
      }
      return result;
    },
    validateInput: (value): value is Record<string, unknown> => argumentError(value, converted) === undefined,
    inputError: value => argumentError(value, converted),
    validateOutput: (value): value is Record<string, unknown> => isRecord(value),
    async run(input, signal) {
      const args = toMcpArguments(input, converted.kinds);
      if (!allowed.has(key)) {
        const decision = await approval.request({ kind: 'mcp', server: tool.server, tool: tool.name, arguments: JSON.stringify(args, null, 2).slice(0, 4_000) }, signal);
        if (!decision) return { status: 'rejected', server: tool.server, tool: tool.name };
        if (decision === 'always') allowed.add(key);
      }
      const result = await mcp.call(tool.server, tool.name, args, signal);
      return { status: result.isError ? 'error' : 'done', server: tool.server, tool: tool.name, result: result.text };
    },
  };
}
