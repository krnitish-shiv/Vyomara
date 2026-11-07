import { spawn } from 'node:child_process';
import { romanForSpeech } from '../shared/voice-intents.ts';

export type MacSpeechResult =
  | { readonly status: 'completed' }
  | { readonly status: 'cancelled' };

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

  constructor(spawnProcess: SpawnSpeechProcess = spawnMacSpeechProcess, platform: NodeJS.Platform = process.platform) {
    this.#spawnProcess = spawnProcess;
    this.#platform = platform;
  }

  async speak(text: unknown, gender: 'male' | 'female' = 'male'): Promise<MacSpeechResult> {
    const stops = this.#stopCount;
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

  #speak(text: unknown, voice: string | undefined): Promise<MacSpeechResult> {
    if (this.#platform !== 'darwin') {
      return Promise.reject(new MacSpeechError('Local speech output is available only on macOS.'));
    }
    if (typeof text !== 'string' || text.trim() !== text || text.length === 0 || text.length > maximumSpeechChars) {
      return Promise.reject(new MacSpeechError(`Speech text must contain 1 to ${maximumSpeechChars} characters.`));
    }
    if (this.#activeChild) {
      return Promise.reject(new MacSpeechError('Speech output is already in progress.'));
    }

    let child: SpeechChild;
    try {
      child = this.#spawnProcess('/usr/bin/say', ['-r', '180', ...(voice === undefined ? [] : ['-v', voice]), '--', text]);
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
    const child = this.#activeChild;
    if (!child) return this.#starting > 0;
    const stopped = child.kill('SIGTERM');
    if (stopped) this.#cancelActive?.();
    return stopped;
  }
}
