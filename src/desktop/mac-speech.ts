import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { romanForSpeech } from '../shared/voice-intents.ts';
import { textForNatural, type NaturalSpeechPort } from './natural-voice.ts';

export type MacSpeechResult =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled' };

/**
 * Plays a synthesized file somewhere other than afplay (the app window, so
 * the microphone's echo canceller hears it and the user can talk over it).
 * Returns undefined when it cannot play right now; afplay is used instead.
 */
export type FilePlayer = (file: string) => { readonly done: Promise<MacSpeechResult>; readonly stop: () => void } | undefined;

/** A clause ready to play (see MacSpeechRunner.prepare). */
export type PreparedSpeech =
  | { readonly kind: 'file'; readonly file: string }
  | { readonly kind: 'say'; readonly text: string; readonly voice: string | undefined };

export class MacSpeechError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MacSpeechError';
  }
}

export interface SpeechChild {
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnSpeechProcess = (executable: string, arguments_: readonly string[]) => SpeechChild;

const maximumSpeechChars = 2_000;

/** Installed macOS voices ("Lekha (Enhanced)  hi_IN # …" lines from `say -v ?`), re-read every few minutes. */
let installedVoices: { readonly at: number; readonly voices: Promise<ReadonlySet<string>> } | undefined;

function listInstalledVoices(): Promise<ReadonlySet<string>> {
  // Re-read now and then, so voices downloaded in System Settings are picked up without a restart.
  if (installedVoices && Date.now() - installedVoices.at < 120_000) return installedVoices.voices;
  const voices = new Promise<ReadonlySet<string>>(resolve => {
    const child = spawn('/usr/bin/say', ['-v', '?'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.once('error', () => resolve(new Set()));
    child.once('close', () => resolve(parseVoiceList(output)));
  });
  installedVoices = { at: Date.now(), voices };
  return voices;
}

/**
 * Voice names from `say -v ?`. Newer macOS adds a language to some names
 * ("Tara (English (India))"); the plain name ("Tara") is kept too, since `say`
 * accepts it. "(Enhanced)" and "(Premium)" stay distinct voices.
 */
export function parseVoiceList(output: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const name = line.match(/^(.+?)\s+[a-z]{2,3}_[A-Z0-9]{2,3}\s+#/u)?.[1]?.trim();
    if (!name) continue;
    names.add(name);
    const plain = name.replace(/\s*\((?!(?:Enhanced|Premium)\)$).*\)$/u, '');
    if (plain) names.add(plain);
  }
  return names;
}

/**
 * One voice per assistant, so it never changes mid-conversation. Better
 * Premium/Enhanced versions (System Settings → Accessibility → Spoken
 * Content → Manage Voices) are used when installed.
 * - Vyomara (female): Lekha (Hindi), which also reads English. She says the
 *   name "Vyomara" correctly only when it is written व्योमारा.
 * - Vyom (male): Aman (Indian English), chosen by the owner; macOS has no
 *   male Hindi voice, so Devanagari is read in Roman letters (romanForSpeech).
 */
const VOICES: Readonly<Record<'male' | 'female', readonly string[]>> = {
  female: ['Lekha (Premium)', 'Lekha (Enhanced)', 'Lekha', 'Tara (Premium)', 'Tara (Enhanced)', 'Tara'],
  male: ['Aman (Premium)', 'Aman (Enhanced)', 'Aman', 'Rishi (Premium)', 'Rishi (Enhanced)', 'Rishi'],
};

export async function voiceFor(gender: 'male' | 'female', available?: ReadonlySet<string>): Promise<string | undefined> {
  const voices = available ?? await listInstalledVoices();
  return VOICES[gender].find(voice => voices.has(voice));
}

/**
 * Text as the assistant's voice should read it (see VOICES). The names are
 * respelled so they sound right: Vyom is "व्योम" (rhymes with Om), which Aman
 * says from "Vyo Om" (plain "Vyom" comes out as "Vyam"); Lekha needs both
 * names in Devanagari. Checked with whisper.
 */
export function textForVoice(text: string, gender: 'male' | 'female'): string {
  if (gender === 'male') return romanForSpeech(text).replace(/\bVyom\b/gu, 'Vyo Om');
  return text.replace(/\bVyomara\b/gu, 'व्योमारा').replace(/\bVyom\b/gu, 'व्योम');
}
const maximumSpeechDurationMs = 180_000;

function spawnMacSpeechProcess(executable: string, arguments_: readonly string[]): SpeechChild {
  return spawn(executable, [...arguments_], {
    shell: false,
    stdio: 'ignore',
  });
}

export class MacSpeechRunner {
  readonly #spawnProcess: SpawnSpeechProcess;
  readonly #platform: NodeJS.Platform;
  #activeChild: SpeechChild | undefined;
  #cancelActive: (() => void) | undefined;
  /** Bumped by stop(), so a reply still choosing its voice is not started afterwards. */
  #stopCount = 0;
  /** Replies still choosing their voice. */
  #starting = 0;

  readonly #natural: NaturalSpeechPort | undefined;
  #synthesis: AbortController | undefined;
  #filePlayer: FilePlayer | undefined;
  #stopPlayer: (() => void) | undefined;

  constructor(
    spawnProcess: SpawnSpeechProcess = spawnMacSpeechProcess,
    platform: NodeJS.Platform = process.platform,
    natural?: NaturalSpeechPort,
  ) {
    this.#spawnProcess = spawnProcess;
    this.#platform = platform;
    this.#natural = natural;
  }

  /** Play synthesized speech through this player (the app window) instead of afplay. */
  setFilePlayer(player: FilePlayer | undefined): void {
    this.#filePlayer = player;
  }

  /** Play a synthesized file: through the file player when set, otherwise afplay. */
  async #playFile(file: string): Promise<MacSpeechResult> {
    if (this.#activeChild || this.#stopPlayer) throw new MacSpeechError('Speech output is already in progress.');
    const playback = this.#filePlayer?.(file);
    if (!playback) return this.#run('/usr/bin/afplay', [file]);
    this.#stopPlayer = playback.stop;
    try {
      return await playback.done;
    } finally {
      this.#stopPlayer = undefined;
    }
  }

  /** Replies are read in the natural voice (Kokoro) when it is installed. */
  get naturalVoiceReady(): boolean {
    return this.#natural?.ready === true;
  }

  async speak(text: unknown, gender: 'male' | 'female' = 'male'): Promise<MacSpeechResult> {
    const stops = this.#stopCount;
    if (typeof text === 'string' && this.#platform === 'darwin' && this.#natural?.ready) {
      const natural = await this.#speakNatural(text, gender, stops);
      if (natural) return natural;
      // The natural voice failed: fall through to the system voice, so a reply is never silent.
    }
    this.#starting += 1;
    let voice: string | undefined;
    try {
      voice = await (typeof text === 'string' && this.#platform === 'darwin' && this.#spawnProcess === spawnMacSpeechProcess
        ? voiceFor(gender)
        : Promise.resolve(undefined));
    } finally {
      this.#starting -= 1;
    }
    // Stopped while the voice was being chosen: do not start speaking.
    if (stops !== this.#stopCount) return { status: 'cancelled' };
    const spoken = typeof text === 'string' ? textForVoice(text, gender) : text;
    return this.#speak(spoken, voice);
  }

  /**
   * Get one clause ready to play without playing it: synthesized to a file by
   * the natural voice, or text and voice for `say`. Lets a spoken reply
   * prepare its next clause while the current one plays. Undefined when
   * stopped meanwhile.
   */
  async prepare(text: string, gender: 'male' | 'female' = 'male'): Promise<PreparedSpeech | undefined> {
    const stops = this.#stopCount;
    if (this.#platform === 'darwin' && this.#natural?.ready) {
      const spoken = textForNatural(text);
      if (spoken.length > 0 && spoken.length <= maximumSpeechChars && spoken.trim() === spoken) {
        const controller = new AbortController();
        this.#synthesis = controller;
        this.#starting += 1;
        try {
          const file = await this.#natural.synthesize(spoken, gender, controller.signal);
          if (stops !== this.#stopCount) {
            void rm(file, { force: true });
            return undefined;
          }
          return { kind: 'file', file };
        } catch {
          if (controller.signal.aborted || stops !== this.#stopCount) return undefined;
          // Natural voice failed: this clause uses the system voice instead.
        } finally {
          this.#starting -= 1;
          if (this.#synthesis === controller) this.#synthesis = undefined;
        }
      }
    }
    this.#starting += 1;
    let voice: string | undefined;
    try {
      voice = this.#platform === 'darwin' && this.#spawnProcess === spawnMacSpeechProcess ? await voiceFor(gender) : undefined;
    } finally {
      this.#starting -= 1;
    }
    if (stops !== this.#stopCount) return undefined;
    return { kind: 'say', text: textForVoice(text, gender), voice };
  }

  /** Play a clause from prepare(). */
  async play(prepared: PreparedSpeech): Promise<MacSpeechResult> {
    if (prepared.kind === 'say') return this.#speak(prepared.text, prepared.voice);
    try {
      return await this.#playFile(prepared.file);
    } finally {
      void rm(prepared.file, { force: true });
    }
  }

  /** Throw away a prepared clause that will not be played. */
  discard(prepared: PreparedSpeech): void {
    if (prepared.kind === 'file') void rm(prepared.file, { force: true });
  }

  /** Synthesize with the natural voice and play the file; undefined when it could not (use the system voice). */
  async #speakNatural(text: string, gender: 'male' | 'female', stops: number): Promise<MacSpeechResult | undefined> {
    const spoken = textForNatural(text);
    if (spoken.trim() !== spoken || spoken.length === 0 || spoken.length > maximumSpeechChars) return undefined;
    const controller = new AbortController();
    this.#synthesis = controller;
    this.#starting += 1;
    let file: string;
    try {
      file = await this.#natural!.synthesize(spoken, gender, controller.signal);
    } catch {
      return controller.signal.aborted ? { status: 'cancelled' } : undefined;
    } finally {
      this.#starting -= 1;
      if (this.#synthesis === controller) this.#synthesis = undefined;
    }
    try {
      if (stops !== this.#stopCount) return { status: 'cancelled' };
      return await this.#playFile(file);
    } catch {
      return undefined;
    } finally {
      void rm(file, { force: true });
    }
  }

  #speak(text: unknown, voice: string | undefined): Promise<MacSpeechResult> {
    if (this.#platform !== 'darwin') {
      return Promise.reject(new MacSpeechError('Local speech output is available only on macOS.'));
    }
    if (typeof text !== 'string' || text.trim() !== text || text.length === 0 || text.length > maximumSpeechChars) {
      return Promise.reject(new MacSpeechError(`Speech text must contain 1 to ${maximumSpeechChars} characters.`));
    }
    return this.#run('/usr/bin/say', ['-r', '180', ...(voice === undefined ? [] : ['-v', voice]), '--', text]);
  }

  #run(executable: string, arguments_: readonly string[]): Promise<MacSpeechResult> {
    if (this.#activeChild) {
      return Promise.reject(new MacSpeechError('Speech output is already in progress.'));
    }

    let child: SpeechChild;
    try {
      child = this.#spawnProcess(executable, arguments_);
    } catch (error) {
      return Promise.reject(new MacSpeechError(error instanceof Error ? error.message : 'macOS speech could not be started.'));
    }
    this.#activeChild = child;

    return new Promise<MacSpeechResult>((resolve, reject) => {
      let cancelled = false;
      let timedOut = false;
      let settled = false;
      const finish = (error?: Error, result?: MacSpeechResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.#activeChild === child) {
          this.#activeChild = undefined;
          this.#cancelActive = undefined;
        }
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new MacSpeechError('macOS speech ended without a result.'));
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          if (!child.kill('SIGTERM')) finish(new MacSpeechError('Local speech exceeded its three-minute limit.'));
        } catch (error) {
          finish(new MacSpeechError(error instanceof Error ? error.message : 'Timed-out speech could not be stopped.'));
        }
      }, maximumSpeechDurationMs);
      this.#cancelActive = () => {
        cancelled = true;
      };
      child.once('error', error => finish(new MacSpeechError(`macOS speech failed: ${error.message}`)));
      child.once('close', (code, signal) => {
        if (timedOut) {
          finish(new MacSpeechError('Local speech exceeded its three-minute limit.'));
        } else if (cancelled) {
          finish(undefined, { status: 'cancelled' });
        } else if (code === 0) {
          finish(undefined, { status: 'completed' });
        } else {
          finish(new MacSpeechError(
            signal
              ? `Local speech was interrupted (${signal}).`
              : `macOS speech failed (exit ${code ?? 'unknown'}).`,
          ));
        }
      });
    });
  }

  stop(): boolean {
    this.#stopCount += 1;
    this.#synthesis?.abort();
    if (this.#stopPlayer) {
      this.#stopPlayer();
      return true;
    }
    const child = this.#activeChild;
    if (!child) return this.#starting > 0;
    const stopped = child.kill('SIGTERM');
    if (stopped) this.#cancelActive?.();
    return stopped;
  }
}
