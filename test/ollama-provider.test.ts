import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentError, runAgent } from '../src/agent/agent.ts';
import { loadConfig } from '../src/config/config.ts';
import { createLogger } from '../src/diagnostics/logger.ts';
import {
  OllamaProvider,
  ProviderError,
  type FetchImplementation,
} from '../src/providers/provider.ts';
import { Session } from '../src/session/session.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import type { ModelToolDefinition } from '../src/tools/contracts.ts';
import { ToolExecutor } from '../src/tools/executor.ts';
import { PolicyGateway } from '../src/tools/policy.ts';

function provider(fetchImplementation: FetchImplementation, options: {
  readonly model?: string;
  readonly maxResponseBytes?: number;
  readonly maxResponseChars?: number;
  readonly maxToolCallArgumentsChars?: number;
  readonly maxRequestBytes?: number;
} = {}) {
  return new OllamaProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: options.model ?? 'llama3.2',
    fetchImplementation,
    ...options,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const listTool: ModelToolDefinition = {
  id: 'list_directory',
  description: 'List entries in an allowed directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', maxLength: 4096, pattern: '^/' },
      maxEntries: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['path'],
    additionalProperties: false,
  },
};


test('Ollama provider rejects non-loopback, credentialed, and query-bearing endpoints', () => {
  for (const baseUrl of [
    'https://example.invalid',
    'http://example.invalid',
    'http://user:password@127.0.0.1:11434',
    'http://127.0.0.1:11434?redirect=remote',
  ]) {
    assert.throws(
      () => new OllamaProvider({ baseUrl, model: 'llama3.2' }),
      /local HTTP loopback URL/,
    );
  }
});

test('Ollama connection check queries only the configured loopback tags endpoint', async () => {
  let requestUrl = '';
  let requestMethod = '';
  let redirectMode: RequestInit['redirect'];
  const fetchImplementation: FetchImplementation = async (input, init) => {
    requestUrl = String(input);
    requestMethod = init?.method ?? '';
    redirectMode = init?.redirect;
    assert.ok(init?.signal);
    return jsonResponse({ models: [{ name: 'llama3.2:latest' }] });
  };

  await provider(fetchImplementation).checkConnection();
  assert.equal(requestUrl, 'http://127.0.0.1:11434/api/tags');
  assert.equal(requestMethod, 'GET');
  assert.equal(redirectMode, 'error');
});

test('Ollama model availability check is read-only and matches the implicit latest tag', async () => {
  let requestUrl = '';
  let requestMethod = '';
  let redirectMode: RequestInit['redirect'];
  const fetchImplementation: FetchImplementation = async (input, init) => {
    requestUrl = String(input);
    requestMethod = init?.method ?? '';
    redirectMode = init?.redirect;
    return jsonResponse({
      models: [
        { name: 'qwen2.5-coder:latest' },
        { name: 'other-model:latest' },
      ],
    });
  };

  assert.equal(await provider(fetchImplementation, { model: 'qwen2.5-coder' }).checkModelAvailability(), 'installed');
  assert.equal(requestUrl, 'http://127.0.0.1:11434/api/tags');
  assert.equal(requestMethod, 'GET');
  assert.equal(redirectMode, 'error');
  assert.equal(await provider(fetchImplementation, { model: 'missing-model' }).checkModelAvailability(), 'not-installed');
});

test('Ollama model availability check rejects malformed model lists', async () => {
  for (const payload of [
    { models: [{ name: '' }] },
    { models: [{ name: 7 }] },
    { models: 'llama3.2' },
  ]) {
    await assert.rejects(
      provider(async () => jsonResponse(payload)).checkModelAvailability(),
      (error: unknown) => error instanceof ProviderError && error.code === 'malformed-response',
    );
  }
});

test('Ollama connection check reports service and malformed-response failures', async () => {
  const httpFailure = provider(async () => jsonResponse({}, 503));
  await assert.rejects(httpFailure.checkConnection(), (error: unknown) =>
    error instanceof ProviderError && error.code === 'http-error');

  const malformedResponse = provider(async () => new Response('not json'));
  await assert.rejects(malformedResponse.checkConnection(), (error: unknown) =>
    error instanceof ProviderError && error.code === 'malformed-response');

  const unavailable = provider(async () => {
    throw new Error('connection refused');
  });
  await assert.rejects(unavailable.checkConnection(), (error: unknown) =>
    error instanceof ProviderError && error.code === 'unavailable');
});

test('Ollama chat sends a system prompt, configured model, and conversation; returns assistant text', async () => {
  let requestUrl = '';
  let redirectMode: RequestInit['redirect'];
  let requestBody: Record<string, unknown> | undefined;
  const fetchImplementation: FetchImplementation = async (input, init) => {
    requestUrl = String(input);
    redirectMode = init?.redirect;
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ message: { role: 'assistant', content: 'Hello from local Ollama.' } });
  };
  const result = await provider(fetchImplementation).complete([
    { role: 'user', content: 'Hello, Vyom' },
    { role: 'assistant', content: 'How can I help?' },
  ], new AbortController().signal, [listTool], undefined, 'Agent system prompt.');

  assert.equal(requestUrl, 'http://127.0.0.1:11434/api/chat');
  assert.equal(redirectMode, 'error');
  assert.deepEqual(result, { kind: 'final', text: 'Hello from local Ollama.' });
  assert.equal(requestBody?.model, 'llama3.2');
  assert.equal(requestBody?.stream, false);
  const sentMessages = requestBody?.messages as Array<{ role: string; content: string }>;
  assert.equal(sentMessages[0]?.role, 'system');
  assert.equal(sentMessages[0]?.content, 'Agent system prompt.');
  assert.deepEqual(sentMessages.slice(1), [
    { role: 'user', content: 'Hello, Vyom' },
    { role: 'assistant', content: 'How can I help?' },
  ]);
  assert.deepEqual(requestBody?.tools, [{
    type: 'function',
    function: {
      name: listTool.id,
      description: listTool.description,
      parameters: listTool.parameters,
    },
  }]);
});

test('Ollama streams assistant text chunks while preserving the complete final response', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImplementation: FetchImplementation = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const chunks = [
      { message: { role: 'assistant', content: 'Hello ' }, done: false },
      { message: { role: 'assistant', content: 'from Vyom.' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true },
    ];
    return new Response(`${chunks.map(chunk => JSON.stringify(chunk)).join('\n')}\n`);
  };
  const received: string[] = [];
  const result = await provider(fetchImplementation).complete(
    [{ role: 'user', content: 'Say hello.' }],
    new AbortController().signal,
    [],
    text => received.push(text),
  );
  assert.equal(requestBody?.stream, true);
  assert.deepEqual(received, ['Hello ', 'from Vyom.']);
  assert.deepEqual(result, { kind: 'final', text: 'Hello from Vyom.' });
});

test('Ollama represents nullable optional limits and omits null wire values only', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const fetchImplementation: FetchImplementation = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{
          function: {
            name: 'directory_tree',
            arguments: {
              path: '/tmp/allowed',
              maxDepth: null,
              maxEntries: null,
            },
          },
        }],
      },
    });
  };
  const treeTool: ModelToolDefinition = {
    id: 'directory_tree',
    description: 'List an allowed directory tree.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', maxLength: 4096 },
        maxDepth: { type: 'integer', nullable: true, minimum: 1, maximum: 10 },
        maxEntries: { type: 'integer', nullable: true, minimum: 1, maximum: 100 },
      },
      required: ['path'],
      additionalProperties: false,
    },
  };
  const result = await provider(fetchImplementation).complete(
    [{ role: 'user', content: 'Show the directory tree.' }],
    new AbortController().signal,
    [treeTool],
  );
  assert.deepEqual(result, {
    kind: 'tool-calls',
    content: '',
    calls: [{
      toolId: 'directory_tree',
      arguments: { path: '/tmp/allowed' },
    }],
  });
  const tools = requestBody?.tools as Array<{
    function: { parameters: { properties: Record<string, { type: unknown }> } };
  }>;
  assert.deepEqual(tools[0]?.function.parameters.properties.maxDepth?.type, ['integer', 'null']);
  assert.deepEqual(tools[0]?.function.parameters.properties.maxEntries?.type, ['integer', 'null']);
});

test('Ollama does not coerce string limits while parsing tool calls', async () => {
  const fetchImplementation: FetchImplementation = async () => jsonResponse({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        function: {
          name: 'list_directory',
          arguments: { path: '/tmp/allowed', maxEntries: '10' },
        },
      }],
    },
  });
  const result = await provider(fetchImplementation).complete(
    [{ role: 'user', content: 'List this directory.' }],
    new AbortController().signal,
    [{
      ...listTool,
      parameters: {
        ...listTool.parameters,
        properties: {
          ...listTool.parameters.properties,
          maxEntries: {
            ...listTool.parameters.properties.maxEntries!,
            nullable: true,
          },
        },
      },
    }],
  );
  assert.deepEqual(result, {
    kind: 'tool-calls',
    content: '',
    calls: [{
      toolId: 'list_directory',
      arguments: { path: '/tmp/allowed', maxEntries: '10' },
    }],
  });
});

test('Ollama provider rejects HTTP errors without exposing response bodies', async () => {
  const result = provider(async () =>
    new Response('private response body', { status: 500 }),
  );
  await assert.rejects(
    result.complete([], new AbortController().signal),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === 'http-error' &&
      !error.message.includes('private response body'),
  );
});

test('Ollama provider reports a missing model without exposing raw server text', async () => {
  const result = provider(async () =>
    new Response(JSON.stringify({ error: "model 'private-model' not found" }), { status: 404 }),
  );
  await assert.rejects(
    result.complete([], new AbortController().signal),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === 'model-not-found' &&
      !error.message.includes('private-model'),
  );
});

test('Ollama provider rejects malformed JSON and malformed response shapes', async () => {
  await assert.rejects(
    provider(async () => new Response('{not json')).complete([], new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'malformed-response',
  );
  await assert.rejects(
    provider(async () => jsonResponse({ message: { content: 42 } }))
      .complete([], new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'malformed-response',
  );
  await assert.rejects(
    provider(async () => jsonResponse({
      message: { role: 'assistant', content: 'ignored', function_call: { name: 'unknown.tool' } },
    })).complete([], new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'malformed-response',
  );
  await assert.rejects(
    provider(async () => new Response(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])))
      .complete([], new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'malformed-response',
  );
});

test('Ollama provider parses valid registered tool calls', async () => {
  const result = await provider(async () => jsonResponse({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_jhfubo5a',
        function: { index: 0, name: listTool.id, arguments: { path: '/allowed' } },
      }],
    },
  })).complete([], new AbortController().signal, [listTool]);
  assert.deepEqual(result, {
    kind: 'tool-calls',
    content: '',
    calls: [{ toolId: listTool.id, arguments: { path: '/allowed' } }],
  });
});

test('Ollama provider parses all calls in a response batch', async () => {
  const secondTool: ModelToolDefinition = {
    ...listTool,
    id: 'read_file',
    description: 'Read an allowed UTF-8 text file.',
  };
  const result = await provider(async () => jsonResponse({
    message: {
      role: 'assistant',
      content: 'I will inspect these items.',
      tool_calls: [
        { function: { name: listTool.id, arguments: { path: '/allowed' } } },
        { function: { name: secondTool.id, arguments: { path: '/allowed/file.txt' } } },
      ],
    },
  })).complete([], new AbortController().signal, [listTool, secondTool]);
  assert.deepEqual(result, {
    kind: 'tool-calls',
    content: 'I will inspect these items.',
    calls: [
      { toolId: listTool.id, arguments: { path: '/allowed' } },
      { toolId: secondTool.id, arguments: { path: '/allowed/file.txt' } },
    ],
  });
});

test('Ollama provider rejects malformed, unknown, and oversized tool calls', async () => {
  const invalidToolCalls = [
    [{}],
    [{ function: { name: listTool.id } }],
    [{ function: { name: 42, arguments: {} } }],
    [{ function: { name: listTool.id, arguments: [] } }],
    [{ function: { name: listTool.id, arguments: {}, code: 'not-allowed' } }],
    [{ function: { name: listTool.id, arguments: { path: 'x'.repeat(100) } } }],
    [{ id: {}, function: { name: listTool.id, arguments: {} } }],
    [{ function: { index: '0', name: listTool.id, arguments: {} } }],
    [{ function: { index: 10, name: listTool.id, arguments: {} } }],
  ];
  for (const toolCalls of invalidToolCalls) {
    await assert.rejects(
      provider(async () => jsonResponse({
        message: { role: 'assistant', content: '', tool_calls: toolCalls },
      }), { maxToolCallArgumentsChars: 20 })
        .complete([], new AbortController().signal, [listTool]),
      (error: unknown) =>
        error instanceof ProviderError &&
        (error.code === 'malformed-response' || error.code === 'response-too-large'),
    );
  }
});

test('Ollama provider represents prior assistant calls and tool results structurally', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const messages = [
    { role: 'user', content: 'List my project files.' },
    {
      role: 'assistant',
      kind: 'tool-call',
      content: '',
      toolCalls: [{ toolId: listTool.id, arguments: { path: '/allowed' } }],
    },
    { role: 'tool', toolId: listTool.id, content: '{"entries":[],"truncated":false}' },
  ] as const;
  await provider(async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ message: { role: 'assistant', content: 'The directory is empty.' } });
  }).complete(messages, new AbortController().signal, [listTool]);
  const sentMessages = requestBody?.messages as Array<Record<string, unknown> & { role: string; content?: string }>;
  assert.equal(sentMessages[0]?.role, 'system');
  assert.match(sentMessages[0]?.content ?? '', /never invent tool results/);
  assert.deepEqual(sentMessages.slice(1), [
    { role: 'user', content: 'List my project files.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: listTool.id, arguments: { path: '/allowed' } } }],
    },
    {
      role: 'tool',
      tool_name: listTool.id,
      content: '{"entries":[],"truncated":false}',
    },
  ]);
});

test('Ollama provider parses unknown tool names for authoritative executor rejection', async () => {
  const result = await provider(async () => jsonResponse({
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'danger', arguments: {} } }] },
  })).complete([], new AbortController().signal);
  assert.deepEqual(result, {
    kind: 'tool-calls',
    content: '',
    calls: [{ toolId: 'danger', arguments: {} }],
  });
});

test('Ollama provider rejects oversized serialized requests before fetch', async () => {
  let fetched = false;
  await assert.rejects(
    provider(async () => {
      fetched = true;
      return jsonResponse({ message: { role: 'assistant', content: 'unexpected' } });
    }, { maxRequestBytes: 64 })
      .complete([{ role: 'user', content: 'x'.repeat(100) }], new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'request-too-large',
  );
  assert.equal(fetched, false);
});

test('Ollama provider rejects unbounded response bodies and oversized assistant content', async () => {
  await assert.rejects(
    provider(async () => new Response('x'.repeat(32)), { maxResponseBytes: 16 })
      .complete([], new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'response-too-large',
  );
  await assert.rejects(
    provider(async () => jsonResponse({ message: { content: 'x'.repeat(20) } }), {
      maxResponseChars: 10,
    }).complete([], new AbortController().signal),
    (error: unknown) => error instanceof ProviderError && error.code === 'malformed-response',
  );
});

test('Ollama provider maps unavailable local server to a safe error', async () => {
  await assert.rejects(
    provider(async () => {
      throw new TypeError('private host and response details');
    }).complete([], new AbortController().signal),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === 'unavailable' &&
      !error.message.includes('private host'),
  );
});

test('Ollama provider cancellation is propagated safely', async () => {
  const controller = new AbortController();
  const pending = provider(async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('private abort detail')), { once: true });
    }),
  ).complete([], controller.signal);
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ProviderError && error.code === 'cancelled',
  );
});

test('Ollama provider cancels a response body that is still streaming', async () => {
  const controller = new AbortController();
  const pending = provider(async () =>
    new Response(new ReadableStream<Uint8Array>({ start() {} })),
  ).complete([], controller.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof ProviderError && error.code === 'cancelled',
  );
});

test('agent timeout bounds an Ollama request even if fetch does not settle', async () => {
  const ollama = provider(async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  );
  const config = { ...loadConfig({}), requestTimeoutMs: 50 };
  const executor = new ToolExecutor({
    registry: new ToolRegistry(),
    policy: new PolicyGateway(),
    config,
    logger: createLogger(() => {}),
  });

  await assert.rejects(
    runAgent('Tell me a fun fact.', new AbortController().signal, {
      provider: ollama,
      tools: executor,
      config,
      session: new Session(),
      logger: createLogger(() => {}),
    }),
    (error: unknown) => error instanceof AgentError && error.code === 'timeout',
  );
});

test('unload asks Ollama to free the model now and never throws', async () => {
  const requests: { url: string; body: unknown }[] = [];
  const provider = new OllamaProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:14b',
    fetchImplementation: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}');
    },
  });
  await provider.unload();
  assert.deepEqual(requests, [{ url: 'http://127.0.0.1:11434/api/generate', body: { model: 'qwen3:14b', keep_alive: 0 } }]);
  const offline = new OllamaProvider({
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:14b',
    fetchImplementation: async () => { throw new Error('connection refused'); },
  });
  await offline.unload();
});
