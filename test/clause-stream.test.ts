import assert from 'node:assert/strict';
import test from 'node:test';
import { ClauseStream, speakableClause } from '../src/shared/clause-stream.ts';

function streamAll(chunks: readonly string[], options?: ConstructorParameters<typeof ClauseStream>[0]): string[] {
  const stream = new ClauseStream(options);
  const out: string[] = [];
  for (const chunk of chunks) out.push(...stream.push(chunk));
  out.push(...stream.end());
  return out;
}

test('the first sentence is ready before the reply is complete', () => {
  const stream = new ClauseStream();
  assert.deepEqual(stream.push('Haan, main dekh '), []);
  assert.deepEqual(stream.push('raha hoon. Shop project'), ['Haan, main dekh raha hoon.']);
  assert.deepEqual(stream.push(' mil gaya'), []);
  assert.deepEqual(stream.end(), ['Shop project mil gaya']);
});

test('token-by-token streaming gives the same clauses as one chunk', () => {
  const reply = 'Tests pass ho gaye! Maine `cartTotal` theek kiya hai. Aur kuch?';
  const whole = streamAll([reply]);
  const tokens = streamAll(reply.match(/.{1,3}/gsu) ?? []);
  assert.deepEqual(tokens, whole);
  assert.deepEqual(whole, ['Tests pass ho gaye!', 'Maine cartTotal theek kiya hai.', 'Aur kuch?']);
});

test('long sentences break at a comma after a few words, short ones do not', () => {
  assert.deepEqual(streamAll(['Haan, ho gaya.']), ['Haan, ho gaya.']);
  assert.deepEqual(
    streamAll(['Maine teen files padhi aur bug mil gaya, ab main test chala raha hoon.']),
    ['Maine teen files padhi aur bug mil gaya,', 'ab main test chala raha hoon.'],
  );
});

test('Hindi sentence ends (।) split clauses', () => {
  assert.deepEqual(streamAll(['हाँ, कर दिया। अब क्या करूँ?']), ['हाँ, कर दिया।', 'अब क्या करूँ?']);
});

test('the app footer is never spoken, even when it arrives in pieces', () => {
  const out = streamAll(['Bug fix ho gaya.\n', '\n--', '-\n**Verified actions**\n- ✅ Edited cart.js']);
  assert.deepEqual(out, ['Bug fix ho gaya.']);
  assert.deepEqual(streamAll(['Done.\n\n⚠️ The model could not access files.']), ['Done.']);
});

test('code blocks become one short note, and markdown is read as words', () => {
  const out = streamAll(['Ye raha fix:\n```js\nconst a = 1;\n```\nAur ye dusra:\n```\nb()\n```\n## Result\n- **Sab** theek hai']);
  assert.deepEqual(out, ['Ye raha fix:', 'Code screen par dikha diya hai.', 'Aur ye dusra:', 'Result', 'Sab theek hai']);
  assert.equal(speakableClause('Dekho [docs](https://x.y) aur ~/Projects/shop/src/cart.js'), 'Dekho docs aur cart.js');
});

test('long replies stop with a pointer to the screen', () => {
  const out = streamAll(['Pehla point bahut lamba hai. Doosra point bhi lamba hai. Teesra point.'], { maxChars: 40 });
  assert.deepEqual(out, ['Pehla point bahut lamba hai.', 'Baaki screen par hai.']);
});

test('punctuation-only pieces are skipped', () => {
  assert.deepEqual(streamAll(['...\n\n- \n**OK.**']), ['OK.']);
});
