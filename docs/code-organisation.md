# Code organisation: today's map, the target layout, and the path to the empire

Status: analysis and plan (2026-11-24). No code has moved yet.

This document has three parts:
1. **Where everything is today**, so anyone can find code.
2. **What is wrong with the current shape**, from an analysis of the code on `dev/version2` at `ec69f1a`.
3. **The target modular layout and the order of work**: first reorganise without changing behaviour, then build the empire padaav by padaav.

The empire itself is specified in [empire-spec.md](./empire-spec.md) (picture: [empire-design.html](./empire-design.html)). Section 15 of the spec proposed a `src/empire/` folder. This document replaces that proposal with a full layout for the whole codebase.

---

## 1. Today's map (where is what)

The codebase has about 22,300 lines of TypeScript across 95 source files, 44 test files and 10 scripts.

### Entry points

| File | Lines | What it is |
|---|---|---|
| `src/main/index.ts` | 1600 | The Electron main process: windows, PiP, 46 IPC handlers, voice and speech wiring, approvals, settings files, model warm-up and MCP. Almost all of the desktop's glue lives here. |
| `src/preload/index.ts` | 236 | The typed `window.vyomara` bridge. |
| `src/renderer/src/ui/App.tsx` | 2075 | The whole main window UI in one component: chat, composer, history, voice, persona, approvals, plan, activity drawer, panels. It has 51 `useState` and 17 `useEffect` calls. |
| `src/cli.ts` | 470 | The terminal app (`pnpm dev`), with terminal approvals and storage commands. |

### Agent (the brain today)

| File | Lines | What it holds |
|---|---|---|
| `src/agent/agent.ts` | 1132 | `runAgent` and the 370-line `runAgentTask` loop. Also: about 20 prompt/reply heuristics (`isSmallTalk`, `asksForCurrentInfo`, `claimsActionDone`, `missingLookup`, …) with their nudge texts, `describeToolCall`, `verifiedAction`, `runExplorer`, `runTeamMember`, `summarizeEarlierTurns`, `prepareTurn` and `primeAgent`. |
| `src/agent/system-prompt.ts` | 379 | The static system prompt and `buildTurnContext` (persona, character, per-turn facts). |
| `src/agent/context.ts` | 97 | Fits history into the context window. |
| `src/agent/project-extras.ts` | — | Project conveniences (project notes, hooks), as in Claude Code. |
| `src/agent/team.ts` | — | The four inner team members: khoj, yatra, kavach and lipi. |
| `src/agent/talker.ts` | 91 | **Untracked draft.** The fast talker (`routeRequest`, `runTalker`). |

### Tools

| File | Lines | What it holds |
|---|---|---|
| `src/tools/contracts.ts`, `executor.ts`, `policy.ts`, `default-tools.ts` | ~550 | The registry, executor (validation, timeouts, `coerceToSchema`), effect policy, and default registration. |
| `src/tools/filesystem-tools.ts` | 1621 | Path safety, plus list, read, tree, search, text search and edit tools, all in one file. |
| `src/tools/action-tools.ts` | 1124 | Approval memory and grants, the shell, apps, URLs, browser, web search and news. Ports and tools are mixed together. |
| `src/tools/utility-tools.ts` | 719 | Time zones, calculator, units, dates, system info, weather, currency and package versions. |
| `src/tools/git-tools.ts` | 474 | Git tools. |
| `mcp-client.ts`, `mcp-tools.ts` | 419 | MCP servers. |
| `command-runner.ts` | 263 | The shell runner. |
| `web-client.ts` | 235 | The HTTP client for web tools. |
| `plan-tool.ts`, `memory-tool.ts`, `explore-tool.ts`, `delegate-tool.ts` | — | Agent-internal tools. |
| `system-tool.ts`, `problems-tool.ts`, `vscode-tool.ts` | — | Mac and IDE tools. |

### Providers, storage, app service

| File | Lines | What it holds |
|---|---|---|
| `src/providers/provider.ts` | 839 | The `ModelProvider` port, the whole Ollama adapter (streaming, tools, think, keep-alive, pull, list) and a placeholder provider. |
| `src/storage/sqlite-store.ts` | 941 | One store class: migrations, sessions, memory, audit, settings, usage and backups. |
| `src/storage/memory-store.ts` | 142 | Fact memory, `relevant()` and `looksSecret`. |
| `src/app/application.ts` | 288 | `runRequest`, `createProvider`, `createTools`, sessions, model settings. Shared by the CLI and the desktop. |
| `src/session/session.ts`, `src/tasks/task-run.ts`, `src/types.ts`, `src/config/config.ts`, `src/diagnostics/*` | — | Session messages, task lifecycle, shared types, config, logging. |

### Desktop (main-process services) and voice

| Area | Files |
|---|---|
| Approvals and safety | `action-approval.ts`, `file-operation-approval.ts`, `full-control.ts`, `change-journal.ts`, `vscode-diff.ts` |
| Mac connectors | `mac-application-launcher.ts`, `mac-system-control.ts`, `chrome-browser.ts`, `usage-sampler.ts` |
| Hearing (STT) | `local-whisper.ts`, `whisper-server.ts`, `hinglish-model.ts` |
| Speaking (TTS) | `mac-speech.ts`, `natural-voice.ts`, `speech-queue.ts`, `self-echo.ts` |
| IPC | `contracts.ts` (339 lines; every desktop type in one file), `validation.ts`, `session-export.ts`, `ui-scale.ts` |
| Shared, renderer-safe voice logic (in `src/shared/`) | `voice-intents.ts` (wake and twin), `phrase-detector.ts`, `turn-taking.ts`, `clause-stream.ts`, `hinglish-match.ts`, `hinglish-devanagari.ts`, `acknowledgement.ts`, `persona.ts` |
| Other shared helpers | `bounded.ts`, `diff.ts`, `text-replace.ts`, `html-text.ts`, `rss.ts`, `link-alias.ts`, `link-check.ts` |

### Renderer

- `App.tsx`: see the entry points above.
- Panels: `models-panel`, `permissions-panel`, `memories-panel`, `approvals`, `pip`, `brand` and `markdown`.
- Audio: `voice-capture`, `voice-dictation`, `speech-player` and `earcon`.
- `activity.ts`.
- One `styles.css`.

### Scripts and tests

- `scripts/`: the desktop launcher, packaging, smoke test, voice and Hinglish setup, `eval-agent.ts` and `eval-conversation.ts`.
- `test/`: 44 flat `*.test.ts` files. Their names roughly match the source files.
- Two result files sit in the repo root (`eval-results.json`, `eval-talk-results.json`).

---

## 2. What is wrong today

| # | Problem | Evidence | Why it hurts the empire |
|---|---|---|---|
| 1 | **Four giant files hold most of the logic** | `App.tsx` 2075, `main/index.ts` 1600, `filesystem-tools.ts` 1621, `agent.ts` 1132, `action-tools.ts` 1124 lines | Nobody can read them in one sitting, and every feature touches them, which causes merge conflicts and makes regressions hard to see. CONTRIBUTING already names two of them as split candidates. |
| 2 | **The main process is a bag of global state** | about 40 module-level `let`/`const` singletons (voice, persona, approvals, MCP, PiP, speech, config) and 46 IPC handlers in one file | Twins, modes, the ledger and breakers all need clear owners. Global state makes them impossible to test. |
| 3 | **One huge component for the UI** | 51 `useState` in `App` | The memory viewer, ledger drawer, mood line and identity editor have no place to live. |
| 4 | **The agent loop is mixed with heuristics** | about 20 regex detectors and nudge texts sit beside the loop in `agent.ts`; `runAgentTask` is 370 lines | The empire adds a door, talker, router, desks and a verifier. Each must be its own module, not more `if`s in one function. |
| 5 | **Dependencies point the wrong way** | `shared → agent` (`acknowledgement.ts` imports `team.ts`), `tools → agent` (`delegate-tool`), `tools ↔ desktop` (12 and 3 imports), `tools → storage`, and `main` imports 22 desktop modules directly | No clean layering, so changing one part breaks distant ones. `shared` is supposed to be the bottom layer. |
| 6 | **Folders are by technical type, not by feature** | voice code is split across `desktop/`, `shared/` and `renderer/`; approvals across `tools/action-tools.ts` and `desktop/` | To understand "hearing" you must open 8 files in 3 folders. |
| 7 | **God files for types and storage** | `desktop/contracts.ts` (all IPC types), `sqlite-store.ts` (all tables) | The memory table, ledger and desks will each add tables and types. |
| 8 | **Team members live in code** | `team.ts` has hard-coded briefs | The spec makes desks and skills *data* (`desk.yaml` + `SKILL.md`) so they can grow without code changes. |
| 9 | **The project rule conflicts with the talker** | CONTRIBUTING says "No routing by regex", but `talker.ts`'s `routeRequest` routes by regex | This needs an ADR: bounded routing that always falls back to the worker, or a model-based classifier. |
| 10 | **Tests and evals are flat** | 44 tests in one folder; evals in `scripts/` with results in the repo root | The spec adds suites per desk and per risk (privacy, drift, honesty). They need a home and a runner. |

What is good and stays:
- strict TypeScript, ports, typed errors, bounds everywhere
- `node:test` with scripted providers
- tool contracts and the effect policy
- the renderer-safe `shared/` idea
- the ADR habit

---

## 3. Target layout

### 3.1 Principles

1. **Organise by feature (vertical slices), named after the empire.** A newcomer looking for "mood" finds `src/empire/twins/mood.ts`. Looking for "hearing", they find `src/voice/hearing/`.
2. **Every module folder has a `README.md`** of 3–10 lines (what it does, its public API, what it may import) **and an `index.ts`** that is the only file other modules import.
3. **Dependencies flow one way.** Lower layers never import higher ones. A test (`test/architecture.test.ts`) enforces this by parsing imports, so the rule cannot rot.
4. **Size limits:** a file stays under ~400 lines and a function under ~60. When one grows past that, split it.
5. **Data lives outside code:** desks, skills, identity cards and eval cases are files under `data/` and `evals/`.
6. **Moving and changing are separate commits.** Moves use `git mv` and change nothing else, so history and blame survive.

### 3.2 Layers (lowest first)

```
L0  core        pure helpers + shared types/errors; no Node, renderer-safe
L1  storage     SQLite, migrations, one repository per table group
L1  engines     models: llm (ollama), talker, deep, embed; stt; tts; modes; breakers
L1  connectors  Mac, Chrome, VS Code, MCP, web client (talk to the outside world)
L2  tools       tool contracts + registry + executor + tool groups (use connectors via ports)
L2  voice       turn-taking, wake/door matching, echo, speech queue (renderer-safe parts in voice/shared)
L3  agent       the loop, prompts, context, nudges, verifier
L4  empire      door, twins (identity, mood, twin_ask), memory, ledger, desks, governance
L5  app         request service: wires empire + agent + tools for one request
L6  main / cli  Electron main (windows, ipc/*), CLI; preload bridge
--  renderer    React UI; imports only core and ipc contracts
```

Rule: a module may import its own layer or any lower one, but only through that module's `index.ts`. `renderer` may import only `core` and `main/ipc/contracts`.

### 3.3 The tree

```
src/
  core/                     L0  (today: most of src/shared, types.ts, errors)
    text/  bounded.ts diff.ts text-replace.ts html-text.ts rss.ts link-alias.ts link-check.ts
    hinglish/  match.ts devanagari.ts           (from shared/hinglish-*.ts)
    persona.ts  types.ts  errors.ts
  storage/                  L1
    db.ts migrations/  sessions.ts settings.ts audit.ts usage.ts backups.ts   (split sqlite-store.ts)
    memory-items.ts ledger.ts                    (new tables, padaav 0–1)
  engines/                  L1
    llm/  provider.ts ollama/{client,stream,tools,models}.ts  placeholder.ts   (split provider.ts)
    talker.ts  modes.ts  breaker.ts  embed.ts     (padaav 0–2)
    stt/  whisper-server.ts local-whisper.ts hinglish-model.ts polish.ts
    tts/  mac-speech.ts natural-voice.ts maya.ts kokoro.ts
  connectors/               L1
    mac/  launcher.ts system-control.ts usage-sampler.ts
    chrome.ts  vscode/{diff,tool-port}.ts  mcp/{client,servers}.ts  web/client.ts  shell/runner.ts
  tools/                    L2
    contracts.ts registry.ts executor.ts policy.ts schema.ts   (coerceToSchema)
    filesystem/  paths.ts list.ts read.ts tree.ts search.ts text-search.ts edit.ts   (split 1621 lines)
    actions/     approvals-memory.ts shell.ts apps.ts browser.ts urls.ts   (split action-tools)
    web/         search.ts news.ts fetch.ts weather.ts
    utility/     time.ts calc.ts units.ts dates.ts system-info.ts currency.ts versions.ts
    git/  mcp/  system/  problems/
    agent/       plan.ts memory.ts explore.ts delegate.ts   (tools the agent uses on itself)
  voice/                    L2
    shared/      phrase-detector.ts turn-taking.ts clause-stream.ts wake.ts (voice-intents) acknowledgement.ts
    speech-queue.ts self-echo.ts
  agent/                    L3
    loop/        run.ts turn.ts tool-step.ts finish.ts verified-actions.ts   (split runAgentTask)
    prompt/      system-prompt.ts turn-context.ts
    nudges/      small-talk.ts lookup.ts claims.ts plan.ts language.ts       (the ~20 heuristics + texts)
    context.ts  project-extras.ts  describe-tool-call.ts  verifier.ts (padaav 1)
  empire/                   L4  (new; built padaav by padaav, see §4)
    door/        addressee.ts active-twin.ts
    twins/       runtime.ts identity.ts style.ts mood.ts self.ts twin-ask.ts
    memory/      access.ts write.ts retrieve.ts reflect.ts diary.ts forget.ts leak-check.ts dates.ts secrets.ts
    ledger/      ledger.ts progress.ts budget.ts resume.ts
    desks/       registry.ts skills.ts report.ts help-requests.ts subagents.ts router.ts
    governance/  safety/ (full-control, approvals, change-journal)  privacy.ts  resources.ts  fallback.ts  quality.ts
  app/                      L5
    request.ts sessions.ts model-settings.ts create-tools.ts
  main/                     L6
    index.ts                 boot only (<150 lines)
    state.ts                 one typed AppState object instead of ~40 globals
    windows/  main-window.ts pip-window.ts zoom.ts
    ipc/      contracts/ (split desktop/contracts.ts per feature)  validation.ts
              chat.ts voice.ts speech.ts approvals.ts models.ts sessions.ts memory.ts settings.ts pip.ts mcp.ts
    services/ live-speech.ts audio-bridge.ts warm-up.ts settings-files.ts
  preload/  index.ts
  cli/      index.ts terminal-input.ts approvals.ts storage-commands.ts   (split cli.ts)
  renderer/src/
    app/      App.tsx (layout + providers only, <200 lines)  store.ts (useReducer or context)
    features/ chat/ composer/ history/ voice/ persona/ approvals/ plan/ activity/
              panels/{models,permissions,memories}/  pip/  (later: memory-viewer/ ledger/ identity-editor/ mood/)
    ui/       brand.tsx markdown.tsx earcon.ts
    styles/   tokens.css glass.css layout.css + one css file per feature
data/                       desks/<id>/{desk.yaml,skills/*/SKILL.md}  twins/<id>/identity.yaml
evals/                      runner.ts  suites/{talk,coding,routing,privacy,drift,honesty,memory,desks/*}/  results/ (gitignored)
test/                       mirrors src/: test/core/…, test/agent/…, test/empire/…  + architecture.test.ts
```

### 3.4 What happens to each current file

**Legend:**
- **M** = move only (no code change)
- **S** = split into several files
- **R** = rewrite or replace (behaviour change, done only inside a padaav)
- **K** = keep where it is

| Current | Action | Target |
|---|---|---|
| `main/index.ts` | **S** | `main/index.ts` (boot), `main/state.ts`, `main/windows/*`, `main/ipc/*`, `main/services/*` |
| `renderer/src/ui/App.tsx` | **S** | `renderer/src/app/*` + `features/*`; state moves into a reducer store |
| `renderer/src/ui/styles.css` | **S** | `renderer/src/styles/*` |
| other `renderer/src/ui/*` panels | **M** | `features/<name>/` |
| `agent/agent.ts` | **S** | `agent/loop/*`, `agent/nudges/*`, `agent/describe-tool-call.ts`; `runTeamMember` goes to `empire/desks/subagents.ts` |
| `agent/system-prompt.ts` | **S** | `agent/prompt/system-prompt.ts` + `turn-context.ts` |
| `agent/team.ts` | **R** (padaav 1) | becomes `data/desks/*` + `empire/desks/registry.ts` |
| `agent/talker.ts` (untracked) | **M** + finish (padaav 0) | `engines/talker.ts` + `empire/door/` routing; needs an ADR (problem 9) |
| `tools/filesystem-tools.ts` | **S** | `tools/filesystem/*` |
| `tools/action-tools.ts` | **S** | `tools/actions/*`, `tools/web/*`; the ports go to `connectors/` |
| `tools/utility-tools.ts` | **S** | `tools/utility/*`; weather and currency go to `tools/web/` |
| `tools/mcp-client.ts`, `web-client.ts`, `command-runner.ts` | **M** | `connectors/mcp`, `connectors/web`, `connectors/shell` |
| `tools/delegate-tool.ts` | **R** (padaav 1) | `tools/agent/delegate.ts` → desk call returning a `Report` |
| other `tools/*` | **M** | their group folder |
| `providers/provider.ts` | **S** | `engines/llm/*` |
| `storage/sqlite-store.ts` | **S** | `storage/db.ts` + one repository per table group |
| `storage/memory-store.ts` | **R** (padaav 1) | `storage/memory-items.ts` + `empire/memory/*`; `looksSecret` goes to `empire/memory/secrets.ts` |
| `desktop/local-whisper.ts`, `whisper-server.ts`, `hinglish-model.ts` | **M** | `engines/stt/` (`polishTranscript` goes to `stt/polish.ts`) |
| `desktop/mac-speech.ts`, `natural-voice.ts` | **M** / **S** | `engines/tts/` |
| `desktop/speech-queue.ts`, `self-echo.ts` | **M** | `voice/` |
| `desktop/*-approval.ts`, `full-control.ts`, `change-journal.ts` | **M** | `empire/governance/safety/` |
| `desktop/mac-*.ts`, `chrome-browser.ts`, `usage-sampler.ts`, `vscode-diff.ts` | **M** | `connectors/` |
| `desktop/contracts.ts`, `validation.ts` | **S** | `main/ipc/contracts/*`, `main/ipc/validation.ts` |
| `desktop/ui-scale.ts`, `session-export.ts` | **M** | `main/windows/zoom.ts`, `app/sessions.ts` |
| `shared/voice-intents.ts`, `phrase-detector.ts`, `turn-taking.ts`, `clause-stream.ts`, `acknowledgement.ts` | **M** | `voice/shared/`; `acknowledgement` loses its `team.ts` import, so it gets desk names from data |
| other `shared/*` | **M** | `core/` |
| `app/application.ts` | **S** | `app/request.ts`, `sessions.ts`, `model-settings.ts`, `create-tools.ts` |
| `cli.ts` | **S** | `cli/*` |
| `session/`, `tasks/task-run.ts`, `config/`, `diagnostics/` | **K** for now; `task-run` is absorbed by `empire/ledger` (padaav 0) | |
| `scripts/eval-*.ts` | **M** | `evals/` with one runner; results gitignored |
| `test/*.test.ts` | **M** | mirror the new `src/` tree |

---

## 4. Order of work

### Step R: reorganise (no behaviour change)

Do this before any empire code, in small commits. After **every** commit:
- `pnpm check` and `pnpm test:desktop-ui` must pass
- `pnpm eval` and `pnpm eval:talk` must match the last results

| # | Commit | Risk |
|---|---|---|
| R1 | Add `test/architecture.test.ts` (layer rule, initially allow-listing today's violations) and a `README.md` per top-level folder | none |
| R2 | Move `shared/*` → `core/` and `voice/shared/`; fix the `shared → agent` import | low |
| R3 | Split `providers/provider.ts` → `engines/llm/*`; move STT and TTS files to `engines/` | low |
| R4 | Split `tools/filesystem-tools.ts`, `action-tools.ts` and `utility-tools.ts` into groups; move clients to `connectors/` | medium (big files, but pure moves) |
| R5 | Split `agent/agent.ts` into `loop/`, `nudges/`, `prompt/` and `describe-tool-call.ts` | medium |
| R6 | Split `main/index.ts`: `state.ts`, `windows/`, `ipc/*` (one file per feature), `services/` | medium |
| R7 | Split `App.tsx` into `features/*` with one reducer store; split the CSS | medium (run the UI smoke test and do a manual check) |
| R8 | Split `sqlite-store.ts`, `cli.ts` and `application.ts`; move the evals to `evals/`; mirror the tests | low |
| R9 | Remove the allow-list from the architecture test: zero violations | none |

**Done when:**
- no source file is over ~500 lines
- the architecture test has no allow-list
- every folder has a README
- all checks and evals are unchanged

### Before padaav 0: decisions to record as ADRs

- **ADR-0033 Empire architecture.** Record the spec's decisions: desks plus skills, agent-as-tool, one hop, the ledger, memory access in SQL, code-owned mood, rule-based escalation and modes.
- **ADR-0034 Talker routing.** Amend "No routing by regex". Routing to the talker is allowed only as a bounded decision that always falls back to the worker when in doubt, and never blocks a task. Desk choice stays with the model (structured output).

### The padaav, mapped to modules

| Padaav | New or changed modules | Acceptance (from spec §14) |
|---|---|---|
| **0 Neev** | `engines/{talker,modes,breaker}.ts`, the Modelfiles, `empire/ledger/*` + `storage/ledger.ts`, `empire/governance/{resources,fallback}.ts`, tracing (`step_event`), `evals/suites/routing` | small talk first audio < 1.2 s warm; no reload in voice; honest resume after a crash; talk pass^3 ≥ 95%; routing ≥ 95% |
| **1 Pehchaan** | `data/twins/*`, `empire/twins/{identity,style,runtime,twin-ask}.ts`, `empire/door/*`, `storage/memory-items.ts` + `empire/memory/{access,write,retrieve,secrets,dates,leak-check}.ts`, `data/desks/{vishwa,khoj,yatra,kavach}`, `empire/desks/*`, `agent/verifier.ts`, renderer `features/memory-viewer` | 0 privacy leaks; twins tell-apart ≥ 90%; honesty 100%; recall ≥ 70%; Vishwa→Khoj help request end to end |
| **2 Zindagi** | `empire/twins/{mood,self}.ts`, `empire/memory/{reflect,diary,forget}.ts`, `engines/embed.ts` + sqlite-vec/FTS, scheduler service, Deep-work mode, `data/desks/{sandesh,samay,griha}`, renderer `features/{mood,ledger,identity-editor}`, `evals/suites/drift` | no-pressure 100%; new desks ≥ 80%; no secrets in diaries |
| **3 Saltanat** | `data/desks/{kosh,guru,kala}`, proactivity and wellbeing in `governance/quality.ts`, screen vision engine, more MCP connectors, image engine | all desks ≥ 80%; 30 days without identity contradictions |

---

## 5. UI: what to remove, what to change, what to add

The basis for this section:
- an analysis of today's main window (`App.tsx`, `styles.css`, the screenshot in `docs/assets/screenshots/home-models.png`)
- the owner's feedback (corner space was wasted; it must fit both the laptop and an extended monitor; a glass look like Stonic; only the twins face the user)
- the empire spec

**Step R7** only splits the code. The screen looks the same afterwards. The redesign below happens inside the padaav, one feature at a time.

### 5.1 What the window has today

- **Top bar:** app icon + wordmark, and a "Local Ollama · qwen3:14b" chip.
- **Left sidebar:**
  - an "Assistant" dropdown (Vyom/Vyomara)
  - Tasks & Activity, Approvals, Models, Permissions, Memories, History
  - a Mini Vyom toggle
  - New conversation
- **Centre:**
  - a marketing-style welcome ("Your personal AI assistant", "Tell Vyom what you need.", a paragraph, "AI Twins. One Orbit. Your Control.")
  - the orb with decorative waveform bars on both sides
  - the composer
- **Right:** one panel at a time (Models, Permissions, Memories, Activity) that pushes the chat aside.

### 5.2 Remove or demote

| What | Why | Where it goes |
|---|---|---|
| Welcome copy: kicker, headline, paragraph, tagline | It is a website hero, not an assistant. It repeats the brand and wastes the centre of the screen. | Replace with the **twin stage** (5.3) and up to 3 suggestions that depend on context (time of day, an unfinished task, today's reminders). |
| A second brand mark (icon + wordmark + tagline) | It appears twice and eats header height. | One small mark in the rail. The window title carries the name. |
| "Local Ollama · qwen3:14b" chip | Technical detail; the twins choose models. | A **health dot** (green, amber or red) plus the current mode (Voice / Deep work). Details on hover and in Saltanat. |
| "Assistant" dropdown with a chevron | A menu hides the fact that there are two people, and the door selects by name anyway. | **Two twin avatars** on the stage. Click one, or say its name. |
| Approvals as a nav destination | Approvals belong where the work happens. | Inline cards in the conversation, plus a badge on the ledger. |
| Models and Permissions in the main nav | Settings, not daily use. | One **Saltanat** page (5.3). |
| Mini Vyom toggle in the sidebar | A setting. | Saltanat → Voice, plus the menu-bar icon. |
| Waveform bars beside the orb | Decoration that duplicates the orb. | The twin avatar itself reacts to voice. |
| A fixed reading column on big monitors | The owner's "corner space barbad" complaint. | A fluid layout (5.4). |

### 5.3 Add

| Feature | What the owner sees | Padaav | Folder |
|---|---|---|---|
| **Twin stage** | Two characters side by side (Vyom blue, Vyomara violet). The addressed twin is lit and the other is dimmed. Each shows a state (listening, thinking, speaking, idle), a small **AI badge** and the live caption while speaking. In padaav 2 the mood line appears under the active twin. This is where the hologram (roadmap milestone 6) will live. | 1 (mood line: 2) | `features/twin-stage/` |
| **Door feedback** | When a name is heard, that twin lights up within 200 ms, before any reply, so the owner knows who is answering. | 1 | `features/twin-stage/` |
| **Bahi-khata drawer** | It replaces "Tasks & Activity". It shows: <ul><li>the current farmaan and its steps</li><li>which vibhaag (mantri) is working and with which hunar</li><li>help requests ("Vishwa ne Khoj se madad maangi")</li><li>budget used</li><li>owner decisions as buttons</li><li>a **Continue** button after a crash</li></ul> | 0 | `features/ledger/` |
| **Inline decision cards** | Approvals and `owner_decisions` appear in the chat at the point they arise, with the exact action shown. | 0 | `features/approvals/` |
| **Reply feedback** | 👍/👎 plus an optional note on every reply. Each 👎 becomes an eval candidate. | 0 | `features/chat/` |
| **Yaad-khana viewer** | It replaces "Memories". It has one tab per twin (Niji, About the twin, About you). Each item shows provenance: who heard it, when, and the source. The owner can: <ul><li>edit, pin and forget items</li><li>forget everything from today</li><li>export everything</li></ul> The page says plainly that the owner can open both vaults. | 1 | `features/memory/` |
| **Incognito switch** | In the composer: this conversation writes no memory. | 1 | `features/composer/` |
| **Pehchaan-patra editor** | Edit each twin's identity card and style card, with a preview line in that twin's voice. The changelog of the evolving self, with revert. | 1 (changelog: 2) | `features/identity/` |
| **Diary** | Read or hide each twin's diary. | 2 | `features/memory/` |
| **Saltanat page** | One place for: <ul><li>**Engines:** the mode switch Voice ⇄ Deep work, and a 24 GB memory bar showing what is loaded</li><li>breaker status per engine</li><li>models (today's Models panel)</li><li>voices</li><li>permissions and full control</li><li>privacy and data</li><li>Mini Vyom</li><li>proactivity caps</li></ul> | 0 (grows each padaav) | `features/saltanat/` |
| **Onboarding** | A short first run voiced by both twins: who they are, that they are AI, privacy, and the mic test. | 1 | `features/onboarding/` |
| **Command palette (⌘K)** and shortcuts | Jump to any conversation, memory, setting or twin. | 1 | `features/palette/` |
| **Visual hub** (later) | Structured results (budgets, trip plans, comparisons) drawn as cards and charts instead of long text. | 3 | `features/visual/` |

### 5.4 Layout that fits the laptop and the extended monitor

```
┌ rail ┐┌──────────── centre ────────────┐┌─ drawer ─┐
│ Baat ││  twin stage (Vyom  ·  Vyomara)  ││ Bahi-    │
│ Bahi ││  conversation (fluid, ≤ 960px   ││ khata /  │
│ Yaad ││  text, cards may go wider)      ││ Yaad /   │
│ Itih.││  composer (incognito · mic)     ││ Saltanat │
│ Salt.││                                 ││          │
└──────┘└─────────────────────────────────┘└──────────┘
```

- **Under 1100 px (laptop):**
  - The rail shows icons only.
  - The drawer is an overlay.
  - The twin stage shrinks to a strip above the chat.
- **1100–1600 px:** the rail has labels and the drawer can be pinned.
- **Above 1600 px (external monitor):**
  - The drawer is pinned by default, so the ledger is always visible.
  - The stage is larger.
  - Cards and code blocks can use the extra width.
- `uiZoomFor` stays in place for density. Check every change with screenshots at 860, 1024, 1440 and 1920 widths.

**Rail labels.** The labels use the empire words with English tooltips:
- Baat (chat)
- Bahi-khata
- Yaad-khana
- Itihaas (history)
- Saltanat

The owner should confirm this choice on the first build.

### 5.5 Design system

- **Tokens:** move colours, glass blur, radius, spacing and motion into `styles/tokens.css`. Each twin has a colour pair (Vyom blue, Vyomara violet) for light and dark, and these are the only accent colours.
- **One glass recipe**, applied only to floating surfaces (the drawer, cards, the composer). The conversation text sits on a solid background so it stays readable.
- **Motion** only shows state (listening, speaking, working). Respect `prefers-reduced-motion`.
- **Text on screen** is always Roman Hinglish or English, never Devanagari.
- **The UI smoke test** (`pnpm test:desktop-ui`) gains checks for the twin stage, the drawer and the Saltanat page as they land.

### Working rules for every step

- Build only what the current padaav needs.
- Each new module starts with its README, its `index.ts` API and its tests, then the code.
- When a padaav finishes: fresh build, install, and the owner's real test.
- Update this file's §1 map whenever files move. It is the "where is what" index.
