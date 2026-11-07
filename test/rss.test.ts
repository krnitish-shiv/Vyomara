import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeXmlText, parseFeed } from '../src/shared/rss.ts';

const GOOGLE_NEWS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Top stories</title>
<item><title>India wins the series 3-1 - The Hindu</title><link>https://news.google.com/rss/articles/abc?oc=5</link>
<pubDate>Sat, 07 Nov 2026 09:30:00 GMT</pubDate><source url="https://www.thehindu.com">The Hindu</source></item>
<item><title><![CDATA[Markets rise &amp; rupee steadies]]></title><link>https://example.com/markets</link></item>
<item><title>No link here</title></item>
</channel></rss>`;

test('RSS items give title, publisher, time, and link', () => {
  assert.deepEqual(parseFeed(GOOGLE_NEWS), [
    { title: 'India wins the series 3-1', url: 'https://news.google.com/rss/articles/abc?oc=5', source: 'The Hindu', published: '2026-11-07T09:30:00.000Z' },
    { title: 'Markets rise & rupee steadies', url: 'https://example.com/markets' },
  ]);
});

test('Atom entries and entities are read too', () => {
  const atom = `<feed><entry><title>Release 2.0 &#8211; notes</title><link href="https://blog.example.com/2.0"/><updated>2026-11-06T10:00:00Z</updated></entry></feed>`;
  assert.deepEqual(parseFeed(atom), [{ title: 'Release 2.0 – notes', url: 'https://blog.example.com/2.0', published: '2026-11-06T10:00:00.000Z' }]);
  assert.equal(decodeXmlText('<b>Hi</b> &lt;3 &#x1F600;'), 'Hi <3 😀');
});

test('the item count is limited', () => {
  const many = `<rss>${Array.from({ length: 30 }, (_, index) => `<item><title>Story ${index}</title><link>https://x.test/${index}</link></item>`).join('')}</rss>`;
  assert.equal(parseFeed(many, 5).length, 5);
});
