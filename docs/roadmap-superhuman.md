# Roadmap: superhuman Vyom and Vyomara

The owner handed the project over on 2026-11-21: make the twins the best possible assistants, in UI and in function. This file is the working plan. Each milestone ends with `pnpm check`, plus `pnpm test:desktop-ui` (and `pnpm eval` where relevant), and a commit on `dev/version2`.

**Ground rules that do not change:**
- Local-first.
- Every side effect needs the user's approval.
- Only the twins face the user.
- Replies follow the user's language (Hinglish included).
- The prompt prefix stays static, so Ollama's cache keeps hitting (ADR-0026).

Background research:
- [research/voice-and-local-models-2026-11.md](research/voice-and-local-models-2026-11.md)
- [research/stonic-ai-teardown.md](research/stonic-ai-teardown.md)

| # | Milestone | What "done" means | Status |
|---|---|---|---|
| 1 | **Twins and inner team** | Only Vyom and Vyomara can be picked (app and CLI). A `delegate` tool hands tasks to the inner team (Khoj research, Yatra travel, Kavach Mac health, Lipi writing). Each member runs in its own context with a tool whitelist, and the cache-safe prefix is unchanged. Activity rows show "Khoj: …" progress. ADR-0029. | done (2026-11-21) |
| 2 | **Hearing** | A Hinglish-tuned whisper model option. VAD threshold, padding and minimum speech tuned. The names are biased in the prompt and fuzzy-fixed afterwards. Phantom phrases are filtered. Replies play through Web Audio so echo cancellation works and Vyom doesn't hear himself. | done except echo cancellation, which moved to milestone 3 with barge-in (ADR-0030) |
| 3 | **Speed** | Thinking off in voice mode. Clause-by-clause streaming TTS (done, ADR-0030). A shorter end-of-turn wait (done with word-aware pauses, about 0.9 s instead of 2.3–2.6 s; Smart Turn v3 audio model still to evaluate). Acknowledgement lines when work starts (done). Every stage is timed. Qwen3-Coder-30B-A3B and gpt-oss:20b are evaluated against qwen3:14b. | planned |
| 4 | **Voices** | A Maya 2 Native (MLX) sidecar with two consistent cloned character voices. Kokoro stays as the instant fallback. Samples are played to the owner before switching. | planned |
| 5 | **Talker and worker** | A small, fast model answers or acknowledges within about 1 s, while the main model works and its progress is spoken. | planned |
| 6 | **Twin stage UI** | Glass look and responsive layout for laptop and external monitor (done, 2026-11-21). Still to do: A hologram avatar for each twin (WebGL point cloud, voice-reactive), presence modes (floating bar or notch), a sound design system, voiced onboarding, and a Visual Hub for structured answers. | planned |
| 7 | **Mind** | Awareness that can speak first, with visible restraint. Memory search tuned for Hinglish (FTS5 plus a consonant skeleton). Memory extraction only from verified quotes. | planned |
