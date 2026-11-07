import type { Tool, ToolRegistry } from './contracts.ts';

export interface PlanStep {
  readonly text: string;
  readonly status: 'pending' | 'in_progress' | 'done';
}

interface PlanInput {
  readonly plan: string;
}

interface PlanOutput {
  readonly ok: true;
  readonly steps: readonly PlanStep[];
}

const MAX_STEPS = 20;

/** Parse "- [x] done", "- [>] doing", "- [ ] todo" lines (also "1." numbering or bare lines). */
export function parsePlan(plan: string): PlanStep[] {
  return plan.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(0, MAX_STEPS)
    .map(line => {
      const match = /^(?:[-*•]|\d+[.)])?\s*(?:\[([ xX>~-])\])?\s*(.+)$/u.exec(line);
      const mark = match?.[1] ?? ' ';
      const text = (match?.[2] ?? line).slice(0, 200);
      const status: PlanStep['status'] = mark === 'x' || mark === 'X'
        ? 'done'
        : mark === '>' || mark === '~' || mark === '-'
          ? 'in_progress'
          : 'pending';
      return { text, status };
    });
}

function planError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'Arguments must be a JSON object.';
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'plan')) return 'Use only the plan argument.';
  if (typeof record.plan !== 'string' || record.plan.trim() === '' || record.plan.length > 4_000) {
    return 'plan must be a non-empty checklist, one step per line, e.g. "- [x] Run tests\\n- [>] Fix bug\\n- [ ] Re-run tests".';
  }
  return undefined;
}

/** A side-effect-free checklist the agent keeps for multi-step tasks; the UI shows it live. */
export function registerPlanTool(registry: ToolRegistry): void {
  const tool: Tool<PlanInput, PlanOutput> = {
    id: 'update_plan',
    effect: 'read',
    description: 'Write or update your step-by-step plan for a multi-step task. One step per line: "- [x]" done, "- [>]" in progress, "- [ ]" to do. Send the whole list each time. The user sees it as a live checklist.',
    parameters: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'The full checklist, one step per line.', maxLength: 4_000 },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    validateInput: (value): value is PlanInput => planError(value) === undefined,
    inputError: planError,
    validateOutput: (value): value is PlanOutput =>
      typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true,
    async run(input) {
      return { ok: true, steps: parsePlan(input.plan) };
    },
  };
  registry.register(tool);
}
