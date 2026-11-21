import assert from 'node:assert/strict';
import test from 'node:test';
import { matchScore, skeleton, skeletons } from '../src/shared/hinglish-match.ts';

test('Roman spellings and Devanagari share one skeleton', () => {
  assert.equal(skeleton('kitab'), skeleton('kitaab'));
  assert.equal(skeleton('kitab'), skeleton('किताब'));
  assert.equal(skeleton('dukaan'), skeleton('dukan'));
  assert.equal(skeleton('dukan'), skeleton('दुकान'));
  assert.equal(skeleton('bhai'), skeleton('भाई'));
  assert.equal(skeleton('phone'), skeleton('फोन'));
  assert.equal(skeleton('shaadi'), skeleton('shadi'));
  assert.equal(skeleton('shaadi'), skeleton('शादी'));
  assert.notEqual(skeleton('shop'), skeleton('cart'));
});

test('common words are ignored', () => {
  assert.deepEqual([...skeletons('mera shop project hai')].sort(), [skeleton('shop'), skeleton('project')].sort());
});

test('a request finds the memory written a different way', () => {
  const memory = 'User ki dukaan ka project ~/Projects/shop mein hai';
  assert.ok(matchScore('दुकान वाला project kholo', memory) >= 0.5);
  assert.ok(matchScore('dukan wala project kholo', memory) >= 0.5);
  assert.equal(matchScore('weather in Delhi', memory), 0);
  assert.equal(matchScore('', memory), 0);
});
