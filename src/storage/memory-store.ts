import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { matchScore } from '../shared/hinglish-match.ts';

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

/** Luhn checksum: real card numbers pass it, prices and phone numbers almost never do. */
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Passwords, API keys, tokens, private keys, card numbers, Aadhaar and PAN
 * numbers, and one-time codes must never be stored, in English or Hinglish
 * ("mera otp 482913 hai").
 */
export function looksSecret(text: string): boolean {
  if (/\b(?:password|passwd|pass ?code|pin|api[_ -]?key|secret|token|private key|otp|cvv|upi pin)\b\s*(?:is|=|:)/iu.test(text)) return true;
  if (/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[bpas]-[A-Za-z0-9-]{10,}|\bAIza[0-9A-Za-z_-]{30,}|\bhf_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY/u.test(text)) return true;
  // Hinglish: "otp 482913 hai", "mera pin 4821", "password abc@123 hai".
  // (A postal "PIN code" / "pincode" is an address, not a secret.)
  const withoutPostal = text.replace(/\bpin ?code\b/giu, 'postcode');
  if (/\b(?:otp|pin|cvv|passcode|upi pin)\b\W*(?:\p{L}+\W+){0,3}?\d{3,8}\b/iu.test(withoutPostal)) return true;
  if (/\bpassword\b\W*(?:\p{L}+\W+){0,2}?(?=\S*\d)(?=\S*\p{L})\S{6,}/iu.test(text)) return true;
  // Card numbers (13–19 digits, spaces or dashes allowed) that pass the Luhn check.
  for (const match of text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/gu)) {
    const digits = match[0].replace(/\D/gu, '');
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) return true;
  }
  // Aadhaar (12 digits, often 4-4-4) and PAN (ABCDE1234F).
  if (/\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/u.test(text) && /aadha+r|आधार|uid/iu.test(text)) return true;
  if (/\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/u.test(text)) return true;
  return false;
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
  relevant(project: string | undefined, maxChars = 4_000, query = ''): MemoryEntry[] {
    const root = project === undefined ? undefined : resolve(project);
    const entries = this.list();
    const byProject = [
      ...entries.filter(entry => entry.project === undefined || entry.project === root),
      ...entries.filter(entry => entry.project !== undefined && entry.project !== root),
    ];
    // Memories that match the request come first (Roman, Devanagari, or any
    // spelling), so they survive the size budget; ties keep the project order.
    const ordered = query.trim() === ''
      ? byProject
      : byProject
        .map((entry, index) => ({ entry, index, score: matchScore(query, entry.text) }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map(item => item.entry);
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
