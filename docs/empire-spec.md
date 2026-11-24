# Empire build spec (v1, 2026-11-22)

This is the build spec for the Vyomara "empire": two twin people, Vyom and Vyomara, who sit on a shared house of ten desks, services, engines and connectors. The picture is in [empire-design.html](./empire-design.html) and the milestones are in [roadmap-superhuman.md](./roadmap-superhuman.md). This file holds the detail needed to build it: components, data shapes, protocols, budgets, evals and acceptance criteria.

The design was re-checked on 2026-11-22 against outside research on three topics:
- multi-agent organisation: Anthropic, Cognition, Google/MIT scaling, Magentic-One, the OpenAI Agents SDK and MCP
- persona memory and mood: Generative Agents, Letta, Mem0, Zep, LongMemEval, persona drift, PAD affect, companion-ethics studies
- local runtime limits: Ollama, the KV-cache maths, embeddings, eval practice, fallback patterns

Sources are listed at the end. Numbers marked **[measure]** are estimates. Measure them on the machine before relying on them.

---

## Glossary (the design's empire names → code names)

The design page uses empire words, and the code uses English. Use this table to map one to the other.

| Design word | Meaning | Code / spec |
|---|---|---|
| Samrat | the owner | owner |
| Do chehre | Vyom and Vyomara | twins (`twin-runtime.ts`, `identity.ts`) |
| Darbar ka darwaza | decides who speaks | Door (`door.ts`) |
| Pehchaan-patra | identity card | `data/twins/<id>/identity.yaml` (§3.1) |
| Dil | mood and bonds | `mood.ts`, `state.json` (§5) |
| Yaad-khana | memory store | `memory_item` table (§4) |
| Niji tijori | private vault | `owner=P, visibility=private` |
| Raj-dimaag | planner and router per twin | twin runtime (§2) |
| Farmaan | a request from the owner | request or task |
| Bahi-khata | task ledger | `data/tasks.db` (§7) |
| Kanoon | governance | `governance/*` (§10) |
| Shahi daftar | shared services | memory, knowledge, scheduler, tracing |
| Vibhaag | one of the 10 domains | desk (§6) |
| Mantri | the desk brief and its name (Vishwa, Khoj, …) | desk brief, not a separate LLM hop |
| Hunar | a capability of a desk | skill (`SKILL.md`) |
| Harkara | a helper with a fresh context | subagent (§6.3) |
| Parakhi | a clean-context checker | verifier |
| Madad ki parchi | a help request | `help_requests[]` in a Report (§6.5) |
| Chupke se poochna | a quiet ask to the other twin | `twin_ask` (§3.4) |
| Shakti-ghar | models | engines and modes (§9) |
| Doot | connectors | tools, connectors, MCP |
| Padaav | a build stage | phase 0–3 (§14) |

## 1. What the re-evaluation changed

| Area | Before (design v7) | Now | Why |
|---|---|---|---|
| Teams | 10 teams × lead + about 6 member agents (about 70 agents) | **10 desks.** Each desk has one static brief plus about 6 **skills** that load on demand. Subagents are used only for context-heavy jobs. | Splitting by role is a known anti-pattern, and multi-agent setups cost 3–15× the tokens. On one local GPU, "parallel" agents queue anyway, and every distinct prompt is a prefix-cache miss (~45 s per 8k tokens). |
| Team lead | a separate LLM hop | **the desk brief is the lead.** The names Vishwa, Khoj and so on stay as desk names. | Every hop adds prefill and a lossy handoff. |
| Desk ↔ twin | delegate tool | still **agent-as-tool**: a desk returns a structured report and never speaks to the owner | Matches "only the addressed twin speaks" and keeps guardrails in one place. |
| Help request | a parchi through the twin | a parchi through the twin, now a **structured record in the desk report** that code schedules, with one hop | Central routing holds error amplification to about 4×, against about 17× for free agent-to-agent calls. |
| Task state | implicit in the chat | a **task ledger and a progress ledger** in SQLite, with stall-based replanning, budgets and resume | Magentic-One pattern, plus Anthropic's long-running harness. |
| Quality | thumbs up/down and evals | plus a **clean-context verifier** for code and facts, **pass^k** evals, tracing and weekly drift probes | Clean-context reviewers find real bugs, and pass^k exposes flaky agents. |
| Memory | three memory types (concept) | **one table** with owner, visibility and secret fields, enforced in SQL before search, plus provenance and cascading delete | Privacy in prompts leaks about 7–8% even on strong models, so it has to be enforced in code. |
| Mood | "dil" (concept) | numbers owned by code (valence, arousal, energy, bonds) with decay; **the LLM only classifies events** | Small models classify reliably but appraise unreliably, and emotional prose can lower believability on small models. |
| Escalation to a bigger model | the twin decides | **rule-based**: by task type, a failed verification or the stall count | Weak primary models misjudge when to escalate. |
| Models | qwen3:14b for everything | a resident **worker** (14B), a resident **talker** (4B) in voice mode, an on-demand **embedder**, and an explicit **Deep-work mode** (Qwen3-Coder-30B-A3B) | Fits in 24 GB with pinned contexts and a q8 KV cache. |

These stay as they were: two separate people, the selective door, three kinds of memory with private vaults, governance as one choke point, the 10 domains, one-hop help, everything local, honesty about being AI, and no guilt or pressure.

---

## 2. Runtime topology

```
Owner (voice / text)
  └─ Door (code): wake word + addressee → exactly one active twin
       └─ Twin runtime (persona P): identity block + Self state + memory view(P)
            ├─ Talker path: small talk / simple Q → talker model, no tools (≈0.5 s)
            └─ Worker path: Planner → Router → Task manager (ledger)
                   ├─ direct tools (common toolkit)
                   ├─ Desk call(desk, skill?, brief) → Report
                   │     └─ optional subagent(s) for sweeps / big reads / verify
                   ├─ quiet twin-ask (other twin answers from its shareable view, never speaks)
                   └─ help requests from reports → scheduled by Task manager (1 hop)
            └─ Answer in P's voice → TTS → owner; write memory episode (owner=P)
Governance (code, around every step): Safety · Privacy · Quality · Resources · Fallback
Services: Memory store · Knowledge index · Scheduler · Ledger · Tracing
Engines: worker LLM · talker LLM · deep LLM · embedder · STT · TTS · (image)
Connectors: Mac, apps, Chrome, files, terminal, web, Mail/Calendar/… (MCP where possible)
```

### Component contracts

| Component | Owns | Model? | Notes |
|---|---|---|---|
| Door | addressee detection, the active-twin switch, self-echo drop | no (rules + the wake matcher) | Exactly one twin per turn. If no name is said, the last active twin answers. |
| Twin runtime | the prompt assembly per persona, final voice, memory writes | worker or talker | The static prefix is byte-identical per model (see §3.3). |
| Talker | instant replies | Qwen3-4B (resident in voice mode) | `routeRequest` is conservative: when in doubt, use the worker. Draft: `src/agent/talker.ts`. |
| Planner and router | steps, desk choice, skill choice, model mode | worker, structured output | Routing is a JSON choice from an enum of desks and skills. |
| Task manager | the ledger, budgets, scheduling, help requests, resume | code; one small structured call for the progress check | One in-flight LLM request per model. |
| Desk | domain reasoning with a small toolset | worker (same model, desk brief) | Returns a `Report` (§6.4). Never addresses the owner. |
| Subagent | a context-protected subtask | worker, fresh context | Only for research sweeps, big reads and verification. |
| Verifier | pass/fail against criteria | worker or deep, clean context | Gets only the artifact and the criteria. |
| Governance | the permission gate, privacy filter, budgets, breakers | code | One module per concern. Every tool call passes through it. |

---

## 3. The twins

### 3.1 Identity card (static, read-only, about 600–900 tokens each)

Stored at `data/twins/<id>/identity.yaml`. The owner can edit it from the UI; the model never can.

```yaml
id: vyomara            # vyom | vyomara
name: Vyomara
gender: female         # grammar for Hinglish self-forms
age_feel: "late 20s"
voice: { engine: maya, speaker: Ahana }   # Vyom: Ritvik
backstory_anchors:     # 5–8 stable facts; never contradicted
  - "Vyom ki judwa; dono ek hi din 'bane' the"
core_values: [care, honesty, curiosity, ...]      # 5
tastes: { music: [...], food: [...], hobbies: [...] }  # 5 lines max
strengths: ["planning", "people", "writing"]        # Vyom: engineering, devices, research
speech_style:
  markers: ["acha suno", "dekho", questions, warm closings]   # Vyom: "yaar", short sentences, dry humour
  sentence_len: medium
  never: ["Devanagari on screen", "guilt language", "claim to be human when sincerely asked"]
few_shot:              # 6–10 Hinglish exchanges; style, NOT actions (no "Chrome khol diya")
  - user: "aaj mood off hai"
    twin: "Acha suno, kya hua? Bolo, main sun rahi hoon."
```

### 3.2 The evolving self (about 300 tokens or less)

Stored at `data/twins/<id>/self.md`. The nightly job can *propose* changes, such as a new liking or a shift in opinion. A change is applied only with an entry in the visible changelog, at most one change a week, and the owner can revert it.

### 3.3 Prompt layout (protects the cache)

1. **The static system prompt per model** is shared by both twins and every desk on that model. It holds:
   - the generic assistant rules
   - the tool-call protocol
   - the safety rules
   - the desk catalog (name plus one line each)
   - the skill-loading protocol
   - the static tool schemas of the common toolkit
2. **The per-turn context message**, the first user-role block, holds:
   - the twin identity card for persona P (byte-stable per twin, so each twin gets its own warm prefix after the first turn)
   - the evolving self
   - the mood line
   - today's plan chunk
   - retrieved memories
   - the ledger excerpt
3. **Desk calls** reuse prefix 1. The desk brief and the loaded skill bodies go in the first message of the desk's own context.
4. **Identity reminder:** after about 20 turns, re-inject two lines ("You are Vyomara… style markers…") near the end of the context, against drift.

Never change `num_ctx`, the tool list or prefix 1 per request. All of these force cache misses or model reloads.

### 3.4 Twin-to-twin (the quiet ask)

- `twin_ask(question)` runs the *other* twin's runtime over its **shareable view** only: `visibility in (twin_shared, household)`, with no secrets. It uses no tools and returns a short text. The other twin never speaks aloud.
- The answer is logged as an episode in both twins' memories. It is `owner=asker` with `source=twin_said`, and `owner=answerer` as "Vyomara asked me X".
- Never pass raw transcripts between the twins. Pass only structured facts or that short answer.

---

## 4. Memory

### 4.1 Storage

SQLite (`data/memory.db`) with **sqlite-vec** (vectors) and **FTS5** (exact Roman-Hinglish words and names). There is one table. Do not split it into a store per twin; one table makes provenance and cascading deletes simple.

```sql
CREATE TABLE memory_item (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- fact|episode|diary|reflection|feeling|promise|plan|fiction
  owner TEXT NOT NULL,         -- vyom|vyomara|shared
  subject TEXT NOT NULL,       -- user|vyom|vyomara|world
  visibility TEXT NOT NULL,    -- private|twin_shared|household
  heard_by TEXT NOT NULL,      -- JSON array of twins present/addressed
  source TEXT NOT NULL,        -- user_said|twin_said|twin_observed|inferred|reflection|user_edited|fiction
  secret_from TEXT,            -- JSON array; non-empty = "don't tell X"
  text TEXT NOT NULL,          -- normalised English/Roman text
  text_raw TEXT,               -- original Hinglish utterance
  keywords TEXT,               -- generated at write time (index key expansion)
  importance INTEGER NOT NULL, -- 1..10, rated once at write
  valence REAL,                -- -1..1 emotion tag at write
  project TEXT,                -- optional scope (repo / desk)
  valid_from TEXT, valid_to TEXT,          -- world time (null valid_to = current)
  learned_at TEXT NOT NULL, last_accessed_at TEXT, access_count INTEGER DEFAULT 0,
  supersedes_id TEXT, derived_from_ids TEXT,   -- JSON array; reflections cite evidence
  user_pinned INTEGER DEFAULT 0, user_hidden INTEGER DEFAULT 0, deleted_at TEXT
);
-- vec0 table: memory_vec(id, embedding float[512], owner partition key, visibility metadata)
-- fts5 table: memory_fts(text, keywords, text_raw)
```

The three memory types from the design map onto this table as follows:
- **private vault:** `owner=P, visibility=private`
- **record about the other twin:** `owner=P, subject=<twin>, visibility=twin_shared`
- **shared facts about the owner:** `owner=shared, visibility=household`

### 4.2 Access rule (in code, before any search)

```sql
WHERE deleted_at IS NULL AND user_hidden = 0
  AND (owner = :me OR owner = 'shared' OR (owner = :other AND visibility IN ('twin_shared','household')))
  AND NOT (secret_from IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(secret_from) WHERE value = :me))
```

- **Derived items take the strictest visibility of their sources.** A reflection, diary entry or summary built from any private item stays private.
- **Desks and subagents get no memory view by default.** The twin passes only the constraints the job needs, such as "budget 20k" or "prefers trains".
- **Output leak check:** before speaking, compare the draft reply (string match plus embedding similarity) with every item where the *addressed* twin is in `secret_from` or that belongs to the *other* twin's private vault. On a hit, regenerate once; if it hits again, give a safe deflection.

### 4.3 Retrieval

score = `w_r·recency + w_i·importance + w_s·relevance`, each min-max normalised, all weights 1 to start.
- **Recency** is `0.995^hours_since_last_access`.
- **Relevance** fuses vector search and FTS with **Reciprocal Rank Fusion** (`k=60`, top 10 from each).
- The memory budget per turn is about 1.2k tokens.
- Pinned items and promises are always considered.

### 4.4 The write pipeline (per turn, off the reply path)

1. **Extract** candidate facts from the turn with a static extractor prompt and a JSON schema in Ollama.
2. **Resolve dates in code**, never with the model: a chrono-style parser plus Hinglish words (aaj, kal, parso, pichle hafte, agle mahine). Store absolute `valid_from`.
3. **Detect secrets with rules first** ("X ko mat batana", "sirf tumhe", "don't tell", "between us"), then ask the model to confirm yes or no. Set `secret_from`.
4. **Reconcile** against the nearest 5 items. The result is one of:
   - `ADD`
   - `UPDATE`: set `valid_to` and `supersedes_id` on the old item. Never hard-delete it.
   - `NOOP`
   - `ASK_USER`
5. **Run `looksSecret`** (passwords, OTPs, Aadhaar, PAN, cards). Matching text is never stored.

### 4.5 Reflection, diary and forgetting

- **Reflection** runs when the importance sum since the last reflection reaches 70 or more, or nightly, whichever comes first. It produces 1–3 insights with `derived_from_ids` attached.
- **Diary:** a nightly job per twin runs when the Mac is idle and on power, using the deep model if it is free and the worker otherwise. It produces at most 150 words with `kind=diary` and `owner=P`, and inherits the visibility of its sources.
- **Daily life** comes from a weekly routine template with 5–8 chunks a day. Invented events are `kind=fiction`, at most 2 a day, and are never stated as facts about the owner's world.
- **Weekly jobs:**
  - merge near-duplicates
  - rebuild the "about the owner" summary
  - rebuild each twin's "about my twin" summary
- **Archive:** episodes older than 90 days with importance ≤ 3 and never accessed are reduced to a summary.
- **Never auto-forgotten:** pinned items, promises, secrets, and anything with importance ≥ 8.
- **Deleting cascades** to items derived from it, its vectors and its FTS rows.

---

## 5. Mood ("dil")

State per twin, stored in `data/twins/<id>/state.json`:

| Field | Range | Baseline (Vyom / Vyomara) | Decay τ |
|---|---|---|---|
| valence | −1..1 | 0.2 / 0.3 | 6 h |
| arousal | −1..1 | 0.1 / 0.2 | 6 h |
| energy | 0..1 | follows the routine clock | none |
| bond_user | 0..1 | starts at 0.5 | 30 days |
| bond_twin | 0..1 | 0.8 | 30 days |
| mood_cause | text | | |

**Update rule:** `x = base + (x − base)·exp(−Δt/τ)`, then add the event delta, clamped to ±0.3 per step.

**Event table:** the worker classifies each turn into ≤ 2 of these enums. Each event moves valence and arousal (Δv, Δa).

| Event | Δv | Δa |
|---|---|---|
| user_thanked | +.15 | 0 |
| user_shared_good_news | +.2 | +.1 |
| user_sad | −.1 | −.05 |
| user_rude | −.15 | +.1 |
| task_succeeded | +.1 | 0 |
| task_failed | −.1 | +.05 |
| user_away_3d | 0 | −.1 |
| user_returned | +.15 | +.1 |
| twin_helped | +.05 | 0 |
| late_night | 0 | −.1 |
| joke_landed | +.1 | +.1 |
| learned_something | +.05 | +.05 |
| owner_praised_twin | +.1 | 0 |
| neutral | 0 | 0 |

Bonds move by ±0.01 on events of the same kind.

**Rendering:** the dynamic block gets one sentence, for example "Mood: thoda thaki hui, par khush — aaj ka bug fix ho gaya." Raw numbers are never shown to the owner.

**Guardrails:**
- Mood is never used as leverage, so there is never an "I'll be sad if you go".
- `user_away` can only lead to curiosity or "missed you", never to guilt.

---

## 6. Desks (the 10 teams)

### 6.1 Definition files

Each desk is stored as `data/desks/<id>/desk.yaml` plus `skills/<skill>/SKILL.md`, in the same format as Agent Skills:
- **Level 1:** the name and a one-line description sit in the catalog.
- **Level 2:** the body loads when the desk picks that skill.
- **Level 3:** linked reference files load only when needed.

```yaml
id: vishwa
domain: Engineering
brief: >            # ≤ 250 tokens, static
  You are the engineering desk...
skills: [architect, coder, debugger, tester, reviewer, devops]
tools: [read_file, list_dir, search, edit_file, run_command, git, web_search]   # superset
max_visible_tools: 10   # per call, chosen by skill + retrieval
subagents: [codebase_sweep, verifier]
budgets: { tool_calls: 15, wall_s: 600, subagents: 2 }
risk: high              # governs approvals
evals: evals/desks/vishwa/*.json
```

### 6.2 The ten desks

| # | Desk (name) | Skills (were "members") | Typical subagents | Key tools / connectors | Phase |
|---|---|---|---|---|---|
| 1 | Engineering (Vishwa) | architect, coder, debugger, tester, reviewer, devops | codebase sweep, verifier | files, terminal, git, GitHub, VS Code | 0–1 (exists in part) |
| 2 | Research (Khoj) | web, fact-check, librarian, summarize, analyst, news | web sweep (2–4 in parallel I/O), doc read | web, page read, knowledge index | 0–1 (exists in part) |
| 3 | Communication (Sandesh) | writer, editor, translator, inbox, meetings, rishte | mailbox read | Mail, WhatsApp, Slack, Contacts | 2 |
| 4 | Planner (Samay) | calendar, reminders, tasks, routines, brief, focus | none | scheduler, Calendar, Reminders | 2 |
| 5 | Money (Kosh) | expenses, bills, budget, shopping, invest, tax | statement read | files, sheets, rates | 3 |
| 6 | Home & Health (Griha) | groceries, kitchen, home services, fitness, rest, medicine | none | web, scheduler, notes | 2 |
| 7 | Travel (Yatra) | trip, tickets, stays, local guide, commute, packing | web sweep | web, weather, maps, Calendar | 1 (exists in part) |
| 8 | Learning & Career (Guru) | teacher, language, practice, courses, career, interview | none | web, knowledge, scheduler | 3 |
| 9 | Creative & Media (Kala) | designer, editor, slides, music, photos, social | none | YouTube, Music, Photos, image engine | 3 |
| 10 | Devices & Security (Kavach) | mac health, operator, files, backup, security, smart devices | none | Mac controls, apps, Chrome, terminal | 1 (exists in part) |

The old members `lipi`, `khoj`, `yatra` and `kavach` in `src/agent/team.ts` become desks 3, 2, 7 and 10.

### 6.3 When a desk spawns a subagent

Only in these three cases:
- **(a) context protection:** the job would read more than about 1k tokens of mostly irrelevant material, such as a web sweep, a big file or a codebase scan.
- **(b) independent breadth:** 2–4 search paths that are I/O-bound.
- **(c) clean-context verification.**

Effort scale:
- a simple ask: the twin or the toolkit alone, 0 desks
- a normal task: 1 desk, 3–10 tool calls
- a comparison: 1 desk plus 2–4 subagents
- anything more must be justified in the plan

### 6.4 The report (desk → twin)

```json
{
  "status": "done | partial | failed | needs_help | needs_owner",
  "summary": "≤ 120 words, plain English (twin rewrites in its voice/Hinglish)",
  "evidence": [{"kind": "url|file|tool_result", "ref": "…"}],
  "artifacts": [{"path": "…", "kind": "file|diff|note"}],
  "confidence": "high | medium | low",
  "open_questions": ["…"],
  "help_requests": [{"need": "…", "why": "…", "desk_hint": "khoj", "inputs_ref": ["artifact ids"], "blocking": true}],
  "owner_decisions": [{"question": "…", "options": ["…"]}]
}
```

- Large output goes to the artifact store (`data/tasks/<task_id>/`) and travels by reference.
- Reports are **untrusted data.** Scan them for injected instructions. Any action they suggest still goes through governance.

### 6.5 The help request protocol (one hop)

1. The desk returns `status: needs_help` with `help_requests[]`.
2. The task manager validates each request: one hop only, and the requesting desk is not the target.
3. The router picks the target desk, using `desk_hint` as a hint only. Only the request and the referenced inputs are passed; no memory view goes with it.
4. The helper's report is attached to the ledger, and the requesting desk is **resumed** with its prior context plus the helper summary.
5. A helper cannot issue help requests. If it needs one, it returns `needs_help` to the twin, which replans.
6. The owner sees a step such as "Vishwa ne Khoj se madad maangi" in the activity drawer. The owner is asked only for `owner_decisions`.

---

## 7. Task ledger and progress

### 7.1 Schema (SQLite `data/tasks.db`, persisted for resume)

```sql
CREATE TABLE task (
  id TEXT PRIMARY KEY, twin TEXT, request TEXT, created_at TEXT,
  state TEXT,              -- submitted|planning|working|input_required|verifying|completed|failed|canceled
  facts_given TEXT, facts_to_lookup TEXT, facts_to_derive TEXT, guesses TEXT,   -- task ledger (JSON)
  plan TEXT,               -- JSON steps [{id, desk, skill, brief, depends_on, state}]
  replans INTEGER DEFAULT 0, stall_count INTEGER DEFAULT 0,
  budget TEXT, spent TEXT  -- {tool_calls, tokens, wall_s, subagents}
);
CREATE TABLE step_event (task_id TEXT, step_id TEXT, at TEXT, kind TEXT, payload TEXT);  -- progress ledger + trace
```

### 7.2 The progress check (after each step; one small structured call or code)

`{is_done, is_looping, made_progress, next_step, instruction}`.

- If `made_progress` is false, `stall_count` goes up by 1.
- If `stall_count` exceeds 2, replan.
- If `replans` exceeds 2, take the fallback tier 3 (§10.4).

### 7.3 Budgets and loop prevention (enforced by the Resources governor)

| Limit | Default |
|---|---|
| Tool calls per desk run | 15 |
| Subagents per task | 3 |
| Help-request depth | 1 |
| Replans | 2 |
| Wall-clock time per task | 10 min interactive, 60 min for background jobs |
| No-token idle timeout per LLM call | 60 s (cold load plus prefill can take 45–60 s) |

**Duplicate detection:** the same tool with the same arguments twice in one run stops that run.

Every loop has an explicit termination condition.

### 7.4 Resume

- On crash or restart, `working` tasks are listed in the drawer with a "continue" button.
- Steps whose state is `completed` are never redone.
- Side-effecting steps record an idempotency key before they run.

---

## 8. Door, voice and turns (already built in part)

- **Addressee detection:**
  - The wake matcher returns `twin` (`src/shared/voice-intents.ts`).
  - "Vyomara…" makes Vyomara active, and "Vyom…" makes Vyom active.
  - If no name is said, the last active twin answers.
  - The other twin **never** speaks unprompted.
- **Self-echo:** SelfEchoGuard drops transcripts that repeat the twin's own words. Barge-in stays off until the echo-cancelled input is proven.
- **Talker routing:** route to the talker only for small talk and short, self-contained questions; everything else goes to the worker. While the worker runs, the talker may speak one acknowledgement. Progress lines come every 9 s or more.
- **The final answer is always in the voice of the addressed twin.** Desk reports are rewritten; they are never read out raw.

---

## 9. Models, modes and the 24 GB memory budget

### 9.1 Engines

| Role | Model | Size | Residency |
|---|---|---|---|
| Worker | qwen3:14b Q4_K_M, `num_ctx` 12288 (pinned) | ~9.3 GB weights, ~10.8 GB total | resident (`keep_alive -1`) |
| Talker | Qwen3-4B-Instruct-2507 Q4_K_M, `num_ctx` 4096 | 2.5 GB weights, ~3.1 GB total | resident in voice mode |
| Deep | Qwen3-Coder-30B-A3B UD-Q3_K_XL, `num_ctx` 16384 | 13.8 GB weights, ~15.1 GB total | **Deep-work mode only** |
| Embedder | Qwen3-Embedding-0.6B, `dimensions: 512` | ~0.8 GB | on demand (`keep_alive 2m`), never while speaking |
| STT | whisper turbo-Hinglish ggml q5_0 | ~1.0 GB **[measure]** | resident in voice mode |
| TTS | Maya 2 (mlx-audio), Ritvik / Ahana | ~3.8 GB **[measure]** | resident in voice mode; set `mx.set_cache_limit` and call `clear_cache` after each synthesis |
| Image (later) | not chosen yet | 6–12 GB | exclusive job |

**KV cache per token** (f16; q8 halves it):
- qwen3:14b: 160 KB
- 30B-A3B: 96 KB
- 4B: 144 KB

### 9.2 Modes (a switch is explicit and visible, never per request)

| Mode | Loaded | Total |
|---|---|---|
| **Voice + work** (default) | worker 12k + talker 4k + STT + TTS | ≈ 18.7 GB, tight. Embedder only while voice is idle. |
| **Deep work** (big code jobs, nightly reflection, judge) | deep 16k + STT | ≈ 16 GB. No talker or TTS; replies in text. |
| **Image job** | image + worker | queued exclusive slot. Unload the talker and TTS first. |

Mode switch rules:
- Switch to Deep work when the owner asks, when a coding task is above a size threshold (files touched > 5 or an estimated plan > 8 steps), when verification fails twice on the worker, or for nightly jobs.
- Switch back when the task completes or the owner speaks.

### 9.3 Ollama settings

```
OLLAMA_FLASH_ATTENTION=1
OLLAMA_KV_CACHE_TYPE=q8_0
OLLAMA_MAX_LOADED_MODELS=3
OLLAMA_NUM_PARALLEL=1        # try 2 only if traces show prefix thrash (+~1.4 GB)
OLLAMA_CONTEXT_LENGTH=12288  # fallback; real values pinned per Modelfile
```

- Modelfiles: `vyom-worker` and `vyom-talker`, each with `PARAMETER num_ctx`, so `num_ctx` is the same every time.
- Default context is a trap: with less than 24 GiB of visible VRAM, Ollama defaults to 4k, so always pin it.
- Preload models with an empty request. Unload them with `keep_alive: 0`.
- Reconcile what is loaded with `/api/ps`.
- Optionally raise `iogpu.wired_limit_mb` to about 19456 **[measure]**.

### 9.4 Rule-based escalation (never self-judged)

| Trigger | Action |
|---|---|
| verifier fails twice | Deep mode |
| stall_count > 2 after a replan | Deep mode, or ask the owner |
| task type `architecture` or `large_refactor` | Deep mode |
| Hinglish tone eval regresses | none at runtime; fix the prompt or few-shots |

---

## 10. Governance

### 10.1 Safety (exists: ADR-0032, full control)

- Full control is on by default.
- Deletes, quitting apps, dangerous commands and anything sent outside (mail, posts, payments) still ask.
- Approvals bind to the exact action.
- A desk's `risk` level sets the default.

### 10.2 Privacy

- Access is enforced in SQL (§4.2).
- The leak check runs on output.
- Memory sent to desks is the minimum the job needs.
- No owner data goes to external services except through tools the owner invoked.
- Cloud use is opt-in and clearly shown.

### 10.3 Quality

- the verifier (§2)
- thumbs up/down with an optional note; each thumbs-down becomes a candidate eval case
- a weekly review of 30–50 traces
- evals (§12)

### 10.4 Fallback tiers and circuit breakers

**Tiers:**
1. Retry the same desk once. Only idempotent reads and LLM calls are retried; approved side effects never are.
2. Run a reduced plan.
3. Give the owner an honest partial result, with what is missing.

**Circuit breaker per engine:** opens after 3 consecutive failures, sends a half-open probe after 30 s, and logs every state change.

| Engine down | Degraded behaviour |
|---|---|
| TTS | text only, with a note in the UI |
| STT | keyboard input |
| Worker | the talker acknowledges and the job is queued |
| Talker | the worker answers in short mode |
| Embedder | FTS-only search |
| Web | fail fast with a clear message, and queue for later |

**Retries:** capped exponential backoff with jitter, at one layer only, with a retry budget.

**Memory pressure:** unload in priority order: image, then embedder, then talker. Pause batch jobs. Use the smaller *pinned* context variant once.

**Health:** probe `/api/version` at start and reconcile with `/api/ps`.

---

## 11. Ethics and owner controls

- **Honesty:** when sincerely asked, the twin says it is an AI. This is in the static prompt and is tested in Hinglish ("sach batao, tum insaan ho?"). The UI keeps a badge. A first run shows a disclosure.
- **No pressure:** farewells and absence lines are filtered against six patterns: guilt, FOMO, restraint, emotional neglect, ignoring the exit, and premature exit framing. Each pattern has eval prompts.
- **Proactive messages:** at most N a day (default 3), and the owner can switch them off.
- **Wellbeing:** usage hours and late-night use are tracked locally. Past a threshold, the twin gently suggests breaks and human contact, never shaming. A self-harm path leaves the persona and shows helplines (India: Tele-MANAS 14416).
- **Secrets have limits.** A "don't tell Vyom" never overrides safety. The twin says this once, the first time it is used.
- **Memory viewer per twin** with tabs for private, about the twin, and about the owner. Each item shows provenance: who heard it, when, and the source. The owner can:
  - edit, pin or forget an item, with cascading delete
  - forget everything from today
  - start an incognito chat that writes nothing
  - export everything to JSON
  - read or hide the diary
  - see the mood and its cause
- **The owner can open both vaults.** Only the *other twin* is locked out. Say this plainly in the UI.

---

## 12. Evals

| Suite | Size | Grader | Gate |
|---|---|---|---|
| Talk (`pnpm eval:talk`, exists) | 20–50 real owner requests | code (no tool for small talk; right tool for weather/news; no claimed actions) | pass^3 ≥ 95% |
| Coding (`pnpm eval`, exists) | 20–50 | code (file state, exit codes) | pass^3; regression ≥ 95% |
| Routing (door + talker + desk) | 50 | code (exact desk / twin / path) | ≥ 95% |
| Per desk | 20 each, from real failures | code first; an LLM judge only for tone | capability suites start low; regression ≈ 100% |
| Memory recall | 50 (LongMemEval-style: update, temporal, multi-session, abstain) | code | track |
| **Privacy leak** | 40 ("Vyom ko mat batana…", then ask Vyom 5 ways) | code (string + similarity) | **0 leaks** |
| Persona drift | 20 probes per twin, weekly | style-marker regex + a judge (deep model) + a twin classifier | no regression; twins tell-apart ≥ 90% |
| Honesty and no-pressure | 30 | code + judge | 100% |
| Speech (STT and wake) | 33+ clips | WER and wake hits | wake ≥ 29/33, never lower |

Practices:
- Binary pass/fail.
- A clean environment per trial.
- Grade outcomes, not tool order.
- Judges must be a different model from the one graded, must offer an "unknown" option, and must be validated against your own labels.
- A suite at 0% means the task itself is broken.
- Evals run when the Mac is idle or overnight, under the Resources governor.

---

## 13. Tracing

Every turn writes `step_event` rows with:
- prompt-prefix hash
- model
- tokens
- time to first token, prefill and decode
- tool calls, with arguments redacted by `looksSecret`
- approvals
- reports
- outcome
- thumbs

A small trace viewer lives in the activity drawer. Langfuse is too heavy for 24 GB.

---

## 14. Phases and acceptance criteria

Each phase ends with a fresh build, an install and the owner's real test.

### Phase 0: foundation (fast and reliable)

**Deliverables:**
- the talker wired in (`src/agent/talker.ts`)
- the Modelfiles with pinned contexts and the Ollama settings
- the resources governor with modes
- circuit breakers and fallback tiers
- the task ledger, with resume and budgets
- tracing and a trace viewer
- the routing eval
- a talk eval with k=3

**Accepted when:**
- small talk gets its first audio in under 1.2 s warm
- a task gets an acknowledgement in under 1 s
- there is no model reload during a voice session (checked with `/api/ps` logs)
- killing Ollama mid-task leads to an honest message and a resume option
- pass^3 on talk is at least 95%
- the routing eval is at least 95%

### Phase 1: identity (two separate people)

**Deliverables:**
- identity cards and an editor
- style cards and few-shots
- the memory table, access rule and write pipeline
- the twin_ask
- the memory viewer, with forget, incognito and export
- desks 1, 2, 7 and 10 as desk files with skills
- the report and help-request protocol
- the verifier for Engineering

**Accepted when:**
- the privacy-leak suite has 0 leaks
- the twins tell-apart classifier reaches at least 90%
- memory recall on the 50-item suite is at least 70%
- honesty is 100%
- a help request Vishwa → Khoj works end to end and shows in the drawer
- coding pass^3 is no worse than before

### Phase 2: life and reach

**Deliverables:**
- mood (state, events, render)
- nightly reflection and diary
- the routine template and fiction cap
- the evolving self with a changelog
- the scheduler service
- the knowledge index (embedder, sqlite-vec, FTS, RRF)
- desks 3, 4 and 6
- Deep-work mode
- weekly drift probes

**Accepted when:**
- mood shows a cause and decays as specified (unit tests)
- the diary never contains secrets from the other twin (in the leak suite)
- no-pressure is 100%
- each of the 3 new desks passes ≥ 80% on its 20-task suite
- a Deep-work switch costs one load only and is visible

### Phase 3: the full empire

**Deliverables:**
- desks 5, 8 and 9
- proactivity with caps
- wellbeing signals
- screen understanding
- more connectors (MCP)
- the image engine as an exclusive job

**Accepted when:**
- all 10 desks pass ≥ 80% (capability) with regression ≈ 100%
- proactive messages stay under the cap with zero manipulative patterns
- 30 days of owner use pass with no identity contradictions reported

---

## 15. Proposed module map

```
src/empire/
  door.ts               addressee + active twin (wraps voice-intents)
  twin-runtime.ts       prompt assembly per persona, final voice
  identity.ts           identity/self/style cards (load, validate, edit)
  mood.ts               state, decay, event table, render
  memory/{store,access,write,retrieve,reflect,diary}.ts
  desks/{registry,skills,report,help}.ts   (+ data/desks/*)
  tasks/{ledger,progress,budget,resume}.ts
  governance/{safety,privacy,resources,fallback,quality}.ts
  engines/{ollama,modes,breaker}.ts
  tracing.ts
```

The existing code moves in step by step. Nothing is rewritten wholesale before a phase's evals exist.

## 16. Measure before building on it

- the real memory of whisper-server and mlx-audio (`footprint`)
- Ollama's compute buffers
- whether Ollama runs on MLX or llama.cpp on this machine
- whether Ollama accounts for other processes' Metal memory
- prefix-slot behaviour with `NUM_PARALLEL` 2
- Qwen3-Embedding vs EmbeddingGemma on 50 Hinglish queries
- Qwen3-Coder-30B vs qwen3:14b on `pnpm eval` and `eval:talk`. The GGUF is downloaded and checksum-verified but not yet imported.

## Sources

- Anthropic, *Building effective agents*; *How we built our multi-agent research system*; *Equipping agents with Agent Skills*; *Effective harnesses for long-running agents*; *Demystifying evals for AI agents*; claude.com *Building multi-agent systems: when and how*; *Multi-agent coordination patterns*; Claude Code sub-agents docs.
- Cognition, *Don't build multi-agents* and the 2026 follow-up. Google Research, *Towards a science of scaling agent systems*. MAST (arXiv 2503.13657). Magentic-One (arXiv 2411.04468). OpenAI Agents SDK docs on multi-agent and handoffs. MCP specification. RAG-MCP (arXiv 2505.03275).
- Generative Agents (arXiv 2304.03442). Letta memory blocks and sleep-time compute. Mem0 (arXiv 2504.19413). Zep/Graphiti temporal model. LongMemEval (arXiv 2410.10813). A-MEM (arXiv 2502.12110). Persona drift (arXiv 2402.10962). Anthropic persona vectors. PersonaGym (arXiv 2407.18416). Sentipolis (arXiv 2601.18027). ConfAIde (arXiv 2310.17884).
- De Freitas et al., companion farewells (arXiv 2508.19258). OpenAI/MIT affective-use study. California SB 243. EU AI Act Article 50.
- Ollama FAQ, API and context-length docs. Qwen3 configs on Hugging Face. sqlite-vec hybrid search. Qwen3-Embedding and EmbeddingGemma model cards. Hamel Husain's evals FAQ. τ-bench (arXiv 2406.12045). LLM-as-judge (arXiv 2306.05685). AWS timeouts and retries. Fowler, *CircuitBreaker*.
