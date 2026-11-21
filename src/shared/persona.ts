/**
 * The twins. Vyom (male) and Vyomara (female) are the only assistants the
 * user talks to; specialists work behind them as an inner team they delegate
 * to (src/agent/team.ts, ADR-0029). The persona sets the name, the
 * grammatical gender used in Hindi/Hinglish replies, and the speaking voice.
 */
export type PersonaId = 'vyom' | 'vyomara';

export interface Persona {
  readonly id: PersonaId;
  readonly name: string;
  readonly gender: 'male' | 'female';
  /** Hindi verb ending the assistant uses for itself ("kar raha hoon" / "kar rahi hoon"). */
  readonly selfVerb: 'raha' | 'rahi';
  /** Short role label shown under the name in the assistant picker. */
  readonly role: string;
  /**
   * Spoken when the app opens on the welcome screen and when this assistant
   * is chosen, followed by the brand chime. Spelled for the voice (checked
   * with whisper): Aman reads "AI" correctly; Lekha needs "A I" and says the
   * names right only in Devanagari.
   */
  readonly greeting: string;
}

function greetingFor(spokenName: string, ai: string): string {
  return `Hi, I'm ${spokenName}, your personal ${ai} assistant. Tell me what you need.`;
}

export const PERSONAS: Readonly<Record<PersonaId, Persona>> = {
  vyom: {
    id: 'vyom',
    name: 'Vyom',
    gender: 'male',
    selfVerb: 'raha',
    role: 'Twin',
    greeting: greetingFor('Vyom', 'AI'),
  },
  vyomara: {
    id: 'vyomara',
    name: 'Vyomara',
    gender: 'female',
    selfVerb: 'rahi',
    role: 'Twin',
    greeting: greetingFor('व्योमारा', 'A I'),
  },
};

export const DEFAULT_PERSONA: PersonaId = 'vyom';

export function isPersonaId(value: unknown): value is PersonaId {
  return typeof value === 'string' && Object.hasOwn(PERSONAS, value);
}

export function personaFor(id: PersonaId | undefined): Persona {
  return PERSONAS[id ?? DEFAULT_PERSONA];
}
