/**
 * Reads RSS 2.0 and Atom feeds (news sites publish these for readers and
 * apps). Pure string parsing: no network, no external XML library.
 */
export interface FeedItem {
  readonly title: string;
  readonly url: string;
  /** Publisher, e.g. "The Hindu" (from <source>, or a " - Publisher" title suffix). */
  readonly source?: string;
  /** ISO time when the feed gives one. */
  readonly published?: string;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeXmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/giu, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/\s+/gu, ' ')
    .trim();
}

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'iu').exec(block);
  return match?.[1] === undefined ? undefined : decodeXmlText(match[1]);
}

function isoTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}

export function parseFeed(xml: string, limit = 20): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/giu) ?? [];
  for (const block of blocks) {
    let title = tag(block, 'title') ?? '';
    const atomLink = /<link[^>]*href="([^"]+)"/iu.exec(block)?.[1];
    const url = (tag(block, 'link') || (atomLink ? decodeXmlText(atomLink) : '')).trim();
    if (!title || !/^https?:\/\//iu.test(url)) continue;
    let source = tag(block, 'source');
    // Google News titles end with " - Publisher"; keep the publisher separately.
    const suffix = / [-–] ([^-–]{2,60})$/u.exec(title);
    const googleNews = /^https?:\/\/news\.google\.com\//iu.test(url);
    if (suffix?.[1] && (source === suffix[1] || (googleNews && !source))) {
      source = source ?? suffix[1];
      title = title.slice(0, suffix.index);
    }
    const published = isoTime(tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated'));
    items.push({
      title: title.slice(0, 300),
      url,
      ...(source ? { source: source.slice(0, 100) } : {}),
      ...(published ? { published } : {}),
    });
    if (items.length >= limit) break;
  }
  return items;
}
