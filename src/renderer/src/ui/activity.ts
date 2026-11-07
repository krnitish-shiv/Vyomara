import type { DiagnosticEvent } from '../../../diagnostics/logger.ts';
import type { DesktopToolActivity } from '../../../desktop/contracts.ts';

/** Task-level events worth showing; per-tool steps come from tool activity instead. */
export function activityLabel(event: DiagnosticEvent): string | undefined {
  switch (event.event) {
    case 'task.created':
      return 'Task accepted';
    case 'task.state-changed':
      return undefined;
    case 'task.completed':
      return 'Task completed';
    case 'task.needs-attention':
      return 'Task needs attention';
    case 'task.failed':
    case 'request.failed':
      return `Task failed (${event.code})`;
    case 'task.cancelled':
    case 'request.cancelled':
      return 'Task cancelled';
    case 'tool.denied':
      return `Blocked by policy: ${event.toolId}`;
    case 'tool.requested':
    case 'tool.invoked':
    case 'tool.execution-started':
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.retry-scheduled':
      return undefined;
    case 'request.completed':
      return 'Response ready';
  }
}

export function activityIcon(status: DesktopToolActivity['status']): string {
  switch (status) {
    case 'running': return '◌';
    case 'done': return '✓';
    case 'rejected': return '⊘';
    default: return '✗';
  }
}
