import assert from 'node:assert/strict';
import test from 'node:test';
import { urlsIn, verifyLinks } from '../src/shared/link-check.ts';

const TOOL_RESULT = JSON.stringify({ results: [{ url: 'https://news.google.com/rss/articles/CBMiXEFVX3lxTE53WjRpT3VBUmlpUGlaYnp?oc=5' }, { url: 'https://en.wikipedia.org/wiki/Khesari_Lal_Yadav' }] });

test('links from tool results and search links stay; invented or garbled links are removed', () => {
  const known = urlsIn([TOOL_RESULT]);
  const reply = [
    '1. [Real article](https://news.google.com/rss/articles/CBMiXEFVX3lxTE53WjRpT3VBUmlpUGlaYnp?oc=5)',
    '2. [Garbled](https://news.google.com/rss/articles/CBMiXEFVX3lxTE53WjRpT3VBUmlpUGzaYnp?oc=5)',
    '3. [Invented](https://www.youtube.com/watch?v=example_video_id)',
    '4. [Search it](https://www.youtube.com/results?search_query=Jarela+Jethani+Sujit+Sagar)',
    '5. See https://en.wikipedia.org/wiki/Khesari_Lal_Yadav.',
    '6. Bare made-up https://example.com/song',
  ].join('\n');
  const { text, removed } = verifyLinks(reply, known);
  assert.equal(removed, 3);
  assert.match(text, /\[Real article\]\(https:\/\/news\.google\.com/u);
  assert.match(text, /Garbled _\(link removed: not from a source\)_/u);
  assert.match(text, /Invented _\(link removed: not from a source\)_/u);
  assert.match(text, /\[Search it\]\(https:\/\/www\.youtube\.com\/results/u);
  assert.match(text, /See https:\/\/en\.wikipedia\.org\/wiki\/Khesari_Lal_Yadav\./u);
  assert.match(text, /Bare made-up _\(link removed: not from a source\)_/u);
});

test('a reply without links is unchanged', () => {
  assert.deepEqual(verifyLinks('No links here.', new Set()), { text: 'No links here.', removed: 0 });
});
