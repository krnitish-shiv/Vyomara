/**
 * The two assistants: Vyom (male) and Vyomara (female). They share the same
 * tools and safety rules; the persona sets the name, the grammatical gender
 * used in Hindi/Hinglish replies, and the speaking voice.
 */
export type PersonaId = 'vyom' | 'vyomara';

export interface Persona {
  readonly id: PersonaId;
  readonly name: string;
  readonly gender: 'male' | 'female';
  /** Hindi verb ending the assistant uses for itself ("kar raha hoon" / "kar rahi hoon"). */
  readonly selfVerb: 'raha' | 'rahi';
  /**
   * Spoken when the app opens on the welcome screen and when this assistant
   * is chosen, followed by the brand chime. Spelled for the voice (checked
   * with whisper): Aman reads "AI" correctly; Lekha needs "A I" and says the
   * name right only in Devanagari.
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
    greeting: greetingFor('Vyom', 'AI'),
  },
  vyomara: {
    id: 'vyomara',
    name: 'Vyomara',
    gender: 'female',
    selfVerb: 'rahi',
    greeting: greetingFor('व्योमारा', 'A I'),
  },
};

export const DEFAULT_PERSONA: PersonaId = 'vyom';

export function isPersonaId(value: unknown): value is PersonaId {
  return value === 'vyom' || value === 'vyomara';
}

export function personaFor(id: PersonaId | undefined): Persona {
  return PERSONAS[id ?? DEFAULT_PERSONA];
}
