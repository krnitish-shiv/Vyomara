import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';

const SERVER_BINARIES = ['/opt/homebrew/bin/whisper-server', '/usr/local/bin/whisper-server'];
/** 16 kHz mono 16-bit audio is 32 KB/s; utterances are capped at ~15 s. */
export const MAX_UTTERANCE_BYTES = 44 + 16_000 * 2 * 16;

export function resolveWhisperServer(candidates = SERVER_BINARIES): string | undefined {
  return candidates.find(path => existsSync(path));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port.'))));
    });
  });
}

/**
 * Keeps a whisper.cpp model loaded in a loopback-only `whisper-server` so a
 * finished phrase is transcribed in ~0.3 s instead of waiting for
 * whisper-stream's 2-second polling. Audio never leaves the Mac.
 */
export class LocalWhisperServer {
  #child: ChildProcess | undefined;
  #port: number | undefined;
  #key: string | undefined;
  #starting: Promise<void> | undefined;

  get running(): boolean {
    return this.#child !== undefined && this.#port !== undefined;
  }

  /** Start (or reuse) a server for this model and language. */
  start(modelPath: string, language: string, binary = resolveWhisperServer(), vadModelPath?: string): Promise<void> {
    const key = `${modelPath}\n${language}\n${vadModelPath ?? ''}`;
    if (this.#key === key && this.#starting) return this.#starting;
    this.stop();
    if (!binary) return Promise.reject(new Error('whisper-server was not found. Install it with `brew install whisper.cpp`.'));
    this.#key = key;
    this.#starting = (async () => {
      const port = await freePort();
      const child = spawn(binary, [
        '--model', modelPath,
        '--language', language,
        '--host', '127.0.0.1',
        '--port', String(port),
        '--threads', '8',
        // A 15-second audio context: roughly halves encode time for short phrases.
        '--audio-ctx', '768',
        // Tokens like "(music)" never become words.
        '--suppress-nst',
        // Silero VAD keeps only the stretches with speech, so breaths and
        // keyboard noise stop turning into hallucinated words. The low
        // threshold and generous padding keep quiet speech (checked against
        // recorded Hinglish clips: nothing lost, trailing junk gone).
        ...(vadModelPath ? ['--vad', '--vad-model', vadModelPath, '--vad-threshold', '0.30', '--vad-speech-pad-ms', '200'] : []),
      ], { stdio: 'ignore', shell: false });
      this.#child = child;
      child.once('exit', () => {
        if (this.#child === child) {
          this.#child = undefined;
          this.#port = undefined;
          this.#key = undefined;
          this.#starting = undefined;
        }
      });
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (this.#child !== child) throw new Error('The speech server stopped while starting.');
        try {
          await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
          this.#port = port;
          return;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      this.stop();
      throw new Error('The local speech server did not start in time.');
    })();
    return this.#starting;
  }

  /**
   * Transcribe one phrase. With `languages` like ['auto', 'hi'], the first
   * result is kept unless it is in an unexpected script (whisper sometimes
   * writes short Hindi as Urdu or Hebrew), in which case the next language is tried.
   */
  async transcribe(wav: Uint8Array, languages: readonly string[] = [], signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<string> {
    const attempts = languages.length === 0 ? [undefined] : languages;
    let text = '';
    for (const language of attempts) {
      text = await this.#transcribeOnce(wav, language, signal);
      if (!hasUnexpectedScript(text)) break;
    }
    return polishTranscript(text);
  }

  async #transcribeOnce(wav: Uint8Array, language: string | undefined, signal: AbortSignal): Promise<string> {
    if (this.#starting) await this.#starting;
    if (this.#port === undefined) throw new Error('The local speech server is not running.');
    if (wav.byteLength < 44 || wav.byteLength > MAX_UTTERANCE_BYTES) throw new Error('The recorded phrase has an invalid size.');
    const form = new FormData();
    form.append('file', new Blob([Uint8Array.from(wav)], { type: 'audio/wav' }), 'phrase.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    if (language) form.append('language', language);
    const response = await fetch(`http://127.0.0.1:${this.#port}/inference`, { method: 'POST', body: form, signal });
    if (!response.ok) throw new Error(`The local speech server answered HTTP ${response.status}.`);
    const payload: unknown = await response.json();
    const text = typeof payload === 'object' && payload !== null && typeof (payload as { text?: unknown }).text === 'string'
      ? (payload as { text: string }).text
      : '';
    return cleanTranscript(text);
  }

  stop(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#port = undefined;
    this.#key = undefined;
    this.#starting = undefined;
    child?.kill('SIGTERM');
  }
}

/** Text in scripts other than Latin and Devanagari (Arabic/Urdu, Hebrew, Cyrillic, CJK, …). */
export function hasUnexpectedScript(text: string): boolean {
  return /[^\p{Script=Latin}\p{Script=Devanagari}\p{Script=Common}\p{Script=Inherited}\s]/u.test(text);
}

/** Remove whisper's markers ("[BLANK_AUDIO]", "(music)") and collapse whitespace. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Whole transcripts whisper invents from silence or noise (learned from video
 * subtitles). Dropped only when they are the entire phrase, never mid-sentence.
 */
const PHANTOM_PHRASES = [
  'thanks for watching', 'thank you for watching', 'thanks for watching and see you next time',
  'please subscribe', 'please like and subscribe', 'subscribe to my channel', 'like share and subscribe',
  'subtitles by the amara.org community', 'subtitles by amara.org', 'see you in the next video',
  'सब्सक्राइब करें', 'लाइक और सब्सक्राइब करें', 'चैनल को सब्सक्राइब करें', 'वीडियो देखने के लिए धन्यवाद',
  'video dekhne ke liye dhanyavad', 'subscribe karein', 'channel ko subscribe karein',
];

function phraseKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}.]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/**
 * The assistants' names as whisper tends to mishear them, mapped back to the
 * real spelling. Conservative on purpose: only forms that are not ordinary
 * words ("beyond" or "via" stay untouched).
 */
const NAME_FIXES: readonly (readonly [RegExp, string])[] = [
  // Heard in tests with real and synthetic voices (whisper large-v3-turbo and the Hinglish model).
  // The whole name first, including two-word forms ("Viyo maara", "vya maara",
  // "Vyohmaara", "Vaayomara"), so they never turn into "Vyom maara".
  [/(?<![\p{L}\p{M}])(?:v|w|b)(?:iew|iy|aay|ay|aa|y|i|a)?(?:o|oh|aa|ah|au|a)?h?\s?m(?:aa|a)r(?:aa|a)(?![\p{L}\p{M}])/giu, 'Vyomara'],
  [/(?<![\p{L}\p{M}])(?:vyomra|vivaara|viv\s?mara)(?![\p{L}\p{M}])/giu, 'Vyomara'],
  [/(?<![\p{L}\p{M}])(?:vaaymar|vaymar|vaimar)(?![\p{L}\p{M}])/giu, 'Vyomara'],
  // "Hey Vyomara" heard as "Haveno maara".
  [/(?<![\p{L}\p{M}])(?:haveno|hey\s?no|heyno)\s+maa?ra(?![\p{L}\p{M}])/giu, 'Hey Vyomara'],
  [/(?<![\p{L}\p{M}])(?:viom|wyom|vyom|viyom|biyom|beyom|vyoam|vyaanm|vyaam|vyon|voom|vyoom|vyaan|viyo|vyo\s?om)(?![\p{L}\p{M}])/giu, 'Vyom'],
  // "Vyo," / "Vyo " at the start is the name cut short.
  [/^(?:vyo|vio)(?=[,\s])/iu, 'Vyom'],
  [/(?<![\p{L}\p{M}])(?:व्योमरा|वियोमारा|व्योमारा|विव\s?मारा)(?![\p{L}\p{M}])/gu, 'व्योमारा'],
  [/(?<![\p{L}\p{M}])(?:वियोम|व्यूम|व्याम|व्योम)(?![\p{L}\p{M}])/gu, 'व्योम'],
  // Product names the Hinglish model spells out.
  [/(?<![\p{L}\p{M}])v\.?\s?s\.?\s?code(?![\p{L}\p{M}])/giu, 'VS Code'],
];

/**
 * Final clean-up of a transcribed phrase: drop invented subtitle phrases and a
 * repeated prompt, and spell the assistants' names right.
 */
export function polishTranscript(text: string, prompt = ''): string {
  const cleaned = cleanTranscript(text);
  const key = phraseKey(cleaned);
  if (key === '' || PHANTOM_PHRASES.some(phrase => phraseKey(phrase) === key)) return '';
  if (prompt !== '' && key === phraseKey(prompt)) return '';
  return NAME_FIXES.reduce((value, [pattern, name]) => value.replace(pattern, name), cleaned);
}
