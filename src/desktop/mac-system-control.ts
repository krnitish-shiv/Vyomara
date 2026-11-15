import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ToolFailure } from '../tools/contracts.ts';
import type { SystemAction, SystemControlPort, SystemResult } from '../tools/system-tool.ts';

/** Runs a program without a shell; arguments are never spliced into scripts. */
export type RunProgram = (file: string, args: readonly string[], signal: AbortSignal, stdin?: string) => Promise<string>;

const runProgram: RunProgram = (file, args, signal, stdin) => new Promise((resolve, reject) => {
  const child = stdin === undefined
    ? execFile(file, [...args], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message)));
      else resolve(stdout);
    })
    : spawn(file, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  if (stdin !== undefined) {
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => reject(error));
    child.once('close', code => code === 0 ? resolve('') : reject(new Error(stderr.trim() || `${file} exited with ${String(code)}`)));
    child.stdin?.end(stdin);
  }
  signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
});

const KEY_CODES: Readonly<Record<string, number>> = {
  enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

const MODIFIERS: Readonly<Record<string, string>> = {
  cmd: 'command down', command: 'command down', ctrl: 'control down', control: 'control down',
  alt: 'option down', option: 'option down', shift: 'shift down',
};

/** System Settings panes by the names people use. */
const SETTINGS_PANES: Readonly<Record<string, string>> = {
  wifi: 'com.apple.wifi-settings-extension',
  'wi-fi': 'com.apple.wifi-settings-extension',
  network: 'com.apple.Network-Settings.extension',
  bluetooth: 'com.apple.BluetoothSettings',
  display: 'com.apple.Displays-Settings.extension',
  displays: 'com.apple.Displays-Settings.extension',
  sound: 'com.apple.Sound-Settings.extension',
  privacy: 'com.apple.settings.PrivacySecurity.extension',
  security: 'com.apple.settings.PrivacySecurity.extension',
  accessibility: 'com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
  automation: 'com.apple.settings.PrivacySecurity.extension?Privacy_Automation',
  keyboard: 'com.apple.Keyboard-Settings.extension',
  battery: 'com.apple.Battery-Settings.extension',
  notifications: 'com.apple.Notifications-Settings.extension',
  appearance: 'com.apple.Appearance-Settings.extension',
  general: 'com.apple.settings.General',
  software: 'com.apple.Software-Update-Settings.extension',
  update: 'com.apple.Software-Update-Settings.extension',
};

/**
 * Does Mac-level things on the user's behalf through the system's own
 * programs (osascript, pbcopy, networksetup, screencapture). Typing and key
 * presses need Accessibility permission for Vyomara; dark mode and
 * notifications need Automation for System Events.
 */
export class MacSystemControl implements SystemControlPort {
  readonly #run: RunProgram;

  constructor(run: RunProgram = runProgram) {
    this.#run = run;
  }

  async perform(action: SystemAction, signal: AbortSignal): Promise<SystemResult> {
    try {
      switch (action.kind) {
        case 'volume':
          await this.#script(['on run argv', 'set volume output volume ((item 1 of argv) as integer)', 'end run'], [String(action.level)], signal);
          return { detail: `Volume set to ${action.level}%.` };
        case 'mute':
          await this.#script(['set volume with output muted'], [], signal);
          return { detail: 'Sound muted.' };
        case 'unmute':
          await this.#script(['set volume without output muted'], [], signal);
          return { detail: 'Sound unmuted.' };
        case 'dark_mode': {
          const line = action.state === 'toggle'
            ? 'set dark mode to not dark mode'
            : `set dark mode to ${action.state === 'on' ? 'true' : 'false'}`;
          const now = await this.#script(['tell application "System Events" to tell appearance preferences', line, 'return dark mode as string', 'end tell'], [], signal);
          return { detail: `Dark mode is now ${now.trim() === 'true' ? 'on' : 'off'}.` };
        }
        case 'lock_screen':
          await this.#run('/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend'], signal);
          return { detail: 'Screen locked.' };
        case 'sleep':
          await this.#run('/usr/bin/pmset', ['sleepnow'], signal);
          return { detail: 'The Mac is going to sleep.' };
        case 'screenshot': {
          const stamp = new Date().toISOString().replace(/[:T]/gu, '-').slice(0, 19);
          const path = join(homedir(), 'Desktop', `Vyomara screenshot ${stamp}.png`);
          await this.#run('/usr/sbin/screencapture', ['-x', path], signal);
          return { detail: `Screenshot saved as ${path}.`, path };
        }
        case 'clipboard_get': {
          const text = await this.#run('/usr/bin/pbpaste', [], signal);
          return { detail: text === '' ? 'The clipboard has no text.' : `Clipboard text (${text.length} characters).`, text: text.slice(0, 20_000) };
        }
        case 'clipboard_set':
          await this.#run('/usr/bin/pbcopy', [], signal, action.text);
          return { detail: 'Text copied to the clipboard.' };
        case 'notify':
          await this.#script(['on run argv', 'display notification (item 1 of argv) with title (item 2 of argv)', 'end run'], [action.text, action.title], signal);
          return { detail: 'Notification shown.' };
        case 'type_text':
          await this.#script(['on run argv', 'tell application "System Events" to keystroke (item 1 of argv)', 'end run'], [action.text], signal);
          return { detail: `Typed ${action.text.length} characters into the front app.` };
        case 'press_key':
          await this.#pressKey(action.key, signal);
          return { detail: `Pressed ${action.key}.` };
        case 'open_settings': {
          const pane = SETTINGS_PANES[action.pane];
          await this.#run('/usr/bin/open', [pane ? `x-apple.systempreferences:${pane}` : '-b', ...(pane ? [] : ['com.apple.systempreferences'])], signal);
          return { detail: pane ? `Opened System Settings › ${action.pane}.` : `Opened System Settings${action.pane ? ` (no pane called “${action.pane}”; known: ${Object.keys(SETTINGS_PANES).join(', ')})` : ''}.` };
        }
        case 'wifi': {
          const device = await this.#wifiDevice(signal);
          await this.#run('/usr/sbin/networksetup', ['-setairportpower', device, action.state], signal);
          return { detail: `Wi-Fi turned ${action.state}.` };
        }
        default: {
          const output = await this.#script(['tell application "System Events" to get name of every application process whose background only is false'], [], signal);
          const apps = output.trim().split(', ').map(name => name.trim()).filter(Boolean).slice(0, 100);
          return { detail: `${apps.length} apps are running.`, apps };
        }
      }
    } catch (error) {
      throw this.#failure(error, action);
    }
  }

  async #pressKey(combination: string, signal: AbortSignal): Promise<void> {
    const parts = combination.split('+').filter(Boolean);
    const key = parts.at(-1) ?? '';
    const modifiers = parts.slice(0, -1).map(part => {
      const modifier = MODIFIERS[part];
      if (modifier === undefined) throw new ToolFailure(`“${combination}” is not a key combination I can press: use modifiers (cmd, ctrl, alt, shift) plus one key.`, 'unsupported-operation');
      return modifier;
    });
    const using = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';
    const code = KEY_CODES[key];
    if (code !== undefined) {
      await this.#script(['tell application "System Events" to key code ' + String(code) + using], [], signal);
      return;
    }
    if (!/^[a-z0-9]$/u.test(key)) throw new ToolFailure(`“${combination}” is not a key combination I can press.`, 'unsupported-operation');
    // The key itself travels as an argument; the modifier clause is from the fixed table above.
    await this.#script(['on run argv', 'tell application "System Events" to keystroke (item 1 of argv)' + using, 'end run'], [key], signal);
  }

  async #wifiDevice(signal: AbortSignal): Promise<string> {
    const ports = await this.#run('/usr/sbin/networksetup', ['-listallhardwareports'], signal);
    const match = /Hardware Port: (?:Wi-Fi|AirPort)\nDevice: (\w+)/u.exec(ports);
    if (!match?.[1]) throw new ToolFailure('No Wi-Fi interface was found on this Mac.', 'not-found');
    return match[1];
  }

  #script(lines: readonly string[], args: readonly string[], signal: AbortSignal): Promise<string> {
    return this.#run('/usr/bin/osascript', [...lines.flatMap(line => ['-e', line]), ...args], signal);
  }

  #failure(error: unknown, action: SystemAction): ToolFailure {
    if (error instanceof ToolFailure) return error;
    const message = error instanceof Error ? error.message : '';
    if (/-1743|not authori[sz]ed/iu.test(message)) {
      return new ToolFailure('macOS blocked Vyomara from controlling the system. Allow it in System Settings → Privacy & Security → Automation (System Events), then try again.', 'permission-denied');
    }
    if (/-1719|-25211|assistive access|not allowed assistive/iu.test(message)) {
      return new ToolFailure('Typing and key presses need Accessibility access. Enable Vyomara in System Settings → Privacy & Security → Accessibility, then try again.', 'permission-denied');
    }
    return new ToolFailure(`macOS could not do that (${action.kind}).`, 'tool-failed');
  }
}
