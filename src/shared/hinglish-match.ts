/**
 * Matching words across the ways Hinglish gets written: Roman with any
 * spelling ("kitaab", "kitab"), Devanagari ("किताब"), and English. Every word
 * is reduced to a consonant skeleton ("ktb") shared by all three, so a memory
 * written one way is found by a request written another way. No model, no
 * network. Pure code.
 */

/** Devanagari letters → the Roman consonant they sound like (vowels and marks drop out). */
const DEVANAGARI: Readonly<Record<string, string>> = {
  'क': 'k', 'ख': 'k', 'ग': 'g', 'घ': 'g', 'ङ': 'n', 'च': 'c', 'छ': 'c', 'ज': 'j', 'झ': 'j', 'ञ': 'n',
  'ट': 't', 'ठ': 't', 'ड': 'd', 'ढ': 'd', 'ण': 'n', 'त': 't', 'थ': 't', 'द': 'd', 'ध': 'd', 'न': 'n',
  'प': 'p', 'फ': 'f', 'ब': 'b', 'भ': 'b', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 's',
  'ष': 's', 'स': 's', 'ह': 'h', 'क़': 'k', 'ख़': 'k', 'ग़': 'g', 'ज़': 'j', 'ड़': 'd', 'ढ़': 'd', 'फ़': 'f',
  'ळ': 'l', 'ऋ': 'r',
};

/** Spellings that sound the same in Roman Hinglish. Applied before vowels drop. */
const ROMAN_SOUNDS: readonly (readonly [RegExp, string])[] = [
  [/ph/gu, 'f'], [/kh/gu, 'k'], [/gh/gu, 'g'], [/ch/gu, 'c'], [/jh/gu, 'j'], [/th/gu, 't'], [/dh/gu, 'd'],
  [/bh/gu, 'b'], [/sh/gu, 's'], [/q/gu, 'k'], [/z/gu, 'j'], [/w/gu, 'v'], [/x/gu, 'ks'], [/ck/gu, 'k'],
  // A final "h" is usually a vowel ending ("yeh", "nahin"); "h" between vowels is kept.
  [/h\b/gu, ''],
];

/** Words too common to tell memories apart. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'my', 'me', 'i', 'it', 'this', 'that',
  'hai', 'hain', 'tha', 'thi', 'ka', 'ki', 'ke', 'ko', 'se', 'me', 'mein', 'aur', 'ya', 'bhi', 'to', 'toh', 'kya', 'mera', 'meri', 'mere',
  'main', 'hum', 'tum', 'aap', 'ye', 'yeh', 'wo', 'woh', 'karo', 'kar', 'do', 'please', 'batao',
  'है', 'हैं', 'का', 'की', 'के', 'को', 'से', 'में', 'और', 'भी', 'मेरा', 'मेरी', 'क्या',
]);

/** One word's consonant skeleton, the same for Roman and Devanagari spellings. */
export function skeleton(word: string): string {
  const lower = word.toLowerCase().normalize('NFC');
  if (/[ऀ-ॿ]/u.test(lower)) {
    return [...lower.normalize('NFD').normalize('NFC')].map(character => DEVANAGARI[character] ?? (/[a-z0-9]/u.test(character) ? character : '')).join('').replace(/(.)\1+/gu, '$1');
  }
  let roman = lower.normalize('NFD').replace(/\p{M}/gu, '');
  for (const [pattern, sound] of ROMAN_SOUNDS) roman = roman.replace(pattern, sound);
  return roman.replace(/[aeiouy]/gu, '').replace(/[^a-z0-9]/gu, '').replace(/(.)\1+/gu, '$1');
}

/** The distinct skeletons of a text's meaningful words. */
export function skeletons(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (word.length < 2 || STOPWORDS.has(word.toLowerCase())) continue;
    const key = skeleton(word);
    // Very short skeletons ("k", "n") match too much.
    if (key.length >= 2 || /^\d+$/u.test(word)) out.add(key || word);
  }
  return out;
}

/** How well `text` matches `query`: the share of the query's words found in the text (0–1). */
export function matchScore(query: string, text: string): number {
  const wanted = skeletons(query);
  if (wanted.size === 0) return 0;
  const have = skeletons(text);
  let found = 0;
  for (const key of wanted) if (have.has(key)) found += 1;
  return found / wanted.size;
}
