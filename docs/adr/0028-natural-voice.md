# ADR-0028: Natural voice (Kokoro) beside the system voice

- **Status:** Accepted; extends ADR-0021 (two assistants) and ADR-0018 (voice)
- **Date:** 2026-11-15

## Context

macOS system voices (Aman, Lekha) sound robotic, Aman cannot pronounce
"Vyom", and macOS has no male Hindi voice. Apps cannot use Siri voices.

## Decision

1. **Kokoro-82M (v1.0, quantized ONNX) runs locally** as the natural voice:
   `hf_beta` for female, `hm_omega` for male. Chosen from recorded samples
   transcribed back with whisper (both read "व्योम" correctly; `hf_alpha`
   did not).
2. **Setup is explicit and verified:** `pnpm setup:voice` creates a Python
   environment in `~/Library/Application Support/vyomara/natural-voice`,
   installs pinned `kokoro-onnx` and `soundfile`, and downloads the model and
   voices from the official `onnx-community/Kokoro-82M-v1.0-ONNX` repository,
   refusing any file whose SHA-256 differs from the pinned value. Voices are
   raw float files joined into an `.npz` without pickle.
3. **A persistent sidecar** (`NaturalVoice`) keeps the model loaded and
   answers one request at a time (~1–2 s per reply after the first). Text is
   cut into runs by script: Devanagari as Hindi, everything else as English.
   Names are written in Devanagari for the voice.
4. **Fallback is automatic:** without setup, or if the sidecar fails, the
   reply is read by the system voice, never silent. Stopping cancels both
   synthesis and playback.
5. **Spoken replies may use Devanagari** when the natural voice is ready
   (the system male voice could only read Roman letters).

## Consequences

- Everything stays on this Mac; nothing is sent anywhere at run time.
- First reply after launch takes ~4 s (model load).
- Kokoro does not clone voices; only the shipped voices can be chosen.
- Designed to carry full voice conversations later: the sidecar already
  serves sentence-sized requests, so streaming replies sentence by sentence
  is a change in the caller, not in the engine.
