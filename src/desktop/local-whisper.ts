import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

export type LocalWhisperEvent =
  | { readonly type: 'listening' }
  | { readonly type: 'partial'; readonly transcript: string }
  | { readonly type: 'command'; readonly transcript: string }
  | { readonly type: 'stopped' }
  | { readonly type: 'model-progress'; readonly received: number; readonly total: number }
  | { readonly type: 'model-ready' }
  | { readonly type: 'error'; readonly message: string };

export interface LocalWhisperOptions {
  readonly modelDirectory: string;
  /** Which speech model to use (default "fast"). */
  readonly model?: SpeechModelId;
  readonly binaryPath?: string;
  readonly spawnProcess?: typeof spawn;
}

export class LocalSpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalSpeechError';
  }
}

export type SpeechModelId = 'fast' | 'best';

export interface SpeechModelInfo {
  readonly id: SpeechModelId;
  readonly label: string;
  readonly file: string;
  readonly sha1: string;
  readonly maxBytes: number;
  readonly approxMegabytes: number;
  /**
   * Language passed to whisper. The base model guesses Hindi as Urdu or
   * Hebrew on short phrases, so it transcribes everything as English
   * (Hinglish comes out romanized). The large turbo model writes Hindi in
   * Devanagari and keeps English words in English.
   */
  readonly language: 'en' | 'hi';
}

export const SPEECH_MODELS: Readonly<Record<SpeechModelId, SpeechModelInfo>> = {
  fast: {
    id: 'fast',
    label: 'Fast (English and romanized Hinglish)',
    file: 'ggml-base.bin',
    sha1: '465707469ff3a37a2b9b8d8f89f2f99de7299dac',
    maxBytes: 180 * 1024 * 1024,
    approxMegabytes: 148,
    language: 'en',
  },
  best: {
    id: 'best',
    label: 'Best for Hindi, English, and mixed speech',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    sha1: 'e050f7970618a659205450ad97eb95a18d69c9ee',
    maxBytes: 600 * 1024 * 1024,
    approxMegabytes: 574,
    language: 'hi',
  },
};

function modelUrl(model: SpeechModelInfo): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.file}`;
}

/** Verified model files (path → size:mtime), so large models are hashed once per change. */
const verifiedModels = new Map<string, string>();
const defaultWhisperBinaries = ['/opt/homebrew/bin/whisper-stream', '/usr/local/bin/whisper-stream'];

export function extractWhisperTranscriptions(output: string): string[] {
  const transcripts: string[] = [];
  const blocks = output.matchAll(/### Transcription \d+ START[^\n]*\n([\s\S]*?)### Transcription \d+ END/g);
  for (const [, body] of blocks) {
    if (!body) continue;
    const text = body.split('\n')
      .map(line => line
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/^\[[^\]]+ --> [^\]]+\]\s*/, '')
        .replace(/\[BLANK_AUDIO\]/gi, '')
        .trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) transcripts.push(text);
  }
  return transcripts;
}

async function fileSha1(path: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export class LocalWhisperRunner {
  readonly modelPath: string;
  readonly model: SpeechModelInfo;
  readonly #modelDirectory: string;
  readonly #binaryPath: string | undefined;
  readonly #spawnProcess: typeof spawn;
  #child: ReturnType<typeof spawn> | undefined;
  #stoppingChild: ReturnType<typeof spawn> | undefined;
  #silentStopChild: ReturnType<typeof spawn> | undefined;
  #stdoutBuffer = '';
  #inTranscription = false;
  #transcriptionLines: string[] = [];
  #onEvent: ((event: LocalWhisperEvent) => void) | undefined;

  constructor(options: LocalWhisperOptions) {
    this.#modelDirectory = options.modelDirectory;
    this.model = SPEECH_MODELS[options.model ?? 'fast'];
    this.modelPath = join(options.modelDirectory, this.model.file);
    this.#binaryPath = options.binaryPath;
    this.#spawnProcess = options.spawnProcess ?? spawn;
  }

  get isListening(): boolean {
    return this.#child !== undefined;
  }

  async modelAvailable(): Promise<boolean> {
    try {
      const metadata = await stat(this.modelPath);
      if (!metadata.isFile() || metadata.size === 0 || metadata.size > this.model.maxBytes) return false;
      const stamp = `${metadata.size}:${metadata.mtimeMs}`;
      if (verifiedModels.get(this.modelPath) === stamp) return true;
      const valid = await fileSha1(this.modelPath) === this.model.sha1;
      if (valid) verifiedModels.set(this.modelPath, stamp);
      return valid;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  async downloadModel(onEvent: (event: LocalWhisperEvent) => void): Promise<void> {
    await mkdir(this.#modelDirectory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(this.#modelDirectory, `${this.model.file}.download`);
    const maximumModelBytes = this.model.maxBytes;
    const sizeLimit = `${Math.round(maximumModelBytes / 1024 / 1024)} MiB`;
    const response = await fetch(modelUrl(this.model), { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new LocalSpeechError(`Local speech model download failed (HTTP ${response.status}).`);
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maximumModelBytes) {
      throw new LocalSpeechError(`The speech model download exceeded the ${sizeLimit} size limit.`);
    }
    const total = Number.isFinite(declaredLength) ? declaredLength : 0;
    let received = 0;
    const hash = createHash('sha1');
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maximumModelBytes) {
          callback(new LocalSpeechError(`The speech model download exceeded the ${sizeLimit} size limit.`));
          return;
        }
        hash.update(chunk);
        onEvent({ type: 'model-progress', received, total });
        callback(null, chunk);
      },
    });
    try {
      await pipeline(response.body, meter, createWriteStream(temporaryPath, { flags: 'w', mode: 0o600 }));
      if (hash.digest('hex') !== this.model.sha1) throw new LocalSpeechError('The downloaded speech model failed its integrity check.');
      await rename(temporaryPath, this.modelPath);
      onEvent({ type: 'model-ready' });
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (error instanceof LocalSpeechError) throw error;
      throw new LocalSpeechError(error instanceof Error ? error.message : 'The local speech model could not be downloaded.');
    }
  }

  start(onEvent: (event: LocalWhisperEvent) => void): void {
    if (this.#child) throw new Error('Local voice listening is already active.');
    if (!this.#binaryPath) throw new LocalSpeechError('Local speech engine not found. Install whisper.cpp with `brew install whisper.cpp`, then restart Vyomara.');
    this.#stdoutBuffer = '';
    this.#inTranscription = false;
    this.#transcriptionLines = [];
    this.#onEvent = onEvent;
    let child: ReturnType<typeof spawn>;
    try {
      child = this.#spawnProcess(this.#binaryPath, [
        '--step', '0',
        '--length', '8000',
        '--vad-thold', '0.6',
        '--language', this.model.language,
        '--threads', '4',
        '--model', this.modelPath,
      ], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.#onEvent = undefined;
      throw new LocalSpeechError(`Local speech engine could not start: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    this.#child = child;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      child.kill('SIGTERM');
      this.#finish();
      throw new LocalSpeechError('Local speech engine did not provide its audio-stream controls.');
    }
    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');
    stdout.on('data', chunk => this.#handleOutput(String(chunk)));
    let errorOutput = '';
    stderr.on('data', chunk => { errorOutput = (errorOutput + String(chunk)).slice(-4_096); });
    child.once('error', error => {
      if (this.#stoppingChild === child) return;
      this.#finish();
      onEvent({ type: 'error', message: `Local speech engine could not start: ${error.message}` });
    });
    child.once('close', (code, signal) => {
      const silentStop = this.#silentStopChild === child;
      const intentionalStop = this.#stoppingChild === child;
      if (intentionalStop) this.#stoppingChild = undefined;
      if (silentStop) this.#silentStopChild = undefined;
      const unexpected = this.#child === child && !intentionalStop;
      this.#finish();
      if (silentStop) return;
      if (unexpected && code !== 0) {
        onEvent({
          type: 'error',
          message: errorOutput.trim() || `Local speech engine stopped unexpectedly (${signal ?? code ?? 'unknown'}).`,
        });
      } else {
        onEvent({ type: 'stopped' });
      }
    });
  }

  stop(options: { readonly silent?: boolean } = {}): Promise<boolean> {
    const child = this.#child;
    if (!child) return Promise.resolve(false);
    this.#stoppingChild = child;
    if (options.silent) this.#silentStopChild = child;
    return new Promise(resolve => {
      let forceKillTimer: NodeJS.Timeout | undefined;
      child.once('close', () => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve(true);
      });
      if (!child.kill('SIGTERM')) {
        if (this.#stoppingChild === child) this.#stoppingChild = undefined;
        if (this.#silentStopChild === child) this.#silentStopChild = undefined;
        if (this.#child !== child) {
          resolve(true);
          return;
        }
        resolve(false);
        return;
      }
      forceKillTimer = setTimeout(() => {
        if (this.#child === child) child.kill('SIGKILL');
      }, 1_500);
    });
  }

  #finish(): void {
    this.#child = undefined;
    this.#stdoutBuffer = '';
    this.#inTranscription = false;
    this.#transcriptionLines = [];
  }

  #handleOutput(chunk: string): void {
    this.#stdoutBuffer += chunk;
    if (this.#stdoutBuffer.length > 32_768) {
      const child = this.#child;
      this.#finish();
      this.#onEvent?.({ type: 'error', message: 'Local speech engine exceeded its output limit.' });
      child?.kill('SIGTERM');
      return;
    }
    let newline = this.#stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#stdoutBuffer.slice(0, newline).replace(/\x1b\[[0-9;]*m/g, '').trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      newline = this.#stdoutBuffer.indexOf('\n');
      if (line.includes('[Start speaking]')) this.#onEvent?.({ type: 'listening' });
      if (line.startsWith('### Transcription ') && line.includes(' START')) {
        this.#inTranscription = true;
        this.#transcriptionLines = [];
      } else if (line.startsWith('### Transcription ') && line.includes(' END')) {
        const transcript = extractWhisperTranscriptions([
          '### Transcription 0 START',
          ...this.#transcriptionLines,
          '### Transcription 0 END',
        ].join('\n'))[0];
        this.#inTranscription = false;
        this.#transcriptionLines = [];
        if (transcript) this.#handleTranscript(transcript);
      } else if (this.#inTranscription && line) {
        this.#transcriptionLines.push(line);
      }
    }
  }

  #handleTranscript(transcript: string): void {
    this.#onEvent?.({ type: 'partial', transcript });
    this.#onEvent?.({ type: 'command', transcript });
  }
}

export function resolveWhisperBinary(pathCandidates = defaultWhisperBinaries): string | undefined {
  return pathCandidates.find(path => existsSync(path));
}
