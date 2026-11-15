import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { MacSpeechRunner } from '../src/desktop/mac-speech.ts';
import type { SpawnSpeechProcess, SpeechChild } from '../src/desktop/mac-speech.ts';

class FakeSpeechChild extends EventEmitter implements SpeechChild {
  kill(signal?: NodeJS.Signals): boolean {
    queueMicrotask(() => this.emit('close', null, signal ?? 'SIGTERM'));
    return true;
  }
}

test('local speech invokes only the fixed macOS voice binary with bounded text', async () => {
  const child = new FakeSpeechChild();
  let invocation: { executable: string; args: readonly string[] } | undefined;
  const spawnProcess: SpawnSpeechProcess = (executable, args) => {
    invocation = { executable, args };
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  const result = await new MacSpeechRunner(spawnProcess, 'darwin').speak('Hello from Vyom.');
  assert.deepEqual(invocation, {
    executable: '/usr/bin/say',
    // The name is respelled so the voice says "व्योम" (see textForVoice).
    args: ['-r', '180', '--', 'Hello from Vyo Om.'],
  });
  assert.deepEqual(result, { status: 'completed' });
});

test('local speech can be stopped and reports cancellation', async () => {
  const child = new FakeSpeechChild();
  const runner = new MacSpeechRunner(() => child, 'darwin');
  const pending = runner.speak('A spoken response.');
  assert.equal(runner.stop(), true);
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.equal(runner.stop(), false);
});

test('local speech rejects invalid input and a concurrent utterance', async () => {
  const child = new FakeSpeechChild();
  const runner = new MacSpeechRunner(() => child, 'darwin');
  await assert.rejects(runner.speak(''), /must contain/i);
  const pending = runner.speak('First utterance.');
  await assert.rejects(runner.speak('Second utterance.'), /already in progress/i);
  child.emit('close', 0, null);
  assert.deepEqual(await pending, { status: 'completed' });
});

test('local speech rejects unsupported platforms and oversized output without spawning', async () => {
  let spawnCount = 0;
  const runner = new MacSpeechRunner(() => {
    spawnCount += 1;
    return new FakeSpeechChild();
  }, 'linux');
  await assert.rejects(runner.speak('Hello'), /only on macOS/i);
  assert.equal(spawnCount, 0);

  const macRunner = new MacSpeechRunner(() => {
    spawnCount += 1;
    return new FakeSpeechChild();
  }, 'darwin');
  await assert.rejects(macRunner.speak('x'.repeat(2_001)), /1 to 2000 characters/i);
  assert.equal(spawnCount, 0);
});

test('stopping before speech starts cancels it', async () => {
  const { MacSpeechRunner } = await import('../src/desktop/mac-speech.ts');
  let spawned = 0;
  const runner = new MacSpeechRunner(() => { spawned += 1; throw new Error('should not spawn'); }, 'darwin');
  const pending = runner.speak('Hello there.');
  runner.stop();
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.equal(spawned, 0);
});

test('voice names with an added language are also known by their plain name', async () => {
  const { parseVoiceList } = await import('../src/desktop/mac-speech.ts');
  const names = parseVoiceList([
    'Lekha               hi_IN    # नमस्ते, मेरा नाम लेखा है।',
    'Tara (English (India)) en_IN    # Hello! My name is Tara.',
    'Lekha (Enhanced)    hi_IN    # नमस्ते',
    'Eddy (English (UK)) en_GB    # Hello! My name is Eddy.',
  ].join('\n'));
  assert.ok(names.has('Tara'));
  assert.ok(names.has('Tara (English (India))'));
  assert.ok(names.has('Lekha (Enhanced)'));
  assert.ok(names.has('Lekha'));
  assert.ok(names.has('Eddy'));
});

function naturalPort(synthesize: (text: string, gender: 'male' | 'female', signal: AbortSignal) => Promise<string>, ready = true) {
  return { ready, synthesize };
}

test('the natural voice plays its file with afplay, names in Devanagari', async () => {
  const calls: { executable: string; args: readonly string[] }[] = [];
  const spoken: string[] = [];
  const runner = new MacSpeechRunner((executable, args) => {
    calls.push({ executable, args });
    const child = new FakeSpeechChild();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  }, 'darwin', naturalPort(async (text, gender) => { spoken.push(`${gender}:${text}`); return '/tmp/vyomara-test-voice.wav'; }));
  assert.equal(runner.naturalVoiceReady, true);
  assert.deepEqual(await runner.speak('Hi, I am Vyom and Vyomara.', 'female'), { status: 'completed' });
  assert.deepEqual(spoken, ['female:Hi, I am व्योम and व्योमारा.']);
  assert.deepEqual(calls, [{ executable: '/usr/bin/afplay', args: ['/tmp/vyomara-test-voice.wav'] }]);
});

test('a failing natural voice falls back to the system voice; one that is not installed is not tried', async () => {
  const calls: string[] = [];
  const spawnProcess: SpawnSpeechProcess = executable => {
    calls.push(executable);
    const child = new FakeSpeechChild();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
  const failing = new MacSpeechRunner(spawnProcess, 'darwin', naturalPort(async () => { throw new Error('sidecar died'); }));
  assert.deepEqual(await failing.speak('Hello.'), { status: 'completed' });
  assert.deepEqual(calls, ['/usr/bin/say']);

  const synthesized: string[] = [];
  const missing = new MacSpeechRunner(spawnProcess, 'darwin', naturalPort(async text => { synthesized.push(text); return '/tmp/x.wav'; }, false));
  assert.equal(missing.naturalVoiceReady, false);
  await missing.speak('Hello.');
  assert.deepEqual(synthesized, []);
});

test('stopping while the natural voice is still synthesizing cancels the reply', async () => {
  let seenSignal: AbortSignal | undefined;
  const calls: string[] = [];
  const runner = new MacSpeechRunner(executable => { calls.push(executable); return new FakeSpeechChild(); }, 'darwin',
    naturalPort((_text, _gender, signal) => new Promise<string>((_resolve, reject) => {
      seenSignal = signal;
      signal.addEventListener('abort', () => reject(new Error('cancelled')));
    })));
  const pending = runner.speak('A long reply.');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.stop(), true);
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.equal(seenSignal?.aborted, true);
  assert.deepEqual(calls, []);
});
