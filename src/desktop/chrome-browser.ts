import { execFile } from 'node:child_process';
import { ToolFailure } from '../tools/contracts.ts';
import type { BrowserAction, BrowserPage, BrowserPort } from '../tools/action-tools.ts';

/**
 * Drives the user's own Google Chrome, visibly, like a person would: search,
 * open, read, click, scroll, go back. Pages are read from the live tab, so
 * JavaScript-heavy sites and pages the user is signed in to work. Needs
 * Chrome's "Allow JavaScript from Apple Events" (View → Developer) and macOS
 * permission for Vyomara to control Chrome.
 */
export type RunAppleScript = (lines: readonly string[], args: readonly string[], signal: AbortSignal) => Promise<string>;

const runAppleScript: RunAppleScript = (lines, args, signal) => new Promise((resolve, reject) => {
  const child = execFile('/usr/bin/osascript', [...lines.flatMap(line => ['-e', line]), ...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message)));
    else resolve(stdout);
  });
  signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
});

/** Runs in the page: numbered visible links (also tagged so click can find them) and the page text. */
const READ_PAGE = `(() => {
  const visible = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  document.querySelectorAll('[data-vyom-link]').forEach(el => el.removeAttribute('data-vyom-link'));
  const google = /(^|\\.)google\\./.test(location.hostname) && location.pathname === '/search';
  let results = [];
  if (google) {
    results = [...document.querySelectorAll('a h3')].map(h => {
      const a = h.closest('a');
      const box = a.closest('[data-hveid], .g, div');
      const snippet = (box?.innerText || '').replace(h.innerText, '').replace(/\\s+/g, ' ').trim().slice(0, 240);
      return { title: h.innerText.trim(), url: a.href, snippet };
    }).filter(r => /^https?:/.test(r.url)).slice(0, 10);
  }
  const anchors = [...document.querySelectorAll('a[href]')].filter(a => visible(a) && a.innerText.trim() && /^https?:/.test(a.href)).slice(0, 80);
  const links = anchors.map((a, i) => { a.setAttribute('data-vyom-link', String(i + 1)); return { n: i + 1, text: a.innerText.trim().replace(/\\s+/g, ' ').slice(0, 100), url: a.href }; });
  document.querySelectorAll('[data-vyom-input]').forEach(el => el.removeAttribute('data-vyom-input'));
  const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]), textarea, select, [contenteditable="true"]')].filter(visible).slice(0, 40);
  const inputs = fields.map((el, i) => {
    el.setAttribute('data-vyom-input', String(i + 1));
    const labelled = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || (labelled && labelled.innerText) || el.getAttribute('name') || el.getAttribute('title') || '';
    const type = el.tagName === 'INPUT' ? (el.type || 'text') : el.tagName.toLowerCase();
    return { n: i + 1, type, label: String(label).replace(/\\s+/g, ' ').trim().slice(0, 80) };
  });
  const captcha = /unusual traffic|not a robot|captcha/i.test(document.body.innerText.slice(0, 3000));
  return JSON.stringify({ url: location.href, title: document.title, text: document.body.innerText, links, inputs, results, captcha,
    scroll: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight });
})()`;

/** Runs in the page: fills the numbered input the way a person typing would (so React-style inputs notice), optionally submits. */
const typeScript = (field: number, text: string, submit: boolean): string => `(() => {
  const el = document.querySelector('[data-vyom-input="${field}"]');
  if (!el) return 'missing';
  el.focus();
  const text = ${JSON.stringify(text)};
  if (el.isContentEditable) {
    el.textContent = text;
  } else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, text); else el.value = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  ${submit ? `if (el.form) { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
  else { for (const type of ['keydown', 'keypress', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); }` : ''}
  return 'ok';
})()`;

/** Runs in the page: scrolls to the first match and returns the text around each match. */
const findScript = (text: string): string => `(() => {
  const q = ${JSON.stringify(text)};
  const matched = !!window.find(q, false, false, true, false, true, false);
  const body = document.body.innerText; const lower = body.toLowerCase(); const needle = q.toLowerCase();
  const snippets = []; let from = 0;
  while (snippets.length < 5) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    snippets.push(body.slice(Math.max(0, at - 150), at + q.length + 150).replace(/\\s+/g, ' ').trim());
    from = at + q.length;
  }
  return JSON.stringify({ matched, snippets });
})()`;

const LIST_TABS = [
  'tell application "Google Chrome"',
  'if (count of windows) is 0 then return ""',
  'set out to (active tab index of front window as string) & linefeed',
  'repeat with i from 1 to count of tabs of front window',
  'set t to tab i of front window',
  'set out to out & i & tab & (title of t) & tab & (URL of t) & linefeed',
  'end repeat',
  'return out',
  'end tell',
];

const SWITCH_TAB = [
  'on run argv',
  'tell application "Google Chrome"',
  'if (count of windows) is 0 then error "no window" number 2',
  'set active tab index of front window to ((item 1 of argv) as integer)',
  'activate',
  'end tell',
  'end run',
];

const CLOSE_TAB = ['tell application "Google Chrome" to if (count of windows) > 0 then close active tab of front window'];

const EXECUTE = [
  'on run argv',
  'tell application "Google Chrome"',
  'if (count of windows) is 0 then make new window',
  'return execute active tab of front window javascript (item 1 of argv)',
  'end tell',
  'end run',
];

const OPEN_TAB = [
  'on run argv',
  'tell application "Google Chrome"',
  'activate',
  'if (count of windows) is 0 then make new window',
  'tell front window to make new tab with properties {URL:(item 1 of argv)}',
  'end tell',
  'end run',
];

const IS_LOADING = [
  'tell application "Google Chrome"',
  'if (count of windows) is 0 then return "false"',
  'return loading of active tab of front window as string',
  'end tell',
];

const GO_BACK = ['tell application "Google Chrome" to go back active tab of front window'];

export class ChromeBrowser implements BrowserPort {
  readonly #run: RunAppleScript;

  constructor(run: RunAppleScript = runAppleScript) {
    this.#run = run;
  }

  async perform(action: BrowserAction, signal: AbortSignal): Promise<BrowserPage> {
    try {
      switch (action.kind) {
        case 'search':
          await this.#open(`https://www.google.com/search?q=${encodeURIComponent(action.query)}`, signal);
          break;
        case 'open':
          await this.#open(action.url, signal);
          break;
        case 'click': {
          const clicked = await this.#run(EXECUTE, [`(() => { const a = document.querySelector('[data-vyom-link="${action.link}"]'); if (!a) return 'missing'; a.removeAttribute('target'); a.click(); return 'ok'; })()`], signal);
          if (clicked.trim() !== 'ok') throw new ToolFailure(`Link ${action.link} is not on the page any more. Read the page again to get fresh link numbers.`, 'not-found');
          await this.#settle(signal);
          break;
        }
        case 'scroll':
          await this.#run(EXECUTE, [`window.scrollBy({ top: ${action.direction === 'up' ? -1 : 1} * Math.round(innerHeight * 0.85), behavior: 'smooth' }); 'ok'`], signal);
          await new Promise(resolve => setTimeout(resolve, 600));
          break;
        case 'back':
          await this.#run(GO_BACK, [], signal);
          await this.#settle(signal);
          break;
        case 'type': {
          const typed = await this.#run(EXECUTE, [typeScript(action.field, action.text, action.submit)], signal);
          if (typed.trim() !== 'ok') throw new ToolFailure(`Input ${action.field} is not on the page any more. Read the page again to get fresh input numbers.`, 'not-found');
          if (action.submit) await this.#settle(signal);
          else await new Promise(resolve => setTimeout(resolve, 300));
          break;
        }
        case 'find': {
          const raw = await this.#run(EXECUTE, [findScript(action.text)], signal);
          const found = JSON.parse(raw) as BrowserPage['found'];
          const page = await this.#read(signal);
          return { ...page, ...(found ? { found } : {}) };
        }
        case 'tabs':
          return { ...await this.#read(signal), tabs: await this.#tabs(signal) };
        case 'switch':
          await this.#run(SWITCH_TAB, [String(action.tab)], signal);
          await new Promise(resolve => setTimeout(resolve, 300));
          return { ...await this.#read(signal), tabs: await this.#tabs(signal) };
        case 'close':
          await this.#run(CLOSE_TAB, [], signal);
          await new Promise(resolve => setTimeout(resolve, 300));
          return { ...await this.#read(signal), tabs: await this.#tabs(signal) };
        default:
          break;
      }
      return await this.#read(signal);
    } catch (error) {
      throw this.#error(error);
    }
  }

  async #tabs(signal: AbortSignal): Promise<NonNullable<BrowserPage['tabs']>> {
    const [first, ...rest] = (await this.#run(LIST_TABS, [], signal)).split('\n');
    const active = Number.parseInt(first ?? '', 10);
    return rest.filter(line => line.includes('\t')).slice(0, 60).map(line => {
      const [n, title = '', url = ''] = line.split('\t');
      const index = Number.parseInt(n ?? '', 10);
      return { n: index, title: title.slice(0, 120), url, active: index === active };
    });
  }

  async #open(url: string, signal: AbortSignal): Promise<void> {
    await this.#run(OPEN_TAB, [url], signal);
    await this.#settle(signal);
  }

  /** Wait until the tab has loaded (up to 15 s), then a moment for scripts to render. */
  async #settle(signal: AbortSignal): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 400));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (signal.aborted) throw new ToolFailure('Browsing was cancelled.', 'tool-failed');
      const loading = (await this.#run(IS_LOADING, [], signal)).trim();
      if (loading !== 'true') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await new Promise(resolve => setTimeout(resolve, 700));
  }

  async #read(signal: AbortSignal): Promise<BrowserPage> {
    const raw = await this.#run(EXECUTE, [READ_PAGE], signal);
    let page: unknown;
    try {
      page = JSON.parse(raw);
    } catch {
      throw new ToolFailure('The page could not be read.', 'tool-failed');
    }
    return page as BrowserPage;
  }

  #error(error: unknown): ToolFailure {
    if (error instanceof ToolFailure) return error;
    const message = error instanceof Error ? error.message : '';
    if (/JavaScript.*(turned off|disabled|not allowed)|Allow JavaScript from Apple Events/iu.test(message)) {
      return new ToolFailure('Chrome blocks reading pages for now. In Chrome choose View → Developer → Allow JavaScript from Apple Events once, then ask again.', 'permission-denied');
    }
    if (/not allowed|-1743|not authorized/iu.test(message)) {
      return new ToolFailure('macOS has not allowed Vyomara to control Google Chrome. Allow it in System Settings → Privacy & Security → Automation, then ask again.', 'permission-denied');
    }
    if (/-600|isn.t running|can.t get application/iu.test(message)) {
      return new ToolFailure('Google Chrome is not installed or could not be started.', 'not-found');
    }
    if (/no window|\(2\)|Invalid index|-1719/iu.test(message)) {
      return new ToolFailure('There is no such tab or window in Chrome. List the tabs again.', 'not-found');
    }
    return new ToolFailure('Chrome could not do that.', 'tool-failed');
  }
}
