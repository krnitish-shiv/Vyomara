import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnCollector } from '../src/shared/turn-taking.ts';

function harness() {
  const turns: string[] = [];
  let pending: (() => void) | undefined;
  const collector = new TurnCollector(text => turns.push(text), {
    schedule: callback => {
      pending = callback;
      return () => { pending = undefined; };
    },
  });
  const elapse = (): void => {
    const callback = pending;
    pending = undefined;
    callback?.();
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
