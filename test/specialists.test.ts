import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt } from '../src/agent/system-prompt.ts';
import { isPersonaId, PERSONAS, personaFor } from '../src/shared/persona.ts';
import { parseFrontAppName, parseIdleSeconds, UsageSampler } from '../src/desktop/usage-sampler.ts';
import { SqliteStore } from '../src/storage/sqlite-store.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { registerUtilityTools } from '../src/tools/utility-tools.ts';
import type { ActionToolPorts } from '../src/tools/action-tools.ts';

const environment = { date: '2026-11-15', osRelease: 'test', home: '/Users/test', projectFolders: [] } as unknown as Parameters<typeof buildSystemPrompt>[0];

test('the specialists are valid personas with a focus; the leads have none', () => {
  for (const id of ['kavach', 'yatra', 'khoj', 'lipi'] as const) {
    assert.ok(isPersonaId(id));
    assert.ok(PERSONAS[id].focus !== undefined && PERSONAS[id].focus.length > 50);
    assert.ok(PERSONAS[id].role.length > 0);
  }
  assert.equal(personaFor('vyom').focus, undefined);
  assert.equal(personaFor('vyomara').focus, undefined);
  assert.ok(!isPersonaId('stonic'));
});

test('a specialist\'s focus and the user\'s character reach the system prompt', () => {
  const kavach = buildSystemPrompt(environment, [], { persona: 'kavach' });
  assert.match(kavach, /You are Kavach, the male AI assistant/);
  assert.match(kavach, /guardian of this Mac/);
  const withCharacter = buildSystemPrompt(environment, [], { persona: 'yatra', character: 'Call me boss. Short answers.' });
  assert.match(withCharacter, /travel planner/);
  assert.match(withCharacter, /Your character, set by the user[\s\S]*Call me boss/);
  const plain = buildSystemPrompt(environment, [], { persona: 'vyom' });
  assert.doesNotMatch(plain, /Your character, set by the user/);
  assert.doesNotMatch(plain, /guardian of this Mac/);
});

test('the usage sampler parses macOS probes and nudges once per threshold', () => {
  assert.equal(parseIdleSeconds('    | |     "HIDIdleTime" = 28728330250'), 28.72833025);
  assert.equal(parseIdleSeconds('no match'), undefined);
  assert.equal(parseFrontAppName('"LSDisplayName"="Code"'), 'Code');
  assert.equal(parseFrontAppName(''), undefined);

  const recorded: string[] = [];
  const nudges: number[] = [];
  const sampler = new UsageSampler({
    record: sample => recorded.push(`${sample.app}:${sample.seconds}`),
    nudge: seconds => nudges.push(seconds),
    nudgeAfterSeconds: 60,
  });
  sampler.apply(5, 'Code');
  sampler.apply(5, 'Code');
  assert.deepEqual(recorded, ['Code:30', 'Code:30']);
  assert.deepEqual(nudges, [60]);
  sampler.apply(130, undefined); // short idle: sitting continues, nothing recorded
  assert.equal(sampler.sittingSeconds, 60);
  sampler.apply(5, 'Safari');
  sampler.apply(5, 'Safari');
  assert.deepEqual(nudges, [60, 120]); // nudges again only after another full threshold
  sampler.apply(400, undefined); // a real break resets the sitting
  assert.equal(sampler.sittingSeconds, 0);
});

test('app usage accumulates per day and app in the local database', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vyomara-usage-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SqliteStore(root);
  t.after(() => store.close());
  store.addAppUsage('2026-11-15', 'Code', 30);
  store.addAppUsage('2026-11-15', 'Code', 30);
  store.addAppUsage('2026-11-14', 'Chrome', 90);
  assert.deepEqual(store.appUsageSince('2026-11-15'), [{ day: '2026-11-15', app: 'Code', seconds: 60 }]);
  assert.equal(store.appUsageSince('2026-11-01').length, 2);
  assert.throws(() => store.addAppUsage('yesterday', 'Code', 30), /invalid/u);
  assert.throws(() => store.addAppUsage('2026-11-15', 'Code', -1), /invalid/u);
});

test('screen_time sums the recorded days and is registered only with a usage port', async () => {
  const usage = {
    usageSince: () => [
      { day: '2026-11-15', app: 'Code', seconds: 3_600 },
      { day: '2026-11-14', app: 'Code', seconds: 600 },
      { day: '2026-11-15', app: 'Chrome', seconds: 300 },
    ],
  };
  const registry = new ToolRegistry();
  registerUtilityTools(registry, { approval: { request: async () => true }, usage } as unknown as ActionToolPorts);
  const tool = registry.get('screen_time');
  assert.ok(tool);
  const result = await tool.run({ days: '7' }, AbortSignal.timeout(1_000)) as { total: string; apps: readonly { app: string; minutes: number }[] };
  assert.equal(result.total, '1h 15m');
  assert.deepEqual(result.apps[0], { app: 'Code', minutes: 70 });
  assert.equal(tool.inputError?.({ days: '0' }), 'days must be a whole number from 1 to 30.');

  const bare = new ToolRegistry();
  registerUtilityTools(bare, { approval: { request: async () => true } } as unknown as ActionToolPorts);
  assert.equal(bare.get('screen_time'), undefined);
});
