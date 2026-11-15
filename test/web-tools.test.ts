import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config/config.ts';
import { createLogger } from '../src/diagnostics/logger.ts';
import { decodeEntities, htmlToText } from '../src/shared/html-text.ts';
import { ApprovalMemory, isPrivateHost } from '../src/tools/action-tools.ts';
import type { ActionProposal, ApprovalDecision } from '../src/tools/action-tools.ts';
import { createDefaultToolRegistry } from '../src/tools/default-tools.ts';
import { ToolExecutionError, ToolExecutor } from '../src/tools/executor.ts';
import { PolicyGateway } from '../src/tools/policy.ts';
import { HttpWebClient } from '../src/tools/web-client.ts';

type Route = (url: URL) => Response;

function fakeFetch(routes: Record<string, Route>, requested: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requested.push(url.href);
    const route = routes[`${url.origin}${url.pathname}`];
    if (!route) return new Response('missing', { status: 404 });
    return route(url);
  }) as typeof fetch;
}

const html = (body: string): Response => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

function webExecutor(
  client: HttpWebClient,
  answers: ApprovalDecision[] = [true, true, true, true],
  asked: ActionProposal[] = [],
  memory = new ApprovalMemory(),
) {
  const config = loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_ALLOWED_ROOTS: '[]' });
  return new ToolExecutor({
    registry: createDefaultToolRegistry(config, {
      actions: {
        approval: { async request(action) { asked.push(action); return answers.shift() ?? false; } },
        approvalMemory: memory,
        web: client,
      },
    }),
    policy: new PolicyGateway({ allowedEffects: ['network'] }),
    config,
    logger: createLogger(() => {}),
  });
}

test('htmlToText keeps readable text, headings, lists, and absolute links; drops scripts and styles', () => {
  const page = htmlToText(`<!doctype html><html><head><title>Docs &amp; Guides</title><style>p{}</style></head>
    <body><nav><a href="/home">Home</a></nav><script>alert(1)</script>
    <h1>Install</h1><p>Run <code>pnpm add x</code>&nbsp;now.</p>
    <ul><li>One</li><li>Two &#8212; more</li></ul>
    <a href="/guide?a=1&amp;b=2">Read the guide</a> <a href="javascript:evil()">bad</a></body></html>`, 'https://example.com/docs/');
  assert.equal(page.title, 'Docs & Guides');
  assert.match(page.text, /## Install/);
  assert.match(page.text, /Run pnpm add x now\./);
  assert.match(page.text, /- One\n- Two — more/);
  assert.doesNotMatch(page.text, /alert|p\{\}|Home/);
  assert.deepEqual(page.links, [{ text: 'Read the guide', url: 'https://example.com/guide?a=1&b=2' }]);
  assert.equal(decodeEntities('&lt;a&gt; &#x41; &unknown;'), '<a> A &unknown;');
});

test('private and loopback hosts are recognised', () => {
  for (const host of ['localhost', 'api.localhost', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.169.254', '::1', '[::1]', 'fd00::1', 'printer.local']) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['example.com', '8.8.8.8', '172.32.0.1', 'react.dev']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('fetch_url reads a page after approval and pages through long text', async () => {
  const long = `<title>Long</title><p>${'word '.repeat(10_000)}</p><a href="https://example.com/next">Next</a>`;
  const client = new HttpWebClient({ fetchImplementation: fakeFetch({ 'https://example.com/long': () => html(long) }) });
  const asked: ActionProposal[] = [];
  const executor = webExecutor(client, [true, true], asked);
  const first = await executor.execute('fetch_url', { url: 'https://example.com/long' }, new AbortController().signal) as {
    status: string; title: string; content: string; truncated: boolean; nextOffset: number; links: unknown[];
  };
  assert.equal(first.status, 'fetched');
  assert.equal(first.title, 'Long');
  assert.equal(first.truncated, true);
  assert.equal(first.links.length, 1);
  const second = await executor.execute('fetch_url', { url: 'https://example.com/long', offset: first.nextOffset }, new AbortController().signal) as {
    content: string; links?: unknown;
  };
  assert.ok(second.content.length > 0);
  assert.equal(second.links, undefined);
  assert.deepEqual(asked[0], { kind: 'web', operation: 'fetch', target: 'https://example.com/long', host: 'example.com' });
});

test('fetch_url refuses private addresses, including through redirects, and non-text content', async () => {
  const requested: string[] = [];
  const client = new HttpWebClient({
    fetchImplementation: fakeFetch({
      'https://example.com/redirect': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:11434/api/tags' } }),
      'https://example.com/file.zip': () => new Response('PK', { headers: { 'content-type': 'application/zip' } }),
    }, requested),
  });
  const executor = webExecutor(client);
  await assert.rejects(
    executor.execute('fetch_url', { url: 'http://localhost:11434/' }, new AbortController().signal),
    (error: unknown) => error instanceof ToolExecutionError && error.code === 'invalid-input',
  );
  await assert.rejects(
    executor.execute('fetch_url', { url: 'https://example.com/redirect' }, new AbortController().signal),
    /local or private network/,
  );
  await assert.rejects(
    executor.execute('fetch_url', { url: 'https://example.com/file.zip' }, new AbortController().signal),
    /not a readable text page/,
  );
  assert.ok(!requested.some(url => url.includes('127.0.0.1')), 'the private redirect target is never requested');
});

test('rejected fetches download nothing; "always" skips later prompts for that host only', async () => {
  const requested: string[] = [];
  const client = new HttpWebClient({
    fetchImplementation: fakeFetch({
      'https://a.example/x': () => html('<p>a</p>'),
      'https://b.example/y': () => html('<p>b</p>'),
    }, requested),
  });
  const asked: ActionProposal[] = [];
  const executor = webExecutor(client, [false, 'always', true], asked);
  const signal = new AbortController().signal;
  assert.equal((await executor.execute('fetch_url', { url: 'https://a.example/x' }, signal) as { status: string }).status, 'rejected');
  assert.deepEqual(requested, []);
  await executor.execute('fetch_url', { url: 'https://a.example/x' }, signal);
  await executor.execute('fetch_url', { url: 'https://a.example/x?again' }, signal);
  await executor.execute('fetch_url', { url: 'https://b.example/y' }, signal);
  assert.equal(asked.length, 3, 'a.example is asked twice (reject, always), b.example once');
});

const NEWS_RSS = `<rss><channel>
<item><title>Chandrayaan update - ISRO</title><link>https://news.google.com/rss/articles/1</link><pubDate>Sat, 07 Nov 2026 08:00:00 GMT</pubDate><source url="https://isro.gov.in">ISRO</source></item>
<item><title>Rupee closes higher - Mint</title><link>https://news.google.com/rss/articles/2</link></item>
</channel></rss>`;
const rss = (body: string): Response => new Response(body, { headers: { 'content-type': 'application/rss+xml' } });

test('without SearXNG, web_search uses DuckDuckGo: results parsed, wrapped links unwrapped, ads dropped', async () => {
  const requested: string[] = [];
  const page = `<div class="result results_links web-result"><div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://reactnative.dev/versions">Versions - <b>React</b> Native</a></h2>
    <a class="result__snippet" href="https://reactnative.dev/versions">Ahead of each <b>stable</b>
      release, release candidates.</a></div></div>
    <div class="result__body"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2Freact-native&amp;rut=abc">react-native - npm</a>
    <a class="result__snippet">Latest version: 0.86.2</a></div>
    <div class="result__body"><a class="result__a" href="https://duckduckgo.com/y.js?ad_provider=bing&amp;u3=x">Sponsored</a></div>`;
  const client = new HttpWebClient({ fetchImplementation: fakeFetch({ 'https://html.duckduckgo.com/html/': () => html(page) }, requested) });
  const asked: ActionProposal[] = [];
  const result = await webExecutor(client, [true], asked).execute('web_search', { query: 'react native' }, new AbortController().signal);
  assert.deepEqual(result, {
    status: 'searched',
    query: 'react native',
    results: [
      { title: 'Versions - React Native', url: 'https://reactnative.dev/versions', snippet: 'Ahead of each stable release, release candidates.' },
      { title: 'react-native - npm', url: 'https://www.npmjs.com/package/react-native', snippet: 'Latest version: 0.86.2' },
    ],
  });
  assert.deepEqual(asked, [{ kind: 'web', operation: 'search', target: 'react native', host: 'html.duckduckgo.com' }]);
  assert.deepEqual(requested, ['https://html.duckduckgo.com/html/']);
});

test('when DuckDuckGo is unavailable, web_search falls back to Wikipedia and Google News after their own approval', async () => {
  const requested: string[] = [];
  const client = new HttpWebClient({
    fetchImplementation: fakeFetch({
      'https://html.duckduckgo.com/html/': () => new Response('<p>anomaly: bots</p>', { status: 202, headers: { 'content-type': 'text/html' } }),
      'https://en.wikipedia.org/w/api.php': () => new Response(JSON.stringify({ query: { search: [{ title: 'Chandrayaan-3', snippet: 'Indian <span>lunar</span> mission' }] } }), { headers: { 'content-type': 'application/json' } }),
      'https://news.google.com/rss/search': () => rss(NEWS_RSS),
    }, requested),
  });
  const asked: ActionProposal[] = [];
  const result = await webExecutor(client, [true, true], asked).execute('web_search', { query: 'chandrayaan' }, new AbortController().signal) as { results: { title: string; url: string }[]; note?: string };
  assert.deepEqual(result.results.map(item => item.title), ['Chandrayaan-3 (Wikipedia)', 'Chandrayaan update (ISRO)', 'Rupee closes higher (Mint)']);
  assert.equal(result.results[0]?.url, 'https://en.wikipedia.org/wiki/Chandrayaan-3');
  assert.match(result.note ?? '', /html\.duckduckgo\.com was unavailable \(DuckDuckGo asked for a bot check/);
  assert.deepEqual(asked, [
    { kind: 'web', operation: 'search', target: 'chandrayaan', host: 'html.duckduckgo.com' },
    { kind: 'web', operation: 'search', target: 'chandrayaan', host: 'wikipedia.org + news.google.com' },
  ]);
  assert.ok(requested.some(url => url.includes('srsearch=chandrayaan')));

  // Refusing the fallback hosts sends the query nowhere else.
  const refused: ActionProposal[] = [];
  await assert.rejects(
    webExecutor(client, [true, false], refused).execute('web_search', { query: 'chandrayaan' }, new AbortController().signal),
    (error: unknown) => error instanceof ToolExecutionError,
  );
  assert.equal(refused.length, 2);
});

test('news_headlines returns publisher, time, and link from Google News', async () => {
  const requested: string[] = [];
  const client = new HttpWebClient({ fetchImplementation: fakeFetch({ 'https://news.google.com/rss': () => rss(NEWS_RSS), 'https://news.google.com/rss/search': () => rss(NEWS_RSS) }, requested) });
  const asked: ActionProposal[] = [];
  const executor = webExecutor(client, [true, true], asked);
  const top = await executor.execute('news_headlines', {}, new AbortController().signal) as { headlines: unknown[] };
  assert.deepEqual(top.headlines[0], { title: 'Chandrayaan update', url: 'https://news.google.com/rss/articles/1', source: 'ISRO', published: '2026-11-07T08:00:00.000Z' });
  await executor.execute('news_headlines', { topic: 'cricket', language: 'hi', count: 1 }, new AbortController().signal);
  assert.match(requested[1] ?? '', /rss\/search\?q=cricket&hl=hi/u);
  assert.equal(asked[0]?.kind === 'web' && asked[0].host, 'news.google.com');
});

test('SearXNG search returns cleaned results', async () => {

  const requested: string[] = [];
  const client = new HttpWebClient({
    searxngUrl: 'http://127.0.0.1:8888',
    fetchImplementation: fakeFetch({
      'http://127.0.0.1:8888/search': url => new Response(JSON.stringify({
        query: url.searchParams.get('q'),
        results: [
          { title: 'React Native', url: 'https://reactnative.dev/', content: 'Learn once, write anywhere.' },
          { title: 'Bad', url: 'javascript:alert(1)' },
        ],
      }), { headers: { 'content-type': 'application/json' } }),
    }, requested),
  });
  const asked: ActionProposal[] = [];
  const result = await webExecutor(client, [true], asked).execute('web_search', { query: 'react native' }, new AbortController().signal);
  assert.deepEqual(result, {
    status: 'searched',
    query: 'react native',
    results: [{ title: 'React Native', url: 'https://reactnative.dev/', snippet: 'Learn once, write anywhere.' }],
  });
  assert.deepEqual(asked, [{ kind: 'web', operation: 'search', target: 'react native', host: '127.0.0.1' }]);
  assert.match(requested[0] ?? '', /format=json/);
});

test('VYOM_SEARXNG_URL is validated', () => {
  assert.equal(loadConfig({ VYOM_SEARXNG_URL: 'http://localhost:8888' }).searxngUrl, 'http://localhost:8888/');
  assert.equal(loadConfig({}).searxngUrl, undefined);
  assert.throws(() => loadConfig({ VYOM_SEARXNG_URL: 'ftp://x' }), /VYOM_SEARXNG_URL/);
  assert.throws(() => loadConfig({ VYOM_SEARXNG_URL: 'https://user:pw@x.dev' }), /VYOM_SEARXNG_URL/);
});

test('the browser tool drives a browser port: one Chrome grant covers browsing, numbered links come back', async () => {
  const config = loadConfig({ VYOM_PROVIDER: 'placeholder', VYOM_ALLOWED_ROOTS: '[]' });
  const performed: unknown[] = [];
  const page = { url: 'https://www.google.com/search?q=best+laptop', title: 'best laptop - Google Search', text: 'Result one ... Result two', links: [{ n: 1, text: 'Laptop review', url: 'https://example.com/review' }], results: [{ title: 'Laptop review', url: 'https://example.com/review', snippet: 'Top picks' }], scroll: 0, height: 2000, viewport: 1000 };
  const asked: ActionProposal[] = [];
  const memory = new ApprovalMemory();
  const answers: ApprovalDecision[] = ['always'];
  const executor = new ToolExecutor({
    registry: createDefaultToolRegistry(config, {
      actions: {
        approval: { async request(action) { asked.push(action); return answers.shift() ?? false; } },
        approvalMemory: memory,
        browser: { async perform(action) { performed.push(action); return page; } },
      },
    }),
    policy: new PolicyGateway({ allowedEffects: ['network'] }),
    config,
    logger: createLogger(() => {}),
  });
  const searched = await executor.execute('browser', { action: 'search', query: 'best laptop' }, new AbortController().signal) as Record<string, unknown>;
  assert.equal(searched.status, 'done');
  assert.deepEqual(searched.results, page.results);
  assert.equal(searched.scrolledTo, '50% of the page');
  assert.deepEqual(asked, [{ kind: 'url', url: 'https://www.google.com/search?q=best%20laptop', application: 'Google Chrome' }]);
  // "Always allow" granted Chrome: clicking and scrolling do not ask again.
  await executor.execute('browser', { action: 'click', link: 1 }, new AbortController().signal);
  await executor.execute('browser', { action: 'scroll', direction: 'down' }, new AbortController().signal);
  assert.equal(asked.length, 1);
  // Typing into a numbered input, finding text, and tabs go through the same port.
  await executor.execute('browser', { action: 'type', field: 2, text: 'react native', submit: true }, new AbortController().signal);
  await executor.execute('browser', { action: 'find', text: 'price' }, new AbortController().signal);
  await executor.execute('browser', { action: 'switch', tab: 3 }, new AbortController().signal);
  assert.deepEqual(performed, [
    { kind: 'search', query: 'best laptop' }, { kind: 'click', link: 1 }, { kind: 'scroll', direction: 'down' },
    { kind: 'type', field: 2, text: 'react native', submit: true }, { kind: 'find', text: 'price' }, { kind: 'switch', tab: 3 },
  ]);
  assert.equal(asked.length, 1);
  await assert.rejects(executor.execute('browser', { action: 'type', text: 'x' }, new AbortController().signal), /type needs field/u);
  await assert.rejects(executor.execute('browser', { action: 'open', url: 'http://192.168.1.1/' }, new AbortController().signal), /private network/u);
});

test('ChromeBrowser lists the window tabs and reports an input that is gone', async () => {
  const { ChromeBrowser } = await import('../src/desktop/chrome-browser.ts');
  const chrome = new ChromeBrowser(async (lines, args) => {
    if (lines.some(line => line.includes('active tab index of front window as string'))) return '2\n1\tDocs\thttps://docs.example/\n2\tnpm\thttps://www.npmjs.com/\n';
    if (args[0]?.includes('data-vyom-input="')) return 'missing';
    return JSON.stringify({ url: 'https://www.npmjs.com/', title: 'npm', text: 'Search packages', links: [], inputs: [{ n: 1, type: 'search', label: 'Search packages' }] });
  });
  const page = await chrome.perform({ kind: 'tabs' }, new AbortController().signal);
  assert.deepEqual(page.tabs, [
    { n: 1, title: 'Docs', url: 'https://docs.example/', active: false },
    { n: 2, title: 'npm', url: 'https://www.npmjs.com/', active: true },
  ]);
  assert.deepEqual(page.inputs, [{ n: 1, type: 'search', label: 'Search packages' }]);
  await assert.rejects(chrome.perform({ kind: 'type', field: 3, text: 'x', submit: false }, new AbortController().signal), /Input 3 is not on the page/u);
});
