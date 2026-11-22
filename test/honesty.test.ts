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

test('time and date questions count as current information', async () => {
  const { asksForCurrentInfo } = await import('../src/agent/agent.ts');
  for (const question of ['Abhi kitne baje hain?', 'time kya hua hai', 'aaj kya date hai', 'What time is it in London?'])
    assert.equal(asksForCurrentInfo(question), true, question);
  assert.equal(asksForCurrentInfo('ye function ki time complexity kya hai'), false);
});

test('a guessed reply to a current-facts question is held back, not shown or spoken', async () => {
  const registry = new ToolRegistry();
  registry.register({
    id: 'web_search',
    effect: 'read',
    description: 'Search the web.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    validateInput: (value): value is { query: string } => typeof (value as { query?: unknown }).query === 'string',
    validateOutput: (value): value is Record<string, unknown> => typeof value === 'object',
    async run() { return { results: [{ title: 'Pune weather', snippet: '22°C, clear' }] }; },
  });
  const tools = new ToolExecutor({ registry, policy: new PolicyGateway(), config, logger });
  let step = 0;
  const provider: ModelProvider = {
    id: 'scripted',
    async complete(_messages, _signal, _tools, onText) {
      step += 1;
      if (step === 1) { onText?.('Haan, Chrome '); onText?.('khol diya.'); return { kind: 'final', text: 'Haan, Chrome khol diya.' }; }
      if (step === 2) return { kind: 'tool-calls', calls: [{ toolId: 'web_search', arguments: { query: 'weather Pune today' } }] };
      onText?.('Today in Pune it is 22°C and clear.');
      return { kind: 'final', text: 'Today in Pune it is 22°C and clear.' };
    },
  };
  let shown = '';
  const reply = await runAgent('Hi, can you tell me the today\'s weather?', AbortSignal.timeout(5_000), {
    provider, tools, config, session: new Session(), logger, environment, onText: text => { shown += text; },
  });
  assert.doesNotMatch(shown, /Chrome/u, 'the guess never reached the screen or the voice');
  assert.match(shown, /22°C/u);
  assert.match(reply, /22°C/u);
});

test('a held reply that is kept is still shown', async () => {
  const tools = new ToolExecutor({ registry: new ToolRegistry(), policy: new PolicyGateway(), config, logger });
  const provider: ModelProvider = {
    id: 'scripted',
    async complete(_messages, _signal, _tools, onText) { onText?.('I cannot check the weather here.'); return { kind: 'final', text: 'I cannot check the weather here.' }; },
  };
  let shown = '';
  await runAgent('What is the weather today?', AbortSignal.timeout(5_000), { provider, tools, config, session: new Session(), logger, environment, onText: text => { shown += text; } });
  assert.equal(shown, 'I cannot check the weather here.');
});
