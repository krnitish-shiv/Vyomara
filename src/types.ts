import type { DiagnosticEvent } from './diagnostics/logger.ts';

export interface ToolInvocationContext {
  readonly taskId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly attempt: number;
}

export interface Logger {
  emit(event: DiagnosticEvent): void;
  failure(error?: unknown): void;
}
