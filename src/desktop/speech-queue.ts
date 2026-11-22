/**
 * Speaks a reply clause by clause while it is still being written: each
 * clause is prepared (synthesized) while the previous one plays, so there is
 * no gap between them and the first words come as soon as the first clause
 * is complete.
 */
export interface SpeechQueuePorts<Prepared> {
  prepare(text: string): Promise<Prepared | undefined>;
  play(prepared: Prepared): Promise<unknown>;
  discard(prepared: Prepared): void;
}

export class SpeechQueue<Prepared> {
  readonly #ports: SpeechQueuePorts<Prepared>;
  readonly #onSpeaking: ((speaking: boolean) => void) | undefined;
  #pending: string[] = [];
  #closed = false;
  #cancelled = false;
  #started = false;
  #worker: Promise<void> | undefined;
  #wake: (() => void) | undefined;
  #playing = false;
  /** Clauses taken from the queue and still being prepared. */
  #preparing = 0;

  constructor(ports: SpeechQueuePorts<Prepared>, onSpeaking?: (speaking: boolean) => void) {
    this.#ports = ports;
    this.#onSpeaking = onSpeaking;
  }

  /** Something is queued or playing right now. */
  get busy(): boolean {
    return this.#playing || this.#preparing > 0 || this.#pending.length > 0;
  }

  /** True once at least one clause began playing. */
  get started(): boolean {
    return this.#started;
  }

  enqueue(text: string): void {
    if (this.#closed || this.#cancelled || text.trim() === '') return;
    this.#pending.push(text);
    this.#worker ??= this.#run();
    this.#wake?.();
  }

  /** No more clauses will come; resolves when everything queued has been spoken. */
  close(): Promise<void> {
    this.#closed = true;
    this.#wake?.();
    return this.#worker ?? Promise.resolve();
  }

  /** Stop: drop what is queued (the caller stops the clause that is playing). */
  cancel(): Promise<void> {
    this.#cancelled = true;
    this.#pending = [];
    this.#wake?.();
    return this.#worker ?? Promise.resolve();
  }

  async #run(): Promise<void> {
    let next: Promise<Prepared | undefined> | undefined;
    try {
      while (!this.#cancelled) {
        if (!next) {
          const text = this.#pending.shift();
          if (text !== undefined) next = this.#prepare(text);
          else if (this.#closed) break;
          else {
            await new Promise<void>(resolve => { this.#wake = resolve; });
            this.#wake = undefined;
          }
          continue;
        }
        const prepared = await next;
        next = undefined;
        // Prepare the following clause while this one plays.
        const following = this.#pending.shift();
        if (following !== undefined && !this.#cancelled) next = this.#prepare(following);
        if (prepared === undefined) continue;
        if (this.#cancelled) {
          this.#ports.discard(prepared);
          break;
        }
        if (!this.#started) {
          this.#started = true;
          this.#onSpeaking?.(true);
        }
        this.#playing = true;
        await this.#ports.play(prepared).catch(() => undefined);
        this.#playing = false;
      }
    } finally {
      if (next) void next.then(prepared => { if (prepared !== undefined) this.#ports.discard(prepared); });
      if (this.#started) this.#onSpeaking?.(false);
    }
  }

  #prepare(text: string): Promise<Prepared | undefined> {
    this.#preparing += 1;
    return this.#ports.prepare(text).catch(() => undefined).finally(() => { this.#preparing -= 1; });
  }
}
