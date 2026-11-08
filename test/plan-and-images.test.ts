import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../src/agent/agent.ts';
import { loadConfig } from '../src/config/config.ts';
import { parseDesktopChatRequest } from '../src/desktop/validation.ts';
import { createLogger } from '../src/diagnostics/logger.ts';
import type { ModelProvider } from '../src/providers/provider.ts';
import { Session } from '../src/session/session.ts';
import type { SessionMessage } from '../src/session/session.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { ToolExecutor } from '../src/tools/executor.ts';
import { PolicyGateway } from '../src/tools/policy.ts';

const config = loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_DATA_DIR: '/tmp/vyomara-unused' });
const environment = { date: '2026-11-08', osRelease: 'test', home: '/Users/test', projectFolders: [] };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function editRegistry(edits: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    id: 'edit_file',
    effect: 'read',
    description: 'Edit a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    validateInput: (value): value is { path: string } => typeof (value as { path?: unknown }).path === 'string',
    validateOutput: (value): value is Record<string, unknown> => typeof value === 'object',
    async run(input) { edits.push(input.path); return { status: 'applied' }; },
  });
  return registry;
}

test('plan mode refuses changes and asks for a plan, without "keep going" nudges', async () => {
  const edits: string[] = [];
  const seen: SessionMessage[][] = [];
  let step = 0;
  const provider: ModelProvider = {
    id: 'scripted',
    async complete(messages) {
      seen.push([...messages]);
      step += 1;
      if (step === 1) return { kind: 'tool-calls', calls: [{ toolId: 'edit_file', arguments: { path: '/tmp/a.ts' } }] };
      return { kind: 'final', text: '1. [ ] Edit /tmp/a.ts to fix the total.\n2. [ ] Run the tests.' };
    },
  };
  const tools = new ToolExecutor({ registry: editRegistry(edits), policy: new PolicyGateway(), config, logger: createLogger(() => {}) });
  const reply = await runAgent('fix the cart total', AbortSignal.timeout(5_000), {
    provider, tools, config, session: new Session(), logger: createLogger(() => {}), environment, planOnly: true,
  });
  assert.deepEqual(edits, [], 'nothing was edited');
  assert.match(seen[0]?.at(-1)?.content ?? '', /^fix the cart total\n\n\(Plan mode:/u);
  assert.match(seen[1]?.at(-1)?.content ?? '', /Plan mode: nothing may be changed/u);
  assert.equal(seen.length, 2, 'the checklist reply is accepted as the answer');
  assert.match(reply, /Edit \/tmp\/a\.ts/u);
});

test('pictures go with the request to a vision model, and a text-only model says so', async () => {
  const seen: SessionMessage[][] = [];
  const make = (vision: boolean): ModelProvider => ({
    id: 'scripted',
    supportsVision: async () => vision,
    async complete(messages) { seen.push([...messages]); return { kind: 'final', text: 'A red error dialog.' }; },
  });
  const tools = new ToolExecutor({ registry: new ToolRegistry(), policy: new PolicyGateway(), config, logger: createLogger(() => {}) });
  const run = (vision: boolean, session: Session): Promise<string> => runAgent('ye error kya hai?', AbortSignal.timeout(5_000), {
    provider: make(vision), tools, config, session, logger: createLogger(() => {}), environment, images: [PNG],
  });
  const session = new Session();
  assert.equal(await run(true, session), 'A red error dialog.');
  const sent = seen[0]?.at(-1);
  assert.ok(sent?.role === 'user' && sent.images?.[0] === PNG);
  assert.ok(session.messages().every(message => !('images' in message)), 'pictures are not stored in history');
  assert.match(await run(false, new Session()), /cannot see pictures/u);
  assert.equal(seen.length, 1, 'the text-only model was not asked');
});

test('chat requests accept plan mode and up to four real pictures only', () => {
  const id = '6f1c0a1e-2b3c-4d5e-8f90-123456789abc';
  assert.deepEqual(parseDesktopChatRequest({ prompt: 'hi', requestId: id, planOnly: true, images: [PNG] }, 100), { prompt: 'hi', requestId: id, planOnly: true, images: [PNG] });
  assert.throws(() => parseDesktopChatRequest({ prompt: 'hi', requestId: id, images: ['not-base64!'] }, 100));
  assert.throws(() => parseDesktopChatRequest({ prompt: 'hi', requestId: id, images: [Buffer.from('#!/bin/sh echo hi').toString('base64')] }, 100));
  assert.throws(() => parseDesktopChatRequest({ prompt: 'hi', requestId: id, images: [PNG, PNG, PNG, PNG, PNG] }, 100));
});
