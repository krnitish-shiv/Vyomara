import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * What the assistant remembers across conversations: the user's preferences
 * and facts about their projects ("tests run with pnpm check"). Kept in the
 * app's data folder as a small JSON file the user can review and edit in the
 * Memories panel. Secrets are refused.
 */
export interface MemoryEntry {
  readonly id: string;
  readonly text: string;
  /** Absolute project root when the memory is about one project; absent for the user in general. */
  readonly project?: string;
  readonly createdAt: string;
}

export const MAX_MEMORY_CHARS = 300;
const MAX_ENTRIES = 200;

/** Passwords, API keys, tokens, and private keys must never be stored. */
export function looksSecret(text: string): boolean {
  return /\b(?:password|passwd|pass ?code|pin|api[_ -]?key|secret|token|private key|otp)\b\s*(?:is|=|:)/iu.test(text) ||
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[bpas]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY/u.test(text);
}

export class MemoryStore {
  readonly #path: string;

  constructor(dataDirectory: string) {
    this.#path = join(dataDirectory, 'memories.json');
  }

  list(): MemoryEntry[] {
    try {
      const value: unknown = JSON.parse(readFileSync(this.#path, 'utf8'));
      if (!Array.isArray(value)) return [];
      return value.filter((entry): entry is MemoryEntry =>
        typeof entry === 'object' && entry !== null &&
        typeof (entry as MemoryEntry).id === 'string' &&
        typeof (entry as MemoryEntry).text === 'string' &&
        typeof (entry as MemoryEntry).createdAt === 'string' &&
        ((entry as MemoryEntry).project === undefined || typeof (entry as MemoryEntry).project === 'string'));
    } catch {
      return [];
    }
  }

  /**
   * Memories for the prompt: general ones and this project's first, then
   * other projects' (each is labelled with its project), within a size budget.
   */
  relevant(project: string | undefined, maxChars = 4_000): MemoryEntry[] {
    const root = project === undefined ? undefined : resolve(project);
    const entries = this.list();
    const ordered = [
      ...entries.filter(entry => entry.project === undefined || entry.project === root),
      ...entries.filter(entry => entry.project !== undefined && entry.project !== root),
    ];
    const chosen: MemoryEntry[] = [];
    let used = 0;
    for (const entry of ordered) {
      used += entry.text.length + (entry.project?.length ?? 0) + 20;
      if (used > maxChars) break;
      chosen.push(entry);
    }
    return chosen;
  }

  add(text: string, project?: string): { readonly entry: MemoryEntry; readonly duplicate: boolean } {
    const clean = text.replace(/\s+/gu, ' ').trim();
    if (clean === '') throw new Error('Nothing to remember.');
    if (clean.length > MAX_MEMORY_CHARS) throw new Error(`Keep a memory under ${MAX_MEMORY_CHARS} characters.`);
    if (looksSecret(clean)) throw new Error('Passwords, keys, and tokens are never remembered.');
    const root = project === undefined ? undefined : resolve(project);
    const entries = this.list();
    const existing = entries.find(entry => entry.text.toLowerCase() === clean.toLowerCase() && entry.project === root);
    if (existing) return { entry: existing, duplicate: true };
    const entry: MemoryEntry = {
      id: randomUUID(),
      text: clean,
      ...(root === undefined ? {} : { project: root }),
      createdAt: new Date().toISOString(),
    };
    this.#write([...entries, entry].slice(-MAX_ENTRIES));
    return { entry, duplicate: false };
  }

  remove(id: string): boolean {
    const entries = this.list();
    const kept = entries.filter(entry => entry.id !== id);
    if (kept.length === entries.length) return false;
    this.#write(kept);
    return true;
  }

  #write(entries: readonly MemoryEntry[]): void {
    mkdirSync(join(this.#path, '..'), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
