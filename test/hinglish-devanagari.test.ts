import assert from 'node:assert/strict';
import test from 'node:test';
import { hinglishForVoice } from '../src/shared/hinglish-devanagari.ts';

test('Roman Hinglish is written in Devanagari for the voice, English words stay', () => {
  assert.equal(hinglishForVoice('Haan ji, Google Chrome khol diya hai. Aur kuch karna hai?'), 'हाँ जी, Google Chrome खोल दिया है। और कुछ करना है?'.replace('।', '.'));
  assert.equal(hinglishForVoice('Theek hai, main tests chala raha hoon.'), 'ठीक है, मैं tests चला रहा हूँ.');
  assert.equal(hinglishForVoice('Khoj ko de rahi hoon.'), 'खोज को दे रही हूँ.');
});

test('plain English is left alone, including words that are also Hinglish', () => {
  assert.equal(hinglishForVoice('The tests pass. What do you want to do next?'), 'The tests pass. What do you want to do next?');
  assert.equal(hinglishForVoice('Open the shop project in VS Code.'), 'Open the shop project in VS Code.');
});

test('Devanagari and names pass through untouched', () => {
  assert.equal(hinglishForVoice('हाँ, कर दिया।'), 'हाँ, कर दिया।');
  assert.equal(hinglishForVoice('Vyomara ready hai'), 'Vyomara ready है');
});
