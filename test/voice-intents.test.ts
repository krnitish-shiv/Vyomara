import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyYesNo, confirmsDeletion, isGoodbye, isLikelyNoise, matchWakePhrase, romanForSpeech, speechText, VoiceSession } from '../src/shared/voice-intents.ts';

// Real whisper (base, --language en) transcripts of macOS-synthesized speech.
test('wake phrase matches the ways whisper hears "Vyomara"', () => {
  assert.deepEqual(matchWakePhrase('Hello Viomera, Open My Viomera Project in Versus Code.'), {
    command: 'Open My Viomera Project in Versus Code.',
  });
  assert.deepEqual(matchWakePhrase('Hello Viomora, Kathka Budfix Kero or Test Challio.'), {
    command: 'Kathka Budfix Kero or Test Challio.',
  });
  assert.deepEqual(matchWakePhrase('Hello Vahya Amar, Kathka Budfix Kero'), { command: 'Kathka Budfix Kero' });
  assert.deepEqual(matchWakePhrase('Vyom, open Chrome'), { command: 'open Chrome' });
  assert.deepEqual(matchWakePhrase('hey biomara'), { command: '' });
  assert.equal(matchWakePhrase('Open my project in VS Code'), undefined);
  assert.equal(matchWakePhrase('Hello everyone, welcome to the meeting'), undefined);
  assert.equal(matchWakePhrase('How are you'), undefined);
  assert.equal(matchWakePhrase('Hello Vimeo'), undefined);
});

test('spoken answers to approvals are classified, and unclear answers are not guessed', () => {
  for (const yes of ['Yeah, apply Karo.', 'haan', 'Han ji, kar do', 'ok go ahead', 'Theek hai', 'yes push it']) {
    assert.equal(classifyYesNo(yes), 'yes', yes);
  }
  for (const no of ['Nahin, Rehanedu.', 'nahi', 'no', 'mat karo', 'ruko', 'cancel that', 'rehne do']) {
    assert.equal(classifyYesNo(no), 'no', no);
  }
  for (const unclear of ['what did you change?', 'haan nahi', 'hmm', '']) {
    assert.equal(classifyYesNo(unclear), 'unclear', unclear);
  }
});

test('deleting by voice needs the word delete (or hatao/trash) with a yes', () => {
  assert.equal(confirmsDeletion('haan delete karo'), true);
  assert.equal(confirmsDeletion('yes, move it to trash'), true);
  assert.equal(confirmsDeletion('haan'), false);
  assert.equal(confirmsDeletion('nahi delete mat karo'), false);
});

test('speechText keeps replies short and speakable', () => {
  const reply = [
    'Fixed `cartTotal` in `/Users/me/Projects/shop/src/cart.js`. See [docs](https://example.com).',
    '```js\nreturn x;\n```',
    'All tests pass.',
    '',
    '---',
    '**Verified actions**',
    '- ✅ Edited `x`',
  ].join('\n');
  assert.equal(speechText(reply), 'Fixed cartTotal in cart.js. See docs. (code shown on screen) All tests pass.');
  assert.ok(speechText('A sentence. '.repeat(100)).length <= 320);
});

test('voice session: wake phrase, follow-up window, queueing, cancel, and spoken approvals', async () => {
  const { VoiceSession } = await import('../src/shared/voice-intents.ts');
  let now = 0;
  const session = new VoiceSession(30_000, () => now);

  assert.deepEqual(session.decide('so what are we doing for lunch', false), { type: 'ignore' });
  assert.deepEqual(session.decide('Hello Viomera', false), { type: 'greet' });
  assert.deepEqual(session.decide('VS Code kholo', false), { type: 'submit', text: 'VS Code kholo' });
  now += 31_000;
  assert.deepEqual(session.decide('aur Chrome bhi', false), { type: 'ignore' }, 'follow-up window expired');
  assert.deepEqual(session.decide('Vyom, maximize karo', true), { type: 'queue', text: 'maximize karo' });
  assert.deepEqual(session.decide('ruko', true), { type: 'cancel' });
  // Noise heard in the follow-up window (real case: static transcribed as "झाल").
  assert.deepEqual(session.decide('झाल', false), { type: 'ignore' });
  assert.deepEqual(session.decide('Chrome bhi kholo', false), { type: 'submit', text: 'Chrome bhi kholo' });

  session.awaitApproval('other');
  assert.deepEqual(session.decide('hmm what changed', false), { type: 'reask' });
  assert.deepEqual(session.decide('Yeah, apply Karo.', false), { type: 'answer', approve: true });
  session.clearApproval();

  session.awaitApproval('delete');
  assert.deepEqual(session.decide('haan', false), { type: 'reask' }, 'deleting needs the word delete');
  assert.deepEqual(session.decide('haan delete karo', false), { type: 'answer', approve: true });
  session.clearApproval();
  session.awaitApproval('delete');
  assert.deepEqual(session.decide('nahi', false), { type: 'answer', approve: false });
});

test('approval questions are short and speakable', async () => {
  const { approvalQuestion } = await import('../src/shared/voice-intents.ts');
  assert.equal(approvalQuestion({ kind: 'file', operation: 'edit-file', path: '/a/src/cart.js' }), 'cart.js mein badlaav ready hai, screen par dekh lijiye. Apply karun?');
  assert.equal(approvalQuestion({ kind: 'command', command: 'git push origin dev' }), 'Ye command chalaun: git push origin dev?');
  assert.match(approvalQuestion({ kind: 'file', operation: 'delete', path: '/a/old.txt' }), /haan, delete karo/);
});

// Real whisper large-v3-turbo (--language hi) transcripts of Hindi and Hinglish speech.
test('Devanagari transcripts: wake phrase, yes/no, delete confirmation, and stop', async () => {
  const { classifyYesNo, confirmsDeletion, matchWakePhrase, romanize, VoiceSession } = await import('../src/shared/voice-intents.ts');
  assert.equal(romanize('व्योमारा'), 'vyomaaraa');
  assert.deepEqual(matchWakePhrase('नमस्ति वियोमारा, मेरा प्रोजेक्ट वियेस कोड में खोलो.'), { command: 'मेरा प्रोजेक्ट वियेस कोड में खोलो.' });
  assert.deepEqual(matchWakePhrase('व्योम, क्रोम खोलो'), { command: 'क्रोम खोलो' });
  assert.equal(matchWakePhrase('कार्ट का बढ़ फिक्स करो और टेस्ट चला के वेरिफाइ करो.'), undefined);
  for (const yes of ['हाँ, कर दो', 'हाँ, अपलाई कादू?', 'Huh, apply cardo.', 'Yes, let\'s do it.']) assert.equal(classifyYesNo(yes), 'yes', yes);
  for (const no of ['नहीं, रहने दो.', 'नहीन, रहने दू?', 'No, let it be.', 'मत करो']) assert.equal(classifyYesNo(no), 'no', no);
  assert.equal(confirmsDeletion('हाँ, डिलीट कर दो'), true);
  assert.equal(confirmsDeletion('हाँ'), false);
  const session = new VoiceSession();
  session.extend();
  assert.deepEqual(session.decide('रुको', true), { type: 'cancel' });
});

test('each assistant keeps one voice, preferring Enhanced versions', async () => {
  const { voiceFor } = await import('../src/desktop/mac-speech.ts');
  const installed = new Set(['Lekha', 'Tara', 'Rishi', 'Aman', 'Samantha']);
  // The owner's choice: Aman for Vyom, Lekha for Vyomara.
  assert.equal(await voiceFor('female', installed), 'Lekha');
  assert.equal(await voiceFor('male', installed), 'Aman');
  assert.equal(await voiceFor('male', new Set(['Rishi'])), 'Rishi');
  assert.equal(await voiceFor('female', new Set(['Lekha', 'Lekha (Enhanced)'])), 'Lekha (Enhanced)');
  assert.equal(await voiceFor('male', new Set(['Samantha'])), undefined);
});

// Heard through the real microphone in the app: macOS saying "Hello Vyomara", and room noise.
test('real-microphone transcripts: Devanagari greeting before the name, and noise hallucinations', () => {
  assert.deepEqual(matchWakePhrase('आलो वायोमरा'), { command: '' });
  assert.deepEqual(matchWakePhrase('आलो वायोमरा, कैलकुलेटर खोलो'), { command: 'कैलकुलेटर खोलो' });
  assert.deepEqual(matchWakePhrase('ok Vyom open Chrome'), { command: 'open Chrome' });
  assert.equal(matchWakePhrase('so what are we doing for lunch'), undefined);
  assert.equal(matchWakePhrase('yesterday we visited the museum'), undefined);
  assert.equal(matchWakePhrase('लड़ लड़ लड़ लड़'), undefined);
  assert.equal(isLikelyNoise('लड़ लड़ लड़ लड़'), true);
  assert.equal(isLikelyNoise('Thank you.'), true);
  assert.equal(isLikelyNoise('हाँ, कर दो'), false);
  assert.equal(isLikelyNoise('Hello Vyomara, open Chrome'), false);
});

test('an open conversation needs no wake phrase and ends on a goodbye', () => {
  const session = new VoiceSession(30_000, () => 0);
  assert.deepEqual(session.decide('VS Code kholo', false), { type: 'ignore' });
  session.setOpen(true);
  assert.deepEqual(session.decide('VS Code kholo', false), { type: 'submit', text: 'VS Code kholo' });
  assert.deepEqual(session.decide('Okay, bas.', false), { type: 'end' });
  assert.deepEqual(session.decide('बस', false), { type: 'end' });
  // Heard through the real microphone for "okay bas".
  assert.deepEqual(session.decide('Okay, bass.', false), { type: 'end' });
  assert.deepEqual(session.decide('Okay, bus. so', false), { type: 'end' });
  // "bas" inside a request is not a goodbye, and a goodbye does not end a running task.
  assert.deepEqual(session.decide('bas ek file aur bana do', false), { type: 'submit', text: 'bas ek file aur bana do' });
  assert.deepEqual(session.decide('bye', true), { type: 'ignore' });
  // While a task runs, room talk is not queued; "ruko" and a named request still work.
  assert.deepEqual(session.decide('aur ek kaam karo', true), { type: 'ignore' });
  assert.deepEqual(session.decide('ruko', true), { type: 'cancel' });
  assert.deepEqual(session.decide('Vyom, Chrome bhi kholo', true), { type: 'queue', text: 'Chrome bhi kholo' });
  session.setOpen(false);
  assert.deepEqual(session.decide('Chrome kholo', false), { type: 'ignore' });
});

test('everyday words that sound like Vyom do not wake it', () => {
  for (const phrase of ['bye', 'okay bye', 'why', 'boy']) assert.equal(matchWakePhrase(phrase), undefined, phrase);
  assert.deepEqual(matchWakePhrase('Vyom, Chrome kholo'), { command: 'Chrome kholo' });
});

test('doubled noise words are dropped but doubled answers are kept', () => {
  assert.equal(isLikelyNoise('झाल झाल'), true);
  assert.equal(isLikelyNoise('um'), true);
  assert.equal(isLikelyNoise('Hmm.'), true);
  assert.equal(isLikelyNoise('haan haan'), false);
  assert.equal(isLikelyNoise('nahi nahi'), false);
});

test('goodbyes are recognised in the spellings whisper uses', () => {
  for (const phrase of ['bas', 'Okay, boss.', 'Oke, bas.', 'Okay, bus.', 'theek hai bas karo', 'बस']) assert.equal(isGoodbye(phrase), true, phrase);
  for (const phrase of ['bas ek file aur bana do', 'bus stand kahan hai', 'Chrome kholo']) assert.equal(isGoodbye(phrase), false, phrase);
});

test('Devanagari is read in Roman letters by the male voice', () => {
  assert.equal(romanForSpeech('ठीक है, VS Code खोल दिया। अब क्या करूँ?'), 'theek hai, VS Code khol diya. ab kya karoon?');
  assert.equal(romanForSpeech('Apply karun?'), 'Apply karun?');
});

test('undo requests are recognised in English, Hinglish and Hindi', async () => {
  const { isUndoRequest } = await import('../src/shared/voice-intents.ts');
  for (const text of ['undo', 'Undo karo', 'undo kar do.', 'revert the last change', 'Please undo that', 'badlaav wapas karo', 'pichla change wapas kar do', 'अनडू करो', 'बदलाव वापस करो']) {
    assert.equal(isUndoRequest(text), true, text);
  }
  for (const text of ['undo the rename in cart.js and add tests', 'how do I undo a git commit?', 'wapas aao', 'Chrome kholo']) {
    assert.equal(isUndoRequest(text), false, text);
  }
});
