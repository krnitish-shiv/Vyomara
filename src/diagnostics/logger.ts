export type DiagnosticEvent =
  | { readonly event: 'task.created'; readonly taskId: string; readonly runId: string; readonly state: string }
  | { readonly event: 'task.state-changed'; readonly taskId: string; readonly runId: string; readonly from: string; readonly to: string }
  | { readonly event: 'task.completed'; readonly taskId: string; readonly runId: string }
  | { readonly event: 'task.needs-attention'; readonly taskId: string; readonly runId: string }
  | { readonly event: 'task.failed'; readonly taskId: string; readonly runId: string; readonly code: string }
  | { readonly event: 'task.cancelled'; readonly taskId: string; readonly runId: string; readonly code: string }
  | { readonly event: 'request.completed'; readonly taskId?: string; readonly runId?: string; readonly durationMs: number; readonly iterations: number }
  | { readonly event: 'request.failed'; readonly taskId?: string; readonly runId?: string; readonly code: string }
  | { readonly event: 'request.cancelled'; readonly taskId: string; readonly runId: string; readonly code: string }
  | { readonly event: 'tool.requested'; readonly taskId: string; readonly runId: string; readonly toolCallId: string; readonly toolId: string; readonly attempt: number; readonly argumentKeys: readonly string[] }
  | { readonly event: 'tool.invoked'; readonly taskId: string; readonly runId: string; readonly toolCallId: string; readonly toolId: string; readonly attempt: number }
  | { readonly event: 'tool.execution-started'; readonly taskId?: string; readonly runId?: string; readonly toolCallId?: string; readonly attempt?: number; readonly toolId: string }
  | { readonly event: 'tool.completed'; readonly taskId?: string; readonly runId?: string; readonly toolCallId?: string; readonly attempt?: number; readonly toolId: string; readonly durationMs: number; readonly outputChars?: number }
  | { readonly event: 'tool.failed'; readonly taskId: string; readonly runId: string; readonly toolCallId: string; readonly toolId: string; readonly attempt: number; readonly code: string }
  | { readonly event: 'tool.retry-scheduled'; readonly taskId: string; readonly runId: string; readonly toolCallId: string; readonly toolId: string; readonly nextAttempt: number; readonly reasonCode: string }
  | { readonly event: 'tool.denied'; readonly taskId?: string; readonly runId?: string; readonly toolCallId?: string; readonly attempt?: number; readonly toolId: string; readonly reason: string };

export type LogWriter = (line: string) => void;

export function createLogger(write: LogWriter = line => console.error(line)) {
  const emit = (event: DiagnosticEvent): void => {
    write(JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event,
    }));
  };

  return {
    emit,
    failure(_error?: unknown): void {
      emit({ event: 'request.failed', code: 'request.failed' });
    },
  };
}
