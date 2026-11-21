import { encodeWav, PhraseDetector } from '../../../shared/phrase-detector.ts';

export interface VoiceCaptureHandlers {
  /** A phrase finished; WAV bytes ready for transcription. */
  readonly onPhrase: (wav: Uint8Array) => void;
  /** The user started (true) or stopped (false) speaking. */
  readonly onSpeech?: (speaking: boolean) => void;
  readonly onError?: (message: string) => void;
}

const SAMPLE_RATE = 16_000;
/** Loudness (RMS) that counts as the user speaking over the reply, after echo cancellation. */
const BARGE_IN_RMS = 0.035;
/** Loud frames in a row (64 ms each) before the reply is interrupted. */
const BARGE_IN_FRAMES = 6;

function bargeInLevel(frame: Float32Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, frame.length));
}
const FRAME = 1_024; // 64 ms at 16 kHz

/**
 * Records the microphone in the renderer and cuts it into phrases, ending a
 * phrase after ~0.65 s of silence. Muted while Vyom speaks so its own voice
 * is not taken as a command.
 */
export class VoiceCapture {
  #stream: MediaStream | undefined;
  #context: AudioContext | undefined;
  #processor: ScriptProcessorNode | undefined;
  // A short phrase gap: the turn collector joins phrases and decides from the words when the turn is over.
  #detector = new PhraseDetector({ sampleRate: SAMPLE_RATE, endSilenceMs: 500 });
  #muted = false;
  /** While the twin speaks through this window: listen only for the user talking over it. */
  #bargeIn: (() => void) | undefined;
  #loudFrames = 0;

  get active(): boolean {
    return this.#stream !== undefined;
  }

  #starting: Promise<void> | undefined;

  /** Start recording; calling it again while active (or starting) is a no-op. */
  start(handlers: VoiceCaptureHandlers): Promise<void> {
    if (this.#stream) return Promise.resolve();
    this.#starting ??= this.#start(handlers).finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #start(handlers: VoiceCaptureHandlers): Promise<void> {
    try {
      this.#stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      handlers.onError?.('The microphone could not be opened. Check microphone access for Vyomara in System Settings.');
      return;
    }
    // Chromium resamples the microphone to the context's rate.
    this.#context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = this.#context.createMediaStreamSource(this.#stream);
    this.#processor = this.#context.createScriptProcessor(FRAME, 1, 1);
    this.#processor.onaudioprocess = event => {
      if (this.#bargeIn) {
        // The echo canceller removes the twin's own voice; what is left and
        // loud for ~0.4 s is the user talking over it.
        if (bargeInLevel(event.inputBuffer.getChannelData(0)) > BARGE_IN_RMS) this.#loudFrames += 1;
        else this.#loudFrames = Math.max(0, this.#loudFrames - 1);
        if (this.#loudFrames >= BARGE_IN_FRAMES) {
          const interrupt = this.#bargeIn;
          this.#bargeIn = undefined;
          this.#loudFrames = 0;
          interrupt();
        }
        return;
      }
      if (this.#muted) return;
      const frame = new Float32Array(event.inputBuffer.getChannelData(0));
      const result = this.#detector.push(frame);
      if (!result) return;
      if (result.type === 'speech-start') handlers.onSpeech?.(true);
      else {
        handlers.onSpeech?.(false);
        if (result.type === 'phrase') handlers.onPhrase(encodeWav(result.samples, SAMPLE_RATE));
      }
    };
    source.connect(this.#processor);
    // A ScriptProcessor only runs while connected to the destination; it outputs silence.
    this.#processor.connect(this.#context.destination);
  }

  /** End the phrase in progress now; returns its WAV if it contained speech. */
  flush(): Uint8Array | undefined {
    const samples = this.#detector.flush();
    return samples ? encodeWav(samples, SAMPLE_RATE) : undefined;
  }

  /** Ignore the microphone (while Vyom is speaking). */
  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#bargeIn = undefined;
    this.#loudFrames = 0;
    this.#detector.reset();
  }

  /**
   * While the twin's voice plays in this window (so the echo canceller hears
   * it), call `onInterrupt` once if the user talks over it. Undefined ends
   * the mode and leaves the microphone muted until setMuted(false).
   */
  setBargeIn(onInterrupt: (() => void) | undefined): void {
    this.#bargeIn = onInterrupt;
    this.#loudFrames = 0;
    this.#muted = true;
    this.#detector.reset();
  }

  stop(): void {
    this.#processor?.disconnect();
    this.#processor = undefined;
    void this.#context?.close().catch(() => undefined);
    this.#context = undefined;
    for (const track of this.#stream?.getTracks() ?? []) track.stop();
    this.#stream = undefined;
    this.#detector.reset();
  }
}
