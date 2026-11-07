import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export interface AppConfig {
  readonly provider: 'ollama' | 'placeholder';
  readonly ollamaBaseUrl: string;
  readonly ollamaModel: string;
  /** Context window requested from Ollama, in tokens. */
  readonly ollamaNumCtx: number;
  /** Whether thinking-capable models should reason before answering. */
  readonly ollamaThink: boolean;
  /** Optional SearXNG instance used by web_search (JSON format must be enabled). */
  readonly searxngUrl: string | undefined;
  readonly filesystemAllowedRoots: readonly string[];
  readonly dataDirectory: string;
  readonly maxAgentIterations: number;
  readonly maxToolCalls: number;
  readonly requestTimeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly maxInputChars: number;
  readonly maxToolOutputChars: number;
  readonly maxToolInputChars: number;
  readonly commandTimeoutMs: number;
  readonly maxResponseChars: number;
  readonly maxFileBytes: number;
  readonly maxDirectoryEntries: number;
  readonly maxTreeDepth: number;
}

type Environment = Readonly<Record<string, string | undefined>>;

function boundedInteger(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function localOllamaBaseUrl(raw: string | undefined): string {
  const value = raw === undefined ? 'http://127.0.0.1:11434' : raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('VYOM_OLLAMA_BASE_URL must be a valid local HTTP URL.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '::1'].includes(hostname) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('VYOM_OLLAMA_BASE_URL must use HTTP on localhost or a loopback address, without credentials or query parameters.');
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function validateOllamaModel(value: string): string {
  const model = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model) || model.includes('://')) {
    throw new Error('VYOM_OLLAMA_MODEL must be a non-empty model name of at most 128 valid characters.');
  }
  return model;
}

export const DEFAULT_OLLAMA_MODEL = 'qwen3:14b';

function modelName(raw: string | undefined): string {
  return validateOllamaModel(raw === undefined ? DEFAULT_OLLAMA_MODEL : raw);
}

function searxngUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('VYOM_SEARXNG_URL must be a valid http(s) URL.');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
    throw new Error('VYOM_SEARXNG_URL must be an http(s) URL without credentials.');
  }
  return url.href;
}

function booleanSetting(env: Environment, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

function allowedRoots(raw: string | undefined): readonly string[] {
  // Default: the whole machine for the current user. Protected system and
  // credential paths stay blocked by the filesystem layer. An explicit JSON
  // array narrows access (and `[]` disables filesystem tools entirely).
  if (raw === undefined || raw.trim() === '') return ['/'];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('VYOM_ALLOWED_ROOTS must be a JSON array of absolute directory paths.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 32 ||
    parsed.some(root =>
      typeof root !== 'string' ||
      root.trim() === '' ||
      root !== root.trim() ||
      root.includes('\0') ||
      !isAbsolute(root))
  ) {
    throw new Error('VYOM_ALLOWED_ROOTS must be a JSON array of at most 32 absolute directory paths.');
  }
  return parsed;
}

function dataDirectory(raw: string | undefined): string {
  const value = raw ?? join(homedir(), 'Library', 'Application Support', 'Vyomara');
  if (value.trim() !== value || value.includes('\0') || !isAbsolute(value)) {
    throw new Error('VYOM_DATA_DIR must be an absolute local directory path.');
  }
  return value;
}

export function loadConfig(env: Environment): AppConfig {
  const providerValue = env.VYOM_PROVIDER?.trim() || 'ollama';
  if (providerValue !== 'ollama' && providerValue !== 'placeholder') {
    throw new Error("VYOM_PROVIDER must be 'ollama' or 'placeholder'.");
  }
  const usesOllama = providerValue === 'ollama';

  return {
    provider: providerValue,
    ollamaBaseUrl: usesOllama
      ? localOllamaBaseUrl(env.VYOM_OLLAMA_BASE_URL)
      : 'http://127.0.0.1:11434',
    ollamaModel: usesOllama ? modelName(env.VYOM_OLLAMA_MODEL) : DEFAULT_OLLAMA_MODEL,
    ollamaNumCtx: boundedInteger(env, 'VYOM_OLLAMA_NUM_CTX', 32_768, 2_048, 262_144),
    ollamaThink: booleanSetting(env, 'VYOM_OLLAMA_THINK', false),
    searxngUrl: searxngUrl(env.VYOM_SEARXNG_URL),
    filesystemAllowedRoots: allowedRoots(env.VYOM_ALLOWED_ROOTS),
    dataDirectory: dataDirectory(env.VYOM_DATA_DIR),
    maxAgentIterations: boundedInteger(env, 'VYOM_MAX_AGENT_ITERATIONS', 40, 1, 200),
    maxToolCalls: boundedInteger(env, 'VYOM_MAX_TOOL_CALLS', 80, 0, 400),
    requestTimeoutMs: boundedInteger(env, 'VYOM_REQUEST_TIMEOUT_MS', 300_000, 1_000, 1_800_000),
    toolTimeoutMs: boundedInteger(env, 'VYOM_TOOL_TIMEOUT_MS', 30_000, 50, 300_000),
    commandTimeoutMs: boundedInteger(env, 'VYOM_COMMAND_TIMEOUT_MS', 120_000, 1_000, 1_800_000),
    maxInputChars: boundedInteger(env, 'VYOM_MAX_INPUT_CHARS', 32_000, 1, 200_000),
    maxToolOutputChars: boundedInteger(env, 'VYOM_MAX_TOOL_OUTPUT_CHARS', 24_000, 1, 200_000),
    maxToolInputChars: boundedInteger(env, 'VYOM_MAX_TOOL_INPUT_CHARS', 400_000, 1, 2_000_000),
    maxResponseChars: boundedInteger(env, 'VYOM_MAX_RESPONSE_CHARS', 32_000, 1_000, 200_000),
    maxFileBytes: boundedInteger(env, 'VYOM_MAX_FILE_BYTES', 2_097_152, 1, 16_777_216),
    maxDirectoryEntries: boundedInteger(env, 'VYOM_MAX_DIRECTORY_ENTRIES', 300, 1, 2_000),
    maxTreeDepth: boundedInteger(env, 'VYOM_MAX_TREE_DEPTH', 4, 1, 12),
  };
}
