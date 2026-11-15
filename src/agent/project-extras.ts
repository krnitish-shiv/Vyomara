import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Project conveniences, like Claude Code's:
 * - slash commands: "/review src/cart.ts" expands to a full prompt, from
 *   <project>/.vyomara/commands/<name>.md, ~/.vyomara/commands/<name>.md, or
 *   the built-ins below ($ARGUMENTS is replaced by the rest of the line);
 * - hooks: <project>/.vyomara/hooks.json, e.g. {"afterEdit": "pnpm exec eslint --fix ."},
 *   run (through the normal command approval) after each applied edit.
 */

export const BUILT_IN_COMMANDS: Readonly<Record<string, string>> = {
  review: 'Review my uncommitted changes$IN_PROJECT. Use git_info (status, then diff, and the staged diff) and read the surrounding code where needed. Report real problems only: bugs, missing edge cases, broken behaviour, security issues, and missing tests, each with path:line, severity, and a concrete fix. Do not change anything. $ARGUMENTS',
  fix: 'Find and fix every type error and lint problem$IN_PROJECT: run check_problems on the project root, fix the causes in the code (not by disabling checks), and run check_problems again until it is clean. $ARGUMENTS',
  test: 'Run the project\'s tests$IN_PROJECT. If any fail, read the failing tests and the code under test, find the root cause, fix the code (change a test only if the test itself is wrong), and run the tests again until they pass. $ARGUMENTS',
  commit: 'Commit my current changes$IN_PROJECT: look at git_info status and diff, then call git_commit with a short, clear message that says what changed and why (group unrelated changes into separate commits by passing files). Do not push. $ARGUMENTS',
  explain: 'Explain $ARGUMENTS$IN_PROJECT: read the relevant code first, then explain what it does, how the pieces connect (with path:line references), and anything surprising.',
};

export async function expandSlashCommand(prompt: string, project: string | undefined, home = homedir()): Promise<{ readonly prompt: string; readonly command?: string }> {
  const match = /^\/([a-z][a-z0-9-]{0,40})(?:\s+([\s\S]*))?$/iu.exec(prompt.trim());
  if (!match) return { prompt };
  const name = (match[1] as string).toLowerCase();
  const args = (match[2] ?? '').trim();
  const sources = [
    ...(project ? [join(project, '.vyomara', 'commands', `${name}.md`)] : []),
    join(home, '.vyomara', 'commands', `${name}.md`),
  ];
  let template: string | undefined;
  for (const source of sources) {
    template = await readFile(source, 'utf8').then(text => text.trim().slice(0, 20_000)).catch(() => undefined);
    if (template) break;
  }
  template ??= BUILT_IN_COMMANDS[name];
  if (!template) return { prompt };
  const inProject = project ? ` in ${project}` : '';
  let expanded = template.replace(/\$IN_PROJECT/gu, inProject);
  expanded = expanded.includes('$ARGUMENTS') ? expanded.replace(/\$ARGUMENTS/gu, args) : `${expanded}${args ? `\n\n${args}` : ''}`;
  return { prompt: expanded.trim(), command: name };
}

export interface ProjectHooks {
  readonly afterEdit?: string;
}

/** The nearest .vyomara/hooks.json above a changed file (up to the home folder). */
export async function hooksFor(path: string, home = homedir()): Promise<{ readonly root: string; readonly hooks: ProjectHooks } | undefined> {
  let folder = dirname(path);
  for (let depth = 0; depth < 12 && folder.startsWith(home) && folder !== dirname(folder); depth += 1) {
    const text = await readFile(join(folder, '.vyomara', 'hooks.json'), 'utf8').catch(() => undefined);
    if (text !== undefined) {
      try {
        const value: unknown = JSON.parse(text);
        const afterEdit = typeof value === 'object' && value !== null ? (value as { afterEdit?: unknown }).afterEdit : undefined;
        return { root: folder, hooks: typeof afterEdit === 'string' && afterEdit.trim() !== '' ? { afterEdit: afterEdit.trim().slice(0, 2_000) } : {} };
      } catch {
        return undefined;
      }
    }
    folder = dirname(folder);
  }
  return undefined;
}
