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
  start(modelPath: string, language: string, binary = resolveWhisperServer()): Promise<void> {
    const key = `${modelPath}\n${language}`;
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
      if (!hasUnexpectedScript(text)) return text;
    }
    return text;
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
