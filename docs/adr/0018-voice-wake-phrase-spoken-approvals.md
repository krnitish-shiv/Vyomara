# ADR-0018: Wake phrase, spoken approvals, and multilingual speech

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

The owner wants to run Vyom by voice while working in other apps. They speak
Hindi, English, or a mix of the two. A check of the existing voice pipeline
found three problems.

1. **No wake phrase.** With listening on, every phrase the microphone heard
   was submitted as a command, including background talk. The README promised
   a wake phrase that did not exist.
2. **Wrong language detection.** whisper `--language auto` with the base model
   detected short Hinglish phrases as Arabic, Hebrew, or Urdu script. For
   example "haan, apply karo" became `اپلاکاتو`. That is unusable for approvals.
3. **No voice approvals.** Approving an edit or command meant clicking.

We compared models on synthesized Hindi, English, and Hinglish clips (macOS
voices Lekha and Rishi):

| Model, language setting | Result |
|---|---|
| base, `en` | Readable romanized Hinglish, but Hindi is translated into English. |
| base, `auto` or `hi` | Unusable. |
| small | Weaker than turbo, and repeated one sentence. |
| large-v3-turbo (q5_0), `hi` | Hindi in Devanagari, English stays English, and every yes/no was correct. |

## Decision

1. **Two speech models.**

   | Option | Model | Size | Language setting |
   |---|---|---|---|
   | **Fast** | base | 148 MB | `en` |
   | **Best** | large-v3-turbo q5_0 | 574 MB | `hi` |

   - Each model's language setting is fixed to the setting that works for
     it.
   - Both models are SHA-1 verified, and each verification result is cached
     until the file changes.
   - The user chooses in **Models → Voice**. Best is selected automatically
     when it is installed and no choice has been saved.
2. **Wake phrase.**
   - **Matching:** requests need "Hello Vyomara …" (also "Vyom …", or
     "नमस्ते व्योमारा …"). Matching is fuzzy over sounds whisper confuses
     ("Viomera", "Viomora", "Vahya Amar"). Devanagari is romanized before
     comparing, and the match must start with a v/w/b sound, so "how are you"
     does not count.
   - **Follow-up window:** after Vyom speaks or acts, the user can keep
     talking for 30 seconds without the wake phrase.
   - **Everything else is ignored.**
3. **Spoken approvals.**
   - **The question:** when an approval card appears and listening is on, Vyom
     speaks a short question, for example "cart.js mein badlaav ready hai…
     Apply karun?".
   - **The answer:** the next phrase is treated as the answer, in Hindi,
     English, or Hinglish ("haan / kar do / yes" or "nahi / rehne do / mat
     karo").
   - **Unclear answers** make Vyom ask again. Nothing is guessed.
   - **Deletions** need an explicit "haan, delete karo".
   - **Stopping:** "ruko / stop" cancels a running task.
4. **Spoken replies.** Replies are shortened for speech: footers, code,
   links, and Markdown are removed. Devanagari text is spoken with the Hindi
   voice (Lekha) and everything else with an Indian English voice (Rishi),
   when those voices are installed.

## Later change: faster recognition

Measurements showed most of the delay came before transcription:
`whisper-stream` checks for silence only every 2 s, so a finished phrase
waited 2–3 s before it was transcribed. The pipeline is now:

1. **Recording in the app.** The renderer records the microphone and cuts
   phrases with an adaptive energy detector (`src/shared/phrase-detector.ts`):
   - it first spends 0.5 s measuring the room's background noise;
   - a phrase ends after 0.65 s of silence;
   - a phrase is at most 14 s long;
   - 0.3 s of audio before speech starts is kept.

   Recording is muted while Vyom speaks.
2. **Transcription.** Each phrase is sent as a WAV to a loopback-only
   `whisper-server` that keeps the model loaded (`-ac 768`).
3. **Spoken requests** add a short final section to the prompt asking for one
   or two spoken sentences. The section is placed last so that the cached
   prompt prefix is reused.

Measured with turbo on an M4 Pro:

| Step | Before | After |
|---|---|---|
| End of speech → phrase detected | ~2–3 s | ~0.7 s |
| Phrase → text | ~0.6–1 s | ~0.3 s |
| Agent reply for "Calculator kholo…" | ~3.4 s | ~2.6 s |
| End of speech → reply | ~6–8 s | ~3.5 s |

## Later change: tap-to-record and silent typed requests

- **Tap-to-record.** In the main window and the mini window, tapping the mic
  records until it is tapped again:
  - each finished phrase is added to the editable message box;
  - nothing is sent automatically;
  - no wake phrase is needed;
  - recording continues for 0.45 s after the tap, so the last words are not
    cut off.
- **Silent typed requests.** Requests that were typed or dictated get on-screen
  answers only: no speech, and approval questions are not spoken.
- **Per-request language.** With the Best model, each phrase is transcribed
  with auto-detection first, so English stays English. If the result is in an
  unexpected script (Urdu, Hebrew, …), it is transcribed again as Hindi. A
  fixed `hi` setting had turned an English sentence into nonsense Devanagari.

## Consequences

- **Accuracy.** Spoken approvals use the same approval ports as clicks;
  voice only changes how the answer is given. A misheard "yes" could approve
  an action. Mitigations:
  - the question is spoken and shown;
  - only clear answers count;
  - deleting needs the word "delete".
- **Delay.** The Best model adds about 0.5–1 s per phrase on an M4 Pro.
- **Audio stays local.** Audio never leaves the Mac. Only transcripts go to
  the local model.

## Verification

- `test/voice-intents.test.ts` uses real whisper transcripts, both romanized
  and Devanagari. It covers:
  - wake matching, including false positives;
  - yes/no and delete answers;
  - the follow-up window, queueing, and cancel;
  - speech-text cleanup and voice selection.
- Live microphone testing is done by the user.
