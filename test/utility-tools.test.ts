import assert from 'node:assert/strict';
import test from 'node:test';
import { asksForCurrentInfo, offersToLookItUp } from '../src/agent/agent.ts';
import { loadConfig } from '../src/config/config.ts';
import { encyclopediaQuery } from '../src/tools/action-tools.ts';
import type { ActionProposal, ActionToolPorts } from '../src/tools/action-tools.ts';
import { ToolRegistry } from '../src/tools/contracts.ts';
import { createDefaultToolRegistry } from '../src/tools/default-tools.ts';
import { convertUnits, dateMath, describeTime, evaluateExpression, registerUtilityTools, resolveTimeZone } from '../src/tools/utility-tools.ts';

test('the calculator handles everyday arithmetic without eval', () => {
  assert.equal(evaluateExpression('(1200 + 350) * 12'), 18_600);
  assert.equal(evaluateExpression('18% of 2,499'), 449.82);
  assert.equal(evaluateExpression('2 ^ 10'), 1_024);
  assert.equal(evaluateExpression('2^3^2'), 512);
  assert.equal(evaluateExpression('-3 + 5'), 2);
  assert.equal(evaluateExpression('10 mod 3'), 1);
  assert.equal(evaluateExpression('5!'), 120);
  assert.equal(evaluateExpression('sqrt(144) + max(2, 7)'), 19);
  assert.equal(evaluateExpression('12 × 3 ÷ 4'), 9);
  assert.equal(evaluateExpression('4 x 25'), 100);
  assert.ok(Math.abs(evaluateExpression('sin(30)') - 0.5) < 1e-12);
  assert.throws(() => evaluateExpression('1 / 0'), /finite/u);
  assert.throws(() => evaluateExpression('process.exit()'), /Unknown name|cannot read/u);
  assert.throws(() => evaluateExpression('2 +'), /incomplete/u);
});

test('units convert within a kind and refuse across kinds', () => {
  assert.deepEqual(convertUnits(10, 'km', 'mi'), { value: 6.21371192237, from: 'km', to: 'mi' });
  assert.equal(convertUnits(100, 'C', 'F').value, 212);
  assert.equal(convertUnits(1, 'GB', 'MB').value, 1_000);
  assert.equal(convertUnits(1, 'quintal', 'kg').value, 100);
  assert.equal(convertUnits(1_000, 'sq ft', 'm2').value, 92.90304);
  assert.throws(() => convertUnits(1, 'kg', 'km'), /Cannot convert mass/u);
  assert.throws(() => convertUnits(1, 'parsec', 'km'), /Unknown unit/u);
});

test('date maths counts days and adds periods on the calendar', () => {
  const from = new Date(Date.UTC(2026, 10, 8));
  assert.equal(dateMath({ other_date: '2027-01-01' }, from).days, 54);
  assert.equal(dateMath({ date: '2026-01-31', add: '1 month' }).result, '2026-03-03 (Tuesday)');
  assert.equal(dateMath({ date: '2026-11-08', add: '-2 weeks' }).result, '2026-10-25 (Sunday)');
  assert.throws(() => dateMath({ other_date: '2026-02-30' }, from), /not a date/u);
});

test('time zones resolve from city names and IANA zones', () => {
  assert.equal(resolveTimeZone('Delhi'), 'Asia/Kolkata');
  assert.equal(resolveTimeZone('america/new_york'), 'America/New_York');
  assert.equal(resolveTimeZone('Atlantis'), undefined);
  const time = describeTime(new Date(Date.UTC(2026, 10, 8, 6, 30)), 'Asia/Kolkata');
  assert.equal(time.date, '2026-11-08');
  assert.equal(time.weekday, 'Sunday');
  assert.equal(time.time, '12:00 PM');
  assert.equal(time.utcOffset, 'UTC+05:30');
});

test('the desktop tool set leaves room for MCP tools within the model tool limit', () => {
  const config = loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_ALLOWED_ROOTS: '["/tmp"]', VYOM_DATA_DIR: '/tmp/vyomara-test-unused' });
  const ports = {
    approval: { request: async () => true },
    commandRunner: { run: async () => ({ exitCode: 0, signal: null, timedOut: false, output: '', truncated: false, durationMs: 0 }) },
    launcher: { openApplication: async () => {}, openUrl: async () => {} },
    web: { searchHost: undefined, fetch: async () => ({}), search: async () => [], fetchRaw: async () => '' },
    browser: { perform: async () => ({}) },
  } as unknown as ActionToolPorts;
  const ids = createDefaultToolRegistry(config, { includeFilesystemTools: true, actions: ports }).modelTools().map(tool => tool.id);
  for (const id of ['current_time', 'calculate', 'convert_units', 'date_math', 'system_info', 'weather', 'currency_convert', 'software_version']) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(ids.length <= 40, `${ids.length} tools`);
});

function utilityRegistry(responses: Record<string, unknown>, decisions: boolean[] = []): { registry: ToolRegistry; fetched: string[]; asked: string[] } {
  const fetched: string[] = [];
  const asked: string[] = [];
  const registry = new ToolRegistry();
  registerUtilityTools(registry, {
    approval: {
      async request(action: ActionProposal) {
        asked.push(action.kind === 'web' ? action.host : action.kind);
        return decisions.shift() ?? true;
      },
    },
    web: {
      searchHost: undefined,
      fetch: async () => { throw new Error('unused'); },
      search: async () => [],
      async fetchRaw(url: string) {
        fetched.push(url);
        const key = Object.keys(responses).find(prefix => url.startsWith(prefix));
        if (!key) throw new Error(`unexpected ${url}`);
        return JSON.stringify(responses[key]);
      },
    },
  } as unknown as ActionToolPorts);
  return { registry, fetched, asked };
}

const signal = new AbortController().signal;

test('software_version reads the npm registry, matching the exact package name', async () => {
  const { registry, fetched, asked } = utilityRegistry({
    'https://registry.npmjs.org/-/v1/search': { objects: [
      { package: { name: '@react-native/js-polyfills', version: '0.88.1', date: '2026-10-27T12:14:37Z' } },
      { package: { name: 'react-native', version: '0.88.0', date: '2026-10-27T14:43:35Z' } },
    ] },
    'https://registry.npmjs.org/react-native/latest': { version: '0.88.1' },
  });
  const result = await registry.get('software_version')?.run({ name: 'React Native' }, signal) as Record<string, unknown>;
  assert.equal(result.name, 'react-native');
  assert.equal(result.version, '0.88.1');
  assert.equal(result.released, '2026-10-27');
  assert.deepEqual(asked, ['registry.npmjs.org']);
  assert.match(fetched[0] ?? '', /text=react-native/u);
});

test('weather and currency tools ask first and answer from the services', async () => {
  const { registry, asked } = utilityRegistry({
    'https://geocoding-api.open-meteo.com/': { results: [{ name: 'Patna', admin1: 'Bihar', country: 'India', latitude: 25.6, longitude: 85.1 }] },
    'https://api.open-meteo.com/': {
      current: { time: '2026-11-08T12:00', temperature_2m: 27, apparent_temperature: 28, relative_humidity_2m: 50, precipitation: 0, weather_code: 1, wind_speed_10m: 6 },
      daily: { time: ['2026-11-08'], weather_code: [2], temperature_2m_max: [29], temperature_2m_min: [16], precipitation_probability_max: [5], sunrise: ['2026-11-08T06:02'], sunset: ['2026-11-08T17:05'] },
    },
    'https://api.frankfurter.dev/': { date: '2026-11-06', rates: { INR: 93.92 } },
  });
  const weather = await registry.get('weather')?.run({ place: 'Patna', days: 1 }, signal) as Record<string, unknown>;
  assert.equal(weather.place, 'Patna, Bihar, India');
  assert.deepEqual((weather.now as Record<string, unknown>).weather, 'mainly clear');
  assert.equal(((weather.forecast as Record<string, unknown>[])[0] as Record<string, unknown>).sunset, '17:05');
  const money = await registry.get('currency_convert')?.run({ amount: '100', from: 'usd', to: 'inr' }, signal) as Record<string, unknown>;
  assert.equal(money.result, '9392 INR');
  assert.deepEqual(asked, ['open-meteo.com', 'frankfurter.dev']);
});

test('a rejected approval sends nothing', async () => {
  const { registry, fetched } = utilityRegistry({}, [false]);
  const result = await registry.get('weather')?.run({ place: 'Patna' }, signal) as Record<string, unknown>;
  assert.equal(result.status, 'rejected');
  assert.deepEqual(fetched, []);
});

test('without web access only the local utility tools exist', () => {
  const registry = new ToolRegistry();
  registerUtilityTools(registry);
  assert.deepEqual(registry.modelTools().map(tool => tool.id), ['current_time', 'calculate', 'convert_units', 'date_math', 'system_info']);
});

test('current-information questions and "shall I fetch?" replies are recognised', () => {
  assert.ok(asksForCurrentInfo('tell me what is the current latest version of react native is availble'));
  assert.ok(asksForCurrentInfo('aaj Delhi ka mausam kaisa hai'));
  assert.ok(asksForCurrentInfo('dollar rate today'));
  assert.ok(!asksForCurrentInfo('rate my code in src/cart.ts'));
  assert.ok(!asksForCurrentInfo('explain what a closure is'));
  assert.ok(offersToLookItUp('React Native 0.82 is mentioned.\n\nIf you\'d like, I can fetch the details of this version from the official site for you. Let me know!'));
  assert.ok(offersToLookItUp('Would you like me to read the article?'));
  assert.ok(!offersToLookItUp('I can open it in Chrome if you want.'));
  assert.ok(!offersToLookItUp('The latest version is 0.88.1, released on 27 October 2026.'));
});

test('encyclopedia searches drop recency and question words', () => {
  assert.equal(encyclopediaQuery('latest react native version'), 'react native');
  assert.equal(encyclopediaQuery('who is the PM of India'), 'PM India');
  assert.equal(encyclopediaQuery('latest version'), 'latest version');
});
