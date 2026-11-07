import { encodeWav, PhraseDetector } from '../../../shared/phrase-detector.ts';

export interface VoiceCaptureHandlers {
  /** A phrase finished; WAV bytes ready for transcription. */
  readonly onPhrase: (wav: Uint8Array) => void;
  /** The user started (true) or stopped (false) speaking. */
  readonly onSpeech?: (speaking: boolean) => void;
  readonly onError?: (message: string) => void;
}

const SAMPLE_RATE = 16_000;
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
  #detector = new PhraseDetector({ sampleRate: SAMPLE_RATE });
  #muted = false;

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
