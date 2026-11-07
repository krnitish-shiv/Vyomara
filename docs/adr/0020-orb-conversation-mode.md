# ADR-0020: Orb conversation mode and turn-taking

- **Status:** Accepted
- **Date:** 2026-11-06
- **Updates:** ADR-0018 (wake phrase and follow-up window)

## Context

ADR-0018 made hands-free requests start with "Hello Vyomara …" and sent each
phrase as soon as 0.65 s of silence ended it. In use, the owner wants pressing
the orb to feel like talking with a person:

- no wake phrase after pressing the orb;
- a request spoken with pauses must arrive as one request;
- the reply must appear on screen and be spoken;
- Vyom must keep listening for the next turn.

Typed and dictated requests stay silent (unchanged).

## Decision

1. **Pressing the orb (or ⌥Space) opens a conversation.**
   - `VoiceSession.setOpen(true)`: no wake phrase is needed.
   - Listening never resumes when the app starts, because an open
     conversation hears everything in the room.
2. **Turn-taking.** `TurnCollector` (`src/shared/turn-taking.ts`):
   - collects the phrases of one turn in speaking order;
   - ends the turn after 1 s of extra quiet once a phrase ends (about 1.65 s
     in total) and every phrase has been transcribed;
   - new speech before then continues the same turn.
3. **Live feel.**
   - Soft tones mark: listening started, request taken, conversation ended.
     The microphone ignores them.
   - The orb and the mini window show listening, hearing, thinking and
     speaking.
   - In the main window the message box itself shows the voice state: its
     border glows (cyan listening, violet speaking, red recording), its
     placeholder says what Vyom is doing, and the words of the turn appear in
     it as they are heard. There are no separate status lines under the orb
     or the box. Record and Send sit in a vertical rail inside the box.
   - Pressing the orb while Vyom speaks interrupts it and listens again.
4. **Noise safety.**
   - While a task runs, only "ruko/stop" or a request that names Vyom is
     taken; other speech is ignored instead of queued.
   - Doubled single words ("झाल झाल") count as noise, except answers such
     as "haan haan".
5. **Ending.**
   - "bas" ends the conversation, including whisper's spellings "bass",
     "bus" and "boss", with or without "okay" and one stray trailing word.
     "bye", "band karo" and "that's all" also end it.
   - Pressing the orb ends it.
   - It ends by itself after two quiet minutes.

## Consequences

- End of speech to request sent is about 1.3–1.7 s. That is slower than
  before, but sentences with pauses are no longer cut.
- The wake phrase still works and still matters while a task runs.
- "bye" no longer wakes Vyom; it used to match "Vyom" by sound.
