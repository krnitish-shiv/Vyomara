import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Voices installed by scripts/setup-natural-voice.mjs. */
export const NATURAL_VOICES = { female: 'hf_beta', male: 'hm_omega' } as const;

export interface NaturalSpeechPort {
  /** The engine, model, and voices are installed. */
  readonly ready: boolean;
  /** Synthesize `text` for this gender; resolves with the path of a WAV file the caller removes. */
  synthesize(text: string, gender: 'male' | 'female', signal: AbortSignal): Promise<string>;
}

/**
 * Text as Kokoro should read it. The names are written in Devanagari so both
 * voices say them right ("Vyom" rhymes with Om).
 */
export function textForNatural(text: string): string {
  return text.replace(/\bVyomara\b/gu, 'व्योमारा').replace(/\bVyom\b/gu, 'व्योम');
}

/**
 * The sidecar: loads Kokoro once and answers one JSON request per line on
 * stdin ({"id", "text", "voice", "out"}) with {"id", "ok"} or {"id", "error"}.
 * Text is cut into runs by script: Devanagari is read as Hindi, everything
 * else as English, so mixed replies come out right in a single voice.
 */
export const SYNTH_SCRIPT = `import json, re, sys
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

base = sys.argv[1]
kokoro = Kokoro(base + "/model_quantized.onnx", base + "/voices.npz")
DEVANAGARI = re.compile(r"[\\u0900-\\u097F]")
HAS_SOUND = re.compile(r"[\\w\\u0900-\\u097F]")
RUN = re.compile(r"[\\u0900-\\u097F][\\u0900-\\u097F\\s,.!?\\u0964\\u0965-]*|[^\\u0900-\\u097F]+")

def synthesize(text, voice):
    pieces, rate = [], 24000
    for run in RUN.findall(text):
        run = run.strip()
        if not run or not HAS_SOUND.search(run):
            continue
        lang = "hi" if DEVANAGARI.search(run) else "en-us"
        samples, rate = kokoro.create(run, voice=voice, speed=1.0, lang=lang)
        pieces.append(samples)
        pieces.append(np.zeros(int(rate * 0.05), dtype=np.float32))
    if not pieces:
        raise ValueError("nothing to say")
    return np.concatenate(pieces), rate

print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    try:
        audio, rate = synthesize(request["text"], request["voice"])
        sf.write(request["out"], audio, rate)
        print(json.dumps({"id": request["id"], "ok": True}), flush=True)
    except Exception as error:
        print(json.dumps({"id": request["id"], "error": str(error)}), flush=True)
`;

type Sidecar = ChildProcessByStdio<Writable, Readable, null>;

const SYNTH_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 30_000;

interface Pending {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

/**
 * Natural neural voice (Kokoro, local). Needs `pnpm setup:voice` once; without
 * it `ready` is false and the caller keeps the system voice. The sidecar
 * stays loaded between replies (~0.3 s for a short sentence).
 */
export class NaturalVoice implements NaturalSpeechPort {
  readonly #directory: string;
  #child: Sidecar | undefined;
  #starting: Promise<Sidecar> | undefined;
  #pending = new Map<string, Pending>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string) {
    this.#directory = directory;
  }

  get ready(): boolean {
    return ['ready.json', 'model_quantized.onnx', 'voices.npz', 'venv/bin/python3']
      .every(name => existsSync(join(this.#directory, name)));
  }

  synthesize(text: string, gender: 'male' | 'female', signal: AbortSignal): Promise<string> {
    const run = async (): Promise<string> => {
      if (signal.aborted) throw new Error('Speech was cancelled.');
      const child = await this.#start();
      const id = randomUUID();
      const out = join(tmpdir(), `vyomara-voice-${id}.wav`);
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.#fail(new Error('The natural voice timed out.')); }, SYNTH_TIMEOUT_MS);
        this.#pending.set(id, {
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        signal.addEventListener('abort', () => {
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(new Error('Speech was cancelled.'));
        }, { once: true });
      });
      child.stdin.write(`${JSON.stringify({ id, text, voice: NATURAL_VOICES[gender], out })}\n`);
      await done;
      return out;
    };
    // One request at a time: the sidecar answers in order.
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #start(): Promise<Sidecar> {
    if (this.#child) return Promise.resolve(this.#child);
    this.#starting ??= this.#spawn().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #spawn(): Promise<Sidecar> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const script = join(this.#directory, 'synth.py');
    await writeFile(script, SYNTH_SCRIPT, { mode: 0o600 });
    const child = spawn(join(this.#directory, 'venv/bin/python3'), ['-I', script, this.#directory], { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    let buffer = '';
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('The natural voice did not start in time.')); }, START_TIMEOUT_MS);
      child.stdout.on('data', chunk => {
        buffer += String(chunk);
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          let message: { ready?: boolean; id?: string; ok?: boolean; error?: string };
          try { message = JSON.parse(line); } catch { continue; }
          if (message.ready) { clearTimeout(timer); resolve(); continue; }
          const pending = message.id === undefined ? undefined : this.#pending.get(message.id);
          if (!pending || message.id === undefined) continue;
          this.#pending.delete(message.id);
          if (message.ok) pending.resolve();
          else pending.reject(new Error(message.error ?? 'The natural voice failed.'));
        }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('The natural voice stopped.')); });
    });
    child.once('exit', () => {
      if (this.#child === child) this.#child = undefined;
      this.#fail(new Error('The natural voice stopped.'), false);
    });
    this.#child = child;
    try {
      await ready;
    } catch (error) {
      this.#child = undefined;
      child.kill('SIGTERM');
      throw error;
    }
    return child;
  }

  #fail(error: Error, kill = true): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (kill) {
      this.#child?.kill('SIGTERM');
      this.#child = undefined;
    }
  }

  stop(): void {
    this.#fail(new Error('The natural voice was stopped.'));
  }
}
