import assert from 'node:assert/strict';
import test from 'node:test';
import { closestLinesHint, replaceText } from '../src/shared/text-replace.ts';

const CART = `export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

export function applyDiscount(total, percent) {
  return total - (total * percent) / 100;
}
`;

test('an exact match is replaced as before', () => {
  const result = replaceText(CART, 'item.price, 0', 'item.price * item.quantity, 0');
  assert.deepEqual(result.ok && { fuzzy: result.fuzzy, has: result.content.includes('item.quantity') }, { fuzzy: false, has: true });
});

test('a snippet with different indentation and trailing spaces still matches, keeping the file indentation', () => {
  const find = '    return items.reduce((sum, item) => sum + item.price, 0);   \n';
  const replace = '    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);\n';
  const result = replaceText(CART, find, replace);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.fuzzy, true);
  assert.match(result.content, /\n {2}return items\.reduce\(\(sum, item\) => sum \+ item\.price \* item\.quantity, 0\);\n/u);
});

test('multi-line snippets match line by line and Windows line endings are kept', () => {
  const crlf = CART.replace(/\n/gu, '\r\n');
  const find = 'export function applyDiscount(total, percent) {\n\treturn total - (total * percent) / 100;\n}';
  const result = replaceText(crlf, find, 'export function applyDiscount(total, percent) {\n\treturn Math.max(0, total - (total * percent) / 100);\n}');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.match(result.content, /Math\.max\(0,/u);
  assert.ok(result.content.includes('\r\n') && !/[^\r]\n/u.test(result.content));
});

test('ambiguous and missing snippets are refused, with the closest lines as a hint', () => {
  assert.deepEqual(replaceText('a\nx\na\n', 'a', 'b'), { ok: false, reason: 'ambiguous', count: 2 });
  const missing = replaceText(CART, 'function cartTotals(list) {', 'x');
  assert.equal(missing.ok, false);
  assert.match(!missing.ok ? missing.hint ?? '' : '', /1\| export function cartTotal\(items\) \{/u);
  assert.equal(closestLinesHint(CART, 'zzz qqq'), undefined);
});

test('replace_all applies to every whitespace-tolerant match', () => {
  const result = replaceText('  a = 1\n    a = 1\n', 'a = 1', 'a = 2', true);
  assert.equal(result.ok && result.content, '  a = 2\n    a = 2\n');
});
