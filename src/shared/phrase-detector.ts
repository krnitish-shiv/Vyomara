/**
 * Finds spoken phrases in a stream of 16 kHz mono samples using an adaptive
 * energy threshold. A phrase ends after a short silence, so it can be
 * transcribed immediately instead of waiting for a fixed polling interval.
 * Pure code: used by the renderer's microphone capture and by tests.
 */

export interface PhraseDetectorOptions {
  readonly sampleRate?: number;
  /** Silence that ends a phrase. */
  readonly endSilenceMs?: number;
  /** Shorter sounds (clicks, coughs) are ignored. */
  readonly minSpeechMs?: number;
  /** Long phrases are cut and sent at this length. */
  readonly maxPhraseMs?: number;
  /** Audio kept from just before speech starts, so first syllables are not lost. */
  readonly preRollMs?: number;
}

export type PhraseEvent =
  | { readonly type: 'speech-start' }
  | { readonly type: 'phrase'; readonly samples: Float32Array }
  | { readonly type: 'discard' };

function rms(frame: Float32Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, frame.length));
}

export class PhraseDetector {
  readonly #rate: number;
  readonly #endSilence: number;
  readonly #minSpeech: number;
  readonly #maxPhrase: number;
  readonly #preRoll: number;
  #noiseFloor = 0.004;
  /** Samples heard while measuring the room before detecting speech. */
  #calibrated = 0;
  #calibrationSum = 0;
  #calibrationFrames = 0;
  #speaking = false;
  #loudRun = 0;
  #silence = 0;
  #speech = 0;
  #frames: Float32Array[] = [];
  #preFrames: Float32Array[] = [];
  #preSamples = 0;

  constructor(options: PhraseDetectorOptions = {}) {
    this.#rate = options.sampleRate ?? 16_000;
    this.#endSilence = this.#samples(options.endSilenceMs ?? 650);
    this.#minSpeech = this.#samples(options.minSpeechMs ?? 250);
    this.#maxPhrase = this.#samples(options.maxPhraseMs ?? 14_000);
    this.#preRoll = this.#samples(options.preRollMs ?? 300);
  }

  #samples(ms: number): number {
    return Math.round((ms / 1000) * this.#rate);
  }

  get speaking(): boolean {
    return this.#speaking;
  }

  /** End the current phrase now (the user tapped stop), if it has enough speech. */
  flush(): Float32Array | undefined {
    if (!this.#speaking || this.#speech < this.#minSpeech) {
      this.reset();
      return undefined;
    }
    const length = this.#frames.reduce((sum, item) => sum + item.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    for (const item of this.#frames) {
      samples.set(item, offset);
      offset += item.length;
    }
    this.reset();
    return samples;
  }

  /** Forget any partial phrase (e.g. while Vyom itself is speaking). */
  reset(): void {
    this.#speaking = false;
    this.#loudRun = 0;
    this.#silence = 0;
    this.#speech = 0;
    this.#frames = [];
  }

  push(frame: Float32Array): PhraseEvent | undefined {
    const level = rms(frame);
    // Listen to the room for the first half second (fans, hum) before detecting speech.
    if (this.#calibrated < this.#rate / 2) {
      this.#calibrated += frame.length;
      this.#calibrationSum += level;
      this.#calibrationFrames += 1;
      this.#noiseFloor = Math.max(0.002, this.#calibrationSum / this.#calibrationFrames);
      return undefined;
    }
    const threshold = Math.max(this.#noiseFloor * 3, 0.012);
    const loud = level > threshold;

    if (!this.#speaking) {
      // Track background noise slowly so the threshold follows the room.
      if (!loud) this.#noiseFloor = this.#noiseFloor * 0.95 + level * 0.05;
      this.#preFrames.push(frame);
      this.#preSamples += frame.length;
      while (this.#preSamples - (this.#preFrames[0]?.length ?? 0) >= this.#preRoll) {
        this.#preSamples -= this.#preFrames.shift()?.length ?? 0;
      }
      this.#loudRun = loud ? this.#loudRun + frame.length : 0;
      // Two consecutive loud frames start a phrase.
      if (this.#loudRun >= frame.length * 2) {
        this.#speaking = true;
        this.#frames = [...this.#preFrames];
        this.#speech = this.#loudRun;
        this.#silence = 0;
        this.#preFrames = [];
        this.#preSamples = 0;
        return { type: 'speech-start' };
      }
      return undefined;
    }

    this.#frames.push(frame);
    if (loud) {
      this.#speech += frame.length;
      this.#silence = 0;
    } else {
      this.#silence += frame.length;
    }
    const length = this.#frames.reduce((sum, item) => sum + item.length, 0);
    if (this.#silence >= this.#endSilence || length >= this.#maxPhrase) {
      const enough = this.#speech >= this.#minSpeech;
      const samples = new Float32Array(length);
      let offset = 0;
      for (const item of this.#frames) {
        samples.set(item, offset);
        offset += item.length;
      }
      this.reset();
      return enough ? { type: 'phrase', samples } : { type: 'discard' };
    }
    return undefined;
  }
}

/** 16-bit PCM mono WAV file bytes for whisper. */
export function encodeWav(samples: Float32Array, sampleRate = 16_000): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}
