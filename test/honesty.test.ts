import assert from 'node:assert/strict';
import test from 'node:test';
import { claimsActionDone, runAgent } from '../src/agent/agent.ts';
import { loadConfig } from '../src/config/config.ts';
import { createLogger } from '../src/diagnostics/logger.ts';
import type { ModelProvider } from '../src/providers/provider.ts';
import { Session, type SessionMessage } from '../src/session/session.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { ToolExecutor } from '../src/tools/executor.ts';
import { PolicyGateway } from '../src/tools/policy.ts';

const config = loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_DATA_DIR: '/tmp/vyomara-unused' });
const environment = { date: '2026-11-21', osRelease: 'test', home: '/Users/test', projectFolders: [] };
const logger = createLogger(() => {});

test('claims of a finished action are recognised in Hinglish, Hindi, and English', () => {
  for (const claim of ['"Google Chrome kholo" ke liye main yahaan hoon. Chrome kholega.', 'Haan, Chrome khol diya.', 'I have opened Safari.', 'Spotify open kar diya hai', 'क्रोम खोल दिया'])
    assert.equal(claimsActionDone(claim), true, claim);
  for (const plain of ['Chrome kholne ke liye bataiye kaunsa profile?', 'Main samajh gaya.', 'Opening hours are 9 to 5.'])
    assert.equal(claimsActionDone(plain), false, plain);
});

test('"Chrome kholega" without a tool call is sent back to actually open it', async () => {
  const opened: string[] = [];
  const registry = new ToolRegistry();
  registry.register({
    id: 'open_application',
    effect: 'read',
    description: 'Open an app.',
    parameters: { type: 'object', properties: { application: { type: 'string' } }, required: ['application'], additionalProperties: false },
    validateInput: (value): value is { application: string } => typeof (value as { application?: unknown }).application === 'string',
    validateOutput: (value): value is Record<string, unknown> => typeof value === 'object',
    async run(input) { opened.push(input.application); return { status: 'opened' }; },
  });
  const tools = new ToolExecutor({ registry, policy: new PolicyGateway(), config, logger });
  const seen: SessionMessage[][] = [];
  let step = 0;
  const provider: ModelProvider = {
    id: 'scripted',
    async complete(messages) {
      seen.push([...messages]);
      step += 1;
      if (step === 1) return { kind: 'final', text: 'Chrome kholega.' };
      if (step === 2) return { kind: 'tool-calls', calls: [{ toolId: 'open_application', arguments: { application: 'Google Chrome' } }] };
      return { kind: 'final', text: 'Chrome khul gaya.' };
    },
  };
  const reply = await runAgent('Google Chrome kholvae.', AbortSignal.timeout(5_000), { provider, tools, config, session: new Session(), logger, environment });
  assert.deepEqual(opened, ['Google Chrome']);
  assert.match(JSON.stringify(seen[1]), /no tool ran in this request/u);
  assert.match(reply, /Chrome khul gaya/u);
});

test('greetings and acknowledgements are small talk; requests are not', async () => {
  const { isSmallTalk } = await import('../src/agent/agent.ts');
  for (const talk of ['hi', 'acha ji', 'Hi, bhaiya.', 'Haan, theek hai.', 'kaise ho Vyom?', 'thank you', 'Good morning!', 'ok'])
    assert.equal(isSmallTalk(talk), true, talk);
  for (const task of ['Google Chrome kholo', 'hi, shop project ke tests chala do', 'kya time hua hai', 'theek hai, ab commit kar do', 'weather kaisa hai'])
    assert.equal(isSmallTalk(task), false, task);
});
