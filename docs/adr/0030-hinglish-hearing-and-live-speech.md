# ADR-0030: Hinglish speech model and live spoken replies

- **Status:** Accepted; extends ADR-0018 (voice), ADR-0028 (natural voice), and the whisper-server setup
- **Date:** 2026-11-21

## Context

The owner reported two voice problems:

1. Vyomara often mishears what is said.
2. The reply starts too late after they stop speaking.

Tests on the Hinglish clips published with the Oriserve model showed that the default "best" model (whisper large-v3-turbo with `hi`) turns conversational Hinglish into Spanish, French, Urdu script or invented English:

- "Mehnat to poora karte hain" became "Semena está pura cantada".
- It took 1.6–2.0 s per phrase on average, with stalls of up to 5.8 s.

Spoken replies waited for the whole agent turn. Then the whole reply was synthesized, and only after that did playback start.

## Decision

### 1. A third speech model, "Hinglish", recommended and preferred when installed

The model is Oriserve **Whisper-Hindi2Hinglish-Apex** (Apache-2.0), a fine-tune of large-v3-turbo.

**How it is built:**
- There is no official ggml build, so `src/desktop/hinglish-model.ts` builds one on the Mac.
- It downloads the pinned revision, resumes interrupted downloads, and checks every file's SHA-256, including OpenAI's mel filters at a pinned commit.
- It converts safetensors to ggml with a dependency-free port of whisper.cpp's `convert-h5-to-ggml.py`, then quantizes to q5_0 with `whisper-quantize`.
- It records the result's SHA-1 in a manifest. The model counts as ready only if the file still matches that SHA-1.
- The Models panel's set-up button and `pnpm setup:hinglish` share this code.

**Results on the same clips:**
- Every conversational clip was transcribed correctly or nearly so, in Roman Hinglish (the form the app already uses).
- English stays English.
- Average 0.31–0.36 s per phrase.

**Settings:**
- It runs with `language=en`, which is how the model is meant to be used.
- When it is installed, the app switches to it automatically, unless the user picked another model while it was installed.

### 2. Transcript polish (`polishTranscript`)

- **Invented phrases are dropped:** whole phantom phrases ("Thanks for watching", "सब्सक्राइब करें"), and a prompt echoed back on silence.
- **Name spellings are corrected:** mishearings of the twins' names seen in the tests ("Vyaanm", "Vivaara", "Viyo", "vio mara", "विव मारा", "व्याम") become Vyom and Vyomara. "V s code" becomes VS Code.
- **Ordinary words are protected:** "beyond", "via" and "video" are not changed.
- **No initial prompt:** a prompt with the names did not improve recognition in the tests and slowed one clip, so none is used.

### 3. Live spoken replies

- **Clause splitting:** voice requests pass the model's streamed text through `ClauseStream`. It ends a clause at `. ? ! ।` or a newline, and at a comma after five words. Markdown is read as words, a code block becomes one short note, the app's footer is never spoken, and speech stops after about 420 characters with "Baaki screen par hai."
- **Queueing:** `SpeechQueue` prepares each clause (Kokoro synthesis to a file) while the previous one plays, using the new `MacSpeechRunner.prepare`, `play` and `discard`.
- **One speaker at a time:** a speech-turn lock serialises live clauses with one-off lines such as approval questions, so they wait their turn instead of failing.
- **Renderer events:** the main process sends `vyomara:live-speech` events, which mute the microphone and animate the orb. The chat response carries `spokenLive`, so the reply is not spoken twice. Stop cancels the queue.

**Measured (warm Kokoro, reply streamed at about 22 tok/s):** the first audio comes **0.5 s** after the reply starts, instead of after the full generation plus synthesis (about 2.2 s for a 26-word reply, and growing with length). Text the model writes before a tool call ("Yatra ko de diya…") is now spoken right away.

## Consequences

- Setting up the Hinglish model downloads 1.6 GB and needs `whisper-quantize` (from `brew install whisper-cpp`, which already provides `whisper-server`). The download can be resumed.
- The Hinglish model writes Hindi in Roman letters only. Users who want Devanagari can keep "Hindi (Devanagari)", which is the old "best" model.
- Speech still pauses the microphone while it plays. Echo cancellation and barge-in through Web Audio playback, plus a shorter end-of-turn wait (Smart Turn), are the next steps (roadmap milestone 3).
