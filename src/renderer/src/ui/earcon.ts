/**
 * Short, quiet tones that make spoken conversation feel live without words:
 * Vyom started listening, got your request, or stopped listening.
 */
export type Earcon = 'start' | 'sent' | 'end' | 'brand';

const NOTES: Record<Earcon, readonly number[]> = {
  start: [587, 880],
  sent: [988],
  end: [880, 587],
  /** The Vyomara signature, played after the assistant introduces itself. */
  brand: [587.33, 880, 1174.66],
};

let context: AudioContext | undefined;

/** Plays the tone and resolves when it has finished (~0.2 s). */
export function playEarcon(kind: Earcon): Promise<void> {
  try {
    context ??= new AudioContext();
    const audio = context;
    void audio.resume().catch(() => undefined);
    const notes = NOTES[kind];
    if (kind === 'brand') return playChime(audio, notes);
    const step = 0.085;
    const start = audio.currentTime + 0.01;
    notes.forEach((frequency, index) => {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      const at = start + index * step;
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.07, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0005, at + step + 0.05);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + step + 0.06);
    });
    const duration = (notes.length * step + 0.08) * 1000;
    return new Promise(resolve => setTimeout(resolve, duration));
  } catch {
    return Promise.resolve();
  }
}

/** A brighter, ringing three-note chime with a soft overtone. */
function playChime(audio: AudioContext, notes: readonly number[]): Promise<void> {
  const step = 0.13;
  const ring = 0.55;
  const start = audio.currentTime + 0.02;
  notes.forEach((frequency, index) => {
    const at = start + index * step;
    for (const [multiple, level] of [[1, 0.22], [2, 0.06]] as const) {
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency * multiple;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(level, at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0005, at + ring);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(at);
      oscillator.stop(at + ring + 0.02);
    }
  });
  const duration = ((notes.length - 1) * step + ring) * 1000;
  return new Promise(resolve => setTimeout(resolve, duration));
}
