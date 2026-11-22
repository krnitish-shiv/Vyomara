import assert from 'node:assert/strict';
import test from 'node:test';
import { SpeechQueue } from '../src/desktop/speech-queue.ts';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

test('clauses play in order, and the next one is prepared while the current one plays', async () => {
  const log: string[] = [];
  const playing = new Map<string, ReturnType<typeof deferred<void>>>();
  const queue = new SpeechQueue<string>({
    async prepare(text) { log.push(`prepare ${text}`); return text; },
    play(text) { log.push(`play ${text}`); const done = deferred<void>(); playing.set(text, done); return done.promise; },
    discard(text) { log.push(`discard ${text}`); },
  });
  queue.enqueue('one');
  queue.enqueue('two');
  await tick();
  assert.deepEqual(log, ['prepare one', 'prepare two', 'play one'], 'two is prepared while one plays');
  queue.enqueue('three');
  const closed = queue.close();
  playing.get('one')?.resolve();
  await tick();
  assert.deepEqual(log.slice(3), ['prepare three', 'play two']);
  playing.get('two')?.resolve();
  await tick();
  playing.get('three')?.resolve();
  await closed;
  assert.deepEqual(log.slice(5), ['play three']);
});

test('the queue waits for clauses still being written, and reports speaking once', async () => {
  const events: boolean[] = [];
  const played: string[] = [];
  const queue = new SpeechQueue<string>({
    async prepare(text) { return text; },
    async play(text) { played.push(text); },
    discard() {},
  }, speaking => events.push(speaking));
  queue.enqueue('Haan,');
  await tick();
  await tick();
  assert.deepEqual(played, ['Haan,']);
  assert.equal(queue.started, true);
  queue.enqueue('ho gaya.');
  await queue.close();
  assert.deepEqual(played, ['Haan,', 'ho gaya.']);
  assert.deepEqual(events, [true, false]);
});

test('cancel drops queued clauses and discards one already prepared', async () => {
  const discarded: string[] = [];
  const played: string[] = [];
  const first = deferred<void>();
  const queue = new SpeechQueue<string>({
    async prepare(text) { return text; },
    play(text) { played.push(text); return text === 'one' ? first.promise : Promise.resolve(); },
    discard(text) { discarded.push(text); },
  });
  queue.enqueue('one');
  queue.enqueue('two');
  queue.enqueue('three');
  await tick();
  const cancelled = queue.cancel();
  first.resolve();
  await cancelled;
  await tick();
  assert.deepEqual(played, ['one']);
  assert.deepEqual(discarded, ['two']);
  queue.enqueue('four');
  assert.deepEqual(played, ['one'], 'nothing is spoken after cancel');
});

test('a clause that fails to prepare or play is skipped, not fatal', async () => {
  const played: string[] = [];
  const queue = new SpeechQueue<string>({
    async prepare(text) { if (text === 'bad') throw new Error('synth failed'); return text === 'stopped' ? undefined : text; },
    async play(text) { if (text === 'loud') throw new Error('afplay failed'); played.push(text); },
    discard() {},
  });
  for (const text of ['bad', 'stopped', 'loud', 'ok']) queue.enqueue(text);
  await queue.close();
  assert.deepEqual(played, ['ok']);
});

test('an empty queue closes at once and never reports speaking', async () => {
  const events: boolean[] = [];
  const queue = new SpeechQueue<string>({ async prepare(t) { return t; }, async play() {}, discard() {} }, s => events.push(s));
  queue.enqueue('   ');
  await queue.close();
  assert.deepEqual(events, []);
});

test('busy is true while a clause is queued or playing', async () => {
  let finish!: () => void;
  const queue = new SpeechQueue<string>({ async prepare(t) { return t; }, play: () => new Promise<void>(resolve => { finish = resolve; }), discard() {} });
  assert.equal(queue.busy, false);
  queue.enqueue('one');
  assert.equal(queue.busy, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(queue.busy, true, 'playing');
  finish();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(queue.busy, false);
});
