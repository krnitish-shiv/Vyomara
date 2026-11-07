import type { ToolEffect } from './contracts.ts';

export type PolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'side-effects-disabled' };

export interface PolicyGatewayOptions {
  /**
   * Effects that may execute. `read` and `propose` are always allowed:
   * proposals never change anything until the user approves them in the
   * approval port. `launch`, `shell`, and `network` tools also ask the user
   * before acting, but they are only reachable when explicitly enabled here.
   */
  readonly allowedEffects?: readonly ToolEffect[];
}

const ALWAYS_ALLOWED: readonly ToolEffect[] = ['read', 'propose'];

export class PolicyGateway {
  readonly #allowed: ReadonlySet<ToolEffect>;

  constructor(options: PolicyGatewayOptions = {}) {
    this.#allowed = new Set([...ALWAYS_ALLOWED, ...(options.allowedEffects ?? [])]);
  }

  authorize(effect: ToolEffect, _toolId?: string, _input?: unknown): PolicyDecision {
    // Direct write/delete effects are never allowed: every change goes through
    // a reviewed `propose` tool instead.
    if (effect === 'write' || effect === 'delete') {
      return { allowed: false, reason: 'side-effects-disabled' };
    }
    return this.#allowed.has(effect)
      ? { allowed: true }
      : { allowed: false, reason: 'side-effects-disabled' };
  }
}
