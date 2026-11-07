import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ToolFailure } from '../tools/contracts.ts';
import type { AppControlAction, LauncherPort } from '../tools/action-tools.ts';
import { VSCODE_CLI } from './vscode-diff.ts';

const APPLICATION_FOLDERS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  join(homedir(), 'Applications'),
];

/** Bundle identifier of an installed app, found by name (case-insensitive), or undefined. */
export async function findBundleIdentifier(application: string): Promise<string | undefined> {
  const wanted = `${application}.app`.toLowerCase();
  for (const folder of APPLICATION_FOLDERS) {
    let entries: string[];
    try {
      entries = await readdir(folder);
    } catch {
      continue;
    }
    const match = entries.find(entry => entry.toLowerCase() === wanted);
    if (!match) continue;
    try {
      const plist = await readFile(join(folder, match, 'Contents', 'Info.plist'));
      const text = plist.toString('utf8');
      const xml = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u.exec(text)?.[1];
      if (xml) return xml.trim();
      // Binary plist: ask plutil to convert it.
      const converted = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(folder, match, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 3_000 });
      if (converted.status === 0 && converted.stdout.trim() !== '') return converted.stdout.trim();
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Opens applications, files, and web pages through macOS LaunchServices (`/usr/bin/open`). */
export class MacApplicationLauncher implements LauncherPort {
  async openApplication(application: string, target: string | undefined, signal: AbortSignal, line?: number): Promise<void> {
    if (application === 'Visual Studio Code' && target !== undefined && line !== undefined && existsSync(VSCODE_CLI)) {
      // `code -g file:line` opens the file at that line in the running window.
      await this.#run(VSCODE_CLI, ['-g', `${target}:${line}`], signal, 'VS Code could not open the file at that line.');
      return;
    }
    await this.#open(['-a', application, ...(target === undefined ? [] : [target])], signal,
      `macOS could not open “${application}”. Check that the application is installed.`);
  }

  async controlApplication(application: string, action: AppControlAction, signal: AbortSignal): Promise<void> {
    if (action === 'focus') {
      await this.#open(['-a', application], signal, `macOS could not bring “${application}” forward.`);
      return;
    }
    // Look the bundle up on disk: AppleScript's `id of application` shows a
    // blocking "Where is …?" dialog for unknown apps.
    const bundleId = await findBundleIdentifier(application);
    if (!bundleId) throw new ToolFailure(`“${application}” is not installed.`, 'not-found');
    const scripts: Record<Exclude<AppControlAction, 'focus'>, readonly string[]> = {
      hide: [
        'on run argv',
        'tell application "System Events"',
        'if not (exists (first application process whose bundle identifier is (item 1 of argv))) then error "not running" number 1',
        'set visible of (first application process whose bundle identifier is (item 1 of argv)) to false',
        'end tell',
        'end run',
      ],
      minimize: [
        'on run argv',
        'tell application "System Events"',
        'if not (exists (first application process whose bundle identifier is (item 1 of argv))) then error "not running" number 1',
        'tell (first application process whose bundle identifier is (item 1 of argv))',
        'repeat with w in windows',
        'set value of attribute "AXMinimized" of w to true',
        'end repeat',
        'end tell',
        'end tell',
        'end run',
      ],
      restore: [
        'on run argv',
        'tell application "System Events"',
        'if not (exists (first application process whose bundle identifier is (item 1 of argv))) then error "not running" number 1',
        'tell (first application process whose bundle identifier is (item 1 of argv))',
        'set visible to true',
        'repeat with w in windows',
        'set value of attribute "AXMinimized" of w to false',
        'end repeat',
        'set frontmost to true',
        'end tell',
        'end tell',
        'end run',
      ],
      maximize: [
        'on run argv',
        'tell application "System Events"',
        'if not (exists (first application process whose bundle identifier is (item 1 of argv))) then error "not running" number 1',
        'tell (first application process whose bundle identifier is (item 1 of argv))',
        'set frontmost to true',
        'if (count of windows) is 0 then error "no window" number 2',
        'set value of attribute "AXFullScreen" of window 1 to false',
        'set position of window 1 to {(item 2 of argv) as integer, (item 3 of argv) as integer}',
        'set size of window 1 to {(item 4 of argv) as integer, (item 5 of argv) as integer}',
        'end tell',
        'end tell',
        'end run',
      ],
      fullscreen: [
        'on run argv',
        'tell application "System Events"',
        'if not (exists (first application process whose bundle identifier is (item 1 of argv))) then error "not running" number 1',
        'tell (first application process whose bundle identifier is (item 1 of argv))',
        'set frontmost to true',
        'if (count of windows) is 0 then error "no window" number 2',
        'set value of attribute "AXFullScreen" of window 1 to not (value of attribute "AXFullScreen" of window 1)',
        'end tell',
        'end tell',
        'end run',
      ],
      quit: ['on run argv', 'tell application id (item 1 of argv) to quit', 'end run'],
      // Page Down / Page Up sent to the app (needs Accessibility permission for Vyomara).
      'scroll-down': [
        'on run argv',
        'tell application "System Events"',
        'if not (exists (first application process whose bundle identifier is (item 1 of argv))) then error "not running" number 1',
        'set frontmost of (first application process whose bundle identifier is (item 1 of argv)) to true',
        'delay 0.25',
        'key code 121',
        'end tell',
        'end run',
      ],
      'scroll-up': [
        'on run argv',
        'tell application "System Events"',
        'if not (exists (first application process whose bundle identifier is (item 1 of argv))) then error "not running" number 1',
        'set frontmost of (first application process whose bundle identifier is (item 1 of argv)) to true',
        'delay 0.25',
        'key code 116',
        'end tell',
        'end run',
      ],
      'read-page': [],
    };
    if (action === 'read-page') throw new ToolFailure('Reading a page is done by the browser tool.', 'unsupported-operation');
    const extraArgs = action === 'maximize' ? await this.#usableScreenFrame(signal) : [];
    // An app opened a moment ago may still be starting; give it a few seconds.
    let attempts = action === 'quit' ? 1 : 6;
    while (true) {
      try {
        await this.#osascript(scripts[action], [bundleId.trim(), ...extraArgs], signal);
        return;
      } catch (error) {
        attempts -= 1;
        const notRunning = error instanceof Error && /not running|\(1\)|no window|\(2\)/u.test(error.message);
        if (!notRunning || attempts <= 0 || signal.aborted) throw this.#controlError(error, application, action);
        await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
      }
    }
  }

  /** Main screen area without menu bar and Dock, as [x, y, width, height] in top-left coordinates. */
  async #usableScreenFrame(signal: AbortSignal): Promise<string[]> {
    const output = await this.#osascript([
      'ObjC.import("AppKit");',
      'const screen = $.NSScreen.mainScreen; const full = screen.frame; const v = screen.visibleFrame;',
      '[v.origin.x, full.size.height - (v.origin.y + v.size.height), v.size.width, v.size.height].map(Math.round).join(",")',
    ], [], signal, 'JavaScript');
    const frame = output.trim().split(',');
    if (frame.length !== 4 || frame.some(part => !/^-?\d+$/u.test(part))) {
      throw new ToolFailure('The screen size could not be read.', 'tool-failed');
    }
    return frame;
  }

  #controlError(error: unknown, application: string, action: AppControlAction): ToolFailure {
    const message = error instanceof Error ? error.message : '';
    if (/no window|\(2\)/u.test(message)) return new ToolFailure(`“${application}” has no open window to ${action}.`, 'not-found');
    if (/not running|\(1\)/u.test(message)) return new ToolFailure(`“${application}” is not running.`, 'not-found');
    if (/-1743|not authori[sz]ed|Not authorised/iu.test(message)) {
      return new ToolFailure('macOS blocked Vyomara from controlling other apps. Allow it in System Settings → Privacy & Security → Automation, then try again.', 'permission-denied');
    }
    if (/-1719|-25211|assistive access/iu.test(message)) {
      return new ToolFailure('Changing windows (minimize, maximize, full screen) needs Accessibility access. Enable Vyomara in System Settings → Privacy & Security → Accessibility, then try again. Hiding the app works without it.', 'permission-denied');
    }
    return new ToolFailure(`macOS could not ${action} “${application}”.`, 'tool-failed');
  }

  #osascript(lines: readonly string[], args: readonly string[], signal: AbortSignal, language: 'AppleScript' | 'JavaScript' = 'AppleScript'): Promise<string> {
    return new Promise((resolve, reject) => {
      // Arguments are passed via `on run argv`, never spliced into the script.
      const child = spawn('/usr/bin/osascript', ['-l', language, ...lines.flatMap(line => ['-e', line]), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('osascript timed out'));
      }, 10_000);
      child.once('close', () => clearTimeout(timer));
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      const onAbort = (): void => {
        child.kill('SIGTERM');
        reject(new ToolFailure('Cancelled.', 'tool-failed'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.once('error', error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.once('close', code => {
        signal.removeEventListener('abort', onAbort);
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `osascript exited with ${String(code)}`));
      });
    });
  }

  openUrl(url: string, application: string | undefined, signal: AbortSignal): Promise<void> {
    return this.#open([...(application === undefined ? [] : ['-a', application]), url], signal,
      application === undefined
        ? 'macOS could not open the web page.'
        : `macOS could not open the web page in “${application}”. Check that the browser is installed.`);
  }

  #open(args: readonly string[], signal: AbortSignal, failure: string): Promise<void> {
    return this.#run('/usr/bin/open', args, signal, failure);
  }

  #run(executable: string, args: readonly string[], signal: AbortSignal, failure: string): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new ToolFailure('Opening was cancelled.', 'tool-failed'));
    }
    return new Promise((resolve, reject) => {
      // `--` is not supported by open(1); arguments are passed without a shell.
      const child = spawn(executable, [...args], { stdio: 'ignore' });
      const onAbort = (): void => {
        child.kill('SIGTERM');
        reject(new ToolFailure('Opening was cancelled.', 'tool-failed'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.once('error', () => {
        signal.removeEventListener('abort', onAbort);
        reject(new ToolFailure(failure, 'tool-failed'));
      });
      child.once('close', code => {
        signal.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new ToolFailure(failure, 'not-found'));
      });
    });
  }
}
