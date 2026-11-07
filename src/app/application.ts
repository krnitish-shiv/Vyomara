import type { AppConfig } from '../config/config.ts';
import { MemoryStore } from '../storage/memory-store.ts';
import type { PersonaId } from '../shared/persona.ts';
import type { Logger } from '../types.ts';
import { Session } from '../session/session.ts';
import type { SessionMessage } from '../session/session.ts';
import { primeAgent, runAgent } from '../agent/agent.ts';
import type { ToolActivity } from '../agent/agent.ts';
import { OllamaProvider, PlaceholderProvider } from '../providers/provider.ts';
import type { ModelProvider } from '../providers/provider.ts';
import { SqliteStore } from '../storage/sqlite-store.ts';
import type {
  DesktopConversationMessage,
  FileOperationApprovalPort,
  DesktopSessionHistory,
  DesktopSessionSummary,
} from '../desktop/contracts.ts';
import { createDefaultToolRegistry } from '../tools/default-tools.ts';
import type { ActionToolPorts } from '../tools/action-tools.ts';
import type { PlanStep } from '../tools/plan-tool.ts';
import { ToolExecutor } from '../tools/executor.ts';
import { PolicyGateway } from '../tools/policy.ts';
import { withPersistentAudit } from '../diagnostics/persistent-logger.ts';

export interface RequestResult {
  readonly response: string;
  readonly sessionId: string;
}

export function readDesktopSessions(config: AppConfig): readonly DesktopSessionSummary[] {
  const store = new SqliteStore(config.dataDirectory);
  try {
    return store.listSessions();
  } finally {
    store.close();
  }
}

export function deleteDesktopSession(config: AppConfig, sessionId: string): boolean {
  const store = new SqliteStore(config.dataDirectory);
  try {
    return store.deleteSession(sessionId);
  } finally {
    store.close();
  }
}

export function readDesktopSession(config: AppConfig, sessionId: string): DesktopSessionHistory {
  const store = new SqliteStore(config.dataDirectory);
  try {
    const messages: DesktopConversationMessage[] = [];
    for (const message of store.getSession(sessionId).messages()) {
      if (message.role === 'user') {
        messages.push({ role: 'user', content: message.content });
      } else if (message.role === 'assistant' && message.kind !== 'tool-call') {
        messages.push({ role: 'assistant', content: message.content });
      }
    }
    return { sessionId, messages };
  } finally {
    store.close();
  }
}

export function exportDesktopSession(config: AppConfig, sessionId: string): string {
  const store = new SqliteStore(config.dataDirectory);
  try {
    const messages: readonly SessionMessage[] = store.getSession(sessionId).messages();
    return `${JSON.stringify({
      format: 'vyomara-session',
      version: 1,
      sessionId,
      exportedAt: new Date().toISOString(),
      messages,
    }, null, 2)}\n`;
  } finally {
    store.close();
  }
}

export interface RequestOptions {
  readonly sessionId?: string;
  readonly onText?: (text: string) => void;
  readonly onToolActivity?: (activity: ToolActivity) => void;
  readonly onPlan?: (steps: readonly PlanStep[]) => void;
  /** The request was spoken; replies should be short enough to read aloud. */
  readonly voice?: boolean;
  readonly persona?: PersonaId;
  readonly includeFilesystemTools?: boolean;
  readonly fileOperationApproval?: FileOperationApprovalPort;
  readonly actions?: ActionToolPorts;
}

export function createProvider(config: AppConfig): ModelProvider {
  return config.provider === 'ollama'
    ? new OllamaProvider({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel,
      numCtx: config.ollamaNumCtx,
      think: config.ollamaThink,
      maxResponseChars: config.maxResponseChars,
      maxToolCallArgumentsChars: config.maxToolInputChars,
    })
    : new PlaceholderProvider();
}

function createTools(config: AppConfig, logger: Logger, memory: MemoryStore, options: RequestOptions): ToolExecutor {
  return new ToolExecutor({
    registry: createDefaultToolRegistry(config, {
      ...(options.includeFilesystemTools === undefined ? {} : { includeFilesystemTools: options.includeFilesystemTools }),
      ...(options.fileOperationApproval ? { fileOperationApproval: options.fileOperationApproval } : {}),
      ...(options.actions ? { actions: options.actions } : {}),
      memory,
    }),
    policy: new PolicyGateway({
      allowedEffects: options.actions ? ['launch', 'shell', 'network'] : [],
    }),
    config,
    logger,
  });
}

/**
 * Let the model read a new chat's system prompt and tools in the background
 * (see primeAgent). Pass the same options as the requests that follow.
 */
export async function primeModel(config: AppConfig, logger: Logger, signal: AbortSignal, options: RequestOptions = {}): Promise<void> {
  if (config.provider !== 'ollama') return;
  const memory = new MemoryStore(config.dataDirectory);
  await primeAgent(signal, {
    provider: createProvider(config),
    tools: createTools(config, logger, memory, options),
    config,
    session: new Session(),
    ...(options.persona ? { persona: options.persona } : {}),
    memory,
  });
}

export async function runRequest(
  prompt: string,
  signal: AbortSignal,
  config: AppConfig,
  logger: Logger,
  options: RequestOptions = {},
): Promise<RequestResult> {
  const store = new SqliteStore(config.dataDirectory);
  try {
    const session = options.sessionId === undefined
      ? store.createSession()
      : store.getSession(options.sessionId);
    const taskLogger = withPersistentAudit(logger, store);
    const memory = new MemoryStore(config.dataDirectory);
    const tools = createTools(config, taskLogger, memory, options);

    let response: string | undefined;
    let requestError: unknown;
    try {
      response = await runAgent(prompt, signal, {
        provider: createProvider(config),
        tools,
        config,
        session,
        logger: taskLogger,
        ...(options.onText ? { onText: options.onText } : {}),
        ...(options.onToolActivity ? { onToolActivity: options.onToolActivity } : {}),
        ...(options.onPlan ? { onPlan: options.onPlan } : {}),
        ...(options.voice ? { voice: true } : {}),
        ...(options.persona ? { persona: options.persona } : {}),
        memory,
      });
    } catch (error) {
      requestError = error;
    }

    let historyError: unknown;
    try {
      store.saveSession(session);
    } catch (error) {
      historyError = error;
    }
    if (requestError !== undefined && historyError !== undefined) {
      throw new AggregateError(
        [requestError, historyError],
        'The request failed and its local history could not be saved.',
      );
    }
    if (requestError !== undefined) throw requestError;
    if (historyError !== undefined) throw historyError;
    if (response === undefined) {
      throw new Error('The request ended without a response.');
    }
    return {
      response,
      sessionId: session.id,
    };
  } finally {
    store.close();
  }
}

export function saveSelectedModel(config: AppConfig, model: string): void {
  const store = new SqliteStore(config.dataDirectory);
  try {
    store.setAppSettings({ [SELECTED_MODEL_SETTING]: model });
  } finally {
    store.close();
  }
}

const SELECTED_MODEL_SETTING = 'selected-model';
const NUM_CTX_SETTING = 'ollama-num-ctx';
const THINK_SETTING = 'ollama-think';

/** Model settings chosen in the app; each field is present only if the user changed it. */
export interface SavedModelSettings {
  readonly model?: string;
  readonly numCtx?: number;
  readonly think?: boolean;
}

export function readModelSettings(config: AppConfig): SavedModelSettings {
  const store = new SqliteStore(config.dataDirectory);
  try {
    const model = store.getAppSetting(SELECTED_MODEL_SETTING);
    const numCtx = Number(store.getAppSetting(NUM_CTX_SETTING));
    const think = store.getAppSetting(THINK_SETTING);
    return {
      ...(model ? { model } : {}),
      ...(Number.isSafeInteger(numCtx) && numCtx >= 2_048 && numCtx <= 262_144 ? { numCtx } : {}),
      ...(think === 'true' || think === 'false' ? { think: think === 'true' } : {}),
    };
  } finally {
    store.close();
  }
}

export function saveModelSettings(config: AppConfig, settings: { readonly numCtx?: number; readonly think?: boolean }): void {
  const store = new SqliteStore(config.dataDirectory);
  try {
    store.setAppSettings({
      ...(settings.numCtx === undefined ? {} : { [NUM_CTX_SETTING]: String(settings.numCtx) }),
      ...(settings.think === undefined ? {} : { [THINK_SETTING]: String(settings.think) }),
    });
  } finally {
    store.close();
  }
}

/** Apply saved model settings on top of the environment configuration. */
export function withSavedModelSettings(config: AppConfig, saved: SavedModelSettings): AppConfig {
  return {
    ...config,
    ...(config.provider === 'ollama' && saved.model ? { ollamaModel: saved.model } : {}),
    ...(saved.numCtx === undefined ? {} : { ollamaNumCtx: saved.numCtx }),
    ...(saved.think === undefined ? {} : { ollamaThink: saved.think }),
  };
}
