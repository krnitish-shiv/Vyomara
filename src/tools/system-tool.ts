import { ToolFailure, type Tool, type ToolRegistry } from './contracts.ts';
import type { ActionApprovalPort } from './action-tools.ts';

/** Something the Mac itself does; the desktop implements it (see MacSystemControl). */
export type SystemAction =
  | { readonly kind: 'volume'; readonly level: number }
  | { readonly kind: 'mute' }
  | { readonly kind: 'unmute' }
  | { readonly kind: 'dark_mode'; readonly state: 'on' | 'off' | 'toggle' }
  | { readonly kind: 'lock_screen' }
  | { readonly kind: 'sleep' }
  | { readonly kind: 'screenshot' }
  | { readonly kind: 'clipboard_get' }
  | { readonly kind: 'clipboard_set'; readonly text: string }
  | { readonly kind: 'notify'; readonly title: string; readonly text: string }
  | { readonly kind: 'type_text'; readonly text: string }
  | { readonly kind: 'press_key'; readonly key: string }
  | { readonly kind: 'open_settings'; readonly pane: string }
  | { readonly kind: 'wifi'; readonly state: 'on' | 'off' }
  | { readonly kind: 'running_apps' };

export interface SystemResult {
  /** What happened, for the model ("Volume set to 40%"). */
  readonly detail: string;
  /** Clipboard text, when read. */
  readonly text?: string;
  /** The screenshot file. */
  readonly path?: string;
  readonly apps?: readonly string[];
}

export interface SystemControlPort {
  perform(action: SystemAction, signal: AbortSignal): Promise<SystemResult>;
}

/** A key combination the model may press: modifiers plus one key, e.g. "cmd+s", "enter", "shift+tab". */
export const KEY_COMBINATION = /^(?:(?:cmd|command|ctrl|control|alt|option|shift)\+){0,4}(?:[a-z0-9]|enter|return|tab|space|delete|backspace|escape|esc|left|right|up|down|home|end|pageup|pagedown|f[1-9]|f1[0-2])$/u;

const ACTIONS = ['volume', 'mute', 'unmute', 'dark_mode', 'lock_screen', 'sleep', 'screenshot', 'clipboard_get', 'clipboard_set', 'notify', 'type_text', 'press_key', 'open_settings', 'wifi', 'running_apps'];
const KEYS = ['action', 'level', 'state', 'text', 'title', 'key', 'pane'];

interface SystemInput {
  readonly action: string;
  readonly level?: number;
  readonly state?: string;
  readonly text?: string;
  readonly title?: string;
  readonly key?: string;
  readonly pane?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputError(value: unknown): string | undefined {
  if (!isRecord(value)) return 'Arguments must be a JSON object.';
  if (Object.keys(value).some(key => !KEYS.includes(key))) return `Use only ${KEYS.join(', ')}.`;
  const action = value.action;
  if (typeof action !== 'string' || !ACTIONS.includes(action)) return `action must be one of: ${ACTIONS.join(', ')}.`;
  if (action === 'volume' && (!Number.isInteger(value.level) || (value.level as number) < 0 || (value.level as number) > 100)) return 'volume needs level: 0–100.';
  if (action === 'dark_mode' && !['on', 'off', 'toggle'].includes(String(value.state))) return 'dark_mode needs state: on, off, or toggle.';
  if (action === 'wifi' && !['on', 'off'].includes(String(value.state))) return 'wifi needs state: on or off.';
  if ((action === 'clipboard_set' || action === 'type_text') && (typeof value.text !== 'string' || value.text === '' || value.text.length > 2_000)) return `${action} needs text (at most 2000 characters).`;
  if (action === 'notify' && (typeof value.text !== 'string' || value.text.trim() === '' || value.text.length > 500)) return 'notify needs text (the message).';
  if (action === 'press_key' && (typeof value.key !== 'string' || !KEY_COMBINATION.test(value.key.toLowerCase()))) return 'press_key needs key such as "cmd+s", "enter", or "shift+tab".';
  if (action === 'open_settings' && value.pane !== undefined && (typeof value.pane !== 'string' || value.pane.length > 60)) return 'pane must be a short name such as wifi, bluetooth, display, sound, privacy, keyboard, battery.';
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 120)) return 'title must be a short string.';
  return undefined;
}

function dropNulls(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function actionFor(input: SystemInput): SystemAction {
  const text = input.text ?? '';
  switch (input.action) {
    case 'volume': return { kind: 'volume', level: input.level ?? 50 };
    case 'mute': return { kind: 'mute' };
    case 'unmute': return { kind: 'unmute' };
    case 'dark_mode': return { kind: 'dark_mode', state: input.state === 'on' ? 'on' : input.state === 'off' ? 'off' : 'toggle' };
    case 'lock_screen': return { kind: 'lock_screen' };
    case 'sleep': return { kind: 'sleep' };
    case 'screenshot': return { kind: 'screenshot' };
    case 'clipboard_get': return { kind: 'clipboard_get' };
    case 'clipboard_set': return { kind: 'clipboard_set', text };
    case 'notify': return { kind: 'notify', title: (input.title ?? 'Vyomara').trim() || 'Vyomara', text: text.trim() };
    case 'type_text': return { kind: 'type_text', text };
    case 'press_key': return { kind: 'press_key', key: (input.key ?? '').toLowerCase() };
    case 'open_settings': return { kind: 'open_settings', pane: (input.pane ?? '').trim().toLowerCase() };
    case 'wifi': return { kind: 'wifi', state: input.state === 'on' ? 'on' : 'off' };
    default: return { kind: 'running_apps' };
  }
}

const preview = (text: string): string => JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text);

/** What the approval card says will happen. */
export function describeSystemAction(action: SystemAction): string {
  switch (action.kind) {
    case 'volume': return `Set the output volume to ${action.level}%`;
    case 'mute': return 'Mute the sound';
    case 'unmute': return 'Unmute the sound';
    case 'dark_mode': return action.state === 'toggle' ? 'Switch between light and dark mode' : `Turn dark mode ${action.state}`;
    case 'lock_screen': return 'Lock the screen';
    case 'sleep': return 'Put the Mac to sleep';
    case 'screenshot': return 'Take a screenshot of the whole screen and save it on the Desktop';
    case 'clipboard_get': return 'Read the clipboard (its text goes to the local model)';
    case 'clipboard_set': return `Put this text on the clipboard: ${preview(action.text)}`;
    case 'notify': return `Show a notification “${action.title}”: ${preview(action.text)}`;
    case 'type_text': return `Type into the front app: ${preview(action.text)}`;
    case 'press_key': return `Press ${action.key} in the front app`;
    case 'open_settings': return action.pane ? `Open System Settings › ${action.pane}` : 'Open System Settings';
    case 'wifi': return `Turn Wi-Fi ${action.state}`;
    default: return 'List the running apps';
  }
}

/** mac_control: the Mac itself, each action shown and approved (listing running apps needs no approval). */
export function registerSystemTool(registry: ToolRegistry, system: SystemControlPort, approval: ActionApprovalPort): void {
  const tool: Tool<SystemInput, Record<string, unknown>> = {
    id: 'mac_control',
    effect: 'launch',
    description: 'Control this Mac (after approval): volume (level 0–100), mute, unmute, dark_mode (state on/off/toggle), lock_screen, sleep, screenshot (saved on the Desktop; returns the path), clipboard_get, clipboard_set (text), notify (title, text), type_text (types text into the front app, e.g. into VS Code or a form), press_key (key such as "cmd+s", "enter", "cmd+shift+p"), open_settings (pane: wifi, bluetooth, display, sound, privacy, accessibility, automation, keyboard, battery, notifications, appearance, general), wifi (state on/off), running_apps (no approval). Use this instead of run_command or AppleScript for these.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'volume, mute, unmute, dark_mode, lock_screen, sleep, screenshot, clipboard_get, clipboard_set, notify, type_text, press_key, open_settings, wifi, running_apps.', maxLength: 16 },
        level: { type: 'integer', description: 'volume: 0–100.', minimum: 0, maximum: 100 },
        state: { type: 'string', description: 'dark_mode: on, off, toggle; wifi: on, off.', maxLength: 6 },
        text: { type: 'string', description: 'clipboard_set / type_text: the text; notify: the message.', maxLength: 2_000 },
        title: { type: 'string', description: 'notify: the title.', maxLength: 120 },
        key: { type: 'string', description: 'press_key: e.g. "cmd+s", "enter", "cmd+shift+p", "shift+tab".', maxLength: 40 },
        pane: { type: 'string', description: 'open_settings: which pane.', maxLength: 60 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    normalizeInput: dropNulls,
    validateInput: (value): value is SystemInput => inputError(value) === undefined,
    inputError,
    validateOutput: (value): value is Record<string, unknown> => isRecord(value) && typeof value.status === 'string',
    async run(input, signal) {
      const action = actionFor(input);
      const detail = describeSystemAction(action);
      if (action.kind !== 'running_apps') {
        const approved = await approval.request({ kind: 'system', action: action.kind, detail }, signal);
        if (!approved) return { status: 'rejected', action: action.kind, detail };
      }
      try {
        const result = await system.perform(action, signal);
        return { status: 'done', action: action.kind, ...result };
      } catch (error) {
        if (error instanceof ToolFailure) throw error;
        throw new ToolFailure(`macOS could not do that (${action.kind}).`, 'tool-failed');
      }
    },
  };
  registry.register(tool);
}
