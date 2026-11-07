export type ToolEffect = 'read' | 'propose' | 'launch' | 'write' | 'delete' | 'shell' | 'network';

export type ToolFailureCode =
  | 'not-found'
  | 'invalid-path'
  | 'outside-root'
  | 'permission-denied'
  | 'unsupported-operation'
  | 'tool-failed';

export class ToolFailure extends Error {
  readonly code: ToolFailureCode;

  constructor(message: string, code: ToolFailureCode) {
    super(message);
    this.name = 'ToolFailure';
    this.code = code;
  }
}

export interface ToolArgumentProperty {
  readonly type: 'string' | 'integer' | 'boolean';
  readonly description?: string;
  readonly nullable?: true;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
}

export interface ToolArgumentSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ToolArgumentProperty>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

export interface ModelToolDefinition {
  readonly id: string;
  readonly description: string;
  readonly parameters: ToolArgumentSchema;
}

export interface Tool<Input, Output> {
  readonly id: string;
  readonly effect: ToolEffect;
  readonly description: string;
  readonly parameters: ToolArgumentSchema;
  /** Optional lenient clean-up (drop nulls, coerce "12" → 12) applied before validation. */
  readonly normalizeInput?: (value: unknown) => unknown;
  readonly validateInput: (value: unknown) => value is Input;
  readonly inputError?: (value: unknown) => string | undefined;
  readonly validateOutput: (value: unknown) => value is Output;
  readonly run: (input: Input, signal: AbortSignal) => Promise<Output>;
}

export type RegisteredTool = Tool<unknown, unknown>;

/** Tool IDs: lowercase words joined by underscores (preferred), dots, or hyphens. */
export const TOOL_ID_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;

function validToolArgumentSchema(schema: ToolArgumentSchema): boolean {
  if (
    typeof schema !== 'object' ||
    schema === null ||
    schema.type !== 'object' ||
    schema.additionalProperties !== false ||
    typeof schema.properties !== 'object' ||
    schema.properties === null ||
    Array.isArray(schema.properties) ||
    Object.keys(schema.properties).length > 32 ||
    Object.keys(schema).some(key =>
      key !== 'type' && key !== 'properties' && key !== 'required' && key !== 'additionalProperties')
  ) {
    return false;
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) ||
      typeof property !== 'object' ||
      property === null ||
      Object.keys(property).some(key =>
        !['type', 'description', 'nullable', 'maxLength', 'minimum', 'maximum', 'pattern'].includes(key)) ||
      (property.type !== 'string' && property.type !== 'integer' && property.type !== 'boolean') ||
      (property.nullable !== undefined && property.nullable !== true) ||
      (property.nullable === true && (schema.required ?? []).includes(name)) ||
      (property.description !== undefined &&
        (typeof property.description !== 'string' || property.description.length > 512)) ||
      (property.maxLength !== undefined &&
        (!Number.isSafeInteger(property.maxLength) || property.maxLength < 1 || property.maxLength > 1_048_576)) ||
      (property.minimum !== undefined && !Number.isSafeInteger(property.minimum)) ||
      (property.maximum !== undefined && !Number.isSafeInteger(property.maximum)) ||
      (property.minimum !== undefined && property.maximum !== undefined &&
        property.minimum > property.maximum) ||
      (property.pattern !== undefined &&
        (typeof property.pattern !== 'string' || property.pattern.length > 128))
    ) {
      return false;
    }
  }
  return schema.required === undefined ||
    (Array.isArray(schema.required) &&
      schema.required.length <= 32 &&
      new Set(schema.required).size === schema.required.length &&
      schema.required.every(key =>
        typeof key === 'string' && Object.hasOwn(schema.properties, key)));
}

export class ToolRegistry {
  readonly #tools = new Map<string, RegisteredTool>();

  register<Input, Output>(tool: Tool<Input, Output>): void {
    if (!TOOL_ID_PATTERN.test(tool.id)) {
      throw new Error('Tool ID must use lowercase letters, digits, underscores, dots, and hyphens.');
    }
    if (
      typeof tool.description !== 'string' ||
      tool.description.trim() === '' ||
      tool.description.length > 2048
    ) {
      throw new Error('Tool description must contain between 1 and 2048 characters.');
    }
    if (!validToolArgumentSchema(tool.parameters)) {
      throw new Error('Tool argument schema is invalid.');
    }
    if (this.#tools.has(tool.id)) {
      throw new Error(`Tool ID is already registered: ${tool.id}`);
    }
    this.#tools.set(tool.id, tool as RegisteredTool);
  }

  get(id: string): RegisteredTool | undefined {
    return this.#tools.get(id);
  }

  modelTools(): readonly ModelToolDefinition[] {
    return [...this.#tools.values()]
      .map(({ id, description, parameters }) => ({
        id,
        description,
        parameters: structuredClone(parameters),
      }));
  }
}
