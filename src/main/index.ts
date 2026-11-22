import { existsSync } from 'node:fs';
import { ChromeBrowser } from '../desktop/chrome-browser.ts';
import { MacSystemControl } from '../desktop/mac-system-control.ts';
import { MemoryStore } from '../storage/memory-store.ts';
import { canShowDiff, VSCodeDiffPreview } from '../desktop/vscode-diff.ts';
import { ChangeJournal } from '../desktop/change-journal.ts';
import { DEFAULT_PERSONA, isPersonaId, personaFor, type PersonaId } from '../shared/persona.ts';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification, screen, session, shell, systemPreferences } from 'electron';
import type { SaveDialogOptions } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { AgentError } from '../agent/agent.ts';
import {
  deleteDesktopSession,
  exportDesktopSession,
  readDesktopSession,
  readDesktopSessions,
  readModelSettings,
  saveModelSettings,
  withSavedModelSettings,
  primeModel,
  runRequest,
  saveSelectedModel,
} from '../app/application.ts';
import type { RequestOptions, SavedModelSettings } from '../app/application.ts';
import type { DesktopFileOperationProposal, DesktopUndoResult, DesktopUndoStatus } from '../desktop/contracts.ts';
import { loadConfig, validateOllamaModel } from '../config/config.ts';
import { OllamaProvider } from '../providers/provider.ts';
import { PersistenceError, SqliteStore } from '../storage/sqlite-store.ts';
import { UsageSampler } from '../desktop/usage-sampler.ts';
import { MAYA_ENGINE, NaturalVoice } from '../desktop/natural-voice.ts';
import { ProviderError } from '../providers/provider.ts';
import { ToolExecutionError } from '../tools/executor.ts';
import type { Logger } from '../types.ts';
import type { AppConfig } from '../config/config.ts';
import type { DiagnosticEvent } from '../diagnostics/logger.ts';
import {
  DesktopValidationError,
  isTrustedPageRequest,
  parseDesktopChatRequest,
  parseDesktopFileOperationApprovalRequest,
  parseDesktopSessionDeleteRequest,
  parseDesktopSessionId,
} from '../desktop/validation.ts';
import { exportToSelectedFile } from '../desktop/session-export.ts';
import {
  FileOperationApprovalError,
  FileOperationApprovalManager,
} from '../desktop/file-operation-approval.ts';
import { ActionApprovalError, ActionApprovalManager } from '../desktop/action-approval.ts';
import { MacApplicationLauncher } from '../desktop/mac-application-launcher.ts';
import { homedir } from 'node:os';
import { McpManager, readMcpConfig } from '../tools/mcp-client.ts';
import { ShellCommandRunner } from '../tools/command-runner.ts';
import { HttpWebClient } from '../tools/web-client.ts';
import { ApprovalMemory, DEFAULT_BROWSER, grantId, parseGrantId } from '../tools/action-tools.ts';
import { MacSpeechError, MacSpeechRunner } from '../desktop/mac-speech.ts';
import { isSpeechModelId, LocalSpeechError, LocalWhisperRunner, resolveWhisperBinary, SPEECH_MODEL_IDS, SPEECH_MODELS } from '../desktop/local-whisper.ts';
import { SpeechQueue } from '../desktop/speech-queue.ts';
import { uiZoomFor } from '../desktop/ui-scale.ts';
import type { PreparedSpeech } from '../desktop/mac-speech.ts';
import { ClauseStream } from '../shared/clause-stream.ts';
import { acknowledgementFor } from '../shared/acknowledgement.ts';
import type { SpeechModelId } from '../desktop/local-whisper.ts';
import { LocalWhisperServer, resolveWhisperServer } from '../desktop/whisper-server.ts';
import type { LocalWhisperEvent } from '../desktop/local-whisper.ts';

let mainWindow: BrowserWindow | undefined;
/** The mini controller window shown over other apps while the main window is away. */
let pipWindow: BrowserWindow | undefined;
let quitting = false;
const PIP_SIZE = { width: 384, height: 136 };
/** Last state published by the main window, replayed when the mini window (re)loads. */
let lastPipState: unknown;
let activeRequest: AbortController | undefined;
let activeFileOperationApproval: FileOperationApprovalManager | undefined;
let activeActionApproval: ActionApprovalManager | undefined;
let activeModelPull: AbortController | undefined;
const shellCommandRunner = new ShellCommandRunner();
/** The user's MCP servers (mcp.json in the data folder), started at launch. */
const mcpManager = new McpManager();
const mcpAllowed = new Set<string>();
/** Commands the user chose to always allow; cleared when the app quits. */
/** Standing permissions (apps, browsers, web hosts) are loaded from disk at startup. */
let approvalMemory = new ApprovalMemory();
// Maya 2 (much clearer Hindi) once set up with `pnpm setup:maya`; otherwise Kokoro.
const mayaVoice = new NaturalVoice(join(app.getPath('userData'), 'maya-voice'), MAYA_ENGINE);
const naturalVoice = mayaVoice.ready ? mayaVoice : new NaturalVoice(join(app.getPath('userData'), 'natural-voice'));
const macSpeechRunner = new MacSpeechRunner(undefined, undefined, naturalVoice);

/**
 * Synthesized speech plays in the app window, not through afplay: the
 * microphone's echo canceller then knows what the speakers are playing, so
 * the user can talk over Vyom to interrupt (barge-in). If the window cannot
 * play it, afplay plays the file, so a reply is never silent.
 */
let audioSequence = 0;
const audioWaiters = new Map<number, (status: 'completed' | 'cancelled' | 'failed') => void>();
macSpeechRunner.setFilePlayer(file => {
  const window = mainWindow;
  if (!window || window.isDestroyed()) return undefined;
  const id = audioSequence += 1;
  let settle!: (result: { status: 'completed' | 'cancelled' }) => void;
  const done = new Promise<{ status: 'completed' | 'cancelled' }>(resolve => { settle = resolve; });
  const timeout = setTimeout(() => audioWaiters.get(id)?.('completed'), 180_000);
  audioWaiters.set(id, status => {
    audioWaiters.delete(id);
    clearTimeout(timeout);
    if (status !== 'failed') {
      settle({ status });
      return;
    }
    // The window could not play it: afplay instead.
    const child = spawn('/usr/bin/afplay', [file], { stdio: 'ignore', shell: false });
    child.once('error', () => settle({ status: 'completed' }));
    child.once('close', () => settle({ status: 'completed' }));
  });
  void readFile(file)
    .then(bytes => {
      if (window.isDestroyed()) audioWaiters.get(id)?.('failed');
      else window.webContents.send('vyomara:audio-play', { id, bytes });
    })
    .catch(() => audioWaiters.get(id)?.('failed'));
  return {
    done,
    stop: () => {
      if (!window.isDestroyed()) window.webContents.send('vyomara:audio-stop', { id });
      audioWaiters.get(id)?.('cancelled');
    },
  };
});

ipcMain.on('vyomara:audio-done', (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) return;
  if (typeof input !== 'object' || input === null) return;
  const { id, status } = input as { id?: unknown; status?: unknown };
  if (typeof id !== 'number') return;
  audioWaiters.get(id)?.(status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : 'completed');
});

/**
 * One speaker at a time: clauses of a live reply and one-off lines (approval
 * questions, greetings) take turns instead of failing as "already speaking".
 */
let speechTurn: Promise<unknown> = Promise.resolve();
function inSpeechTurn<T>(speak: () => Promise<T>): Promise<T> {
  const run = speechTurn.then(speak, speak);
  speechTurn = run.catch(() => undefined);
  return run;
}

/** The spoken reply being read while the model is still writing it (voice requests). */
interface LiveSpeech {
  readonly requestId: string;
  readonly clauses: ClauseStream;
  readonly queue: SpeechQueue<PreparedSpeech>;
  /** Something was already said for this reply (text or an acknowledgement). */
  spoke: boolean;
}
let liveSpeech: LiveSpeech | undefined;

function startLiveSpeech(requestId: string): LiveSpeech {
  void liveSpeech?.queue.cancel();
  const gender = personaFor(persona).gender;
  const live: LiveSpeech = {
    requestId,
    spoke: false,
    clauses: new ClauseStream(),
    queue: new SpeechQueue<PreparedSpeech>({
      prepare: text => macSpeechRunner.prepare(text, gender),
      play: prepared => inSpeechTurn(() => macSpeechRunner.play(prepared)),
      discard: prepared => macSpeechRunner.discard(prepared),
    }, speaking => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('vyomara:live-speech', { requestId, speaking });
    }),
  };
  liveSpeech = live;
  return live;
}

function finishLiveSpeech(live: LiveSpeech): void {
  for (const clause of live.clauses.end()) live.queue.enqueue(clause);
  void live.queue.close().finally(() => {
    if (liveSpeech === live) liveSpeech = undefined;
  });
}
/** Approved file changes per request, so "undo karo" can put them back. */
/** Drives the user's Chrome for the browser tool, when Chrome is installed. */
const chromeBrowser = existsSync('/Applications/Google Chrome.app') ? new ChromeBrowser() : undefined;
const macSystemControl = process.platform === 'darwin' ? new MacSystemControl() : undefined;
/** Records per-app screen time locally while the app runs (screen_time tool, break nudges). */
let usageStore: SqliteStore | undefined;
let usageSampler: UsageSampler | undefined;
const changeJournal = new ChangeJournal({ moveToTrash: path => shell.trashItem(path) });
/** Told to the model on the next request in a session after an undo. */
const undoNotes = new Map<string, string>();
/** Shows proposed file changes as diffs in VS Code (created once the app is ready). */
let diffPreview: VSCodeDiffPreview | undefined;
/** File changes waiting for review in the current request, by id. */
const activeProposals = new Map<string, DesktopFileOperationProposal>();
/** Keeps the speech model loaded while listening is on. */
const whisperServer = new LocalWhisperServer();
const macApplicationLauncher = process.platform === 'darwin'
  ? new MacApplicationLauncher()
  : undefined;
let localWhisperRunner: LocalWhisperRunner | undefined;
let voiceListeningEnabled = false;
/** Tap-to-dictate recording into a message box is in progress. */
let dictationActive = false;
/** Speech-recognition model in use; "best" handles Hindi, English, and mixed speech. */
let speechModel: SpeechModelId = 'fast';
/** Which assistant answers and speaks: a lead (Vyom, Vyomara) or a specialist. */
let persona: PersonaId = DEFAULT_PERSONA;
/** User-written character per assistant (Character panel), woven into the system prompt. */
let characters: Partial<Record<PersonaId, string>> = {};
let config: AppConfig | undefined;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
} else {
  app.quit();
}

function publicErrorMessage(error: unknown): string {
  if (
    error instanceof AgentError ||
    error instanceof ProviderError ||
    error instanceof ToolExecutionError ||
    error instanceof PersistenceError ||
    error instanceof MacSpeechError ||
    error instanceof LocalSpeechError ||
    error instanceof FileOperationApprovalError ||
    error instanceof ActionApprovalError
  ) {
    return error.message;
  }
  return 'The request failed safely. No success is implied; review local configuration and retry.';
}

function createDesktopLogger(): Logger {
  const emit = (event: DiagnosticEvent): void => {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('vyomara:activity', event);
    }
  };
  return {
    emit,
    failure() {
      emit({ event: 'request.failed', code: 'request.failed' });
    },
  };
}

function speechModelDirectory(): string {
  return join(app.getPath('userData'), 'speech-models');
}

function getLocalWhisperRunner(): LocalWhisperRunner {
  const binaryPath = resolveWhisperBinary();
  if (localWhisperRunner && localWhisperRunner.model.id !== speechModel && !localWhisperRunner.isListening) {
    localWhisperRunner = undefined;
  }
  localWhisperRunner ??= new LocalWhisperRunner({
    modelDirectory: speechModelDirectory(),
    model: speechModel,
    ...(binaryPath === undefined ? {} : { binaryPath }),
  });
  return localWhisperRunner;
}

async function speechStatus() {
  const runner = getLocalWhisperRunner();
  const models = await Promise.all(SPEECH_MODEL_IDS.map(id => SPEECH_MODELS[id]).map(async model => ({
    id: model.id,
    label: model.label,
    approxMegabytes: model.approxMegabytes,
    ready: await new LocalWhisperRunner({ modelDirectory: speechModelDirectory(), model: model.id }).modelAvailable(),
  })));
  return {
    modelReady: await runner.modelAvailable(),
    runtimeAvailable: resolveWhisperServer() !== undefined,
    listeningEnabled: voiceListeningEnabled,
    model: speechModel,
    models,
  };
}

function emitSpeechEvent(event: LocalWhisperEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vyomara:speech-recognition-event', event);
  }
}

function permissionsPath(): string {
  return join(app.getPath('userData'), 'permissions.json');
}

async function readStandingGrants(): Promise<readonly string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(permissionsPath(), 'utf8'));
    if (typeof value !== 'object' || value === null || !Array.isArray((value as { grants?: unknown }).grants)) return [];
    return (value as { grants: unknown[] }).grants.filter((grant): grant is string => typeof grant === 'string');
  } catch {
    return [];
  }
}

async function saveStandingGrants(grants: readonly string[]): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  const temporaryPath = `${permissionsPath()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ grants }, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, permissionsPath());
}

function describeGrant(id: string): { readonly id: string; readonly kind: string; readonly label: string } | undefined {
  const grant = parseGrantId(id);
  if (!grant) return undefined;
  const label = grant.kind === 'app'
    ? `Open ${grant.application}`
    : grant.kind === 'browser'
      ? `Open web pages in ${grant.browser === DEFAULT_BROWSER ? 'your default browser' : grant.browser}`
      : grant.kind === 'command'
        ? `Run \`${grant.pattern}\` in ${grant.folder.replace(homedir(), '~')}`
        : `Read pages from ${grant.host}`;
  return { id, kind: grant.kind, label };
}

function permissionsState() {
  return {
    grants: approvalMemory.grants().flatMap(id => describeGrant(id) ?? []),
  };
}

function personaPath(): string {
  return join(app.getPath('userData'), 'assistant.json');
}

const MAX_CHARACTER_CHARS = 500;

function sanitizeCharacter(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/gu, ' ').trim().slice(0, MAX_CHARACTER_CHARS);
  return text === '' ? undefined : text;
}

async function readAssistantState(): Promise<{ persona: PersonaId; characters: Partial<Record<PersonaId, string>> }> {
  try {
    const value: unknown = JSON.parse(await readFile(personaPath(), 'utf8'));
    const record = typeof value === 'object' && value !== null
      ? (value as { persona?: unknown; characters?: unknown })
      : {};
    const stored: Partial<Record<PersonaId, string>> = {};
    if (typeof record.characters === 'object' && record.characters !== null) {
      for (const [key, text] of Object.entries(record.characters)) {
        const clean = sanitizeCharacter(text);
        if (isPersonaId(key) && clean !== undefined) stored[key] = clean;
      }
    }
    return { persona: isPersonaId(record.persona) ? record.persona : DEFAULT_PERSONA, characters: stored };
  } catch {
    return { persona: DEFAULT_PERSONA, characters: {} };
  }
}

async function saveAssistantState(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 });
  const temporaryPath = `${personaPath()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ persona, characters }), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, personaPath());
}

function voicePreferencePath(): string {
  return join(app.getPath('userData'), 'voice-preferences.json');
}

async function saveVoiceListeningPreference(enabled: boolean): Promise<void> {
  const path = voicePreferencePath();
  await mkdir(join(app.getPath('userData')), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp`;
  // Remember whether this choice was made with the Hinglish model available, so it is not switched back automatically.
  const chosenWithHinglish = await new LocalWhisperRunner({ modelDirectory: speechModelDirectory(), model: 'hinglish' }).modelAvailable().catch(() => false);
  await writeFile(temporaryPath, JSON.stringify({ enabled, model: speechModel, chosenWithHinglish }), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, path);
}

async function readVoiceListeningPreference(): Promise<boolean> {
  let saved: { enabled?: unknown; model?: unknown; chosenWithHinglish?: unknown } = {};
  try {
    const value: unknown = JSON.parse(await readFile(voicePreferencePath(), 'utf8'));
    if (typeof value !== 'object' || value === null || !('enabled' in value) || typeof value.enabled !== 'boolean') {
      throw new Error('Saved voice-listening preference is invalid.');
    }
    saved = value as { enabled?: unknown; model?: unknown; chosenWithHinglish?: unknown };
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  if (isSpeechModelId(saved.model)) speechModel = saved.model;
  // The Hinglish model hears Hindi and mixed speech far better (and ~5x faster)
  // than the others: use it whenever it is installed, unless the user picked
  // it away after it was installed.
  const hinglish = new LocalWhisperRunner({ modelDirectory: speechModelDirectory(), model: 'hinglish' });
  if (saved.model !== 'hinglish' && saved.chosenWithHinglish !== true && await hinglish.modelAvailable().catch(() => false)) speechModel = 'hinglish';
  else if (!isSpeechModelId(saved.model)) {
    // No choice saved yet: prefer the multilingual model when it is installed.
    const best = new LocalWhisperRunner({ modelDirectory: speechModelDirectory(), model: 'best' });
    if (await best.modelAvailable().catch(() => false)) speechModel = 'best';
  }
  return saved.enabled === true;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    title: 'Vyomara',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      // The conversation keeps running (voice, approvals) while the window is hidden.
      backgroundThrottling: false,
    },
  });
  // Closing hides the window so voice and the mini window keep working; Cmd+Q quits.
  window.on('close', event => {
    if (quitting || process.platform !== 'darwin') return;
    event.preventDefault();
    window.hide();
  });
  window.on('hide', () => showPip());
  window.on('minimize', () => showPip());
  window.on('blur', () => showPip());
  window.on('show', () => hidePipIfMainActive());
  window.on('restore', () => hidePipIfMainActive());
  window.on('focus', () => hidePipIfMainActive());
  // While the user is in another app, only the thinking mark keeps moving.
  const decorate = (): void => pauseAnimations(window, !window.isFocused() || !window.isVisible() || window.isMinimized(), true);
  for (const name of ['hide', 'minimize', 'blur', 'show', 'restore', 'focus'] as const) window.on(name as 'hide', decorate);
  // A reload drops inserted CSS.
  window.webContents.on('did-finish-load', () => { pausedAnimations.delete(window); decorate(); });
  window.webContents.on('preload-error', () => {
    console.error(JSON.stringify({ event: 'desktop.preload-failed', code: 'secure-bridge-unavailable' }));
    dialog.showErrorBox(
      'Vyomara could not start',
      'The secure desktop bridge failed to load. Restart Vyomara after updating the application.',
    );
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  // Scale the interface for the window's size and its screen: maximized on an
  // external monitor everything grows; back on the laptop it returns to 1x.
  let scaleTimer: ReturnType<typeof setTimeout> | undefined;
  const rescale = (): void => {
    if (window.isDestroyed()) return;
    const [width = 0, height = 0] = window.getContentSize();
    const zoom = uiZoomFor({ width, height }, screen.getDisplayMatching(window.getBounds()).workAreaSize);
    if (Math.abs(window.webContents.getZoomFactor() - zoom) > 0.001) window.webContents.setZoomFactor(zoom);
  };
  const scheduleRescale = (): void => {
    if (scaleTimer) clearTimeout(scaleTimer);
    scaleTimer = setTimeout(rescale, 120);
  };
  for (const name of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) window.on(name as 'resize', scheduleRescale);
  window.webContents.on('did-finish-load', rescale);
  screen.on('display-metrics-changed', scheduleRescale);
  screen.on('display-added', scheduleRescale);
  screen.on('display-removed', scheduleRescale);
  window.once('closed', () => {
    screen.removeListener('display-metrics-changed', scheduleRescale);
    screen.removeListener('display-added', scheduleRescale);
    screen.removeListener('display-removed', scheduleRescale);
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = undefined;
      activeRequest?.abort();
    }
  });

  void loadRenderer(window).catch(() => {
    dialog.showErrorBox(
      'Vyomara could not start',
      'The desktop interface could not be loaded. Restart Vyomara after updating the application.',
    );
  });
  return window;
}

function loadRenderer(window: BrowserWindow, hash?: string): Promise<void> {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  return rendererUrl
    ? window.loadURL(hash ? `${rendererUrl}#${hash}` : rendererUrl)
    : window.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)), hash ? { hash } : {});
}

function pipPreferencePath(): string {
  return join(app.getPath('userData'), 'pip.json');
}

async function readPipPosition(): Promise<{ x: number; y: number } | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(pipPreferencePath(), 'utf8'));
    if (typeof value === 'object' && value !== null && 'x' in value && 'y' in value &&
        Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y)) {
      const position = { x: value.x as number, y: value.y as number };
      // Ignore positions on a display that is no longer connected.
      const visible = screen.getAllDisplays().some(display =>
        position.x >= display.workArea.x && position.y >= display.workArea.y &&
        position.x + PIP_SIZE.width <= display.workArea.x + display.workArea.width &&
        position.y + PIP_SIZE.height <= display.workArea.y + display.workArea.height);
      return visible ? position : undefined;
    }
  } catch {
    // No saved position yet.
  }
  return undefined;
}

/**
 * Pause CSS animations in a window nobody is looking at. Every animated
 * frame redraws the window on the GPU, and measured on an M4 Pro that made
 * the local model ~8% slower to read and ~10% slower to write.
 */
const pausedAnimations = new WeakMap<BrowserWindow, Promise<string>>();
const PAUSE_ALL = '*, *::before, *::after { animation-play-state: paused !important; }';
const PAUSE_DECORATION = '*:not(.thinking-mark, .thinking-mark *), *::before, *::after { animation-play-state: paused !important; }';

function pauseAnimations(window: BrowserWindow, paused: boolean, keepThinking = false): void {
  if (window.isDestroyed()) return;
  const key = pausedAnimations.get(window);
  if (paused && key === undefined) {
    pausedAnimations.set(window, window.webContents.insertCSS(keepThinking ? PAUSE_DECORATION : PAUSE_ALL));
  } else if (!paused && key !== undefined) {
    pausedAnimations.delete(window);
    void key.then(css => window.isDestroyed() ? undefined : window.webContents.removeInsertedCSS(css)).catch(() => undefined);
  }
}

async function createPipWindow(): Promise<BrowserWindow> {
  const area = screen.getPrimaryDisplay().workArea;
  const position = await readPipPosition() ??
    { x: area.x + area.width - PIP_SIZE.width - 24, y: area.y + area.height - PIP_SIZE.height - 24 };
  const window = new BrowserWindow({
    ...PIP_SIZE,
    ...position,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: true,
    alwaysOnTop: true,
    // Not a macOS "panel": panels hide whenever Vyomara is not the active app,
    // which is exactly when the mini window is needed. It is shown inactive instead.
    title: personaFor(persona).name,
    // Native frosted glass behind the card on macOS.
    ...(process.platform === 'darwin' ? { vibrancy: 'hud' as const, visualEffectState: 'active' as const } : {}),
    roundedCorners: true,
    webPreferences: {
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('did-finish-load', () => {
    if (lastPipState !== undefined) window.webContents.send('vyomara:pip-state', lastPipState);
  });
  window.on('moved', () => {
    const [x, y] = window.getPosition();
    void writeFile(pipPreferencePath(), JSON.stringify({ x, y }), { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
  });
  window.on('closed', () => {
    if (pipWindow === window) pipWindow = undefined;
  });
  // A hidden mini window would otherwise keep animating and take GPU time from the model.
  window.on('show', () => pauseAnimations(window, false));
  window.on('hide', () => pauseAnimations(window, true));
  window.webContents.on('did-finish-load', () => { pausedAnimations.delete(window); pauseAnimations(window, !window.isVisible()); });
  await loadRenderer(window, 'pip');
  return window;
}

/** The user's choice in the sidebar: show the mini window over other apps, or never. */
let pipEnabled = false;

function pipSettingsPath(): string {
  return join(app.getPath('userData'), 'pip-settings.json');
}

async function readPipEnabled(): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(pipSettingsPath(), 'utf8'));
    return typeof value === 'object' && value !== null && (value as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

function showPip(): void {
  if (!pipEnabled || !pipWindow || pipWindow.isDestroyed() || quitting) return;
  // Only when Vyomara itself is not in front.
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()) return;
  if (!pipWindow.isVisible()) pipWindow.showInactive();
}

function hidePipIfMainActive(): void {
  if (!pipWindow || pipWindow.isDestroyed()) return;
  if (mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized()) pipWindow.hide();
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
}

ipcMain.handle('vyomara:pip-enabled-get', event => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Mini window request is invalid.');
  return pipEnabled;
});

ipcMain.handle('vyomara:pip-enabled-set', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Mini window request is invalid.');
  if (typeof input !== 'boolean') throw new Error('Choose on or off.');
  pipEnabled = input;
  if (!pipEnabled && pipWindow && !pipWindow.isDestroyed()) pipWindow.hide();
  await writeFile(pipSettingsPath(), JSON.stringify({ enabled: pipEnabled }), { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
  return pipEnabled;
});

ipcMain.on('vyomara:pip-state', (event, state: unknown) => {
  if (event.sender !== mainWindow?.webContents) return;
  lastPipState = state;
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.webContents.send('vyomara:pip-state', state);
});

ipcMain.on('vyomara:pip-command', (event, command: unknown) => {
  if (!pipWindow || event.sender !== pipWindow.webContents) return;
  if (typeof command !== 'object' || command === null || !('type' in command)) return;
  const type = (command as { type: unknown }).type;
  if (type === 'open-main') {
    showMainWindow();
    return;
  }
  if (type === 'hide-pip') {
    // Stays hidden until the main window is used again and then left.
    pipWindow.hide();
    return;
  }
  const id = (command as { id?: unknown }).id;
  if (type === 'dictation') {
    const recording = (command as { recording?: unknown }).recording;
    if (typeof recording === 'boolean') mainWindow?.webContents.send('vyomara:pip-command', { type, recording });
    return;
  }
  if (type === 'submit') {
    const text = (command as { text?: unknown }).text;
    if (typeof text === 'string' && text.trim() !== '' && text.length <= 32_000) {
      mainWindow?.webContents.send('vyomara:pip-command', { type, text });
    }
    return;
  }
  if (!['toggle-listening', 'approve', 'reject', 'stop'].includes(String(type))) return;
  if ((type === 'approve' || type === 'reject') && typeof id !== 'string') return;
  mainWindow?.webContents.send('vyomara:pip-command', type === 'approve' || type === 'reject' ? { type, id } : { type });
});

function registerVoiceShortcut(): void {
  // Option+Space toggles listening from any app; fall back if another app owns it.
  for (const accelerator of ['Alt+Space', 'Alt+Shift+Space']) {
    const registered = globalShortcut.register(accelerator, () => {
      mainWindow?.webContents.send('vyomara:pip-command', { type: 'toggle-listening' });
      showPip();
    });
    if (registered) {
      console.error(JSON.stringify({ event: 'shortcut.registered', accelerator }));
      return;
    }
  }
}

function providerStatus(current: AppConfig) {
  return {
    provider: current.provider,
    model: current.ollamaModel,
    contextTokens: current.ollamaNumCtx,
  };
}

function ollamaProvider(current: AppConfig): OllamaProvider {
  return new OllamaProvider({ baseUrl: current.ollamaBaseUrl, model: current.ollamaModel });
}

/** Chat requests get the whole Mac, not only the configured roots. */
function desktopConfigFor(current: AppConfig): AppConfig {
  return { ...current, filesystemAllowedRoots: ['/'] };
}

/** Tools of a desktop chat request; priming must use the same ones, or the cached prompt does not match. */
function desktopToolOptions(
  desktopConfig: AppConfig,
  approvals: FileOperationApprovalManager,
  actionApprovals: ActionApprovalManager,
): Pick<RequestOptions, 'includeFilesystemTools' | 'fileOperationApproval' | 'actions'> {
  return {
    includeFilesystemTools: true,
    fileOperationApproval: approvals,
    actions: {
      approval: actionApprovals,
      approvalMemory: approvalMemory,
      commandRunner: shellCommandRunner,
      ...(macApplicationLauncher ? { launcher: macApplicationLauncher } : {}),
      web: new HttpWebClient(desktopConfig.searxngUrl === undefined ? {} : { searxngUrl: desktopConfig.searxngUrl }),
      ...(chromeBrowser ? { browser: chromeBrowser } : {}),
      ...(macSystemControl ? { system: macSystemControl } : {}),
      ...(usageStore ? { usage: { usageSince: (day: string) => usageStore!.appUsageSince(day) } } : {}),
      mcp: mcpManager,
      mcpAllowed,
    },
  };
}

let activePrime: AbortController | undefined;

/**
 * Load the chosen model in the background, then let it read a new chat's
 * system prompt and tools (~8,000 tokens, ~45 s on a 14B model), so the
 * first message does not wait for either. Runs again when the model,
 * context size, or assistant changes, since those change the prompt.
 */
function warmUpModel(current: AppConfig | undefined): void {
  if (!current || current.provider !== 'ollama') return;
  activePrime?.abort();
  const controller = new AbortController();
  activePrime = controller;
  const desktopConfig = desktopConfigFor(current);
  const refuse = (): never => { throw new Error('Priming never runs tools.'); };
  void new OllamaProvider({
    baseUrl: current.ollamaBaseUrl,
    model: current.ollamaModel,
    numCtx: current.ollamaNumCtx,
  }).warmUp(AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]))
    .then(() => controller.signal.aborted ? undefined : primeModel(desktopConfig, createDesktopLogger(), AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]), {
      persona,
      ...(characters[persona] === undefined ? {} : { character: characters[persona] }),
      ...desktopToolOptions(
        desktopConfig,
        new FileOperationApprovalManager({ config: desktopConfig, onProposal: refuse, moveToTrash: refuse }),
        new ActionApprovalManager({ onProposal: refuse }),
      ),
    }))
    .catch(() => undefined)
    .finally(() => { if (activePrime === controller) activePrime = undefined; });
}

ipcMain.handle('vyomara:provider-status', () => {
  if (!config) throw new Error('Application configuration is unavailable.');
  return providerStatus(config);
});

ipcMain.handle('vyomara:models-list', async () => {
  if (!config) throw new Error('Application configuration is unavailable.');
  const current = config;
  const settings = { numCtx: current.ollamaNumCtx, think: current.ollamaThink };
  const provider = ollamaProvider(current);
  try {
    const installed = await provider.listModels();
    const models = await Promise.all(installed.map(async model => ({ ...model, ...await provider.showModel(model.name) })));
    return { available: true, current: current.ollamaModel, models, settings };
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'unavailable') {
      return { available: false, current: current.ollamaModel, models: [], settings };
    }
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:model-settings-set', (_event, input: unknown) => {
  if (!config) throw new Error('Application configuration is unavailable.');
  if (activeRequest) throw new Error('Wait for the current task to finish before changing model settings.');
  const request = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as { readonly numCtx?: unknown; readonly think?: unknown }
    : {};
  const numCtx = request.numCtx;
  const think = request.think;
  if (numCtx !== undefined && (typeof numCtx !== 'number' || !Number.isSafeInteger(numCtx) || numCtx < 2_048 || numCtx > 262_144)) {
    throw new Error('Context window must be between 2,048 and 262,144 tokens.');
  }
  if (think !== undefined && typeof think !== 'boolean') throw new Error('Thinking must be on or off.');
  const settings = {
    ...(numCtx === undefined ? {} : { numCtx }),
    ...(think === undefined ? {} : { think }),
  };
  saveModelSettings(config, settings);
  config = withSavedModelSettings(config, settings);
  if (numCtx !== undefined) warmUpModel(config);
  return providerStatus(config);
});

ipcMain.handle('vyomara:model-delete', async (_event, input: unknown) => {
  if (!config) throw new Error('Application configuration is unavailable.');
  if (activeRequest) throw new Error('Wait for the current task to finish before removing a model.');
  const request = typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as { readonly name?: unknown; readonly confirmation?: unknown }
    : {};
  if (typeof request.name !== 'string' || request.confirmation !== 'DELETE') {
    throw new Error('Type DELETE to confirm removing this model.');
  }
  const name = validateOllamaModel(request.name);
  if (name === config.ollamaModel) throw new Error('Switch to another model before removing the one in use.');
  try {
    await ollamaProvider(config).deleteModel(name);
  } catch (error) {
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:ollama-start', async () => {
  if (!config) throw new Error('Application configuration is unavailable.');
  if (process.platform !== 'darwin') throw new Error('Starting Ollama from Vyomara is supported on macOS only.');
  const opened = spawnSync('/usr/bin/open', ['-a', 'Ollama'], { stdio: 'ignore' });
  if (opened.status !== 0) {
    throw new Error('Ollama is not installed. Download it from ollama.com, then try again.');
  }
  const provider = ollamaProvider(config);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await provider.checkConnection();
      return;
    } catch {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
    }
  }
  throw new Error('Ollama was opened but is not responding yet. Try again in a moment.');
});

ipcMain.handle('vyomara:model-select', async (_event, input: unknown) => {
  if (!config) throw new Error('Application configuration is unavailable.');
  if (activeRequest) throw new Error('Wait for the current task to finish before switching models.');
  if (typeof input !== 'string') throw new Error('Choose a model by name.');
  let model: string;
  try {
    model = validateOllamaModel(input);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'The model name is invalid.');
  }
  const candidate: AppConfig = { ...config, provider: 'ollama', ollamaModel: model };
  try {
    if (await ollamaProvider(candidate).checkModelAvailability() !== 'installed') {
      throw new Error(`The model “${model}” is not installed. Pull it first.`);
    }
    saveSelectedModel(config, model);
  } catch (error) {
    throw new Error(error instanceof Error && !(error instanceof ProviderError) ? error.message : publicErrorMessage(error));
  }
  const previous = config;
  config = candidate;
  // Free the old model's memory right away (it would otherwise stay loaded for
  // 30 minutes), then load the new one.
  const next = config;
  void (previous.provider === 'ollama' && previous.ollamaModel !== model
    ? ollamaProvider(previous).unload()
    : Promise.resolve()
  ).then(() => warmUpModel(next));
  return providerStatus(config);
});

ipcMain.handle('vyomara:model-pull', async (_event, input: unknown) => {
  if (!config) throw new Error('Application configuration is unavailable.');
  if (activeModelPull) throw new Error('A model download is already in progress.');
  if (typeof input !== 'string') throw new Error('Enter a model name, for example qwen3:14b.');
  let model: string;
  try {
    model = validateOllamaModel(input);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'The model name is invalid.');
  }
  const controller = new AbortController();
  activeModelPull = controller;
  try {
    await ollamaProvider(config).pullModel(model, progress => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('vyomara:model-pull-progress', { model, ...progress });
      }
    }, controller.signal);
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'model-not-found') {
      throw new Error(`Ollama could not download “${model}”. Check the name on ollama.com/library.`);
    }
    throw new Error(publicErrorMessage(error));
  } finally {
    activeModelPull = undefined;
  }
});

ipcMain.handle('vyomara:chat-send', async (_event, input: unknown) => {
  if (!config) throw new Error('Application configuration is unavailable.');
  const request = parseDesktopChatRequest(input, config.maxInputChars);
  if (activeRequest) throw new Error('A request is already in progress.');

  const controller = new AbortController();
  activeRequest = controller;
  const desktopConfig = desktopConfigFor(config);
  const approvals = new FileOperationApprovalManager({
    config: desktopConfig,
    onProposal(proposal) {
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new Error('The review window is unavailable; no file operation was performed.');
      }
      mainWindow.webContents.send('vyomara:file-operation-proposed', proposal);
      activeProposals.set(proposal.id, proposal);
      // The owner reads code in VS Code: when it is open, show the change there too.
      const preview = diffPreview;
      if (preview && canShowDiff(proposal)) {
        void preview.isVSCodeRunning()
          .then(running => (running ? preview.open(proposal) : undefined))
          .catch(() => console.error(JSON.stringify({ event: 'diff-preview.failed' })));
      }
    },
    moveToTrash: path => shell.trashItem(path),
    onApplied: entry => changeJournal.record(request.requestId, entry),
  });
  activeFileOperationApproval = approvals;
  changeJournal.begin(request.requestId, request.sessionId);
  // After an undo, the model must know its earlier changes are gone.
  const undoNote = request.sessionId === undefined ? undefined : undoNotes.get(request.sessionId);
  if (request.sessionId !== undefined) undoNotes.delete(request.sessionId);
  const actionApprovals = new ActionApprovalManager({
    onProposal(proposal) {
      if (!mainWindow || mainWindow.isDestroyed()) {
        throw new ActionApprovalError('The approval window is unavailable; nothing was run or opened.');
      }
      mainWindow.webContents.send('vyomara:action-proposed', proposal);
    },
  });
  activeActionApproval = actionApprovals;
  const send = (channel: string, payload: unknown): void => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };
  // Voice requests are read aloud clause by clause while the reply is written.
  const live = request.voice ? startLiveSpeech(request.requestId) : undefined;
  try {
    const result = await runRequest(
      undoNote === undefined ? request.prompt : `${undoNote}\n\n${request.prompt}`,
      controller.signal,
      desktopConfig,
      createDesktopLogger(),
      {
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.voice ? { voice: true } : {}),
        ...(request.planOnly ? { planOnly: true } : {}),
        ...(request.images ? { images: request.images } : {}),
        persona,
        ...(characters[persona] === undefined ? {} : { character: characters[persona] }),
        ...(macSpeechRunner.naturalVoiceReady ? { devanagariVoice: true } : {}),
        onText: text => {
          send('vyomara:chat-text', { requestId: request.requestId, text });
          if (live) for (const clause of live.clauses.push(text)) {
            live.spoke = true;
            live.queue.enqueue(clause);
          }
        },
        onToolActivity: activity => {
          send('vyomara:tool-activity', { requestId: request.requestId, ...activity });
          // Speak first, then work: a short line when the first tool starts and nothing was said yet.
          if (live && !live.spoke && activity.status === 'running') {
            live.spoke = true;
            live.queue.enqueue(acknowledgementFor(activity.toolId, activity.label, personaFor(persona).gender));
          }
        },
        onPlan: steps => send('vyomara:plan', { requestId: request.requestId, steps }),
        ...desktopToolOptions(desktopConfig, approvals, actionApprovals),
      },
    );
    changeJournal.setSession(request.requestId, result.sessionId);
    if (live) finishLiveSpeech(live);
    return { ...result, ...(live ? { spokenLive: true } : {}) };
  } catch (error) {
    if (live) void live.queue.cancel();
    throw new Error(publicErrorMessage(error));
  } finally {
    activeRequest = undefined;
    activeFileOperationApproval = undefined;
    activeActionApproval = undefined;
    activeProposals.clear();
  }
});

ipcMain.handle('vyomara:file-operation-approve-all', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('File review request is invalid.');
  if (!activeRequest || !activeFileOperationApproval) throw new Error('There is no active file operation to approve.');
  if (typeof input !== 'string') throw new Error('File review request is invalid.');
  try {
    await activeFileOperationApproval.approveAllEdits(input);
  } catch (error) {
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:file-diff-open', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Diff request is invalid.');
  const proposal = typeof input === 'string' ? activeProposals.get(input) : undefined;
  if (!proposal) throw new Error('This change is no longer waiting for review.');
  if (!diffPreview) throw new Error('VS Code diffs are not available yet.');
  try {
    await diffPreview.open(proposal);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'VS Code could not show the diff.');
  }
});

ipcMain.handle('vyomara:undo-status', (event): DesktopUndoStatus => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Undo request is invalid.');
  const group = changeJournal.last();
  return group
    ? { available: true, requestId: group.requestId, paths: group.entries.map(entry => entry.path) }
    : { available: false, paths: [] };
});

ipcMain.handle('vyomara:undo-last', async (event): Promise<DesktopUndoResult> => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Undo request is invalid.');
  if (activeRequest) throw new Error('Wait for the current task to finish, then undo.');
  const result = await changeJournal.undoLast();
  const sessionId = result.group?.sessionId;
  if (sessionId !== undefined && result.restored.length > 0) {
    const restored = result.restored.map(path => path.split('/').at(-1) ?? path).join(', ');
    const skipped = result.skipped.map(item => `${item.path.split('/').at(-1) ?? item.path} (${item.reason})`).join('; ');
    undoNotes.set(sessionId, `[Note from the Vyomara app: the user undid your file changes from the previous request. `
      + `These are back to how they were before your changes: ${restored}.${skipped ? ` Not restored: ${skipped}.` : ''} `
      + `Read files again before changing them.]`);
  }
  return { restored: result.restored, movedToTrash: result.movedToTrash, skipped: result.skipped };
});

ipcMain.handle('vyomara:file-operation-approve', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('File review request is invalid.');
  if (!activeRequest || !activeFileOperationApproval) {
    throw new Error('There is no active file operation to approve.');
  }
  try {
    const approval = parseDesktopFileOperationApprovalRequest(input);
    await activeFileOperationApproval.approve(approval.id, approval.confirmation);
  } catch (error) {
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:file-operation-reject', (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('File review request is invalid.');
  if (!activeRequest || !activeFileOperationApproval) {
    throw new Error('There is no active file operation to reject.');
  }
  try {
    activeFileOperationApproval.reject(parseDesktopSessionId(input));
  } catch (error) {
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:open-link', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Link request is invalid.');
  if (typeof input !== 'string' || input.length > 8_192) throw new Error('This link is not valid.');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('This link is not valid.');
  }
  // The user clicked it; only ordinary web links open, in their own browser.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only web links can be opened.');
  await shell.openExternal(url.href);
});

function memoryStore(): MemoryStore {
  if (!config) throw new Error('Application configuration is unavailable.');
  return new MemoryStore(config.dataDirectory);
}

ipcMain.handle('vyomara:memories-list', event => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Memory request is invalid.');
  return memoryStore().list();
});

ipcMain.handle('vyomara:memory-forget', (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Memory request is invalid.');
  if (typeof input !== 'string') throw new Error('Choose a memory to forget.');
  const store = memoryStore();
  store.remove(input);
  return store.list();
});

ipcMain.handle('vyomara:permissions-list', () => permissionsState());

ipcMain.handle('vyomara:permission-grant', (_event, input: unknown) => {
  const grant = typeof input === 'string' ? parseGrantId(input) : undefined;
  if (!grant) throw new Error('This permission is not valid.');
  approvalMemory.grant(grant);
  return permissionsState();
});

ipcMain.handle('vyomara:permission-revoke', (_event, input: unknown) => {
  const grant = typeof input === 'string' ? parseGrantId(input) : undefined;
  if (!grant) throw new Error('This permission is not valid.');
  approvalMemory.revoke(grantId(grant));
  return permissionsState();
});

ipcMain.handle('vyomara:action-approve', (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Approval request is invalid.');
  if (!activeRequest || !activeActionApproval) throw new Error('There is no pending action to approve.');
  try {
    const request = typeof input === 'object' && input !== null && !Array.isArray(input)
      ? input as { readonly id?: unknown; readonly always?: unknown }
      : { id: input };
    if (request.always !== undefined && typeof request.always !== 'boolean') {
      throw new ActionApprovalError('The approval request is invalid.');
    }
    activeActionApproval.approve(parseDesktopSessionId(request.id), request.always === true);
  } catch (error) {
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:action-reject', (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Approval request is invalid.');
  if (!activeRequest || !activeActionApproval) throw new Error('There is no pending action to reject.');
  try {
    activeActionApproval.reject(parseDesktopSessionId(input));
  } catch (error) {
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:chat-cancel', () => {
  if (!activeRequest) return false;
  activeRequest.abort();
  return true;
});

ipcMain.handle('vyomara:sessions-list', () => {
  if (!config) throw new Error('Application configuration is unavailable.');
  try {
    return readDesktopSessions(config);
  } catch (error) {
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:session-load', (_event, input: unknown) => {
  if (!config) throw new Error('Application configuration is unavailable.');
  try {
    const sessionId = parseDesktopSessionId(input);
    return readDesktopSession(config, sessionId);
  } catch (error) {
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:session-export', async (_event, input: unknown) => {
  if (!config) throw new Error('Application configuration is unavailable.');
  if (activeRequest) {
    throw new Error('Wait for the active operation to finish before exporting a conversation.');
  }

  try {
    const sessionId = parseDesktopSessionId(input);
    const contents = exportDesktopSession(config, sessionId);
    const options: SaveDialogOptions = {
      title: 'Export complete Vyomara conversation',
      buttonLabel: 'Export conversation',
      defaultPath: `vyomara-session-${sessionId}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    };
    const status = await exportToSelectedFile(contents, async () => {
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      return result.canceled ? undefined : result.filePath;
    });
    return { status };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
      throw new Error('That file already exists. Choose a new name; Vyomara will not overwrite exports.');
    }
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:session-delete', (_event, input: unknown) => {
  if (!config) throw new Error('Application configuration is unavailable.');
  if (activeRequest) {
    throw new Error('Wait for the active operation to finish before deleting a conversation.');
  }
  try {
    const request = parseDesktopSessionDeleteRequest(input);
    return deleteDesktopSession(config, request.id);
  } catch (error) {
    if (error instanceof DesktopValidationError) throw new Error(error.message);
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:speech-setup-status', () => speechStatus());

ipcMain.handle('vyomara:speech-model-select', async (_event, input: unknown) => {
  if (!isSpeechModelId(input)) throw new Error('Choose a known speech model.');
  if (input === speechModel) return speechStatus();
  speechModel = input;
  localWhisperRunner = undefined;
  const runner = getLocalWhisperRunner();
  if (voiceListeningEnabled) {
    if (await runner.modelAvailable()) {
      await whisperServer.start(runner.modelPath, runner.model.language, undefined, await runner.ensureVadModel());
    } else {
      voiceListeningEnabled = false;
      whisperServer.stop();
      emitSpeechEvent({ type: 'stopped' });
    }
  }
  await saveVoiceListeningPreference(voiceListeningEnabled);
  return speechStatus();
});

ipcMain.handle('vyomara:speech-model-download', async () => {
  if (voiceListeningEnabled) throw new Error('Turn voice listening off before downloading the speech model.');
  try {
    await getLocalWhisperRunner().downloadModel(emitSpeechEvent);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'speech.model-download-failed',
      message: error instanceof Error ? error.message : 'Unknown native speech startup error.',
    }));
    throw new Error(publicErrorMessage(error));
  }
});

/** Check the model, runtime, and microphone, then make sure the speech server is running. */
async function ensureSpeechServer(): Promise<void> {
  const runner = getLocalWhisperRunner();
  if (!await runner.modelAvailable()) throw new LocalSpeechError('Download the selected speech model (Models panel → Voice) first.');
  if (!resolveWhisperServer()) throw new LocalSpeechError('Install the local whisper.cpp runtime with `brew install whisper.cpp`, then restart Vyomara.');
  const microphoneStatus = systemPreferences.getMediaAccessStatus('microphone');
  const microphoneGranted = microphoneStatus === 'granted' ||
    (microphoneStatus === 'not-determined' && await systemPreferences.askForMediaAccess('microphone'));
  if (!microphoneGranted) {
    throw new LocalSpeechError(
      microphoneStatus === 'denied' || microphoneStatus === 'restricted'
        ? 'Microphone access is blocked. Enable it for Vyomara in System Settings > Privacy & Security > Microphone, then restart Vyomara.'
        : 'Microphone access was not granted. Allow it in the macOS prompt to use voice.',
    );
  }
  // VAD removes hallucinated words from noise; without it (download failed), voice still works.
  await whisperServer.start(runner.modelPath, runner.model.language, undefined, await runner.ensureVadModel());
}

/** Stop the speech server when neither hands-free listening nor dictation needs it. */
function releaseSpeechServer(): void {
  if (!voiceListeningEnabled && !dictationActive) whisperServer.stop();
}

ipcMain.handle('vyomara:speech-listening-set', async (_event, input: unknown) => {
  if (typeof input !== 'boolean') throw new Error('Voice listening must be explicitly enabled or disabled.');
  if (input) {
    try {
      // The renderer records phrases; the server keeps the model loaded to transcribe them.
      await ensureSpeechServer();
      voiceListeningEnabled = true;
      await saveVoiceListeningPreference(true);
      emitSpeechEvent({ type: 'listening' });
    } catch (error) {
      voiceListeningEnabled = false;
      releaseSpeechServer();
      throw new Error(publicErrorMessage(error));
    }
  } else {
    voiceListeningEnabled = false;
    releaseSpeechServer();
    macSpeechRunner.stop();
    await saveVoiceListeningPreference(false);
    emitSpeechEvent({ type: 'stopped' });
  }
  return speechStatus();
});

/** Tap-to-dictate: record into the message box, independent of hands-free listening. */
ipcMain.handle('vyomara:speech-dictation', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Speech request is invalid.');
  if (typeof input !== 'boolean') throw new Error('Dictation must be explicitly started or stopped.');
  if (input) {
    try {
      dictationActive = true;
      await ensureSpeechServer();
    } catch (error) {
      dictationActive = false;
      releaseSpeechServer();
      throw new Error(publicErrorMessage(error));
    }
  } else {
    dictationActive = false;
    releaseSpeechServer();
  }
});

ipcMain.handle('vyomara:speech-transcribe', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Speech request is invalid.');
  if (!voiceListeningEnabled && !dictationActive) throw new Error('The microphone is off.');
  if (!(input instanceof Uint8Array)) throw new Error('Recorded audio is invalid.');
  try {
    // "Best" (hi): try auto-detect first so English stays English, falling back to Hindi
    // when auto-detect picks a wrong script. "Fast" (en) keeps its fixed language.
    const languages = getLocalWhisperRunner().model.language === 'hi' ? ['auto', 'hi'] : [];
    return await whisperServer.transcribe(input, languages);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'The phrase could not be transcribed.');
  }
});

ipcMain.handle('vyomara:speech-speak', async (_event, input: unknown) => {
  // The renderer stops recording while Vyom speaks, so the reply is not heard as a command.
  try {
    return await inSpeechTurn(() => macSpeechRunner.speak(input, personaFor(persona).gender));
  } catch (error) {
    throw new Error(publicErrorMessage(error));
  }
});

ipcMain.handle('vyomara:speech-stop', () => {
  const live = liveSpeech;
  if (live) void live.queue.cancel();
  return macSpeechRunner.stop() || live !== undefined;
});

/** Resolves when the live spoken reply for this request has finished (or at once if none). */
ipcMain.handle('vyomara:live-speech-done', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Speech request is invalid.');
  const live = liveSpeech;
  if (live && live.requestId === input) await live.queue.close();
});

ipcMain.handle('vyomara:persona-get', (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Assistant request is invalid.');
  return persona;
});

ipcMain.handle('vyomara:persona-set', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Assistant request is invalid.');
  if (!isPersonaId(input)) throw new Error('Choose one of the Vyomara assistants.');
  if (activeRequest) throw new Error('Wait for the current task to finish before switching assistants.');
  persona = input;
  if (pipWindow && !pipWindow.isDestroyed()) pipWindow.setTitle(personaFor(persona).name);
  await saveAssistantState();
  // Both twins share one cached system prompt (who speaks is in each turn's context): no re-priming.
  return persona;
});

ipcMain.handle('vyomara:characters-get', (event) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Assistant request is invalid.');
  return { ...characters };
});

ipcMain.handle('vyomara:character-set', async (event, input: unknown) => {
  if (event.sender !== mainWindow?.webContents) throw new Error('Assistant request is invalid.');
  const record = typeof input === 'object' && input !== null ? (input as { persona?: unknown; character?: unknown }) : {};
  if (!isPersonaId(record.persona)) throw new Error('Choose one of the Vyomara assistants.');
  if (record.character !== undefined && typeof record.character !== 'string') throw new Error('The character must be text.');
  if (typeof record.character === 'string' && record.character.length > MAX_CHARACTER_CHARS) {
    throw new Error(`Keep the character under ${MAX_CHARACTER_CHARS} characters.`);
  }
  if (activeRequest) throw new Error('Wait for the current task to finish before changing a character.');
  const clean = sanitizeCharacter(record.character);
  if (clean === undefined) delete characters[record.persona];
  else characters[record.persona] = clean;
  await saveAssistantState();
  // The character travels in each turn's context, so the cached system prompt stays valid.
  return { ...characters };
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  diffPreview = new VSCodeDiffPreview({ previewRoot: join(app.getPath('userData'), 'diff-previews') });
  void diffPreview.clear().catch(() => undefined);
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const audioOnlyRequest = 'mediaTypes' in details &&
      details.mediaTypes?.includes('audio') === true &&
      details.mediaTypes.every(mediaType => mediaType === 'audio');
    // Only Vyomara's own page may use the microphone. Chromium reports file
    // pages with the origin "file:///", so also check the exact page URL.
    const requestingUrl = 'requestingUrl' in details && typeof details.requestingUrl === 'string' ? details.requestingUrl : '';
    const trustedOrigin = isTrustedPageRequest(
      requestingUrl,
      pathToFileURL(fileURLToPath(new URL('../renderer/index.html', import.meta.url))).href,
      process.env.ELECTRON_RENDERER_URL,
    );
    const allowed = webContents === mainWindow?.webContents &&
      permission === 'media' &&
      audioOnlyRequest &&
      trustedOrigin;
    if (!allowed) {
      console.error(JSON.stringify({ event: 'permission.denied', permission, requestingUrl: requestingUrl.split('#')[0] }));
    }
    callback(allowed);
  });
  try {
    const loaded = loadConfig(process.env);
    let saved: SavedModelSettings = {};
    try {
      saved = readModelSettings(loaded);
      if (saved.model) validateOllamaModel(saved.model);
    } catch {
      saved = {};
    }
    // Choices made in the app's Models panel take precedence over the environment.
    config = { ...withSavedModelSettings(loaded, saved), filesystemAllowedRoots: ['/'] };
    // Restores the chosen speech model. Listening itself never resumes on launch:
    // an open conversation hears everything, so it starts only when the user presses the orb.
    await readVoiceListeningPreference();
    const assistantState = await readAssistantState();
    persona = assistantState.persona;
    characters = assistantState.characters;
    // Screen time stays on this Mac: sampled only while the app runs, written to the local database.
    try {
      const store = new SqliteStore(config.dataDirectory);
      usageStore = store;
      usageSampler = new UsageSampler({
        record: sample => store.addAppUsage(sample.day, sample.app, sample.seconds),
        nudge: seconds => {
          const hours = (seconds / 3600).toFixed(1).replace(/\.0$/, '');
          new Notification({
            title: 'Thoda break ho jaye?',
            body: `Aap ${hours} ghante se lagatar screen par hain. Paanch minute ki break le lijiye.`,
          }).show();
        },
      });
      usageSampler.start();
    } catch {
      console.error(JSON.stringify({ event: 'usage.sampler-start-failed' }));
    }
    approvalMemory = new ApprovalMemory({
      grants: await readStandingGrants(),
      onGrantsChanged: grants => {
        void saveStandingGrants(grants).catch(() => {
          console.error(JSON.stringify({ event: 'permissions.save-failed' }));
        });
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Configuration is invalid.';
    dialog.showErrorBox('Vyomara configuration error', message);
    app.quit();
    return;
  }

  mainWindow = createWindow();
  warmUpModel(config);
  // Maya loads a 3.3 GB model (~25 s): load it now, not on the first reply.
  if (naturalVoice.engine === 'maya' && naturalVoice.ready) {
    void naturalVoice.synthesize('हाँ।', 'female', AbortSignal.timeout(180_000))
      .then(file => rm(file, { force: true }))
      .catch(() => undefined);
  }
  // MCP servers start in the background; their tools change the prompt, so prime again once they are ready.
  const startupConfig = config;
  void readMcpConfig(startupConfig.dataDirectory)
    .then(async servers => {
      if (Object.keys(servers).length === 0) return;
      await mcpManager.start(servers);
      console.error(JSON.stringify({ event: 'mcp.started', servers: mcpManager.status().map(server => ({ name: server.name, state: server.state, tools: server.tools })) }));
      warmUpModel(config);
    })
    .catch(error => console.error(JSON.stringify({ event: 'mcp.config-invalid', message: error instanceof Error ? error.message : 'unknown' })));
  app.on('activate', () => showMainWindow());
  registerVoiceShortcut();
  pipEnabled = await readPipEnabled();
  try {
    pipWindow = await createPipWindow();
  } catch {
    console.error(JSON.stringify({ event: 'pip.create-failed' }));
  }
});

/** Set once the model has been asked to leave memory on quit. */
let modelReleased = false;

app.on('will-quit', event => {
  // With Vyomara closed, the model should not keep its memory (it is kept
  // loaded for 30 minutes while the app runs). Wait up to 2 s for Ollama.
  if (!modelReleased && config?.provider === 'ollama') {
    modelReleased = true;
    event.preventDefault();
    void ollamaProvider(config).unload(AbortSignal.timeout(2_000)).finally(() => app.quit());
    return;
  }
  globalShortcut.unregisterAll();
  void diffPreview?.clear().catch(() => undefined);
});

app.on('before-quit', () => {
  quitting = true;
  pipWindow?.destroy();
  activeRequest?.abort();
  activeModelPull?.abort();
  activePrime?.abort();
  shellCommandRunner.stopAll();
  mcpManager.stopAll();
  macSpeechRunner.stop();
  whisperServer.stop();
  void localWhisperRunner?.stop();
  usageSampler?.stop();
  naturalVoice.stop();
  try { usageStore?.close(); } catch { /* already closed */ }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
