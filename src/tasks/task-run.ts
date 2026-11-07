import { randomUUID } from 'node:crypto';
import type { Logger, ToolInvocationContext } from '../types.ts';

export type TaskRunState =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_for_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'needs_attention';

const transitions: Readonly<Record<TaskRunState, readonly TaskRunState[]>> = {
  queued: ['planning', 'failed', 'cancelled'],
  planning: ['running', 'completed', 'failed', 'cancelled', 'needs_attention'],
  running: ['planning', 'completed', 'failed', 'cancelled', 'needs_attention'],
  waiting_for_approval: ['running', 'paused', 'failed', 'cancelled'],
  paused: ['planning', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  needs_attention: ['planning', 'completed', 'failed', 'cancelled'],
};

export class TaskRun {
  readonly taskId = randomUUID();
  readonly runId = randomUUID();
  #state: TaskRunState = 'queued';
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
    this.#logger.emit({
      event: 'task.created',
      taskId: this.taskId,
      runId: this.runId,
      state: this.#state,
    });
  }

  get state(): TaskRunState {
    return this.#state;
  }

  context(toolCallId: string, attempt: number): ToolInvocationContext {
    return {
      taskId: this.taskId,
      runId: this.runId,
      toolCallId,
      attempt,
    };
  }

  transition(next: TaskRunState): void {
    if (!transitions[this.#state].includes(next)) {
      throw new Error(`Invalid task transition: ${this.#state} -> ${next}.`);
    }
    const previous = this.#state;
    this.#state = next;
    this.#logger.emit({
      event: 'task.state-changed',
      taskId: this.taskId,
      runId: this.runId,
      from: previous,
      to: next,
    });
    if (next === 'completed') {
      this.#logger.emit({
        event: 'task.completed',
        taskId: this.taskId,
        runId: this.runId,
      });
    }
  }

  needsAttention(): void {
    this.transition('needs_attention');
    this.#logger.emit({
      event: 'task.needs-attention',
      taskId: this.taskId,
      runId: this.runId,
    });
  }

  fail(code: string): void {
    const state: TaskRunState = code === 'cancelled' ? 'cancelled' : 'failed';
    if (this.#state === 'completed' || this.#state === 'failed' || this.#state === 'cancelled') {
      return;
    }
    this.transition(state);
    if (state === 'cancelled') {
      this.#logger.emit({
        event: 'task.cancelled',
        taskId: this.taskId,
        runId: this.runId,
        code,
      });
      this.#logger.emit({
        event: 'request.cancelled',
        taskId: this.taskId,
        runId: this.runId,
        code,
      });
      return;
    }
    this.#logger.emit({
      event: 'task.failed',
      taskId: this.taskId,
      runId: this.runId,
      code,
    });
    this.#logger.emit({
      event: 'request.failed',
      taskId: this.taskId,
      runId: this.runId,
      code,
    });
  }
}
