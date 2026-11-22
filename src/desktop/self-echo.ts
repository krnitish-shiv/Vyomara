/**
 * The last line of defence against the twin hearing itself: remembers what
 * was just spoken and recognises a transcript that is only the twin's own
 * words coming back through the microphone (speakers, room echo, a missed
 * mute). Such a transcript is dropped instead of being answered. Pure code.
 */
import { matchScore, skeletons } from '../shared/hinglish-match.ts';

/** How long after speech ends its words can still come back. */
const ECHO_WINDOW_MS = 6_000;
/** How long spoken lines are kept for comparison. */
const KEEP_MS = 90_000;
/** Share of the transcript's words that must come from recent speech. */
const ECHO_SHARE = 0.7;

export class SelfEchoGuard {
  #spoken: { readonly text: string; readonly at: number }[] = [];
  #speakingSince: number | undefined;
  #lastEnded = Number.NEGATIVE_INFINITY;

  /** A line is about to be spoken. */
  noteSpoken(text: string, now = Date.now()): void {
    this.#spoken = this.#spoken.filter(item => now - item.at < KEEP_MS);
    this.#spoken.push({ text, at: now });
    this.#speakingSince ??= now;
  }

  /** Playback stopped (finished or interrupted). */
  noteEnded(now = Date.now()): void {
    this.#speakingSince = undefined;
    this.#lastEnded = now;
  }

  /** True when the transcript is the twin's own recent words. */
  isEcho(transcript: string, now = Date.now()): boolean {
    const speakingOrJustSpoke = this.#speakingSince !== undefined || now - this.#lastEnded < ECHO_WINDOW_MS;
    if (!speakingOrJustSpoke) return false;
    if (skeletons(transcript).size === 0) return false;
    const recent = this.#spoken.filter(item => now - item.at < KEEP_MS).map(item => item.text).join(' ');
    return recent !== '' && matchScore(transcript, recent) >= ECHO_SHARE;
  }
}
