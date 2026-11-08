/**
 * Turning speech-to-text output into intents: wake phrase, yes/no answers to
 * approval questions, and short spoken versions of replies. Pure functions so
 * the renderer, a future mini window, and tests share them. Whisper hears
 * "Vyomara" as "Viomera", "Viomora", "Vahya Amar", … so matching is fuzzy.
 */

const WAKE_NAMES = ['vyomara', 'vyom'];
const GREETINGS = new Set([
  'hello', 'hallo', 'helo', 'hey', 'hi', 'ok', 'okay', 'oye', 'arey', 'are', 'namaste', 'namaskar',
  'हेलो', 'हैलो', 'हलो', 'आलो', 'हल्लो', 'नमस्ते', 'नमस्ति', 'अरे', 'ओके', 'aalo', 'halo', 'allo',
]);

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0]!;
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j]!;
      previous[j] = Math.min(
        above + 1,
        previous[j - 1]! + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length]!;
}

/** Lower-case words without punctuation; "Viomera," → "viomera", "हाँ," → "हाँ". */
export function speechWords(transcript: string): string[] {
  return transcript
    .toLocaleLowerCase()
    .normalize('NFKD')
    // Drop Latin accents only; Devanagari vowel signs are marks and must stay.
    .replace(/[̀-ͯ]/gu, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{M}\p{N}\s']/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
}

const DEVANAGARI_CONSONANTS: Readonly<Record<string, string>> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ट': 't', 'ठ': 'th',
  'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n', 'प': 'p', 'फ': 'ph',
  'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
};
const DEVANAGARI_VOWELS: Readonly<Record<string, string>> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ii', 'उ': 'u', 'ऊ': 'uu', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o',
};
const DEVANAGARI_SIGNS: Readonly<Record<string, string>> = {
  'ा': 'aa', 'ि': 'i', 'ी': 'ii', 'ु': 'u', 'ू': 'uu', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o',
  'ं': 'n', 'ँ': 'n', '्': '', '़': '',
};

/** Rough Devanagari → Latin transliteration, enough to compare "व्योमारा" with "vyomara". */
export function romanize(text: string): string {
  const characters = [...text.normalize('NFD')];
  let output = '';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;
    const consonant = DEVANAGARI_CONSONANTS[character];
    if (consonant !== undefined) {
      let next = characters[index + 1];
      if (next === '़') next = characters[index + 2];
      // Inherent "a" unless a vowel sign or virama follows.
      output += consonant + (next !== undefined && next in DEVANAGARI_SIGNS && next !== 'ं' && next !== 'ँ' ? '' : 'a');
      continue;
    }
    output += DEVANAGARI_VOWELS[character] ?? DEVANAGARI_SIGNS[character] ?? character;
  }
  return output;
}

/**
 * Devanagari words in Roman letters an English voice can read aloud:
 * "ठीक है, खोल दिया" → "theek hai, khol diya". Latin text is left alone.
 */
export function romanForSpeech(text: string): string {
  // Words only: the danda (।, ॥) is punctuation and becomes a full stop below.
  return text.replace(/[\u0900-\u0963\u0966-\u097F]+/gu, word => {
    let roman = romanize(word)
      .replace(/ii/gu, 'ee')
      .replace(/uu/gu, 'oo');
    // Hindi drops the inherent "a" after a final consonant: खोल is "khol", not "khola".
    const last = word.at(-1) ?? '';
    if (/[\u0915-\u0939\u0958-\u095F]/u.test(last) && roman.length > 2 && roman.endsWith('a')) roman = roman.slice(0, -1);
    // A final long "aa" reads better as "a" to an English voice: "diya", "kya".
    return roman.replace(/aa$/u, 'a');
  }).replace(/[।॥]/gu, '.');
}

/** Map sounds whisper confuses (v/w/b, i/y, e/a/o, doubled letters) before comparing names. */
function soundKey(word: string): string {
  return romanize(word)
    .toLocaleLowerCase()
    .replace(/[wb]/gu, 'v')
    .replace(/y/gu, 'i')
    .replace(/[eou]/gu, 'a')
    .replace(/h/gu, '')
    .replace(/(.)\1+/gu, '$1');
}

/** Everyday words one sound away from "Vyom" that must not wake it. */
const NOT_NAMES = new Set(['bye', 'buy', 'boy', 'bay', 'via', 'way', 'why', 'view', 'bio', 'bow', 'wow', 'bhai', 'baa', 'bom']);

function soundsLikeName(candidate: string, joinedWords: boolean): boolean {
  if (candidate.length < 3 || NOT_NAMES.has(candidate)) return false;
  const key = soundKey(candidate);
  // The name starts with a v/w/b sound; this rejects "how are" → "howare".
  if (!key.startsWith('v')) return false;
  return WAKE_NAMES.some(name => {
    const target = soundKey(name);
    // Names split across words ("Vahya Amar") drift more than single words.
    const allowed = target.length >= 6 && joinedWords ? 3 : 1;
    return editDistance(key, target) <= allowed;
  });
}

export interface WakeMatch {
  /** The request after the wake phrase ("" when only the name was said). */
  readonly command: string;
}

/**
 * Detect "Hello Vyomara …", "Vyom, …", "hey Viomera …", "नमस्ते व्योमारा …" at
 * the start of a transcript. Joins up to three words, since "Vyomara" is
 * often split ("Vahya Amar").
 */
export function matchWakePhrase(transcript: string): WakeMatch | undefined {
  const words = speechWords(transcript);
  // The name may follow up to two greeting words, which whisper spells many
  // ways ("Hello", "हैलो", "आलो", "ok"). Other leading words are not skipped:
  // "what are" would otherwise sound like "Vyomara".
  for (let index = 0; index <= Math.min(2, words.length - 1); index += 1) {
    if (index > 0 && !GREETINGS.has(words[index - 1]!)) break;
    for (const span of [1, 2, 3]) {
      if (index + span > words.length) break;
      const candidate = words.slice(index, index + span).join('');
      if (candidate && soundsLikeName(candidate, span > 1)) {
        const rawWords = transcript.trim().split(/\s+/u);
        // Drop the greeting and name words from the original text.
        const command = rawWords.slice(index + span).join(' ').replace(/^[\s,.;:!?।-]+/u, '').trim();
        return { command };
      }
    }
  }
  return undefined;
}

export type YesNo = 'yes' | 'no' | 'unclear';

const NO_WORDS = new Set([
  'no', 'nope', 'nah', 'nahi', 'nahin', 'naheen', 'nai', 'nahee', 'naa', 'mat', 'cancel', 'stop', 'reject', 'ruko', 'ruk',
  'dont', "don't", 'never', 'wait',
  'नहीं', 'नही', 'नहीन', 'ना', 'मत', 'रुको', 'रुक', 'कैंसल', 'स्टॉप', 'रोको',
]);
const NO_PHRASES = [
  /\brehne\s*d[oue]\b/u, /\brehanedu\b/u, /\bmat\s+karo\b/u, /\bdo\s+not\b/u, /\bleave\s+it\b/u, /\bnot\s+now\b/u,
  /\blet\s+it\s+be\b/u, /\bstay\s+away\b/u, /रहने\s*द[ोू]/u, /मत\s+कर/u,
];
const YES_WORDS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'haan', 'han', 'haa', 'ha', 'hanji', 'ji', 'ok', 'okay', 'sure', 'theek', 'thik', 'thick',
  'approve', 'approved', 'apply', 'confirm', 'proceed', 'continue', 'chalao', 'karo', 'kardo', 'karde', 'cardo', 'kadoo',
  'kado', 'caro', 'bilkul', 'done', 'go',
  'हाँ', 'हां', 'हा', 'जी', 'ठीक', 'ओके', 'करो', 'करदो', 'कादू', 'कादो', 'अप्लाई', 'अपलाई', 'चलाओ', 'बिल्कुल',
]);

/** Classify a spoken answer to an approval question. Unclear means "ask again". */
export function classifyYesNo(transcript: string): YesNo {
  const text = speechWords(transcript).join(' ');
  const words = text.split(' ');
  // "mat karo", "rehne do": a refusal phrase wins even though it contains "karo"/"do".
  if (NO_PHRASES.some(phrase => phrase.test(text))) return 'no';
  const saysNo = words.some(word => NO_WORDS.has(word));
  const saysYes = words.some(word => YES_WORDS.has(word)) ||
    /\bkar\s*d[oei]\b|\bgo\s+ahead\b|\bdo\s+it\b|कर\s*द[ोे]/u.test(text);
  if (saysNo && !saysYes) return 'no';
  if (saysYes && !saysNo) return 'yes';
  return 'unclear';
}

/** Deleting by voice needs an explicit mention of deleting, not just "yes". */
export function confirmsDeletion(transcript: string): boolean {
  return classifyYesNo(transcript) === 'yes' &&
    /\b(?:delete|deleted|trash|hata|hatao|hatado|mita|mitao|remove)\b|डिलीट|हटा|मिटा/u.test(speechWords(transcript).join(' '));
}

/** A short version of a reply for text-to-speech: no code, footers, links, or Markdown. */
export function speechText(response: string, maxChars = 320): string {
  let text = response
    .replace(/\n*\s*-{3,}\s*\n+\s*\**Verified actions\**[\s\S]*$/iu, '')
    .replace(/\n*\s*-{3,}\s*\n+\s*⚠️[\s\S]*$/u, '')
    .replace(/```[\s\S]*?```/gu, ' (code shown on screen) ')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/https?:\/\/\S+/gu, 'a link')
    .replace(/^\s*#{1,6}\s*/gmu, '')
    .replace(/^\s*[-*•]\s+/gmu, '')
    .replace(/[*_>]/gu, '')
    .replace(/(?:~|\/Users\/[^/\s]+)(\/[\w.@-]+)+/gu, match => match.split('/').at(-1) ?? match)
    .replace(/\s+/gu, ' ')
    .trim();
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('। '));
    text = sentenceEnd > maxChars / 3 ? cut.slice(0, sentenceEnd + 1) : `${cut.trimEnd()}…`;
  }
  return text;
}

export type VoiceDecision =
  /** Not addressed to Vyom (no wake phrase, outside a conversation). */
  | { readonly type: 'ignore' }
  /** Only the wake phrase was said: acknowledge and listen for the request. */
  | { readonly type: 'greet' }
  | { readonly type: 'submit'; readonly text: string }
  /** A request arrived while another is running. */
  | { readonly type: 'queue'; readonly text: string }
  /** Answer to the pending approval question. */
  | { readonly type: 'answer'; readonly approve: boolean }
  /** The answer was unclear; ask the approval question again. */
  | { readonly type: 'reask' }
  /** "ruko"/"stop" while a task is running. */
  | { readonly type: 'cancel' }
  /** "bas", "bye": end the open conversation. */
  | { readonly type: 'end' };

/** Whole-utterance goodbyes that end an open conversation. */
const END_CONVERSATION = /^(?:(?:ok(?:ay)?|oke|theek\s+hai|chalo|achha)\s+)?(?:(?:bas|bass|bus|boss)(?:\s+karo)?|bye(?:\s+bye)?|good\s*bye|that'?s\s+all|band\s+karo|baad\s+mein\s+baat\s+karte(?:\s+hain)?|shukriya\s+bas)$|^(?:(?:ओके|ठीक\s+है)\s+)?(?:बस|बास|बाय|बंद\s+करो)$/u;

/** A goodbye, allowing one stray trailing word whisper sometimes adds ("okay bus so"). */
export function isGoodbye(transcript: string): boolean {
  const words = speechWords(transcript).join(' ');
  const list = words.split(' ');
  return END_CONVERSATION.test(words) || (list.length >= 2 && list.length <= 4 && END_CONVERSATION.test(list.slice(0, -1).join(' ')));
}

const STOP_COMMAND = /^(?:stop|ruko|ruk\s+jao|bas|cancel|band\s+karo|rok\s+do|wait)\b|^(?:रुको|रुक\s+जाओ|बस|रोको|बंद\s+करो|स्टॉप)/u;

/**
 * Decides what a heard phrase means. Requests need the wake phrase, except
 * within a short follow-up window after Vyom spoke or acted, so background
 * talk is ignored. While an approval question is open, every phrase is
 * treated as its answer.
 */
export class VoiceSession {
  readonly #followUpMs: number;
  readonly #now: () => number;
  #conversationUntil = 0;
  #approval: 'delete' | 'other' | undefined;
  #open = false;

  constructor(followUpMs = 30_000, now: () => number = Date.now) {
    this.#followUpMs = followUpMs;
    this.#now = now;
  }

  /** Keep listening without the wake phrase for a while (after Vyom speaks or acts). */
  extend(): void {
    this.#conversationUntil = this.#now() + this.#followUpMs;
  }

  end(): void {
    this.#conversationUntil = 0;
  }

  get inConversation(): boolean {
    return this.#open || this.#now() < this.#conversationUntil;
  }

  /**
   * An open conversation (the user pressed the orb): everything said is for
   * Vyom, no wake phrase needed, until it is closed.
   */
  setOpen(open: boolean): void {
    this.#open = open;
    if (!open) {
      this.#approval = undefined;
      this.#conversationUntil = 0;
    }
  }

  get open(): boolean {
    return this.#open;
  }

  awaitApproval(kind: 'delete' | 'other'): void {
    this.#approval = kind;
    this.extend();
  }

  clearApproval(): void {
    this.#approval = undefined;
  }

  get awaitingApproval(): boolean {
    return this.#approval !== undefined;
  }

  decide(transcript: string, requestPending: boolean): VoiceDecision {
    const text = transcript.trim();
    if (text === '') return { type: 'ignore' };
    const wake = matchWakePhrase(text);
    const request = wake ? wake.command : text;
    const words = speechWords(request).join(' ');

    if (this.#approval !== undefined) {
      this.extend();
      if (this.#approval === 'delete') {
        if (confirmsDeletion(request)) return { type: 'answer', approve: true };
        return classifyYesNo(request) === 'no' ? { type: 'answer', approve: false } : { type: 'reask' };
      }
      const answer = classifyYesNo(request);
      return answer === 'unclear' ? { type: 'reask' } : { type: 'answer', approve: answer === 'yes' };
    }

    if (!wake && !this.inConversation) return { type: 'ignore' };
    if (requestPending && STOP_COMMAND.test(words)) {
      this.extend();
      return { type: 'cancel' };
    }
    if (this.#open && !requestPending && isGoodbye(words)) return { type: 'end' };
    // While Vyom works, an open microphone hears the room; only "stop" (above)
    // or a request that names Vyom is taken.
    if (this.#open && requestPending && !wake) return { type: 'ignore' };
    // Without the wake phrase, a lone word is usually noise that whisper turned
    // into text ("झाल"); real follow-up requests have several words.
    if (!wake && words.split(' ').length < 2) return { type: 'ignore' };
    this.extend();
    if (wake && request === '') return { type: 'greet' };
    return requestPending ? { type: 'queue', text: request } : { type: 'submit', text: request };
  }
}

/** A short spoken question for an approval card. */
export function approvalQuestion(proposal:
  | { readonly kind: 'file'; readonly operation: string; readonly path: string }
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'application'; readonly application: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'web'; readonly operation: string; readonly host: string }
  | { readonly kind: 'app-control'; readonly action: string; readonly application: string }
  | { readonly kind: 'mcp'; readonly server: string; readonly tool: string },
): string {
  const name = (path: string): string => path.split('/').filter(Boolean).at(-1) ?? path;
  switch (proposal.kind) {
    case 'file':
      return proposal.operation === 'delete'
        ? `${name(proposal.path)} ko Trash mein bhejun? Pakka karne ke liye boliye: haan, delete karo.`
        : proposal.operation === 'create-directory'
          ? `Naya folder ${name(proposal.path)} banaun?`
          : `${name(proposal.path)} mein badlaav ready hai, screen par dekh lijiye. Apply karun?`;
    case 'command': {
      const command = proposal.command.length > 60 ? `${proposal.command.slice(0, 60)}…` : proposal.command;
      return `Ye command chalaun: ${command}?`;
    }
    case 'application':
      return `${proposal.application} kholun?`;
    case 'url':
      return `Ye web page kholun?`;
    case 'web':
      return proposal.operation === 'search' ? `${proposal.host} par search karun?` : `${proposal.host} ka page padhun?`;
    case 'mcp':
      return `${proposal.server} ka ${proposal.tool} tool chalaun?`;
    default:
      return `${proposal.application} ko ${proposal.action} karun?`;
  }
}

const HALLUCINATIONS = [
  /^thank(?:s| you)(?: (?:for watching|so much))?[.!]?$/iu,
  /^(?:please )?subscribe/iu,
  /^subtitles? by/iu,
  /^you$/iu,
  /^bye[.!]?$/iu,
  /^so[.!?]?$/iu,
  /^झाल[.!?]?$/u,
  /^(?:u+m+|u+h+|h+m+|a+h+)[.!?]?$/iu,
];

/**
 * Whisper invents text for silence or noise: one word repeated ("लड़ लड़ लड़"),
 * or stock phrases ("Thank you."). These are dropped before intent matching.
 */
export function isLikelyNoise(transcript: string): boolean {
  const text = transcript.trim();
  if (text === '') return true;
  if (HALLUCINATIONS.some(pattern => pattern.test(text))) return true;
  const words = speechWords(text);
  if (words.length === 0) return true;
  if (new Set(words).size !== 1 || words.length < 2) return false;
  // "haan haan" is a real answer; other doubled words ("झाल झाल") are noise.
  return words.length >= 3 || classifyYesNo(text) === 'unclear';
}

const UNDO_REQUESTS = [
  /^(?:please |plz )?(?:undo|revert)(?: (?:it|that|this|karo|kar do|kardo|kijiye|please|the|last|my|your|change|changes|edit|edits|pichla|pichle|aakhri|badlaav|badlav))*$/u,
  /^(?:(?:pichla|pichle|last|aakhri|abhi wala) )?(?:badlaav|badlav|badlao|change|changes|edit|edits) (?:wapas|vapas|undo|revert) (?:karo|kar do|kardo|le lo|lelo|kijiye)$/u,
  /^(?:wapas|vapas) (?:karo|kar do|kardo|le lo|lelo)$/u,
  /^(?:अनडू|रिवर्ट)(?: (?:करो|कर दो|कीजिए))?$/u,
  /^(?:(?:पिछला|पिछले|आखिरी) )?(?:बदलाव|चेंज|चेंजेस) (?:वापस|अनडू) (?:करो|कर दो|ले लो|कीजिए)$/u,
];

/**
 * "undo karo", "revert the last change", "badlaav wapas karo": the whole
 * message asks to undo the last request's file changes. Handled by the app
 * itself, not the model, so it always works the same way.
 */
export function isUndoRequest(text: string): boolean {
  const words = speechWords(text).join(' ');
  return words !== '' && UNDO_REQUESTS.some(pattern => pattern.test(words));
}
