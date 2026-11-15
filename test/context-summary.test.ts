import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../src/agent/agent.ts';
import { summaryCut, transcriptForSummary } from '../src/agent/context.ts';
import { loadConfig } from '../src/config/config.ts';
import { createLogger } from '../src/diagnostics/logger.ts';
import type { ModelProvider } from '../src/providers/provider.ts';
import { Session } from '../src/session/session.ts';
import type { SessionMessage } from '../src/session/session.ts';
import { ToolExecutor } from '../src/tools/executor.ts';
import { PolicyGateway } from '../src/tools/policy.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';

function longConversation(turns: number): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    messages.push({ role: 'user', content: `Question ${turn}: ${'detail '.repeat(200)}` });
    messages.push({ role: 'assistant', content: `Answer ${turn}: ${'explanation '.repeat(200)}` });
  }
  messages.push({ role: 'user', content: 'Now continue with the last step.' });
  return messages;
}

test('nothing is summarised while the conversation fits', () => {
  assert.equal(summaryCut(longConversation(2), 100_000), 0);
});

test('early turns are cut at a user message, never the current turn', () => {
  const messages = longConversation(12);
  const cut = summaryCut(messages, 12_000);
  assert.ok(cut > 0 && cut < messages.length - 1);
  assert.equal(messages[cut]?.role, 'user');
  assert.match(transcriptForSummary(messages.slice(0, cut), 100_000), /^User: Question 1/u);
  assert.match(transcriptForSummary(messages.slice(0, cut), 2_000), /^…\n/u, 'too long: the latest part is kept');
});

test('a long conversation reaches the model as a summary plus recent turns', async () => {
  const config = loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_OLLAMA_NUM_CTX: '8192', VYOM_DATA_DIR: '/tmp/vyomara-unused' });
  const seen: SessionMessage[][] = [];
  const provider: ModelProvider = {
    id: 'scripted',
    async complete(messages) {
      seen.push([...messages]);
      const last = messages.at(-1)?.content ?? '';
      return /summarise the conversation/u.test(last)
        ? { kind: 'final', text: '- The user is building a shop app.\n- Question 1 was about details.' }
        : { kind: 'final', text: 'Continuing.' };
    },
  };
  const tools = new ToolExecutor({ registry: new ToolRegistry(), policy: new PolicyGateway(), config, logger: createLogger(() => {}) });
  const session = new Session(undefined, longConversation(40).slice(0, -1));
  const environment = { date: '2026-11-08', osRelease: 'test', home: '/Users/test', projectFolders: [] };
  await runAgent('Now continue with the last step.', AbortSignal.timeout(5_000), { provider, tools, config, session, logger: createLogger(() => {}), environment });
  assert.equal(seen.length, 2, 'one summary request, then the real one');
  const real = seen[1] ?? [];
  assert.match(real[0]?.content ?? '', /^\[Summary of the earlier part[\s\S]*shop app/u);
  assert.equal(real.at(-1)?.content, 'Now continue with the last step.');
  assert.ok(!real.some(message => message.content.startsWith('Question 1:')), 'the oldest turns are not sent in full');
});
