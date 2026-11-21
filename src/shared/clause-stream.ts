/**
 * Turns a reply that arrives as streamed text into speakable clauses, so the
 * voice can start on the first clause while the model is still writing.
 * Pure code: used by the main process for spoken replies and by tests.
 *
 * - A clause ends at . ? ! । or a newline; after a few words a comma, colon,
 *   or semicolon also ends it, so long sentences start sooner.
 * - Markdown is spoken as plain words; code blocks become one short note.
 * - Everything after the app's footer ("---" + Verified actions / ⚠️) is
 *   never spoken, and speech stops after `maxChars` with a pointer to the screen.
 */
export interface ClauseStreamOptions {
  /** Spoken characters before the rest is left to the screen. */
  readonly maxChars?: number;
  /** A comma ends a clause only after this many words. */
  readonly minWordsForComma?: number;
  /** Said once when a reply is cut at maxChars. */
  readonly overflowNote?: string;
  /** Said once in place of a code block. */
  readonly codeNote?: string;
}

const HARD_END = /[.?!।]["')\]]?(?=\s)|\n/u;
const SOFT_END = /[,;:](?=\s)/u;

/** Plain spoken words for one clause of markdown. */
export function speakableClause(text: string): string {
  return text
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, 'a link')
    .replace(/^\s*#{1,6}\s*/gmu, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gmu, '')
    .replace(/[*_>|]/gu, '')
    .replace(/(?:~|\/Users\/[^/\s]+)(\/[\w.@-]+)+/gu, match => match.split('/').at(-1) ?? match)
    .replace(/\s+/gu, ' ')
    .trim();
}

export class ClauseStream {
  readonly #maxChars: number;
  readonly #minWordsForComma: number;
  readonly #overflowNote: string;
  readonly #codeNote: string;
  #buffer = '';
  #spoken = 0;
  #inCode = false;
  #saidCode = false;
  #finished = false;

  constructor(options: ClauseStreamOptions = {}) {
    this.#maxChars = options.maxChars ?? 420;
    this.#minWordsForComma = options.minWordsForComma ?? 5;
    this.#overflowNote = options.overflowNote ?? 'Baaki screen par hai.';
    this.#codeNote = options.codeNote ?? 'Code screen par dikha diya hai.';
  }

  /** True once the footer or the length limit was reached: nothing more is spoken. */
  get finished(): boolean {
    return this.#finished;
  }

  /** Add streamed text; returns the clauses that are now complete. */
  push(text: string): string[] {
    if (this.#finished) return [];
    this.#buffer += text;
    return this.#drain(false);
  }

  /** The reply is complete: return whatever is left. */
  end(): string[] {
    if (this.#finished) return [];
    const clauses = this.#drain(true);
    this.#finished = true;
    return clauses;
  }

  #drain(final: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      if (this.#finished) break;
      // The app's own footer ends speech.
      const footer = /\n\s*-{3,}\s*\n|\n\s*⚠️/u.exec(this.#buffer);
      if (footer) {
        this.#buffer = this.#buffer.slice(0, footer.index);
        this.#emitAll(out);
        this.#finished = true;
        break;
      }
      if (this.#inCode) {
        const close = this.#buffer.indexOf('```');
        if (close < 0) {
          if (final) this.#buffer = '';
          break;
        }
        this.#buffer = this.#buffer.slice(close + 3);
        this.#inCode = false;
        continue;
      }
      const fence = this.#buffer.indexOf('```');
      const cut = this.#nextCut(fence < 0 ? this.#buffer : this.#buffer.slice(0, fence));
      if (cut !== undefined) {
        this.#emit(this.#buffer.slice(0, cut), out);
        this.#buffer = this.#buffer.slice(cut);
        continue;
      }
      if (fence >= 0) {
        this.#emit(this.#buffer.slice(0, fence), out);
        this.#buffer = this.#buffer.slice(fence + 3);
        this.#inCode = true;
        if (!this.#saidCode) {
          this.#saidCode = true;
          this.#emit(this.#codeNote, out);
        }
        continue;
      }
      // A footer may still be arriving ("\n--"), so hold a trailing newline run back.
      if (final) {
        this.#emit(this.#buffer, out);
        this.#buffer = '';
      }
      break;
    }
    return out;
  }

  /** Index just after the end of the first complete clause, if any. */
  #nextCut(text: string): number | undefined {
    const hard = HARD_END.exec(text);
    // Hold a newline that might be the start of the footer until more text arrives.
    if (hard && hard[0] === '\n' && /^\n\s*-*\s*$/u.test(text.slice(hard.index))) return undefined;
    const soft = SOFT_END.exec(text);
    if (soft && (!hard || soft.index < hard.index)) {
      const words = text.slice(0, soft.index).trim().split(/\s+/u).filter(Boolean).length;
      if (words >= this.#minWordsForComma) return soft.index + 1;
    }
    return hard ? hard.index + hard[0].length : undefined;
  }

  #emit(raw: string, out: string[]): void {
    const clause = speakableClause(raw);
    if (!/[\p{L}\p{N}]/u.test(clause)) return;
    if (this.#spoken + clause.length > this.#maxChars && this.#spoken > 0) {
      out.push(this.#overflowNote);
      this.#finished = true;
      return;
    }
    this.#spoken += clause.length;
    out.push(clause);
  }

  #emitAll(out: string[]): void {
    const rest = this.#buffer;
    this.#buffer = '';
    if (this.#inCode) return;
    let remaining = rest;
    for (;;) {
      const cut = this.#nextCut(`${remaining} `);
      if (cut === undefined || cut >= remaining.length) break;
      this.#emit(remaining.slice(0, cut), out);
      if (this.#finished) return;
      remaining = remaining.slice(cut);
    }
    this.#emit(remaining, out);
  }
}
