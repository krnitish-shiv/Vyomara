/**
 * Plays the twin's synthesized speech in this window. Playing it here (not
 * with afplay) lets Chromium's echo canceller subtract it from the
 * microphone, so the user can talk over the reply to interrupt it.
 */
export class SpeechPlayer {
  #current: { readonly id: number; readonly audio: HTMLAudioElement; readonly url: string } | undefined;
  readonly #onPlaying: (playing: boolean) => void;

  constructor(onPlaying: (playing: boolean) => void) {
    this.#onPlaying = onPlaying;
  }

  get playing(): boolean {
    return this.#current !== undefined;
  }

  play(id: number, bytes: Uint8Array, done: (status: 'completed' | 'cancelled' | 'failed') => void): void {
    this.#finish('cancelled');
    const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'audio/wav' }));
    const audio = new Audio(url);
    const current = { id, audio, url };
    this.#current = current;
    const end = (status: 'completed' | 'failed'): void => {
      if (this.#current !== current) return;
      this.#release();
      done(status);
    };
    audio.addEventListener('ended', () => end('completed'), { once: true });
    audio.addEventListener('error', () => end('failed'), { once: true });
    this.#cancel = () => done('cancelled');
    this.#onPlaying(true);
    audio.play().catch(() => end('failed'));
  }

  /** Stop the clip with this id (or any clip when id is omitted). */
  stop(id?: number): void {
    if (this.#current && (id === undefined || this.#current.id === id)) this.#finish('cancelled');
  }

  #cancel: (() => void) | undefined;

  #finish(status: 'cancelled'): void {
    if (!this.#current) return;
    const cancel = this.#cancel;
    this.#current.audio.pause();
    this.#release();
    if (status === 'cancelled') cancel?.();
  }

  #release(): void {
    if (!this.#current) return;
    URL.revokeObjectURL(this.#current.url);
    this.#current = undefined;
    this.#cancel = undefined;
    this.#onPlaying(false);
  }
}
