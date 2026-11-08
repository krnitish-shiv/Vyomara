import { ToolFailure, type Tool, type ToolRegistry } from './contracts.ts';

/** Filled in per request with a helper agent that only looks (see runExplorer). */
export interface ExplorePort {
  run?: (task: string, signal: AbortSignal) => Promise<string>;
}

interface Input { readonly task: string }

/**
 * `explore` hands a self-contained code question to a read-only helper that
 * searches and reads on its own, in its own context, and reports back. The
 * main conversation then holds one short report instead of many file dumps.
 */
export function registerExploreTool(registry: ToolRegistry, port: ExplorePort): void {
  const tool: Tool<Input, Record<string, unknown>> = {
    id: 'explore',
    effect: 'read',
    description: 'Hand a self-contained research question about code to a read-only helper that searches and reads files on its own and reports back the answer with path:line references, e.g. "In /Users/me/Projects/shop, where is the cart total computed and what calls it?". Use it for broad searches across many files, so your own context stays small. Include the project path. It cannot change anything.',
    parameters: {
      type: 'object',
      properties: { task: { type: 'string', description: 'The question, with the absolute project path and what to report.', maxLength: 2_000 } },
      required: ['task'],
      additionalProperties: false,
    },
    validateInput: (value): value is Input => typeof value === 'object' && value !== null
      && typeof (value as { task?: unknown }).task === 'string' && (value as { task: string }).task.trim().length >= 10
      && Object.keys(value).every(key => key === 'task'),
    inputError: () => 'task must be a clear question (at least a few words) with the project path.',
    validateOutput: (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
    async run(input, signal) {
      if (!port.run) throw new ToolFailure('The explore helper is not available here; search with find_files and search_text yourself.', 'unsupported-operation');
      return { report: await port.run(input.task.trim(), signal) };
    },
  };
  registry.register(tool);
}
