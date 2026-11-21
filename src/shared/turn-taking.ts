/**
 * Turn-taking for spoken conversation: people pause mid-sentence, so one
 * request often arrives as several phrases. The collector joins them and
 * finishes the turn only after the speaker has been quiet for a moment and
 * every phrase has been transcribed. Pure code, shared with tests.
 */

export interface TurnCollectorOptions {
  /** Quiet time after a phrase ends before the turn is over, when no transcript says otherwise. */
  readonly endOfTurnMs?: number;
  /**
   * Quiet time to wait given the words heard so far (see turnPauseMs): short
   * when the sentence sounds finished, long when it trails off ("aur…").
   */
  readonly pauseFor?: (text: string) => number;
  /** Timer hook for tests; returns a function that cancels the timer. */
  readonly schedule?: (callback: () => void, ms: number) => () => void;
  /** Clock hook for tests. */
  readonly now?: () => number;
}

const defaultSchedule = (callback: () => void, ms: number): (() => void) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

/** Words a Hinglish/English sentence does not end on: the speaker is still going. */
const TRAILING = /(?:^|[\s,])(?:aur|ya|ki|ke|ka|ko|se|mein|me|par|pe|lekin|magar|kyunki|kyonki|matlab|jaise|phir|fir|toh|to|bhi|jo|jab|agar|and|or|but|the|a|an|of|with|for|because|so|like|uh|um|umm|hmm|और|या|कि|के|का|को|से|में|पर|लेकिन|क्योंकि|मतलब|जैसे|फिर|तो|अगर)[\s,.…-]*$/iu;
/** Endings of a finished request or question. */
const FINISHED = /(?:[?!।]|\.(?!\.))\s*$|(?:^|\s)(?:karo|kar do|kardo|kariye|kijiye|do|dijiye|batao|bataiye|dikhao|kholo|khol do|chalao|chala do|bajao|band karo|ruko|bas|hai|hain|tha|thi|please|thanks|thank you|na|ok|okay|theek hai|haan|nahi|करो|कर दो|दो|बताओ|दिखाओ|खोलो|चलाओ|है|हैं|था|थी|हाँ|नहीं)\s*$/iu;

/**
 * How long to wait for more speech, from the words heard so far. A finished
 * sentence ends the turn quickly (whisper adds the punctuation); a sentence
 * that trails off on "aur", "ki", "and"… waits longer so a thinking pause is
 * not cut. Pure, so it can be tuned against real transcripts.
 */
export function turnPauseMs(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 900;
  if (/(?:\.\.\.|…)\s*$/u.test(trimmed) || TRAILING.test(trimmed)) return 1_800;
  if (FINISHED.test(trimmed)) return 350;
  return 900;
}

export class TurnCollector {
  readonly #onTurn: (text: string, audio: readonly Uint8Array[]) => void;
  readonly #endOfTurnMs: number;
  readonly #pauseFor: ((text: string) => number) | undefined;
  readonly #schedule: (callback: () => void, ms: number) => () => void;
  readonly #now: () => number;
  /** Transcripts in speaking order; undefined while still being transcribed. */
  #slots: (string | undefined)[] = [];
  /** Each phrase's recording, in speaking order, handed over with the turn. */
  #audio: Uint8Array[] = [];
  #speaking = false;
  /** When the speaker last went quiet (undefined while speaking). */
  #quietSince: number | undefined;
  #cancelTimer: (() => void) | undefined;
  /** Bumped by reset() so late transcripts from an abandoned turn are dropped. */
  #generation = 0;

  constructor(onTurn: (text: string, audio: readonly Uint8Array[]) => void, options: TurnCollectorOptions = {}) {
    this.#onTurn = onTurn;
    this.#endOfTurnMs = options.endOfTurnMs ?? 1000;
    this.#pauseFor = options.pauseFor;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#now = options.now ?? Date.now;
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
    this.#quietSince = undefined;
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
  }

  /** The speaker went quiet (the phrase may follow via addPhrase, or was too short). */
  speechEnded(): void {
    this.#speaking = false;
    this.#quietSince = this.#now();
    this.#arm();
  }

  /** Reserve the next place for a phrase being transcribed; call the returned function with its text. */
  addPhrase(audio?: Uint8Array): (text: string | undefined) => void {
    const index = this.#slots.length;
    const generation = this.#generation;
    this.#slots.push(undefined);
    if (audio) this.#audio.push(audio);
    this.#arm();
    return text => {
      if (generation !== this.#generation || index >= this.#slots.length) return;
      this.#slots[index] = text?.trim() ?? '';
      this.#arm();
    };
  }

  /** Forget the turn in progress (conversation ended, or Vyom started speaking). */
  reset(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    this.#slots = [];
    this.#audio = [];
    this.#speaking = false;
    this.#quietSince = undefined;
    this.#generation += 1;
  }

  /** (Re)start the end-of-turn timer from what is known now. */
  #arm(): void {
    this.#cancelTimer?.();
    this.#cancelTimer = undefined;
    if (this.#speaking || this.#quietSince === undefined) return;
    // Every phrase must be transcribed first; the last transcript re-arms the timer.
    if (this.#slots.some(slot => slot === undefined)) return;
    const wait = this.#slots.length > 0 && this.#pauseFor ? this.#pauseFor(this.text) : this.#endOfTurnMs;
    const remaining = wait - (this.#now() - this.#quietSince);
    if (remaining <= 0) {
      this.#finish();
      return;
    }
    this.#cancelTimer = this.#schedule(() => {
      this.#cancelTimer = undefined;
      this.#finish();
    }, remaining);
  }

  #finish(): void {
    if (this.#speaking || this.#slots.some(slot => slot === undefined)) return;
    const text = this.text;
    const audio = this.#audio;
    this.reset();
    if (text) this.#onTurn(text, audio);
  }
}
