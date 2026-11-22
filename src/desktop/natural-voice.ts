import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hinglishForVoice } from '../shared/hinglish-devanagari.ts';

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
  // The screen shows Roman Hinglish; the voice reads Hindi right only from Devanagari.
  return hinglishForVoice(text).replace(/\bVyomara\b/gu, 'व्योमारा').replace(/\bVyom\b/gu, 'व्योम');
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

/**
 * Maya 2 Native (Apache-2.0, MLX 8-bit) through mlx-audio: far clearer Hindi
 * and Hinglish than Kokoro (round trip: Kokoro "saare best, bhay, bas",
 * Maya "saare tests bhi pass"), first audio ~0.25 s, about 2x real time on
 * an M4 Pro, ~3.3 GB of memory. Set up with `pnpm setup:maya`.
 */
export const MAYA_SCRIPT = `import json, sys
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load

base = sys.argv[1]
model = load(base + "/model")
# Warm up once: the first call compiles the kernels.
for _ in model.generate("नमस्ते।", voice="Ahana", lang_code="hi"):
    pass
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    try:
        chunks = [np.asarray(result.audio, dtype=np.float32).reshape(-1)
                  for result in model.generate(request["text"], voice=request["voice"], lang_code="hi")]
        if not chunks:
            raise ValueError("nothing to say")
        sf.write(request["out"], np.concatenate(chunks), 24000)
        print(json.dumps({"id": request["id"], "ok": True}), flush=True)
    except Exception as error:
        print(json.dumps({"id": request["id"], "error": str(error)}), flush=True)
`;

/** A local voice engine run as a Python sidecar. */
export interface VoiceEngine {
  readonly name: 'kokoro' | 'maya';
  readonly script: string;
  /** Files (relative to the engine folder) that must exist before it is used. */
  readonly readyFiles: readonly string[];
  /** Voice per gender; Maya reads the owner's choice from voices.json in its folder. */
  readonly voices: (directory: string) => Readonly<Record<'male' | 'female', string>>;
  readonly startTimeoutMs: number;
}

export const KOKORO_ENGINE: VoiceEngine = {
  name: 'kokoro',
  script: SYNTH_SCRIPT,
  readyFiles: ['ready.json', 'model_quantized.onnx', 'voices.npz', 'venv/bin/python3'],
  voices: () => NATURAL_VOICES,
  startTimeoutMs: 30_000,
};

/** Default Maya voices: the clearest on the twins' names in the round-trip test. */
export const MAYA_DEFAULT_VOICES = { male: 'Ritvik', female: 'Charvi' } as const;
const MAYA_VOICE_NAMES = new Set(['Ahana', 'Vaidehi', 'Malini', 'Charvi', 'Jahnavi', 'Anirban', 'Nakul', 'Vasant', 'Siddhant', 'Satvik', 'Abhay', 'Nivedita', 'Ishwari', 'Ritvik', 'Vrinda', 'Sreekar', 'Shaunak', 'Akshat', 'Tanushree']);

export const MAYA_ENGINE: VoiceEngine = {
  name: 'maya',
  script: MAYA_SCRIPT,
  readyFiles: ['ready.json', 'model/model.safetensors', 'model/config.json', 'venv/bin/python3'],
  voices: directory => {
    try {
      const chosen = JSON.parse(readFileSync(join(directory, 'voices.json'), 'utf8')) as { male?: unknown; female?: unknown };
      return {
        male: typeof chosen.male === 'string' && MAYA_VOICE_NAMES.has(chosen.male) ? chosen.male : MAYA_DEFAULT_VOICES.male,
        female: typeof chosen.female === 'string' && MAYA_VOICE_NAMES.has(chosen.female) ? chosen.female : MAYA_DEFAULT_VOICES.female,
      };
    } catch {
      return MAYA_DEFAULT_VOICES;
    }
  },
  // Loading the 3.3 GB model and compiling takes ~25 s.
  startTimeoutMs: 120_000,
};

type Sidecar = ChildProcessByStdio<Writable, Readable, null>;

const SYNTH_TIMEOUT_MS = 60_000;

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
  readonly #engine: VoiceEngine;
  #child: Sidecar | undefined;
  #starting: Promise<Sidecar> | undefined;
  #pending = new Map<string, Pending>();
  #queue: Promise<unknown> = Promise.resolve();

  constructor(directory: string, engine: VoiceEngine = KOKORO_ENGINE) {
    this.#directory = directory;
    this.#engine = engine;
  }

  get engine(): VoiceEngine['name'] {
    return this.#engine.name;
  }

  get ready(): boolean {
    return this.#engine.readyFiles.every(name => existsSync(join(this.#directory, name)));
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
      child.stdin.write(`${JSON.stringify({ id, text, voice: this.#engine.voices(this.#directory)[gender], out })}\n`);
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
    await writeFile(script, this.#engine.script, { mode: 0o600 });
    const child = spawn(join(this.#directory, 'venv/bin/python3'), ['-I', script, this.#directory], { stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    let buffer = '';
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('The natural voice did not start in time.')); }, this.#engine.startTimeoutMs);
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
