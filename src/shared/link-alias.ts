/**
 * Small models garble long URLs when copying them (Google News links are
 * ~150 characters of base64). The model sees each long URL as a short alias
 * ("https://l.vyomara/3"); aliases are expanded back to the real URL in tool
 * arguments and in the final reply. Numbers are stable within one request.
 */
const ALIAS_PREFIX = 'https://l.vyomara/';
const LONG_URL = /https?:\/\/[^\s"'<>`\\)\]]{60,}/gu;
const ALIAS = /https:\/\/l\.vyomara\/(\d+)/gu;

export class LinkAliases {
  readonly #byUrl = new Map<string, string>();
  readonly #byAlias = new Map<string, string>();

  /** Replace long URLs in text with aliases. */
  shorten(text: string): string {
    return text.replace(LONG_URL, url => {
      let alias = this.#byUrl.get(url);
      if (!alias) {
        alias = `${ALIAS_PREFIX}${this.#byUrl.size + 1}`;
        this.#byUrl.set(url, alias);
        this.#byAlias.set(alias, url);
      }
      return alias;
    });
  }

  /** Put the real URLs back. Unknown aliases are left as they are (and fail link checks). */
  expand(text: string): string {
    return text.replace(ALIAS, alias => this.#byAlias.get(alias) ?? alias);
  }

  /** Expand aliases in every string of a tool call's arguments. */
  expandArguments(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') return this.expand(item);
      if (Array.isArray(item)) return item.map(walk);
      if (typeof item === 'object' && item !== null) {
        return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
      }
      return item;
    };
    return walk(value) as Record<string, unknown>;
  }
}
