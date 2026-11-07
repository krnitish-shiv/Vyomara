import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeWav, PhraseDetector } from '../src/shared/phrase-detector.ts';
import { cleanTranscript, hasUnexpectedScript } from '../src/desktop/whisper-server.ts';
import { parseDesktopChatRequest } from '../src/desktop/validation.ts';

const RATE = 16_000;
const FRAME = 1_024;

function tone(ms: number, amplitude: number): Float32Array {
  const samples = new Float32Array(Math.round(ms / 1000 * RATE));
  for (let index = 0; index < samples.length; index += 1) samples[index] = amplitude * Math.sin(index / 6);
  return samples;
}

function feed(detector: PhraseDetector, audio: Float32Array) {
  const events = [];
  for (let offset = 0; offset + FRAME <= audio.length; offset += FRAME) {
    const event = detector.push(audio.slice(offset, offset + FRAME));
    if (event) events.push({ ...event, at: Math.round((offset + FRAME) / RATE * 1000) });
  }
  return events;
}

function concat(...parts: Float32Array[]): Float32Array {
  const result = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

test('a phrase ends about 0.65 s after the speaker stops, with pre-roll kept', () => {
  const detector = new PhraseDetector();
  const events = feed(detector, concat(tone(1_000, 0.001), tone(1_500, 0.2), tone(1_500, 0.001)));
  assert.deepEqual(events.map(event => event.type), ['speech-start', 'phrase']);
  const phrase = events[1];
  assert.ok(phrase && phrase.type === 'phrase');
  // Speech ended at 2.5 s; the phrase is ready within ~0.75 s.
  assert.ok(phrase.at - 2_500 <= 800, `ended after ${phrase.at - 2_500} ms`);
  // ~1.5 s of speech + pre-roll + trailing silence.
  assert.ok(phrase.samples.length / RATE > 1.8 && phrase.samples.length / RATE < 2.6);
});

test('background noise and short clicks are not phrases; long speech is cut at the maximum', () => {
  const quiet = new PhraseDetector();
  assert.deepEqual(feed(quiet, tone(3_000, 0.004)).map(event => event.type), []);

  const click = new PhraseDetector({ minSpeechMs: 250 });
  assert.deepEqual(feed(click, concat(tone(500, 0.001), tone(140, 0.3), tone(1_200, 0.001))).map(event => event.type), ['speech-start', 'discard']);

  const long = new PhraseDetector({ maxPhraseMs: 3_000 });
  const events = feed(long, concat(tone(600, 0.001), tone(5_000, 0.2)));
  assert.equal(events.filter(event => event.type === 'phrase').length, 1);
});

test('the detector adapts to a noisier room', () => {
  const detector = new PhraseDetector();
  // Steady fan noise at 0.02 must not trigger; speech well above it does.
  const events = feed(detector, concat(tone(3_000, 0.02), tone(1_200, 0.25), tone(1_200, 0.02)));
  assert.deepEqual(events.map(event => event.type), ['speech-start', 'phrase']);
});

test('flush returns the phrase in progress when the user taps stop mid-sentence', () => {
  const detector = new PhraseDetector();
  feed(detector, concat(tone(1_000, 0.001), tone(800, 0.2)));
  const samples = detector.flush();
  assert.ok(samples && samples.length / RATE > 0.7);
  assert.equal(detector.flush(), undefined, 'nothing left after flushing');
});

test('WAV encoding is 16-bit mono PCM with a valid header', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 0.5]));
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
  assert.equal(view.getInt16(46, true), 0x7fff);
  assert.equal(view.getInt16(48, true), -0x8000);
});

test('transcripts drop whisper markers, and chat requests accept the voice flag', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] Hello  Vyomara (music)\n'), 'Hello Vyomara');
  const id = '0b6f3c1e-2b1a-4c3d-9e8f-1a2b3c4d5e6f';
  assert.deepEqual(parseDesktopChatRequest({ prompt: 'hi', requestId: id, voice: true }, 100), { prompt: 'hi', requestId: id, voice: true });
  assert.throws(() => parseDesktopChatRequest({ prompt: 'hi', requestId: id, voice: 'yes' }, 100));
});

test('transcripts in an unexpected script trigger the Hindi fallback', () => {
  // Real whisper outputs for short Hindi phrases with auto-detect.
  assert.equal(hasUnexpectedScript('ہاں کر دو'), true);
  assert.equal(hasUnexpectedScript('נהין רחנדו'), true);
  assert.equal(hasUnexpectedScript('हाँ, कर दो'), false);
  assert.equal(hasUnexpectedScript('Open the shop project in VS Code.'), false);
  assert.equal(hasUnexpectedScript('Commit karo — “done”!'), false);
});
