import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ActionProposal } from '../src/tools/action-tools.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { McpManager, readMcpConfig } from '../src/tools/mcp-client.ts';
import { convertSchema, mcpToolId, registerMcpTools, toMcpArguments } from '../src/tools/mcp-tools.ts';

const server = fileURLToPath(new URL('../test-fixtures/fake-mcp-server.mjs', import.meta.url));
const signal = new AbortController().signal;

test('MCP schemas become simple fields and convert back', () => {
  const converted = convertSchema({ type: 'object', properties: { count: { type: 'integer' }, ratio: { type: 'number' }, ids: { type: 'array' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['count'] });
  assert.equal(converted.properties.ratio?.type, 'string');
  assert.match(converted.properties.ids?.description ?? '', /JSON array/u);
  assert.match(converted.properties.mode?.description ?? '', /One of: "a", "b"/u);
  assert.deepEqual(toMcpArguments({ count: 2, ratio: '0.5', ids: '[1,2]' }, converted.kinds), { count: 2, ratio: 0.5, ids: [1, 2] });
  assert.equal(mcpToolId('GitHub', 'create-issue', new Set()), 'mcp_github_create_issue');
  assert.equal(mcpToolId('GitHub', 'create-issue', new Set(['mcp_github_create_issue'])), 'mcp_github_create_issue_2');
});

test('mcp.json is read and checked', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'vyomara-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(await readMcpConfig(dir), {}, 'no file, no servers');
  await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { fake: { command: 'node', args: ['x.mjs'] } } }));
  assert.deepEqual(await readMcpConfig(dir), { fake: { command: 'node', args: ['x.mjs'] } });
  await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { 'bad name!': { command: 'x' } } }));
  await assert.rejects(readMcpConfig(dir), /must use letters/u);
});

test('MCP tools are offered, approved per call, and run on the server', async t => {
  const manager = new McpManager();
  t.after(() => manager.stopAll());
  await manager.start({ fake: { command: process.execPath, args: [server] }, missing: { command: '/nonexistent/mcp-server' } });
  const status = Object.fromEntries(manager.status().map(item => [item.name, item.state]));
  assert.deepEqual(status, { fake: 'ready', missing: 'failed' });

  const asked: ActionProposal[] = [];
  const decisions: (boolean | 'always')[] = ['always'];
  const registry = new ToolRegistry();
  const allowed = new Set<string>();
  registerMcpTools(registry, manager, { async request(action) { asked.push(action); return decisions.shift() ?? false; } }, allowed, 10);
  assert.deepEqual(registry.modelTools().map(tool => tool.id), ['mcp_fake_add', 'mcp_fake_broken_tool']);

  const add = registry.get('mcp_fake_add');
  assert.ok(add);
  const input = add.normalizeInput?.({ a: 2, b: '3', tags: ['x', 'y'] });
  assert.equal(add.validateInput(input), true);
  assert.deepEqual(await add.run(input, signal), { status: 'done', server: 'fake', tool: 'add', result: '5 x,y' });
  assert.equal(asked[0]?.kind, 'mcp');
  // "Always allow" covers the next call without asking.
  assert.equal((await add.run({ a: '1', b: '1' }, signal) as { result: string }).result, '2');
  assert.equal(asked.length, 1);

  const broken = await registry.get('mcp_fake_broken_tool')?.run({}, signal);
  assert.deepEqual(broken, { status: 'rejected', server: 'fake', tool: 'broken-tool' }, 'a refused approval runs nothing');
  assert.equal(add.validateInput({ a: '2' }), false, 'required fields are checked');
});
