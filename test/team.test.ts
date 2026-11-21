import assert from 'node:assert/strict';
import test from 'node:test';
import { describeToolCall, runAgent, runTeamMember, type ToolActivity } from '../src/agent/agent.ts';
import { loadConfig } from '../src/config/config.ts';
import { createLogger } from '../src/diagnostics/logger.ts';
import type { ModelProvider } from '../src/providers/provider.ts';
import { Session, type SessionMessage } from '../src/session/session.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { registerDelegateTool, type DelegatePort } from '../src/tools/delegate-tool.ts';
import { ToolExecutor } from '../src/tools/executor.ts';
import { PolicyGateway } from '../src/tools/policy.ts';

const config = loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_DATA_DIR: '/tmp/vyomara-unused' });
const environment = { date: '2026-11-21', osRelease: 'test', home: '/Users/test', projectFolders: [] };
const logger = createLogger(() => {});

function recordingTool(id: string, calls: string[]): Parameters<ToolRegistry['register']>[0] {
  return {
    id,
    effect: 'read',
    description: `${id} for tests.`,
    parameters: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
    validateInput: (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
    validateOutput: (value): value is Record<string, unknown> => typeof value === 'object',
    async run() { calls.push(id); return { result: `${id} ok` }; },
  };
}

test('a team member works with its own whitelist, labels its activity, and reports back', async () => {
  const calls: string[] = [];
  const registry = new ToolRegistry();
  registry.register(recordingTool('web_search', calls));
  registry.register(recordingTool('write_file', calls));
  const tools = new ToolExecutor({ registry, policy: new PolicyGateway(), config, logger });
  const seen: SessionMessage[][] = [];
  let step = 0;
  const provider: ModelProvider = {
    id: 'scripted',
    async complete(messages) {
      seen.push([...messages]);
      step += 1;
      if (step === 1) return { kind: 'tool-calls', calls: [{ toolId: 'web_search', arguments: { query: 'Goa in December' } }, { toolId: 'write_file', arguments: { query: 'x' } }] };
      return { kind: 'final', text: 'Goa is warm in December (sources: a, b).' };
    },
  };
  const activity: ToolActivity[] = [];
  const report = await runTeamMember('yatra', 'Plan 3 days in Goa in December for two, budget 30k.', AbortSignal.timeout(5_000), {
    provider, tools, config, logger, environment, persona: 'vyomara', onToolActivity: item => activity.push(item),
  });
  assert.equal(report, 'Goa is warm in December (sources: a, b).');
  assert.deepEqual(calls, ['web_search'], 'write_file is outside Yatra\'s whitelist');
  assert.match(JSON.stringify(seen[1]), /Yatra, the travel specialist: write_file is not available/u);
  assert.match(seen[0]?.[0]?.content ?? '', /You are Yatra, the travel specialist[\s\S]*Task: Plan 3 days in Goa/u);
  assert.ok(activity.some(item => item.label.startsWith('Yatra: ')));
});

test('the twin hands a task to the team through delegate and gets the report', async () => {
  const registry = new ToolRegistry();
  const handed: string[] = [];
  const port: DelegatePort = {
    async run(member, task) { handed.push(`${member}:${task}`); return 'Three sources agree: Node 24 is the current LTS.'; },
  };
  registerDelegateTool(registry, port);
  const tools = new ToolExecutor({ registry, policy: new PolicyGateway(), config, logger });
  let step = 0;
  const seen: SessionMessage[][] = [];
  const provider: ModelProvider = {
    id: 'scripted',
    async complete(messages) {
      seen.push([...messages]);
      step += 1;
      if (step === 1) return { kind: 'tool-calls', calls: [{ toolId: 'delegate', arguments: { member: 'Khoj', task: 'Find the current Node.js LTS version, with sources.' } }] };
      return { kind: 'final', text: 'Khoj ne check kiya: Node 24 LTS hai.' };
    },
  };
  const reply = await runAgent('Node ka latest LTS kaunsa hai?', AbortSignal.timeout(5_000), { provider, tools, config, session: new Session(), logger, environment });
  assert.match(reply, /Node 24 LTS/u);
  assert.deepEqual(handed, ['khoj:Find the current Node.js LTS version, with sources.'], 'member name is accepted in any case');
  assert.match(JSON.stringify(seen[1]), /Three sources agree/u);
});

test('delegate refuses unknown members and short tasks, and labels the hand-off', async () => {
  const registry = new ToolRegistry();
  registerDelegateTool(registry, {});
  const tool = registry.get('delegate');
  assert.ok(tool);
  assert.equal(tool.validateInput({ member: 'stonic', task: 'Do something useful please.' }), false);
  assert.equal(tool.validateInput({ member: 'khoj', task: 'hi' }), false);
  assert.equal(tool.validateInput({ member: 'khoj', task: 'Find the Node LTS version.', extra: 1 }), false);
  await assert.rejects(tool.run({ member: 'khoj', task: 'Find the Node LTS version.' }, AbortSignal.timeout(1_000)), /not available here/u);
  assert.equal(describeToolCall('delegate', { member: 'Lipi', task: 'Draft a leave email to my manager' }), 'Handing to Lipi: Draft a leave email to my manager');
  assert.match(tool.description, /khoj \(questions that need looking things up/u);
});

test('helper tools outlive the read-tool timeout; ordinary read tools do not', async () => {
  const quick = loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_DATA_DIR: '/tmp/vyomara-unused', VYOM_TOOL_TIMEOUT_MS: '50' });
  const slow = (id: string, longRunning: boolean): Parameters<ToolRegistry['register']>[0] => ({
    id,
    effect: 'read',
    ...(longRunning ? { longRunning: true as const } : {}),
    description: 'Slow tool for tests.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    validateInput: (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
    validateOutput: (value): value is Record<string, unknown> => typeof value === 'object',
    async run() { await new Promise(resolve => setTimeout(resolve, 150)); return { done: true }; },
  });
  const registry = new ToolRegistry();
  registry.register(slow('helper', true));
  registry.register(slow('plain', false));
  const tools = new ToolExecutor({ registry, policy: new PolicyGateway(), config: quick, logger });
  assert.deepEqual(await tools.execute('helper', {}, AbortSignal.timeout(5_000)), { done: true });
  await assert.rejects(tools.execute('plain', {}, AbortSignal.timeout(5_000)), /timed out/iu);
});
