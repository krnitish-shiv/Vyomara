/** Convert an HTML page to readable plain text plus its links (no DOM; safe in Node and the renderer). */

export interface PageText {
  readonly title: string;
  readonly text: string;
  readonly links: readonly { readonly text: string; readonly url: string }[];
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', middot: '·',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', times: '×',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10FFFF ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10FFFF ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim();
}

export function htmlToText(html: string, baseUrl: string, maxLinks = 40): PageText {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html);
  const title = titleMatch ? stripTags(titleMatch[1] ?? '') : '';
  let body = html
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|head)\b[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1\s*>/giu, ' ');

  const links: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  body = body.replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/giu, (_match, _quote, href: string, inner: string) => {
    const text = stripTags(inner);
    if (links.length < maxLinks && text !== '') {
      try {
        const url = new URL(decodeEntities(href), baseUrl);
        if ((url.protocol === 'https:' || url.protocol === 'http:') && !seen.has(url.href)) {
          seen.add(url.href);
          links.push({ text: text.slice(0, 120), url: url.href });
        }
      } catch {
        // Ignore malformed links.
      }
    }
    return ` ${inner} `;
  });

  const text = decodeEntities(body
    .replace(/<(h[1-6])\b[^>]*>/giu, '\n\n## ')
    .replace(/<li\b[^>]*>/giu, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/giu, '\n')
    .replace(/<\/(p|div|section|article|header|h[1-6]|ul|ol|table|tr|pre|blockquote)>/giu, '\n')
    .replace(/<(td|th)\b[^>]*>/giu, ' | ')
    .replace(/<[^>]*>/gu, ' '))
    .replace(/[ \t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return { title, text, links };
}
