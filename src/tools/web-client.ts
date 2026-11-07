import { htmlToText } from '../shared/html-text.ts';
import { ToolFailure } from './contracts.ts';
import { isPrivateHost } from './action-tools.ts';
import type { WebClientPort, WebPage, WebSearchResult } from './action-tools.ts';

const USER_AGENT = 'Vyomara/1.0 (local personal assistant; +https://github.com/krnitish-shiv/Vyomara)';
const MAX_BYTES = 3_000_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;
const TEXT_TYPES = /^(?:text\/(?:html|plain|markdown|xml|csv)|application\/(?:xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))\b/iu;

export interface HttpWebClientOptions {
  /** Base URL of a SearXNG instance with the JSON format enabled; omit to disable search. */
  readonly searxngUrl?: string;
  readonly fetchImplementation?: typeof fetch;
}

async function readLimited(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new ToolFailure('The download was cancelled.', 'tool-failed');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/** Fetches public pages for the agent; never sends cookies or credentials, and refuses private hosts. */
export class HttpWebClient implements WebClientPort {
  readonly #searxng: URL | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: HttpWebClientOptions = {}) {
    this.#searxng = options.searxngUrl ? new URL(options.searxngUrl) : undefined;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  get searchHost(): string | undefined {
    return this.#searxng?.hostname;
  }

  async #get(url: URL, signal: AbortSignal, allowPrivate: boolean, accept: string): Promise<{ readonly response: Response; readonly url: URL }> {
    let current = url;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const combined = AbortSignal.any([signal, timeout]);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (current.protocol !== 'https:' && current.protocol !== 'http:') {
        throw new ToolFailure('The page redirected to a non-web address.', 'tool-failed');
      }
      if (!allowPrivate && isPrivateHost(current.hostname)) {
        throw new ToolFailure('The page redirected to a local or private network address, which is not allowed.', 'permission-denied');
      }
      let response: Response;
      try {
        response = await this.#fetch(current, {
          method: 'GET',
          redirect: 'manual',
          credentials: 'omit',
          signal: combined,
          headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en,hi;q=0.8' },
        });
      } catch {
        if (signal.aborted) throw new ToolFailure('The download was cancelled.', 'tool-failed');
        if (timeout.aborted) throw new ToolFailure(`The site did not respond within ${TIMEOUT_MS / 1000}s.`, 'tool-failed');
        throw new ToolFailure(`Could not connect to ${current.hostname}.`, 'tool-failed');
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw new ToolFailure('The page redirected without a destination.', 'tool-failed');
        current = new URL(location, current);
        continue;
      }
      return { response, url: current };
    }
    throw new ToolFailure('The page redirected too many times.', 'tool-failed');
  }

  async fetchPage(url: string, signal: AbortSignal): Promise<WebPage> {
    const { response, url: finalUrl } = await this.#get(new URL(url), signal, false, 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5');
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ToolFailure(`${finalUrl.hostname} answered HTTP ${response.status}.`, response.status === 404 ? 'not-found' : 'tool-failed');
    }
    const type = response.headers.get('content-type') ?? 'text/html';
    if (!TEXT_TYPES.test(type)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ToolFailure(`The address is not a readable text page (${type.split(';')[0]}).`, 'unsupported-operation');
    }
    const body = await readLimited(response, signal);
    if (/html|xml/iu.test(type)) {
      const page = htmlToText(body, finalUrl.href);
      return { url: finalUrl.href, ...page };
    }
    return { url: finalUrl.href, title: '', text: body.trim(), links: [] };
  }

  /** Raw text of a public feed or API response (RSS, Atom, JSON); same safety rules as fetchPage. */
  async fetchRaw(url: string, signal: AbortSignal): Promise<string> {
    const { response, url: finalUrl } = await this.#get(new URL(url), signal, false, 'application/rss+xml,application/atom+xml,application/json,application/xml,text/xml;q=0.9,*/*;q=0.5');
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ToolFailure(`${finalUrl.hostname} answered HTTP ${response.status}.`, 'tool-failed');
    }
    return readLimited(response, signal);
  }

  async search(query: string, signal: AbortSignal): Promise<readonly WebSearchResult[]> {
    if (!this.#searxng) throw new ToolFailure('Web search is not configured.', 'unsupported-operation');
    const url = new URL('search', this.#searxng.href.endsWith('/') ? this.#searxng : `${this.#searxng.href}/`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    // The configured SearXNG instance is usually local, so private hosts are allowed here.
    const { response } = await this.#get(url, signal, true, 'application/json');
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ToolFailure(
        response.status === 403
          ? 'The SearXNG instance refused JSON results; enable "json" under search.formats in its settings.yml.'
          : `The search service answered HTTP ${response.status}.`,
        'tool-failed',
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readLimited(response, signal));
    } catch {
      throw new ToolFailure('The search service returned invalid data.', 'tool-failed');
    }
    const results = typeof payload === 'object' && payload !== null && Array.isArray((payload as { results?: unknown }).results)
      ? (payload as { results: unknown[] }).results
      : [];
    return results.flatMap(item => {
      if (typeof item !== 'object' || item === null) return [];
      const { title, url: link, content } = item as Record<string, unknown>;
      if (typeof title !== 'string' || typeof link !== 'string' || !/^https?:\/\//u.test(link)) return [];
      return [{ title: title.slice(0, 200), url: link, snippet: typeof content === 'string' ? content.slice(0, 400) : '' }];
    }).slice(0, 10);
  }
}
