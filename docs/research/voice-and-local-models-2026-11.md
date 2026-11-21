# Voice latency, voice quality, and local models: research (2026-11-21)

These are the findings and the recommended next steps for three problems the owner raised:

1. The reply comes too late after you finish speaking.
2. The assistant mishears speech and the character voices sound bad.
3. Which open-weight models, the kind that "rival Claude Code", Vyomara can run on the owner's Mac.

**Hardware:** M4 Pro with 24 GB. About 17.8 GiB of that is usable by the GPU by default.

**Current stack:**
- Speech-to-text: whisper.cpp (`ggml-base` with `en`, or large-v3-turbo with `hi`) plus Silero VAD (threshold 0.30, 200 ms padding).
- After you stop speaking: about 650 ms of silence is waited for, then the whole clip is transcribed in one batch.
- Model: Ollama `qwen3:14b` Q4, at 22 tok/s generation and 170 tok/s prompt processing.
- Text-to-speech: Kokoro-82M ONNX (`hf_beta` / `hm_omega`), and it synthesises the entire reply before playback starts.

Most numbers below come from vendors or the community, not from the owner's machine. **Measure every stage on the owner's Mac before committing to anything.**

---

## 1. Direct voice-to-voice (speech-to-speech): not yet

No open-weight speech-to-speech model meets all four of Vyomara's needs on 24 GB: Hindi speech, reliable tool calls, real-time speed, and a license that allows commercial use.

| Model | Problem |
|---|---|
| NVIDIA NemotronLabs VoiceChat 11B (Aug 2026) | English only; tool arguments correct only 44% of the time; MLX on Mac runs slightly slower than real time; research license |
| NVIDIA PersonaPlex-7B, Kyutai Moshi | English; no tool calls |
| Qwen3-Omni-30B-A3B | Its speech output does not include Hindi; about 2.6 s on an M4 Pro 48 GB; about 17–20 GB at 4-bit |
| Qwen3.5-Omni (Mar 2026) | No open weights found on Hugging Face |
| MiniCPM-o 4.5 | Speech in English and Chinese only |
| LiquidAI LFM3-Audio-2B (Oct 2026, MLX) | Very fast (vendor claims about 50 ms to first token), but its voice chat is English only |
| Step-Audio 2, Fun-Audio-Chat, Kimi-Audio, GLM-4-Voice | Chinese and English; weak tool calling |
| Josh Talks Human-1 (Hindi full-duplex, a Moshi fine-tune) | Only Hindi option found, but its weights could not be found |

**Decision:** stay with a cascaded pipeline (separate speech-to-text, model, text-to-speech) and make it stream. Look at this again around mid-2027; things to watch for are open Qwen3.5-Omni Light weights, a Hindi version of LFM-Audio, and released Human-1 weights.

---

## 2. Latency: streaming cascade plus a talker/worker split

**Why it feels slow today:** every stage waits for the one before it to finish completely.
- 650 ms silence wait, then batch transcription (sometimes a second "auto → hi" pass, see `src/main/index.ts:1189`).
- The full qwen3:14b turn, including thinking tokens.
- Kokoro synthesises the whole reply.
- Only then does playback start.

**Reference points measured on Macs:**
- Pipecat with Smart Turn v3, streaming speech-to-text, an LLM and Kokoro TTS reached a **median of 874 ms** from end of speech to first audio on an M5 Max ([mthomas100/local-voice](https://github.com/mthomas100/local-voice)). Breakdown: VAD 200 ms, STT 24–78 ms, Smart Turn 2–40 ms, LLM first token about 330 ms, TTS first chunk about 285 ms.
- After a prompt-cache miss the same setup took **3.9 s**.
- When the model server ran at background process priority, the first token took 2.4–4.8 s.

### Target budget on the M4 Pro (warm)

| Stage | Technique | ms |
|---|---|---|
| End of turn | Silero VAD with about 250 ms of silence, confirmed by **Pipecat Smart Turn v3** (8 MB ONNX, about 12 ms on CPU; Hindi accuracy 93.4%). If Smart Turn says "incomplete", fall back to waiting 1.5–2 s | 250–320 |
| Speech-to-text | Transcribe rolling partials while the user is still speaking, then run **one** final pass at the end | 150–300 |
| Talker model | A small model (4B) with thinking off and a prompt prefix that never changes, so the cache always hits; resident in memory, run at interactive priority | 150–300 |
| First clause | Stream tokens and cut at `। ? ! .` or at a comma after 4 or more words | ~100 |
| Text-to-speech | Synthesise clause by clause, queueing the next clause while the current one plays | 200–350 |
| Acknowledgement | Pre-rendered "हाँ… एक सेकंड" clips, played the moment a tool or agent path starts | ~0 |

**Expected:** about **1.0–1.4 s** to the first real answer, and about **0.3–0.5 s** to an acknowledgement. Today it is roughly 5–8 s (estimated).

### Talker/worker split
- A small **talker** model gets the transcript first. It either answers directly (chit-chat, quick facts, status) or says a one-line acknowledgement and hands the task to the **worker** (the agent loop and its tools).
- The worker streams progress events, which are spoken as short updates ("file mil gayi, ab test chala raha hoon").
- Prior art for this pattern: ConvFill and LiveKit's talker-reasoner design.
- Memory: worker (about 9–14 GB) + 4B talker (about 3 GB) + whisper turbo (about 1.6 GB) + TTS. This fits, but it is tight; set `OLLAMA_MAX_LOADED_MODELS=2`.
- **Main risk:** how good 4B models are at Hinglish. Test Qwen3-4B-Instruct-2507, Qwen3.5-4B and Gemma 4 E4B on real prompts. If none is good enough, use the worker model itself as the talker, with thinking off and clause streaming (about 1.5–2 s).

---

## 3. Mishearing (speech-to-text)

**The main cause is almost certainly `ggml-base` with `language=en`.** That model is too small for Hindi, and forcing English makes it garble Hindi speech. Even large-v3 without fine-tuning is weak at Hindi: about 29% WER on FLEURS-hi, and about 30% on conversational Hinglish.

| Model | Notes |
|---|---|
| **Oriserve Whisper-Hindi2Hinglish-Apex** (0.8B, Apache-2.0) | Outputs **romanized Hinglish**, the same form Vyomara uses today. WER on FLEURS 29.8 vs 50.8 for large-v3. Convert to ggml and use the existing whisper.cpp server. **Drop-in now** |
| **Trelis whisper-hinglish-preview** (1.5B, Apache-2.0) | Best open Hinglish numbers found: about 13% WER (CoSHE 13.7, FLEURS-hi 12.6). Output mixes scripts. Run an A/B test against Apex |
| **NVIDIA Nemotron 3.5 ASR Streaming 0.6B** (Jun 2026, commercial use allowed) | True streaming in 80 ms–1.1 s chunks with punctuation. FLEURS-hi 6.8–8.1%, but 20% on Vaani (conversational speech). Runs through **NeMo-Speech.cpp** (Metal, Q8 GGUF, WebSocket server). Hinglish behaviour is undocumented. **Best streaming candidate** |
| Voxtral Mini 4B Realtime | FLEURS-hi 10.7–12.9%, but about 9 GB, which is too large next to the LLM |
| Qwen3-ASR 0.6B / Srota fine-tune, IndicConformer 600M | Possible, but little Hinglish evidence |
| Parakeet, Kyutai STT, Moonshine | No Hindi |

**Quick wins that need no new model:**
1. Never use base with `en`. Switch to Apex (or large-v3-turbo with `hi`) as the default.
2. VAD threshold 0.5 instead of 0.30, minimum speech about 250 ms, padding 300–400 ms (200 ms clips the "व्य" at the start of "व्योम").
3. Use whisper's initial `prompt` to bias it towards the names: "Vyom, Vyomara. Hinglish baat-cheet." Also add a fuzzy post-filter (viom / beyond / we om → Vyom).
4. Turn on anti-hallucination settings: beam size 5, temperature fallback, a no-speech threshold, and a blacklist of phantom phrases ("Thanks for watching", "सब्सक्राइब").
5. **Echo, i.e. the assistant hearing itself:** capture with `echoCancellation/noiseSuppression/autoGainControl` and **play TTS through the renderer's Web Audio**, so that Chromium's echo canceller can see it. `afplay` and `say` bypass the canceller. This is also what makes interrupting the assistant mid-sentence (barge-in) possible.
6. RNNoise or DeepFilterNet3, only in noisy rooms (run an A/B test, because they can hurt clean speech).
7. Build a test set of 50–100 clips of the owner and family speaking (Hindi, Hinglish, English, the names). Published benchmarks disagree too much to choose a model without it.

---

## 4. Character voices (text-to-speech)

Kokoro's own author grades its Hindi voices **C**, because they were trained on little data. Tuning won't make them warm.

| Model | Notes |
|---|---|
| **Maya Research Maya 2 Native** (2.5B, Apache-2.0, Oct 2026) | VoiceArena Hindi Elo 1049: #9 overall and #2 among real-time models, above Eleven v3 and Sarvam Bulbul v3. Streaming in 80 ms frames. **Clones a voice from 3–10 s of audio.** Best-effort emotion tags (laughs, sighs, sad, excited). On an **M4 24 GB with MLX 8-bit**: RTF 0.58, first audio 0.12–0.25 s, about 2.5 GB. Code-mixed text is a known weak spot. **Recommended** |
| Chatterbox Multilingual v3, Hindi pack (0.5B, MIT) | Hindi CER 2.6–6.7%, zero-shot cloning, and an emotion "exaggeration" knob. But it does not stream, the repo has been archived since Aug 2026, and its output carries a watermark |
| Indic Parler-TTS (AI4Bharat) | 12 emotions plus voice described in text; no cloning, slow |
| IndicF5 | Good Hindi cloning; not streaming. Offline fallback |
| VoxCPM2, Svara-TTS | Worth a listen; less proven |
| Voxtral TTS, Fish S2, Higgs v3, XTTS-v2 | Licenses not usable commercially |
| Qwen3-TTS, CosyVoice, IndexTTS2, Dia, Kyutai, Sesame | No Hindi |

**Plan for voices:**
- Run Maya 2 Native through **mlx-audio** (or the `maya2-mlx` / `mac-maya` ports) at 8-bit. Its `/v1/audio/speech` endpoint streams 24 kHz PCM.
- Make **two character voices**, Vyom and Vyomara: record about 10 s of clean reference audio each (consenting voice talent), with exact transcripts. Clone once and cache the result.
- Always write the names in Devanagari (व्योम, व्योमारा).
- Synthesise sentence by sentence. Generation slows down while Ollama is decoding because they share memory bandwidth.
- Keep Kokoro as the instant fallback.
- **Play samples aloud for the owner before choosing** (owner preference).

---

## 5. Local coding models ("rival Claude Code")

The open models that genuinely rival Claude on coding are all huge, so they **cannot run on a 24 GB machine**:
- China: Kimi K3/K3.1 (2.8T), DeepSeek V4/V4.1 (284B–1.6T, MIT), GLM-5.x (753B), Qwen3.8 large, MiniMax M3.
- US: Reflection Beam (501B), Nemotron 3 Ultra.
- France: Devstral 2 (123B).

Other countries are releasing open models too, but those are not coding-focused: Korea A.X K2, India Sarvam 30B/105B, UAE K2 Think / Falcon H1R. The only way Vyomara can use the big ones is through an optional cloud key.

**What does fit:** MoE models with about 3B active parameters. Expect roughly 2.5–3x the current speed, and better coding.

| Model | Size on disk | Speed on M4 Pro 24 GB | Coding | Notes |
|---|---|---|---|---|
| **Qwen3-Coder-30B-A3B-Instruct** | UD-Q3_K_XL 13.8 GB / IQ4_XS 16.4 GB | MLX 4-bit, measured: 60 tok/s generation, 400–600 tok/s prompt processing | Coding-tuned, no thinking tokens | **Full attention**, so the static 8k prefix cache works. **Recommended "fast" default** |
| gpt-oss-20b | ~14 GB | ~50 tok/s generation, ~620 tok/s prompt processing | Weaker | Most reliable tool calling; zero-hassle backup |
| Qwen3.6-35B-A3B | UD-Q3_K_XL 16.8 GB / IQ3_S 13.7 GB | MoE speed | SWE-bench Verified 73.4 | **"Smart" option.** Hybrid DeltaNet layers cause prefix-cache misses in llama.cpp/Ollama, and Ollama has had tool-parse bugs with this family. Adopt only if `pnpm eval` passes |
| Devstral Small 2 (24B dense) | ~15 GB | 13–15 tok/s | SWE-bench Verified 68.0 | Cache-safe, but slower than now |
| Qwen3.8-27B | ~18 GB | ~10 tok/s | Strongest small model | Too slow on 24 GB, and has the hybrid cache problem; good on 32–48 GB machines |

**Settings:** `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `num_ctx` 32768, `keep_alive -1`. Optionally raise the GPU memory limit with `sudo sysctl iogpu.wired_limit_mb=20480` (resets on reboot).

**Runtime:**
- Ollama's MLX engine reportedly targets Macs with 32 GB or more, so on 24 GB it stays on llama.cpp.
- Switching to MLX might add about 1.3–1.8x on generation, but prefix caching for agents is less mature there.
- First step: switch the model, not the runtime.
- Cheap extra: accept any OpenAI-compatible base URL, so LM Studio, oMLX or llama-server can be used.

**Hybrid:** local stays the default, with an optional cloud key (DeepSeek V4, GLM-5, Kimi K3) for hard tasks, and a clear "leaves your machine" indicator when it is used.

---

## 6. Recommended order of work

1. **Speech-to-text fix (smallest change, biggest gain):** Apex Hinglish model, VAD tuning, name prompt, anti-hallucination settings, Web Audio playback for echo cancellation.
2. **Latency, phase 1, no new models:** Smart Turn v3 plus a 250 ms silence wait, rolling partial transcripts and a single final pass, `think:false` in voice mode, clause-streamed TTS, pre-rendered acknowledgements.
3. **Model switch:** benchmark Qwen3-Coder-30B-A3B (UD-Q3_K_XL) and gpt-oss:20b against qwen3:14b with `pnpm eval`, checking cache hits and tool parsing.
4. **Voices:** a Maya 2 Native MLX sidecar plus two cloned character voices; play samples for the owner.
5. **Latency, phase 2:** 4B talker plus worker split, barge-in.
6. **Later:** Nemotron 3.5 streaming speech-to-text; look at speech-to-speech again around mid-2027.

**Not verified:**
- Most benchmark numbers (vendor-reported).
- Small-model speeds on the owner's GPU core count.
- Whether Ollama uses its MLX path on a 24 GB Mac.
- Whether Qwen3.6 tool parsing is fixed in current Ollama.
- How Nemotron handles Hinglish.
- How well 4B talker models handle Hinglish.
