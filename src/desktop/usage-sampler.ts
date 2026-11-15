import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const SAMPLE_SECONDS = 30;
/** A gap this long ends a sitting. */
const BREAK_SECONDS = 5 * 60;
/** Idle shorter than this still counts as using the front app (reading counts). */
const IDLE_SECONDS = 120;
export const DEFAULT_NUDGE_SECONDS = 3 * 60 * 60;

export interface UsageSample {
  readonly day: string;
  readonly app: string;
  readonly seconds: number;
}

export interface UsageSamplerPorts {
  /** Store one sample (upsert day+app). */
  readonly record: (sample: UsageSample) => void;
  /** Tell the user they have been at it for `seconds` without a break. */
  readonly nudge: (seconds: number) => void;
  /** Continuous screen time without a break before a nudge; 0 turns nudges off. */
  readonly nudgeAfterSeconds?: number;
}

/** "HIDIdleTime" = 28728330250 (nanoseconds) → seconds. */
export function parseIdleSeconds(ioregOutput: string): number | undefined {
  const match = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioregOutput);
  if (!match) return undefined;
  return Number(match[1]) / 1e9;
}

/** `"LSDisplayName"="Code"` → "Code". */
export function parseFrontAppName(lsappinfoOutput: string): string | undefined {
  const match = /"LSDisplayName"\s*=\s*"([^"\n]{1,128})"/.exec(lsappinfoOutput);
  return match?.[1];
}

export function localDay(date: Date): string {
  return date.toLocaleDateString('en-CA');
}

async function idleSeconds(): Promise<number | undefined> {
  const { stdout } = await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 5_000 });
  return parseIdleSeconds(stdout);
}

async function frontAppName(): Promise<string | undefined> {
  const front = await run('/usr/bin/lsappinfo', ['front'], { timeout: 5_000 });
  const asn = front.stdout.trim();
  if (!/^ASN:0x[0-9a-f]+-0x[0-9a-f]+:?$/i.test(asn)) return undefined;
  const info = await run('/usr/bin/lsappinfo', ['info', '-only', 'name', asn], { timeout: 5_000 });
  return parseFrontAppName(info.stdout);
}

/**
 * Samples the front app every 30 s while the Mac is in use and records the
 * time per app and day. Tracks the current sitting (no break of 5 minutes)
 * and nudges once each time another `nudgeAfterSeconds` of it passes.
 * Everything stays on this Mac.
 */
export class UsageSampler {
  #timer: ReturnType<typeof setInterval> | undefined;
  #sittingSeconds = 0;
  #nudgedAtSeconds = 0;
  readonly #ports: UsageSamplerPorts;

  constructor(ports: UsageSamplerPorts) {
    this.#ports = ports;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      void this.#sample().catch(() => undefined);
    }, SAMPLE_SECONDS * 1_000);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The current sitting's length in seconds (for tests and status). */
  get sittingSeconds(): number {
    return this.#sittingSeconds;
  }

  async #sample(): Promise<void> {
    const idle = await idleSeconds();
    if (idle === undefined) return;
    const needsApp = idle < IDLE_SECONDS;
    this.apply(idle, needsApp ? await frontAppName() : undefined);
  }

  /** One tick of the state machine, separated from the probes for tests. */
  apply(idle: number, app: string | undefined): void {
    if (idle >= BREAK_SECONDS) {
      this.#sittingSeconds = 0;
      this.#nudgedAtSeconds = 0;
      return;
    }
    if (idle >= IDLE_SECONDS || app === undefined) return;
    this.#sittingSeconds += SAMPLE_SECONDS;
    this.#ports.record({ day: localDay(new Date()), app, seconds: SAMPLE_SECONDS });
    const threshold = this.#ports.nudgeAfterSeconds ?? DEFAULT_NUDGE_SECONDS;
    if (threshold > 0 && this.#sittingSeconds - this.#nudgedAtSeconds >= threshold) {
      this.#nudgedAtSeconds = this.#sittingSeconds;
      this.#ports.nudge(this.#sittingSeconds);
    }
  }
}
