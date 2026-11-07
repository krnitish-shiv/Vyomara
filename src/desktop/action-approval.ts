import { randomUUID } from 'node:crypto';
import { OperationStoppedError } from '../shared/bounded.ts';
import { ToolFailure } from '../tools/contracts.ts';
import type { ActionApprovalPort, ActionProposal, ApprovalDecision } from '../tools/action-tools.ts';
import type { DesktopActionProposal } from './contracts.ts';

interface PendingAction {
  readonly signal: AbortSignal;
  readonly resolve: (decision: ApprovalDecision) => void;
  readonly reject: (error: Error) => void;
  readonly removeAbortListener: () => void;
}

export interface ActionApprovalOptions {
  readonly onProposal: (proposal: DesktopActionProposal) => void;
}

export class ActionApprovalError extends ToolFailure {
  constructor(message: string) {
    super(message, 'tool-failed');
    this.name = 'ActionApprovalError';
  }
}

/**
 * Holds commands, application launches, and web pages until the user
 * approves or rejects each one in the desktop UI. Nothing runs on timeout or
 * cancellation; the pending promise rejects instead.
 */
export class ActionApprovalManager implements ActionApprovalPort {
  readonly #options: ActionApprovalOptions;
  readonly #pending = new Map<string, PendingAction>();

  constructor(options: ActionApprovalOptions) {
    this.#options = options;
  }

  request(action: ActionProposal, signal: AbortSignal): Promise<ApprovalDecision> {
    if (signal.aborted) return Promise.reject(new OperationStoppedError('cancelled'));
    const id = randomUUID();
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const onAbort = (): void => {
        this.#finish(id, pending => pending.reject(new OperationStoppedError('cancelled')));
      };
      this.#pending.set(id, {
        signal,
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener('abort', onAbort),
      });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        this.#options.onProposal({ id, ...action });
      } catch (error) {
        const message = error instanceof ActionApprovalError
          ? error.message
          : 'The approval request could not be displayed; nothing was run or opened.';
        this.#finish(id, entry => entry.reject(new ActionApprovalError(message)));
      }
    });
  }

  approve(id: string, always = false): void {
    this.#resolve(id, always ? 'always' : true);
  }

  reject(id: string): void {
    this.#resolve(id, false);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  #resolve(id: string, decision: ApprovalDecision): void {
    const pending = this.#pending.get(id);
    if (!pending) throw new ActionApprovalError('This approval request is no longer active.');
    if (pending.signal.aborted) {
      this.#finish(id, entry => entry.reject(new OperationStoppedError('cancelled')));
      throw new ActionApprovalError('This request was cancelled; nothing was run or opened.');
    }
    this.#finish(id, entry => entry.resolve(decision));
  }

  #finish(id: string, finish: (pending: PendingAction) => void): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.removeAbortListener();
    finish(pending);
  }
}
