import { isAbsolute } from 'node:path';
import { MAX_MEMORY_CHARS, type MemoryStore } from '../storage/memory-store.ts';
import { ToolFailure, type Tool, type ToolRegistry } from './contracts.ts';

interface RememberInput {
  readonly text: string;
  readonly project_path?: string;
}

interface RememberOutput {
  readonly ok: true;
  readonly remembered: string;
  readonly project?: string;
  readonly duplicate: boolean;
  readonly note: string;
}

function rememberError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'Arguments must be a JSON object.';
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'text' && key !== 'project_path')) return 'Use only text and project_path.';
  if (typeof record.text !== 'string' || record.text.trim() === '' || record.text.length > MAX_MEMORY_CHARS) {
    return `text must be one short fact (1-${MAX_MEMORY_CHARS} characters).`;
  }
  if (record.project_path !== undefined && (typeof record.project_path !== 'string' || !isAbsolute(record.project_path))) {
    return 'project_path must be an absolute path to the project root.';
  }
  return undefined;
}

/**
 * `remember` saves one lasting fact for future conversations. It changes only
 * Vyomara's own memory list (shown in Verified actions and the Memories
 * panel, where the user can delete it), never the user's files.
 */
export function registerMemoryTool(registry: ToolRegistry, store: MemoryStore): void {
  const tool: Tool<RememberInput, RememberOutput> = {
    id: 'remember',
    effect: 'read',
    description: 'Save one short, lasting fact for future conversations. Write it in English, in the third person, so it reads correctly later: "The user\'s main project is KeylessRN.", "The user runs tests with pnpm check.", "Reply to the user in Hinglish." Use when the user asks you to remember something ("yaad rakhna") or states a lasting preference. Save each fact separately. Never save secrets, passwords, keys, or one-off details. Pass project_path (the project root) when the fact is about one project.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The fact: one short English sentence about the user, e.g. "The user\'s main project is KeylessRN."', maxLength: MAX_MEMORY_CHARS },
        project_path: { type: 'string', description: 'Optional absolute project root the fact belongs to.', maxLength: 4_096 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    validateInput: (value): value is RememberInput => rememberError(value) === undefined,
    inputError: rememberError,
    validateOutput: (value): value is RememberOutput =>
      typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true,
    async run(input) {
      try {
        const { entry, duplicate } = store.add(input.text, input.project_path);
        return {
          ok: true,
          remembered: entry.text,
          ...(entry.project ? { project: entry.project } : {}),
          duplicate,
          note: 'Saved. Tell the user briefly, in their language, what you will remember.',
        };
      } catch (error) {
        throw new ToolFailure(error instanceof Error ? error.message : 'The memory could not be saved.', 'tool-failed');
      }
    },
  };
  registry.register(tool);
}
