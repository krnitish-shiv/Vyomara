import { ToolFailure, type Tool, type ToolRegistry } from './contracts.ts';
import { isTeamMemberId, TEAM, TEAM_IDS, type TeamMemberId } from '../agent/team.ts';

/** Filled in per request with a runner for the inner team (see runTeamMember). */
export interface DelegatePort {
  run?: (member: TeamMemberId, task: string, signal: AbortSignal) => Promise<string>;
}

interface Input { readonly member: TeamMemberId; readonly task: string }

/**
 * `delegate` hands a self-contained task to a member of the twins' inner team.
 * The member works in its own context with its own tool whitelist (effects
 * still need the user's approval) and returns a report for the twin to pass on.
 */
export function registerDelegateTool(registry: ToolRegistry, port: DelegatePort): void {
  const roster = TEAM_IDS.map(id => `${id} (${TEAM[id].when})`).join('; ');
  const tool: Tool<Input, Record<string, unknown>> = {
    id: 'delegate',
    effect: 'read',
    longRunning: true,
    description: `Hand a self-contained task to a specialist on your inner team, who works on it in their own context and reports back to you. Team: ${roster}. Write the task so it stands alone: what to find or produce, every detail the user gave (dates, budget, paths, tone), and what to report. You stay the one talking to the user; pass the report on in your own words.`,
    parameters: {
      type: 'object',
      properties: {
        member: { type: 'string', pattern: `^(?:${TEAM_IDS.join('|')})$`, description: `Who takes the task: ${TEAM_IDS.join(', ')}.`, maxLength: 16 },
        task: { type: 'string', description: 'The complete, standalone task with all details and what to report.', maxLength: 3_000 },
      },
      required: ['member', 'task'],
      additionalProperties: false,
    },
    // Models sometimes write the name as shown ("Khoj"); accept any case.
    normalizeInput: value => typeof value === 'object' && value !== null && typeof (value as { member?: unknown }).member === 'string'
      ? { ...value, member: (value as { member: string }).member.trim().toLowerCase() }
      : value,
    validateInput: (value): value is Input => typeof value === 'object' && value !== null
      && isTeamMemberId((value as { member?: unknown }).member)
      && typeof (value as { task?: unknown }).task === 'string' && (value as { task: string }).task.trim().length >= 10
      && Object.keys(value).every(key => key === 'member' || key === 'task'),
    inputError: () => `member must be one of ${TEAM_IDS.join(', ')}, and task a complete request of at least a few words.`,
    validateOutput: (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
    async run(input, signal) {
      if (!port.run) throw new ToolFailure('The inner team is not available here; do the task yourself with your own tools.', 'unsupported-operation');
      const report = await port.run(input.member, input.task.trim(), signal);
      return { member: TEAM[input.member].name, report };
    },
  };
  registry.register(tool);
}
