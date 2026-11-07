import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt } from '../src/agent/system-prompt.ts';
import { looksSecret, MemoryStore } from '../src/storage/memory-store.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { registerMemoryTool } from '../src/tools/memory-tool.ts';

async function store(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'vyomara-memory-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, memory: new MemoryStore(directory) };
}

test('memories are saved privately, de-duplicated, scoped to projects, and removable', async t => {
  const { directory, memory } = await store(t);
  const general = memory.add('The user prefers replies in Hinglish.');
  memory.add('Tests run with pnpm check.', '/Users/me/Projects/shop');
  memory.add('Uses yarn.', '/Users/me/Projects/other');
  assert.equal(memory.add('the user prefers replies in hinglish.').duplicate, true);
  // The active project's memories come first; others follow, labelled by project.
  assert.deepEqual(memory.relevant('/Users/me/Projects/shop').map(entry => entry.text), [
    'The user prefers replies in Hinglish.',
    'Tests run with pnpm check.',
    'Uses yarn.',
  ]);
  assert.deepEqual(memory.relevant('/Users/me/Projects/other').map(entry => entry.text), [
    'The user prefers replies in Hinglish.',
    'Uses yarn.',
    'Tests run with pnpm check.',
  ]);
  assert.deepEqual(memory.relevant(undefined, 70).map(entry => entry.text), ['The user prefers replies in Hinglish.']);
  assert.equal((await stat(join(directory, 'memories.json'))).mode & 0o777, 0o600);
  assert.equal(memory.remove(general.entry.id), true);
  assert.equal(memory.list().length, 2);
});

test('secrets and long text are refused', async t => {
  const { memory } = await store(t);
  for (const secret of ['my password is hunter2', 'API key: sk-abcdefghijklmnopqrstuvwx', 'token = ghp_abcdefghijklmnopqrstuvwxyz']) {
    assert.equal(looksSecret(secret), true, secret);
    assert.throws(() => memory.add(secret), /never remembered/);
  }
  assert.equal(looksSecret('The user keeps API docs in ~/docs'), false);
  assert.throws(() => memory.add('x'.repeat(301)), /under 300/);
});

test('the remember tool saves a fact and the prompt shows remembered facts', async t => {
  const { memory } = await store(t);
  const registry = new ToolRegistry();
  registerMemoryTool(registry, memory);
  const tool = registry.get('remember');
  assert.ok(tool);
  const result = await tool.run({ text: 'Main project is KeylessRN.' }, new AbortController().signal);
  const saved = result as { ok: boolean; remembered: string; duplicate: boolean; note: string };
  assert.equal(saved.ok, true);
  assert.equal(saved.remembered, 'Main project is KeylessRN.');
  assert.equal(saved.duplicate, false);
  assert.match(saved.note, /Tell the user briefly/);

  const environment = {
    date: '2026-11-07', osRelease: 'macOS', home: '/Users/me', projectFolders: [],
    memories: [{ text: 'Main project is KeylessRN.' }, { text: 'Tests: pnpm check', project: '/Users/me/shop' }],
  };
  const prompt = buildSystemPrompt(environment, [{ id: 'remember', description: 'x', parameters: { type: 'object', properties: {}, additionalProperties: false } }]);
  assert.match(prompt, /# What you remember about the user[\s\S]*- Main project is KeylessRN\.\n- Tests: pnpm check \(project: \/Users\/me\/shop\)/);
  assert.match(prompt, /# Remembering[\s\S]*yaad rakhna/);
});
