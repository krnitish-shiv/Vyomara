import assert from 'node:assert/strict';
import test from 'node:test';
import { textForVoice } from '../src/desktop/mac-speech.ts';
import { PERSONAS } from '../src/shared/persona.ts';

test('each assistant introduces itself, spelled so its voice says it right', () => {
  // Checked with whisper: Aman reads "AI"; Lekha needs "A I" and the name in Devanagari.
  assert.equal(PERSONAS.vyom.greeting, "Hi, I'm Vyom, your personal AI assistant. Tell me what you need.");
  assert.equal(PERSONAS.vyomara.greeting, "Hi, I'm व्योमारा, your personal A I assistant. Tell me what you need.");
});

test('text is adapted to the voice that reads it', () => {
  assert.equal(textForVoice('Main Vyomara hoon.', 'female'), 'Main व्योमारा hoon.');
  // Vyom rhymes with Om: Aman says plain "Vyom" as "Vyam".
  assert.equal(textForVoice("Hi, I'm Vyom, your assistant.", 'male'), "Hi, I'm Vyo Om, your assistant.");
  assert.equal(textForVoice('Vyom aur Vyomara', 'female'), 'व्योम aur व्योमारा');
  assert.equal(textForVoice('Vyomara', 'male'), 'Vyomara');
  assert.equal(textForVoice('ठीक है, खोल दिया।', 'male'), 'theek hai, khol diya.');
});
