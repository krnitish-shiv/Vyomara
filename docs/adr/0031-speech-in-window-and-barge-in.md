# ADR-0031: Speech plays in the window; the user can talk over the twin

- **Status:** Accepted; extends ADR-0030
- **Date:** 2026-11-21

## Context

Speech used to play with `afplay`, outside the app. Chromium's echo canceller cannot hear sound played that way, so the microphone was muted while the twin spoke, and the only way to interrupt was to press the orb.

## Decision

1. **Speech plays in the window.**
   - `MacSpeechRunner.setFilePlayer` sends each synthesized clip to the main window over `vyomara:audio-play`.
   - `SpeechPlayer` plays the clip there and answers on `vyomara:audio-done`, with completed, cancelled or failed.
   - Stop sends `vyomara:audio-stop`.
   - If there is no window, or the window cannot play the clip, the main process plays the file with `afplay`, so a reply is never silent.
2. **Barge-in.** The microphone already uses `echoCancellation`.
   - While a clip plays in the window and hands-free listening is on, `VoiceCapture.setBargeIn` keeps listening.
   - About 0.4 s of loud input (6 frames above RMS 0.035, measured after echo cancellation) counts as the user talking over the twin. The twin stops and listens.
   - The system voice (`say`) still mutes the microphone, because the echo canceller cannot hear it.

## Consequences

- The thresholds are conservative and untested against real speakers and rooms. If the twin interrupts itself, raise `BARGE_IN_RMS` or `BARGE_IN_FRAMES` in `voice-capture.ts`.
- The first ~0.4 s of the interrupting words is not transcribed. The rest is.
- Checked in Electron: speech requested through `speakText` played in the window, starting about 0.6 s after the request, with no `afplay` process.
