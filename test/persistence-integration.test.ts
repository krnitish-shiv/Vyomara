import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runRequest } from '../src/app/application.ts';
import { loadConfig } from '../src/config/config.ts';
import { createLogger } from '../src/diagnostics/logger.ts';
import { SqliteStore } from '../src/storage/sqlite-store.ts';

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'vyomara-persistence-integration-'));
}

test('requests persist and continue isolated session history with metadata-only audit events', async t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = loadConfig({
    VYOM_PROVIDER: 'placeholder',
    VYOM_DATA_DIR: root,
  });
  const logLines: string[] = [];
  const logger = createLogger(line => logLines.push(line));

  const first = await runRequest(
    'private prompt fixture',
    new AbortController().signal,
    config,
    logger,
  );
  const second = await runRequest(
    'continued turn fixture',
    new AbortController().signal,
    config,
    logger,
    { sessionId: first.sessionId },
  );
  assert.equal(second.sessionId, first.sessionId);
  assert.match(first.response, /deterministic skeleton response/);

  const store = new SqliteStore(root);
  const messages = store.getSession(first.sessionId).messages();
  store.close();
  assert.deepEqual(messages.map(message => message.role), [
    'user',
    'assistant',
    'user',
    'assistant',
  ]);
  assert.equal(messages[0]?.content, 'private prompt fixture');
  assert.equal(messages[2]?.content, 'continued turn fixture');

  const database = new DatabaseSync(join(root, 'vyomara.sqlite'));
  const auditRows = database.prepare('SELECT details_json FROM audit_events').all();
  database.close();
  assert.ok(auditRows.length > 0);
  assert.ok(auditRows.every(row =>
    typeof row.details_json === 'string' &&
    !row.details_json.includes('private prompt fixture') &&
    !row.details_json.includes('continued turn fixture')));
});

test('Ollama chat offers the coding tools and lets the model answer ordinary questions directly', async t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const allowedRoot = join(root, 'allowed');
  await mkdir(allowedRoot);
  const config = loadConfig({
    VYOM_PROVIDER: 'ollama',
    VYOM_DATA_DIR: join(root, 'app-data'),
    VYOM_ALLOWED_ROOTS: JSON.stringify([allowedRoot]),
  });
  let chatRequest: { readonly tools?: readonly { function: { name: string } }[]; readonly options?: unknown; readonly think?: unknown } | undefined;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input).endsWith('/api/show')) {
      return new Response(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] }));
    }
    chatRequest = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      message: { role: 'assistant', content: 'React Native is a framework for building native mobile apps with React.' },
    }), { headers: { 'content-type': 'application/json' } });
  });

  const result = await runRequest(
    'Do you know about React Native?',
    new AbortController().signal,
    config,
    createLogger(() => {}),
  );
  assert.match(result.response, /^React Native is a framework/);
  assert.ok(chatRequest?.tools?.some(tool => tool.function.name === 'read_file'));
  assert.ok(chatRequest?.tools?.some(tool => tool.function.name === 'search_text'));
  assert.deepEqual(chatRequest?.options, { num_ctx: 32_768 });
  assert.equal(chatRequest?.think, false);
});

test('CLI exposes session review/deletion and explicit confirmed memory operations', t => {
  const root = temporaryDirectory();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const env = {
    ...process.env,
    VYOM_PROVIDER: 'placeholder',
    VYOM_DATA_DIR: root,
  };
  const invoke = (args: string[], input = '') => spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', cliPath, ...args],
    { cwd: process.cwd(), env, encoding: 'utf8', input },
  );

  const request = invoke(['A persisted CLI turn']);
  assert.equal(request.status, 0, request.stderr);
  const sessionId = request.stderr.match(/Session ID: ([0-9a-f-]{36})/)?.[1];
  assert.ok(sessionId);

  const sessionList = invoke(['--sessions', 'list']);
  assert.equal(sessionList.status, 0, sessionList.stderr);
  assert.match(sessionList.stdout, new RegExp(sessionId));

  const sessionShow = invoke(['--sessions', 'show', sessionId]);
  assert.equal(sessionShow.status, 0, sessionShow.stderr);
  assert.match(sessionShow.stdout, /A persisted CLI turn/);

  const unconfirmedDelete = invoke(['--sessions', 'delete', sessionId]);
  assert.equal(unconfirmedDelete.status, 1);
  assert.match(unconfirmedDelete.stderr, /requires --confirm/);
  assert.equal(invoke(['--sessions', 'show', sessionId]).status, 0);

  const declinedDelete = invoke(['--sessions', 'delete', sessionId, '--confirm'], 'NO\n');
  assert.equal(declinedDelete.status, 1);
  assert.equal(invoke(['--sessions', 'show', sessionId]).status, 0);

  const deleted = invoke(['--sessions', 'delete', sessionId, '--confirm'], 'DELETE\n');
  assert.equal(deleted.status, 0, deleted.stderr);
  assert.equal(invoke(['--sessions', 'show', sessionId]).status, 1);

  const unconfirmedMemory = invoke(['--memory', 'save', 'explicit memory fixture']);
  assert.equal(unconfirmedMemory.status, 1);
  assert.match(unconfirmedMemory.stderr, /Memory was not saved/);
  assert.equal(invoke(['--memory', 'list']).stdout.trim(), '[]');

  const declinedMemory = invoke(
    ['--memory', 'save', 'declined memory fixture', '--confirm'],
    'NO\n',
  );
  assert.equal(declinedMemory.status, 1);
  assert.equal(invoke(['--memory', 'list']).stdout.trim(), '[]');

  const savedMemory = invoke(
    ['--memory', 'save', 'explicit memory fixture', '--confirm'],
    'SAVE\n',
  );
  assert.equal(savedMemory.status, 0, savedMemory.stderr);
  assert.match(savedMemory.stdout, /Saved explicit memory/);
  assert.match(savedMemory.stdout, /"explicit memory fixture"/);
  const memoryList = invoke(['--memory', 'list']);
  const memoryId = memoryList.stdout.match(/"id": "([0-9a-f-]{36})"/)?.[1];
  assert.ok(memoryId);
  assert.equal(invoke(['--memory', 'show', memoryId]).stdout, '"explicit memory fixture"\n');
  assert.equal(invoke(['--memory', 'delete', memoryId]).status, 1);
  assert.equal(invoke(['--memory', 'delete', memoryId, '--confirm'], 'DELETE\n').status, 0);
});
