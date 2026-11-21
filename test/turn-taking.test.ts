import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnCollector } from '../src/shared/turn-taking.ts';

function harness(options: { readonly pauseFor?: (text: string) => number } = {}) {
  const turns: string[] = [];
  let clock = 0;
  let pending: { readonly callback: () => void; readonly at: number } | undefined;
  const collector = new TurnCollector(text => turns.push(text), {
    ...options,
    now: () => clock,
    schedule: (callback, ms) => {
      const timer = { callback, at: clock + ms };
      pending = timer;
      return () => { if (pending === timer) pending = undefined; };
    },
  });
  /** Let `ms` of quiet pass (default: long enough for any pause). */
  const elapse = (ms = 10_000): void => {
    clock += ms;
    const timer = pending;
    if (timer && timer.at <= clock) {
      pending = undefined;
      timer.callback();
    }
  };
  return { turns, collector, elapse, timerPending: () => pending !== undefined };
}

test('a pause mid-sentence does not end the turn', () => {
  const { turns, collector, elapse } = harness();
  collector.speechStarted();
  collector.speechEnded();
  collector.addPhrase()('VS Code kholo');
  collector.speechStarted(); // the speaker carried on before the turn ended
  collector.speechEnded();
  collector.addPhrase()('aur keylessrn project open karo');
  assert.deepEqual(turns, []);
  elapse();
  assert.deepEqual(turns, ['VS Code kholo aur keylessrn project open karo']);
});

test('the turn waits for slow transcriptions and keeps speaking order', () => {
  const { turns, collector, elapse } = harness();
  collector.speechStarted();
  collector.speechEnded();
  const first = collector.addPhrase();
  collector.speechStarted();
  collector.speechEnded();
  const second = collector.addPhrase();
  second('second part');
  elapse();
  assert.deepEqual(turns, []);
  first('first part');
  assert.deepEqual(turns, ['first part second part']);
});

test('silence and noise-only phrases produce no turn', () => {
  const { turns, collector, elapse } = harness();
  collector.speechStarted();
  collector.speechEnded(); // too short: no phrase follows
  elapse();
  collector.speechStarted();
  collector.speechEnded();
  collector.addPhrase()(undefined);
  elapse();
  assert.deepEqual(turns, []);
  assert.equal(collector.active, false);
});

test('reset drops late transcripts from the abandoned turn', () => {
  const { turns, collector, elapse } = harness();
  collector.speechStarted();
  collector.speechEnded();
  const late = collector.addPhrase();
  collector.reset();
  late('old words');
  elapse();
  assert.deepEqual(turns, []);
  assert.equal(collector.text, '');
});

test('text shows the words heard so far', () => {
  const { collector } = harness();
  collector.speechStarted();
  collector.speechEnded();
  collector.addPhrase()('Chrome kholo');
  collector.speechStarted();
  assert.equal(collector.text, 'Chrome kholo');
  assert.equal(collector.active, true);
});

test('a finished sentence ends the turn quickly; one that trails off waits', async () => {
  const { turnPauseMs } = await import('../src/shared/turn-taking.ts');
  const { turns, collector, elapse } = harness({ pauseFor: turnPauseMs });
  collector.speechStarted();
  collector.speechEnded();
  collector.addPhrase()('Vyom, shop project kholo.');
  elapse(300);
  assert.deepEqual(turns, []);
  elapse(100);
  assert.deepEqual(turns, ['Vyom, shop project kholo.'], 'ends ~350 ms after a finished sentence');

  collector.speechStarted();
  collector.speechEnded();
  collector.addPhrase()('mujhe ek email likhni hai aur');
  elapse(1_000);
  assert.deepEqual(turns.length, 1, 'still waiting after "aur"');
  collector.speechStarted();
  collector.speechEnded();
  collector.addPhrase()('usme meeting ka time daalna hai.');
  elapse(400);
  assert.deepEqual(turns, ['Vyom, shop project kholo.', 'mujhe ek email likhni hai aur usme meeting ka time daalna hai.']);
});

test('the pause rules read Hinglish, Hindi, and English endings', async () => {
  const { turnPauseMs } = await import('../src/shared/turn-taking.ts');
  for (const done of ['Kya iska svaad achchha hai?', 'tests chala do', 'मौसम कैसा है?', 'What is the latest React version?', 'theek hai', 'हाँ, खोलो']) {
    assert.equal(turnPauseMs(done), 350, done);
  }
  for (const trailing of ['code theek karo aur', 'mujhe batao ki', 'open VS Code and', 'matlab', 'मुझे बताओ कि', 'so the thing is...']) {
    assert.equal(turnPauseMs(trailing), 1_800, trailing);
  }
  assert.equal(turnPauseMs('shop project ka cart'), 900);
});

test('a turn hands over each phrase recording, and joined they form one WAV', async () => {
  const { encodeWav, joinWavs } = await import('../src/shared/phrase-detector.ts');
  let received: readonly Uint8Array[] = [];
  let clock = 0;
  let pending: (() => void) | undefined;
  const collector = new TurnCollector((_text, audio) => { received = audio; }, {
    now: () => clock,
    schedule: callback => { pending = callback; return () => { pending = undefined; }; },
  });
  const first = encodeWav(new Float32Array(1_600).fill(0.1));
  const second = encodeWav(new Float32Array(800).fill(-0.1));
  collector.speechStarted();
  collector.speechEnded();
  collector.addPhrase(first)('shop project');
  collector.speechStarted();
  collector.speechEnded();
  collector.addPhrase(second)('kholo');
  clock += 5_000;
  pending?.();
  assert.deepEqual(received, [first, second]);
  const joined = joinWavs(received);
  assert.ok(joined);
  // 1,600 + 3,200 (200 ms gap) + 800 samples, 2 bytes each.
  assert.equal(joined.byteLength, 44 + (1_600 + 3_200 + 800) * 2);
  const view = new DataView(joined.buffer);
  assert.equal(view.getUint32(40, true), (1_600 + 3_200 + 800) * 2);
  assert.equal(view.getInt16(44 + 1_600 * 2 + 100, true), 0, 'the gap is silence');
  assert.equal(joinWavs([first]), first);
  assert.equal(joinWavs([first, second], 16_000, 200, 1_000), undefined, 'too long for one request');
  assert.equal(joinWavs([new Uint8Array(10), second]), undefined);
});
