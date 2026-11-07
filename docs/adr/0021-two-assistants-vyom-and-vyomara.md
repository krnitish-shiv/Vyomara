# ADR-0021: Two assistants: Vyom (male) and Vyomara (female)

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The spoken voice was chosen from the script of each reply:

- Devanagari was read by Lekha (female, Hindi);
- Latin text was read by Rishi (male, Indian English).

Replies switch script often, so the voice changed between male and female
mid-conversation. The owner has always planned two assistants: Vyom (male)
and Vyomara (female), chosen in the app.

## Decision

1. **Persona.** `src/shared/persona.ts` defines `vyom` (male) and `vyomara`
   (female).
   - Main stores the choice in `assistant.json`; Vyom is the default.
   - The choice applies to the next request and the next spoken reply.
   - It cannot be switched while a task runs.
2. **Prompt.** The system prompt names the assistant. It asks for the
   matching Hindi self-forms ("main kar raha/rahi hoon").
   - For Vyom's spoken replies it also asks for Roman letters, because his
     voice is English.
3. **One voice per assistant** (`voiceFor`). Premium or Enhanced versions are
   preferred when installed; the voice list is re-read every 2 minutes.
   - **Vyomara:** Lekha for all text (the owner's choice). "Vyomara" is
     written व्योमारा before speaking, since Lekha mispronounces the Latin
     spelling.
   - **Vyom:** Aman (the owner's choice), then Rishi.
   - **Names are respelled before speaking** (`textForVoice`), checked with
     whisper. Vyom is pronounced "व्योम" (rhymes with Om). Aman says plain
     "Vyom" as "Vyam", so he is given "Vyo Om". Lekha is given both names in
     Devanagari. Any Devanagari left in a reply is changed to
     Roman letters (`romanForSpeech`) before speaking.
   - The speaking rate is lowered from 190 to 180 words per minute.
   - When the app opens on the welcome screen, and when the assistant is
     switched, the assistant introduces itself in its own voice ("Hi, I'm
     Vyomara, your personal AI assistant. Tell me what you need."), followed
     by the three-note brand chime.
     - "AI" is spelled per voice: Aman reads "AI" correctly, while Lekha
       needs "A I" (checked with whisper).
     - Pressing the orb stops the greeting, even in the instant before it
       starts.
   - Voice names are matched by their plain name too, because newer macOS
     lists some voices as "Tara (English (India))".
4. **Interface.**
   - The Assistant tab at the top of the sidebar shows the current
     assistant. Tapping it opens a small menu to switch, and the new
     assistant greets in its own voice.
   - Names in the window and in the mini window follow the choice.

## Consequences

- The voice no longer changes gender within a conversation.
- Vyom's Hindi is read by an English voice, so it is understandable but
  accented. A local neural voice (for example Kokoro, which has male and
  female Hindi voices) is the planned next step for natural Hinglish.
