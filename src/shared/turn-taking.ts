/**
 * Turn-taking for spoken conversation: people pause mid-sentence, so one
 * request often arrives as several phrases. The collector joins them and
 * finishes the turn only after the speaker has been quiet for a moment and
 * every phrase has been transcribed. Pure code, shared with tests.
 */

export interface TurnCollectorOptions {
  /** Extra quiet time after a phrase ends before the turn is over. */
  readonly endOfTurnMs?: number;
  /** Timer hook for tests; returns a function that cancels the timer. */
  readonly schedule?: (callback: () => void, ms: number) => () => void;
}

const defaultSchedule = (callback: () => void, ms: number): (() => void) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

export class TurnCollector {
  readonly #onTurn: (text: string) => void;
  readonly #endOfTurnMs: number;
  readonly #schedule: (callback: () => void, ms: number) => () => void;
  /** Transcripts in speaking order; undefined while still being transcribed. */
  #slots: (string | undefined)[] = [];
  #speaking = false;
  #quietLongEnough = false;
  #cancelTimer: (() => void) | undefined;
  /** Bumped by reset() so late transcripts from an abandoned turn are dropped. */
  #generation = 0;

  constructor(onTurn: (text: string) => void, options: TurnCollectorOptions = {}) {
    this.#onTurn = onTurn;
    this.#endOfTurnMs = options.endOfTurnMs ?? 1000;
    this.#schedule = options.schedule ?? defaultSchedule;
  }

  /** Words heard so far in this turn. */
  get text(): string {
    return this.#slots.filter((slot): slot is string => Boolean(slot)).join(' ');
  }

  /** True while the speaker is talking or the turn has words not yet sent. */
  get active(): boolean {
    return this.#speaking || this.#slots.length > 0;
  }

  speechStarted(): void {
    this.#speaking = true;
    this.#quietLongEnough = false;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
  }

  /** The speaker went quiet (the phrase may follow via addPhrase, or was too short). */
  speechEnded(): void {
    this.#speaking = false;
    this.#cancelTimer?.();
    this.#cancelTimer = this.#schedule(() => {
      this.#cancelTimer = undefined;
      this.#quietLongEnough = true;
      this.#finishIfReady();
    }, this.#endOfTurnMs);
  }

  /** Reserve the next place for a phrase being transcribed; call the returned function with its text. */
  addPhrase(): (text: string | undefined) => void {
    const index = this.#slots.length;
    const generation = this.#generation;
    this.#slots.push(undefined);
    return text => {
      if (generation !== this.#generation || index >= this.#slots.length) return;
      this.#slots[index] = text?.trim() ?? '';
      this.#finishIfReady();
    };
  }

  /** Forget the turn in progress (conversation ended, or Vyom started speaking). */
  reset(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#slots = [];
    this.#speaking = false;
    this.#quietLongEnough = false;
    this.#generation += 1;
  }

  #finishIfReady(): void {
    if (this.#speaking || !this.#quietLongEnough) return;
    if (this.#slots.some(slot => slot === undefined)) return;
    const text = this.text;
    this.reset();
    if (text) this.#onTurn(text);
  }
}
