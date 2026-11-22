/**
 * Conversation evaluation: the spoken Hinglish requests from the owner's
 * first real session, run as voice requests against a model. Every action is
 * recorded and rejected (nothing is opened or run). Reports, per request, the
 * reply, the tools called, time to first text, and total time, plus checks:
 * small talk runs no tool, replies to Roman Hinglish stay in Roman letters,
 * and "open X" calls open_application.
 *
 *   pnpm eval:talk                          # the configured model
 *   pnpm eval:talk -- --model qwen3:14b
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRequest } from '../src/app/application.ts';
import { loadConfig, validateOllamaModel } from '../src/config/config.ts';
import { createLogger } from '../src/diagnostics/logger.ts';
import type { ActionApprovalPort } from '../src/tools/action-tools.ts';
import { ShellCommandRunner } from '../src/tools/command-runner.ts';
import { HttpWebClient } from '../src/tools/web-client.ts';
import { MacApplicationLauncher } from '../src/desktop/mac-application-launcher.ts';

interface Case {
  readonly prompt: string;
  readonly check: (reply: string, tools: readonly string[]) => string | undefined;
}

const devanagari = (text: string): boolean => /[ऀ-ॿ]/u.test(text);
const noTools = (reply: string, tools: readonly string[]): string | undefined => // eslint-disable-line
  tools.length > 0 ? `ran tools for small talk: ${tools.join(', ')}` : devanagari(reply) ? 'replied in Devanagari' : reply.length > 220 ? 'too long for small talk' : undefined;

const CASES: readonly Case[] = [
  { prompt: 'hi', check: noTools },
  { prompt: 'acha ji', check: noTools },
  { prompt: 'Hi, bhaiya.', check: noTools },
  { prompt: 'kaise ho Vyom?', check: noTools },
  { prompt: 'Google Chrome kholvae.', check: (reply, tools) => tools.includes('open_application') ? (devanagari(reply) ? 'replied in Devanagari' : undefined) : `did not call open_application (${tools.join(', ') || 'no tools'})` },
  { prompt: 'Mujhe ek chhota sa joke sunao.', check: (reply, tools) => tools.length > 0 ? `ran tools: ${tools.join(', ')}` : devanagari(reply) ? 'replied in Devanagari' : undefined },
  { prompt: 'Aaj Delhi ka mausam kaisa hai?', check: (reply, tools) => tools.some(tool => tool === 'weather' || tool === 'web_search') ? (devanagari(reply) ? 'replied in Devanagari' : undefined) : 'did not look up the weather' },
  { prompt: "Hi, can you tell me the today's weather?", check: (reply, tools) => !tools.some(tool => tool === 'weather' || tool === 'web_search') ? 'did not look up the weather' : /chrome/iu.test(reply) ? 'mentioned Chrome' : devanagari(reply) ? 'replied in Devanagari' : undefined },
  { prompt: 'Abhi kitne baje hain?', check: (_reply, tools) => tools.includes('current_time') ? undefined : 'did not check the time' },
];

const args = process.argv.slice(2);
const modelIndex = args.indexOf('--model');
const override = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
const data = mkdtempSync(join(tmpdir(), 'vyomara-talk-'));
const config = loadConfig({ ...process.env, VYOM_DATA_DIR: data, ...(override ? { VYOM_OLLAMA_MODEL: validateOllamaModel(override) } : {}) });
console.log(`Conversation eval: ${config.ollamaModel} (${config.ollamaNumCtx} ctx, think=${config.ollamaThink})\n`);

const results: unknown[] = [];
let passed = 0;
let sessionId: string | undefined;
try {
  for (const testCase of CASES) {
    const tools: string[] = [];
    // Reading the web is allowed (it changes nothing); opening apps, links, and commands are recorded and refused.
    const actions: ActionApprovalPort = { async request(action) { return action.kind === 'web'; } };
    const started = Date.now();
    let firstText: number | undefined;
    let reply = '';
    let reason: string | undefined;
    try {
      const result = await runRequest(testCase.prompt, AbortSignal.timeout(10 * 60_000), config, createLogger(() => {}), {
        voice: true,
        persona: 'vyom',
        ...(sessionId ? { sessionId } : {}),
        onText: () => { firstText ??= Date.now() - started; },
        onToolActivity: activity => { if (activity.status === 'running') tools.push(activity.toolId); },
        actions: {
          approval: actions,
          commandRunner: new ShellCommandRunner(),
          web: new HttpWebClient(config.searxngUrl === undefined ? {} : { searxngUrl: config.searxngUrl }),
          ...(process.platform === 'darwin' ? { launcher: new MacApplicationLauncher() } : {}),
        },
      });
      sessionId = result.sessionId;
      reply = result.response.replace(/\n*\s*-{3,}\s*\n+\s*\**Verified actions\**[\s\S]*$/iu, '').trim();
      reason = testCase.check(reply, tools);
    } catch (error) {
      reason = `failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const total = (Date.now() - started) / 1000;
    if (!reason) passed += 1;
    results.push({ prompt: testCase.prompt, pass: !reason, reason, tools, reply, firstTextSeconds: firstText === undefined ? null : firstText / 1000, totalSeconds: total });
    console.log(`${reason ? 'FAIL' : 'PASS'}  "${testCase.prompt}"  first text ${firstText === undefined ? '—' : `${(firstText / 1000).toFixed(1)}s`}  total ${total.toFixed(1)}s  tools [${tools.join(', ')}]${reason ? `  — ${reason}` : ''}`);
    console.log(`      → ${reply.replace(/\s+/gu, ' ').slice(0, 200)}`);
  }
} finally {
  console.log(`\n${passed}/${CASES.length} passed`);
  writeFileSync(join(process.cwd(), 'eval-talk-results.json'), `${JSON.stringify({ model: config.ollamaModel, date: new Date().toISOString(), results }, null, 2)}\n`);
  rmSync(data, { recursive: true, force: true });
}
