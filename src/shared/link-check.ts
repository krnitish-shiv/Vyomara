/**
 * Links in a reply must come from a source: a tool result or the user's own
 * message. Local models invent URLs ("watch?v=example_video_id") and garble
 * long ones while copying, so every link is checked against what the tools
 * actually returned; anything else is removed with a note. Search links are
 * allowed because they are built from words, not invented as facts.
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>`\\)\]]+/gu;

/** Links anyone can build from search words; they always lead somewhere real. */
const SEARCH_LINKS = [
  /^https:\/\/(?:www\.)?youtube\.com\/results\?search_query=/u,
  /^https:\/\/(?:www\.)?google\.com\/search\?q=/u,
  /^https:\/\/news\.google\.com\/search\?q=/u,
];

function clean(url: string): string {
  return url.replace(/&amp;/gu, '&').replace(/[.,;:!?]+$/u, '');
}

/** Every URL mentioned in these texts (tool results, user messages). */
export function urlsIn(texts: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(URL_PATTERN)) found.add(clean(match[0]));
  }
  return found;
}

function trusted(url: string, known: ReadonlySet<string>): boolean {
  const value = clean(url);
  return known.has(value) || SEARCH_LINKS.some(pattern => pattern.test(value));
}

export function verifyLinks(text: string, known: ReadonlySet<string>): { readonly text: string; readonly removed: number } {
  let removed = 0;
  // Markdown links first, so their URL is not also treated as a bare link.
  const withNamed = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu, (whole, label: string, url: string) => {
    if (trusted(url, known)) return whole;
    removed += 1;
    return `${label} _(link removed: not from a source)_`;
  });
  const result = withNamed.replace(/(^|[^(\w])(https?:\/\/[^\s)<>\]]+)/gu, (whole, before: string, url: string) => {
    if (trusted(url, known)) return whole;
    removed += 1;
    return `${before}_(link removed: not from a source)_`;
  });
  return { text: result, removed };
}
