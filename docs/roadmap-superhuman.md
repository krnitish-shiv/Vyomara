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
| 2 | **Hearing** | A Hinglish-tuned whisper model option. VAD threshold, padding and minimum speech tuned. The names are biased in the prompt and fuzzy-fixed afterwards. Phantom phrases are filtered. Replies play through Web Audio so echo cancellation works and Vyom doesn't hear himself. | done; echo cancellation and barge-in added too (ADR-0030, ADR-0031) |
| 3 | **Speed** | Thinking off in voice mode. Clause-by-clause streaming TTS (done, ADR-0030). A shorter end-of-turn wait (done with word-aware pauses, about 0.9 s instead of 2.3–2.6 s; Smart Turn v3 audio model still to evaluate). Acknowledgement lines when work starts (done). Every stage is timed. Qwen3-Coder-30B-A3B and gpt-oss:20b are evaluated against qwen3:14b. | planned |
| 4 | **Voices** | A Maya 2 Native (MLX) sidecar with two consistent cloned character voices. Kokoro stays as the instant fallback. Samples are played to the owner before switching. | planned |
| 5 | **Talker and worker** | A small, fast model answers or acknowledges within about 1 s, while the main model works and its progress is spoken. | planned |
| 6 | **Twin stage UI** | Glass look and responsive layout for laptop and external monitor (done, 2026-11-21). Still to do: A hologram avatar for each twin (WebGL point cloud, voice-reactive), presence modes (floating bar or notch), a sound design system, voiced onboarding, and a Visual Hub for structured answers. | planned |
| 7 | **Mind** | Awareness that can speak first, with visible restraint. Memory search tuned for Hinglish (a consonant skeleton is done; FTS5 for larger stores is still to do). Memory extraction only from verified quotes. | planned |

## Open work (kept up to date; nothing here is forgotten)

From the owner's real test on 2026-11-21. They rated the reply quality "very bad" (it needs more than 100% improvement), listening at about 70% short of good, and said the UI wastes space in the corners.

- [x] Replies in Roman Hinglish, never Devanagari; the voice converts Hindi words itself.
- [x] Small talk never runs tools; claimed actions without a tool are sent back; tool arguments in the wrong type are fixed.
- [x] Time and date questions are looked up, not guessed.
- [x] Conversation eval with the owner's real requests (`pnpm eval:talk`). Results so far:
  - qwen3:14b: 7/8 passed, about 2 s per warm reply, 47 s cold, weak Hinglish.
  - qwen3.6-27b: 8/8 passed, good Hinglish, about 7 s per warm reply, 95 s cold.
- [ ] **Model choice.** Run `eval:talk` and `eval` on Qwen3-Coder-30B-A3B (downloading) and gpt-oss:20b (download paused), then pick the default. Goal: Hinglish as good as qwen3.6-27b at qwen3:14b speed or better.
- [ ] **Cold first reply** (47–95 s). Shrink the ~8k-token fixed prompt (tool descriptions), keep the model loaded longer than 30 minutes, and give a spoken acknowledgement during the wait.
- [x] **Listening.** A turn spoken in pieces is transcribed again as one recording at the end (+~0.35 s), so whisper hears the whole sentence.
- [x] **UI corner space.** Outer margin 18–24px → 6px, corners 18 → 12px, no width cap.
- [ ] **Voices.** Maya 2 Native samples for Vyom and Vyomara (5 voices each, model downloading); the owner listens and chooses; then a Maya sidecar with Kokoro as fallback.
- [ ] **Talker/worker (milestone 5).** A small fast model for instant replies while the main model works.
- [ ] **Twin hologram (milestone 6).** Design it with the owner and attach it to the orb.
- [ ] **Awareness (milestone 7).** The twin can speak first, with visible restraint.
- [ ] Rebuild and install after each batch so the owner can test.

## The empire (target architecture, 2026-11-22)

The owner asked for the whole "empire" to be built the way Claude judges best. Diagram: https://claude.ai/artifact/GqSBJ3VderMbrnBMq2RQJn

```
Aap
 └─ Vyom · Vyomara (the only faces; one brain, two personalities)
     └─ Twin Brain: intent · planner · router (agent + model) · task manager · progress reporter
         └─ Shared services: memory · knowledge (file index) · awareness · skills · scheduler · safety
             └─ Departments (one level deep, small toolboxes):
                  Engineering · Research · Life · Mac & Ops · Communication · Creative · Finance · Learning
                 └─ Engines: model router · fast talker · worker · vision · STT · TTS (local; cloud only if chosen)
                     └─ Connectors: Mac apps · browser · VS Code · GitHub · files · MCP · mail · WhatsApp · calendar
```

**Build order:**
- **Phase 1, foundation.**
  - Model router and a fast talker model.
  - A task manager that runs several jobs in parallel.
  - Spoken progress updates during long jobs (done, 2026-11-22).
  - Memory of past conversations, not just facts.
- **Phase 2, reach.**
  - A knowledge index of the owner's files.
  - A scheduler for reminders and routines.
  - A Communication department (mail, WhatsApp, calendar drafts, sent only after review).
  - A reviewer and tester in Engineering.
- **Phase 3, alive.**
  - Proactive awareness.
  - A skills library.
  - Creative, Finance and Learning departments.
  - Screen vision.
