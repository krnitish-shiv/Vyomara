import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentError, runAgent } from '../src/agent/agent.ts';
import { loadConfig } from '../src/config/config.ts';
import { createLogger } from '../src/diagnostics/logger.ts';
import type { ModelProvider, ProviderResponse } from '../src/providers/provider.ts';
import { PlaceholderProvider } from '../src/providers/provider.ts';
import { Session } from '../src/session/session.ts';
import { OperationStoppedError, runBounded } from '../src/shared/bounded.ts';
import type { Tool } from '../src/tools/contracts.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { ToolExecutionError, ToolExecutor } from '../src/tools/executor.ts';
import { PolicyGateway } from '../src/tools/policy.ts';
import type { Logger } from '../src/types.ts';

function config(overrides: Partial<ReturnType<typeof loadConfig>> = {}) {
  return { ...loadConfig({}), ...overrides };
}

function loggerWithLines() {
  const lines: string[] = [];
  return { logger: createLogger(line => lines.push(line)), lines };
}

function executor(
  registry: ToolRegistry,
  currentConfig = config(),
  currentLogger: Logger = createLogger(() => {}),
) {
  return new ToolExecutor({
    registry,
    policy: new PolicyGateway(),
    config: currentConfig,
    logger: currentLogger,
  });
}

function simpleTool(
  overrides: Partial<Tool<{ value: string }, string>> = {},
): Tool<{ value: string }, string> {
  return {
    id: 'test.echo',
    effect: 'read',
    description: 'Echo a string value.',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string', maxLength: 100 } },
      required: ['value'],
      additionalProperties: false,
    },
    validateInput: (value): value is { value: string } =>
      typeof value === 'object' && value !== null &&
      'value' in value && typeof value.value === 'string',
    validateOutput: (value): value is string => typeof value === 'string',
    async run(input) {
      return input.value;
    },
    ...overrides,
  };
}

function agentOptions(
  provider: ModelProvider,
  currentConfig = config(),
  currentLogger: Logger = createLogger(() => {}),
  registry = new ToolRegistry(),
) {
  return {
    provider,
    tools: executor(registry, currentConfig, currentLogger),
    config: currentConfig,
    session: new Session(),
    logger: currentLogger,
  };
}

test('configuration uses safe defaults and rejects invalid values without echoing them', () => {
  assert.equal(loadConfig({}).provider, 'ollama');
  assert.equal(loadConfig({}).ollamaBaseUrl, 'http://127.0.0.1:11434');
  assert.equal(loadConfig({}).ollamaModel, 'qwen3:14b');
  assert.equal(loadConfig({}).ollamaNumCtx, 32_768);
  assert.equal(loadConfig({}).ollamaThink, false);
  assert.equal(loadConfig({ VYOM_OLLAMA_THINK: 'true' }).ollamaThink, true);
  assert.throws(() => loadConfig({ VYOM_OLLAMA_THINK: 'maybe' }), /VYOM_OLLAMA_THINK/);
  assert.deepEqual(loadConfig({}).filesystemAllowedRoots, ['/']);
  assert.deepEqual(loadConfig({ VYOM_ALLOWED_ROOTS: '[]' }).filesystemAllowedRoots, []);
  assert.equal(loadConfig({}).maxFileBytes, 2_097_152);
  assert.equal(loadConfig({}).maxDirectoryEntries, 300);
  assert.equal(loadConfig({}).maxTreeDepth, 4);
  assert.equal(loadConfig({ VYOM_PROVIDER: 'placeholder' }).provider, 'placeholder');
  assert.equal(
    loadConfig({
      VYOM_PROVIDER: 'placeholder',
      VYOM_OLLAMA_BASE_URL: 'https://unused.invalid',
      VYOM_OLLAMA_MODEL: '   ',
    }).ollamaModel,
    'qwen3:14b',
  );
  assert.equal(loadConfig({}).maxAgentIterations, 40);
  assert.equal(loadConfig({}).maxToolCalls, 80);
  assert.throws(
    () => loadConfig({ VYOM_PROVIDER: 'secret-provider-token' }),
    error => error instanceof Error &&
      error.message.includes('VYOM_PROVIDER') &&
      !error.message.includes('secret-provider-token'),
  );
  assert.throws(() => loadConfig({ VYOM_MAX_TOOL_CALLS: '999999' }), /VYOM_MAX_TOOL_CALLS/);
  assert.throws(() => loadConfig({ VYOM_OLLAMA_BASE_URL: 'not a URL' }), /VYOM_OLLAMA_BASE_URL/);
  assert.throws(() => loadConfig({ VYOM_OLLAMA_BASE_URL: 'https://example.com' }), /loopback address/);
  assert.throws(() => loadConfig({ VYOM_OLLAMA_BASE_URL: '' }), /valid local HTTP URL/);
  assert.throws(() => loadConfig({ VYOM_OLLAMA_MODEL: '   ' }), /VYOM_OLLAMA_MODEL/);
  assert.throws(
    () => loadConfig({ VYOM_PROVIDER: 'ollama', VYOM_OLLAMA_BASE_URL: 'https://unused.invalid' }),
    /loopback address/,
  );
  assert.throws(() => loadConfig({ VYOM_REQUEST_TIMEOUT_MS: '999' }), /VYOM_REQUEST_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ VYOM_ALLOWED_ROOTS: 'not json' }), /VYOM_ALLOWED_ROOTS/);
  assert.throws(() => loadConfig({ VYOM_ALLOWED_ROOTS: '{}' }), /VYOM_ALLOWED_ROOTS/);
  assert.throws(() => loadConfig({ VYOM_ALLOWED_ROOTS: '["relative/path"]' }), /absolute directory paths/);
  assert.throws(() => loadConfig({ VYOM_ALLOWED_ROOTS: '["/tmp/\\u0000bad"]' }), /absolute directory paths/);
  assert.throws(
    () => loadConfig({ VYOM_ALLOWED_ROOTS: JSON.stringify(Array.from({ length: 33 }, (_, index) => `/tmp/${index}`)) }),
    /at most 32/,
  );
  assert.throws(() => loadConfig({ VYOM_MAX_FILE_BYTES: '0' }), /VYOM_MAX_FILE_BYTES/);
  assert.throws(() => loadConfig({ VYOM_MAX_TREE_DEPTH: '13' }), /VYOM_MAX_TREE_DEPTH/);
});

/** A private, temporary data folder for CLI runs, removed when the tests end. */
function cliDataDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'vyomara-cli-test-'));
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('CLI discloses the configured provider before processing a request', () => {
  const result = spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    'src/cli.ts',
    '--',
    'Say hello',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      VYOM_PROVIDER: 'placeholder',
      VYOM_ALLOWED_ROOTS: '[]',
      // Never write test conversations into the user's real history.
      VYOM_DATA_DIR: cliDataDir(),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /deterministic placeholder \(no model service is contacted\)/);
  assert.match(result.stdout, /\[Placeholder provider\]/);
});

test('CLI reports an unavailable local model service without falling back to another provider', () => {
  const result = spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-strip-types',
    'src/cli.ts',
    '--',
    'Say hello',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      VYOM_PROVIDER: 'ollama',
      VYOM_OLLAMA_MODEL: 'qwen3:14b',
      VYOM_OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      VYOM_ALLOWED_ROOTS: '[]',
      VYOM_DATA_DIR: cliDataDir(),
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /local Ollama · qwen3:14b/);
  assert.match(result.stderr, /Ollama is unavailable/);
  assert.equal(result.stdout.trim(), '');
});

test('placeholder provider is deterministic and clearly not an LLM', async () => {
  const provider = new PlaceholderProvider();
  const response = await provider.complete(
    [{ role: 'user', content: 'private prompt' }],
    new AbortController().signal,
  );
  assert.deepEqual(response, {
    kind: 'final',
    text: '[Placeholder provider] No language model is configured; this is a deterministic skeleton response.',
  });
  assert.equal(provider.id, 'deterministic-placeholder');
});

test('session keeps temporary messages in memory and returns defensive copies', () => {
  const session = new Session();
  session.add({ role: 'user', content: 'hello' });
  session.add({
    role: 'assistant',
    kind: 'tool-call',
    content: '',
    toolCalls: [{ toolId: 'test.echo', arguments: { value: 'original' } }],
  });
  const messages = session.messages();
  assert.deepEqual(messages, [
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      kind: 'tool-call',
      content: '',
      toolCalls: [{ toolId: 'test.echo', arguments: { value: 'original' } }],
    },
  ]);
  const toolCalls = messages[1];
  if (toolCalls?.role === 'assistant' && toolCalls.kind === 'tool-call') {
    (toolCalls.toolCalls[0]?.arguments as { value: string }).value = 'changed';
  }
  assert.equal(session.messages()[0]?.content, 'hello');
  const stored = session.messages()[1];
  assert.equal(stored?.role === 'assistant' && stored.kind === 'tool-call'
    ? stored.toolCalls[0]?.arguments.value
    : undefined, 'original');
});

test('tool registry rejects duplicate IDs', () => {
  const registry = new ToolRegistry();
  registry.register(simpleTool());
  assert.throws(() => registry.register(simpleTool()), /already registered/);
});

test('tool registry rejects malformed IDs', () => {
  const registry = new ToolRegistry();
  assert.throws(() => registry.register(simpleTool({ id: 'Invalid ID' })), /Tool ID/);
});

test('tool inputs are validated before execution', async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.register(simpleTool({
    async run(input) {
      executed = true;
      return input.value;
    },
  }));
  await assert.rejects(
    executor(registry).execute('test.echo', { value: 42 }, new AbortController().signal),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'invalid-input',
  );
  assert.equal(executed, false);
});

test('tool inputs are bounded before execution', async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.register(simpleTool({
    async run(input) {
      executed = true;
      return input.value;
    },
  }));
  await assert.rejects(
    executor(registry, config({ maxToolInputChars: 16 }))
      .execute('test.echo', { value: 'too long' }, new AbortController().signal),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'input-too-large',
  );
  assert.equal(executed, false);
});

test('policy gateway denies side effects before tool execution', async () => {
  let executed = false;
  const sideEffectTool: Tool<{ value: string }, string> = {
    ...simpleTool(),
    id: 'test.write',
    effect: 'write',
    async run(input) {
      executed = true;
      return input.value;
    },
  };
  const registry = new ToolRegistry();
  registry.register(sideEffectTool);
  await assert.rejects(
    executor(registry).execute('test.write', { value: 'x' }, new AbortController().signal),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'policy-denied',
  );
  assert.equal(executed, false);
});

test('tool outputs are bounded and validated', async () => {
  const registry = new ToolRegistry();
  registry.register(simpleTool({
    async run() {
      return 'this output is too long';
    },
  }));
  await assert.rejects(
    executor(registry, config({ maxToolOutputChars: 16 }))
      .execute('test.echo', { value: 'x' }, new AbortController().signal),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'output-too-large',
  );
});

test('invalid tool outputs are rejected', async () => {
  const registry = new ToolRegistry();
  registry.register(simpleTool({
    validateOutput: (value): value is string => value === 'expected',
    async run() {
      return 'unexpected';
    },
  }));
  await assert.rejects(
    executor(registry).execute('test.echo', { value: 'x' }, new AbortController().signal),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'invalid-output',
  );
});

test('agent rejects malformed provider responses', async () => {
  const provider: ModelProvider = {
    id: 'test.invalid',
    async complete() {
      return { kind: 'final', text: 42 };
    },
  };
  await assert.rejects(
    runAgent('Tell me a fun fact.', new AbortController().signal, agentOptions(provider)),
    (error: unknown) => error instanceof AgentError && error.code === 'invalid-provider-response',
  );
});

test('agent enforces the iteration limit', async () => {
  let executed = false;
  const registry = new ToolRegistry();
  registry.register(simpleTool({
    async run(input) {
      executed = true;
      return input.value;
    },
  }));
  const provider: ModelProvider = {
    id: 'test.loop',
    async complete(): Promise<ProviderResponse> {
      return {
        kind: 'tool-calls',
        calls: [{ toolId: 'test.echo', arguments: { value: 'continue' } }],
      };
    },
  };
  const response = await runAgent('Tell me a fun fact.', new AbortController().signal, agentOptions(
    provider,
    config({ maxAgentIterations: 2 }),
    createLogger(() => {}),
    registry,
  ));
  // The loop stops honestly instead of running forever, and says how to continue.
  assert.match(response, /used all 2 steps/);
  assert.match(response, /Ask me to continue/);
  assert.equal(executed, true);
});

test('provider timeout is enforced even if a provider ignores its signal', async () => {
  const provider: ModelProvider = {
    id: 'test.never',
    async complete() {
      return new Promise<never>(() => {});
    },
  };
  await assert.rejects(
    runAgent('Tell me a fun fact.', new AbortController().signal, agentOptions(
      provider,
      config({ requestTimeoutMs: 100 }),
    )),
    (error: unknown) => error instanceof AgentError && error.code === 'timeout',
  );
});

test('a late operation completion cannot turn a timed-out result into success', async () => {
  let completedLate = false;
  await assert.rejects(
    runBounded(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      completedLate = true;
      return 'late success';
    }, 5, new AbortController().signal),
    (error: unknown) => error instanceof OperationStoppedError && error.reason === 'timeout',
  );
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(completedLate, true);
});

test('tool timeout is enforced even if a tool ignores its signal', async () => {
  const registry = new ToolRegistry();
  registry.register(simpleTool({
    async run() {
      return new Promise<never>(() => {});
    },
  }));
  await assert.rejects(
    executor(registry, config({ toolTimeoutMs: 50 }))
      .execute('test.echo', { value: 'x' }, new AbortController().signal),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'timeout',
  );
});

test('cancellation stops a pending provider request', async () => {
  const controller = new AbortController();
  const provider: ModelProvider = {
    id: 'test.cancellable',
    async complete(_messages, signal) {
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  const pending = runAgent('Tell me a fun fact.', controller.signal, agentOptions(provider));
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AgentError && error.code === 'cancelled',
  );
});

test('structured diagnostics omit error messages, prompts, and secrets', () => {
  const { logger, lines } = loggerWithLines();
  logger.failure(new Error('private prompt fixture with diagnostic details'));
  const output = lines.join('\n');
  assert.doesNotMatch(output, /private prompt fixture|diagnostic details/);
  assert.deepEqual(JSON.parse(lines[0]!), {
    timestamp: JSON.parse(lines[0]!).timestamp,
    event: 'request.failed',
    code: 'request.failed',
  });
});
