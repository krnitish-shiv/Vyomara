import type { AppConfig } from '../config/config.ts';
import type { Logger, ToolInvocationContext } from '../types.ts';
import { OperationStoppedError, runBounded } from '../shared/bounded.ts';
import { PolicyGateway } from './policy.ts';
import { ToolRegistry } from './contracts.ts';
import type { ToolArgumentSchema } from './contracts.ts';
import { ToolFailure } from './contracts.ts';
import type { ModelToolDefinition } from './contracts.ts';

type ToolExecutionErrorCode =
  | 'unknown-tool'
  | 'invalid-input'
  | 'input-too-large'
  | 'policy-denied'
  | 'invalid-output'
  | 'output-too-large'
  | 'timeout'
  | 'cancelled'
  | 'not-found'
  | 'invalid-path'
  | 'outside-root'
  | 'permission-denied'
  | 'unsupported-operation'
  | 'tool-failed';

const APPROVAL_GATED_TIMEOUT_MS = 30 * 60 * 1000;

export class ToolExecutionError extends Error {
  readonly code: ToolExecutionErrorCode;

  constructor(
    message: string,
    code: ToolExecutionErrorCode,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
    this.code = code;
  }
}

export interface ToolExecutorOptions {
  readonly registry: ToolRegistry;
  readonly policy: PolicyGateway;
  readonly config: AppConfig;
  readonly logger: Logger;
}

export class ToolExecutor {
  private readonly options: ToolExecutorOptions;

  constructor(options: ToolExecutorOptions) {
    this.options = options;
  }

  modelTools(): readonly ModelToolDefinition[] {
    return this.options.registry.modelTools();
  }

  async execute(
    toolId: string,
    input: unknown,
    signal: AbortSignal,
    context?: ToolInvocationContext,
  ): Promise<unknown> {
    const tool = this.options.registry.get(toolId);
    if (!tool) {
      const available = this.modelTools().map(candidate => candidate.id).join(', ');
      throw new ToolExecutionError(
        `There is no tool named "${toolId}". Available tools: ${available || 'none'}.`,
        'unknown-tool',
      );
    }
    input = coerceToSchema(input, tool.parameters);
    if (tool.normalizeInput) input = tool.normalizeInput(input);
    if (!tool.validateInput(input)) {
      throw new ToolExecutionError(
        tool.inputError?.(input) ?? 'Tool arguments were invalid; no operation was performed.',
        'invalid-input',
      );
    }
    let serializedInput: string | undefined;
    try {
      serializedInput = JSON.stringify(input);
    } catch {
      throw new ToolExecutionError('Tool input could not be serialized.', 'invalid-input');
    }
    if (serializedInput === undefined || serializedInput.length > this.options.config.maxToolInputChars) {
      throw new ToolExecutionError(
        'Tool arguments exceeded the configured limit; no operation was performed.',
        'input-too-large',
      );
    }

    const decision = this.options.policy.authorize(tool.effect, toolId, input);
    if (!decision.allowed) {
      this.options.logger.emit({
        event: 'tool.denied',
        ...context,
        toolId,
        reason: decision.reason,
      });
      throw new ToolExecutionError('Tool execution is denied by policy.', 'policy-denied');
    }

    const start = Date.now();
    this.options.logger.emit({
      event: 'tool.execution-started',
      ...context,
      toolId,
    });
    try {
      const result = await runBounded(
        toolSignal => tool.run(input, toolSignal),
        // Tools that wait for a human decision get a long ceiling; Stop still
        // cancels them immediately. Commands enforce their own run timeout.
        tool.effect === 'read' && tool.longRunning !== true
          ? this.options.config.toolTimeoutMs
          : APPROVAL_GATED_TIMEOUT_MS,
        signal,
      );
      if (!tool.validateOutput(result)) {
        throw new ToolExecutionError('Tool output did not match its schema.', 'invalid-output');
      }
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(result);
      } catch {
        throw new ToolExecutionError('Tool output could not be serialized.', 'invalid-output');
      }
      if (serialized === undefined) {
        throw new ToolExecutionError('Tool output could not be serialized.', 'invalid-output');
      }
      if (serialized.length > this.options.config.maxToolOutputChars) {
        throw new ToolExecutionError('Tool output exceeded the configured limit.', 'output-too-large');
      }
      this.options.logger.emit({
        event: 'tool.completed',
        ...context,
        toolId,
        durationMs: Date.now() - start,
        outputChars: serialized.length,
      });
      return result;
    } catch (error) {
      if (error instanceof OperationStoppedError) {
        throw new ToolExecutionError(
          error.message,
          error.reason,
        );
      }
      if (error instanceof ToolFailure) {
        throw new ToolExecutionError(error.message, error.code);
      }
      throw error;
    }
  }
}

/**
 * Local models often send "false" or "12" where the schema says boolean or
 * integer, and leave optional fields as null or "". Fix those before
 * validation so the call runs instead of failing; anything else is left for
 * the tool to reject.
 */
export function coerceToSchema(input: unknown, schema: ToolArgumentSchema): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const required = new Set(schema.required ?? []);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const property = schema.properties[key];
    if (!property) {
      out[key] = value;
      continue;
    }
    // An empty optional value means "not given".
    if (!required.has(key) && property.nullable !== true && (value === null || (value === '' && property.type !== 'string'))) continue;
    if (property.type === 'boolean' && typeof value === 'string' && /^(?:true|false)$/iu.test(value.trim())) {
      out[key] = value.trim().toLowerCase() === 'true';
    } else if (property.type === 'integer' && typeof value === 'string' && /^-?\d+$/u.test(value.trim())) {
      out[key] = Number(value.trim());
    } else if (property.type === 'integer' && typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
      out[key] = Math.round(value);
    } else if (property.type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
      out[key] = String(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}
