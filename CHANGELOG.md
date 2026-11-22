# Changelog

All notable changes to Vyomara are listed here. Versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Voice
- New **Hinglish** speech model (Models panel → Voice, or `pnpm setup:hinglish`):
  hears Hindi and mixed Hindi-English speech correctly, in Roman letters, and
  about five times faster than before. Used automatically once installed (ADR-0030).
- Spoken replies start while they are still being written: the first words
  come in about half a second instead of after the whole answer.
- "Vyomara" and "Vyom" are recognised far more reliably (from 16 to 29 of 33
  test clips across nine voices), and the twin you call by name answers;
  switching twins no longer re-reads the prompt.
- A request spoken with pauses is transcribed again as one recording, so
  words cut at the pauses come out right.
- The twins no longer hear themselves: the microphone stays muted while they
  speak and for 0.6 s after, and anything heard that matches what the twin just
  said is dropped. Talking over the twin to interrupt is off for now (press the
  orb); their voice plays inside the app, ready for it (ADR-0031).
- The twins say a short line the moment they start working ("Khoj ko de rahi
  hoon", "Ek second, dekh raha hoon"), so you never wait in silence.
- Your turn ends sooner when the sentence sounds finished and waits longer
  when it trails off ("…aur", "…ki"): about 0.9 s from your last word to the
  request instead of 2.3–2.6 s.
- Misheard names ("Vyaanm", "Vivaara", "vio mara") are corrected to Vyom and
  Vyomara, and phrases whisper invents from silence ("Thanks for watching")
  are dropped.
- Natural local voice (Kokoro): run `pnpm setup:voice` once; replies are then
  read by a natural female (Vyomara) or male (Vyom) voice, including Hindi,
  with the system voice as automatic fallback (ADR-0028).
- Speech recognition now runs with voice-activity detection and non-speech
  suppression, so noise no longer turns into invented words.

### Interface
- Frosted-glass look: translucent panels over a slow blue-violet aurora.
- Fits every screen: on an external monitor the whole interface grows with
  the window (up to 1.75×) and returns to normal on the laptop screen; narrow
  windows turn the task panel into a drawer, and very narrow ones show the
  navigation as a row of icons. Small labels are easier to read.

### Memory
- Memories that match what you ask come first, however they are spelled
  (Roman Hinglish, Devanagari, or English: "dukaan" finds "दुकान").
- One-time codes, card numbers, Aadhaar and PAN numbers, and Hinglish
  phrasing like "mera otp 482913 hai" are never remembered; addresses with a
  postal PIN code still are.

### Replies (from the owner's first real test)
- **Full control** (on by default, Permissions): the twins search, open, run
  commands, and edit files without asking; only deletions, quitting an app, and
  dangerous commands (sudo, rm -rf, force-push, disk erase…) still ask (ADR-0032).
- A guessed answer to a question that needs a tool (weather, time, "open …") is
  no longer shown or spoken before the tool runs; voice-mode examples that a
  weak model copied into its reply ("Chrome khol diya") are gone.
- Replies stay in Roman Hinglish when you speak Hinglish, never Devanagari;
  the voice converts common Hindi words itself so it still pronounces them
  right.
- Greetings and small talk ("hi", "acha ji", "Hi, bhaiya") get one friendly
  line and never run a tool.
- A twin that says it opened something ("Chrome kholega") without doing it is
  sent back to actually open it, or to say honestly that it could not.
- Tool arguments in the wrong type ("false", "30") are fixed instead of failing.

### Assistants
- Vyom and Vyomara are the only assistants you talk to. Behind them works an
  inner team (Khoj for research, Yatra for travel, Kavach for Mac health,
  Lipi for writing): the twins hand tasks over with the new `delegate` tool
  and pass the report back, and you see each step ("Yatra: Getting the
  weather…") (ADR-0029). A per-twin character is stored for the prompt.
- Helper agents (`explore`, `delegate`) no longer stop after 30 seconds.
- `screen_time`: per-app time recorded locally while the app runs, and a
  gentle break reminder after three hours of continuous use.

## [2.0.0] — 2026-11-15

Vyom now works like a full coding agent on your Mac: it keeps its prompt
cached so every turn starts fast, searches the web without any setup, and
reaches GitHub, VS Code, Chrome, and the Mac itself through approved tools.

### Faster
- The system prompt and tool list stay identical for a whole conversation;
  per-turn facts (date, project, git state, memories, project instructions)
  travel with your message. On a 14B model a turn after an edit starts in
  about a second instead of ~40 s (ADR-0026).

### Coding agent
- Git tools (`git_info`, `git_commit`, `git_branch`, `git_sync`),
  `multi_edit`, `check_problems`, background commands, notebook editing.
- Slash commands (`/review`, `/fix`, `/test`, `/commit`, `/explain`, and the
  project's own), afterEdit hooks, project instructions from `AGENTS.md`,
  `CLAUDE.md`, and similar files.
- Plan mode, pictures for vision models, an `explore` helper for broad code
  searches, and summaries of early turns in long conversations.
- `vscode`: open a file at a line, compare two files, add a folder, install
  or list extensions.

### GitHub
- `github`: repositories (view, create, clone), pull requests (list, view,
  checks, diff, create, comment, review, merge, close, checkout), issues
  (list, view, create, comment, close), workflow runs (list, failed-step
  logs, rerun), releases (list, create). Every write is shown as the exact
  `gh` command.

### Web and browser
- Web search without configuration (DuckDuckGo; SearXNG when configured;
  Wikipedia and Google News as a fallback), `fetch_url`, `news_headlines`,
  weather, exchange rates, latest software versions.
- `browser` drives your own Chrome: search, open, read, click, type into a
  site's search box or form, find text, scroll, back, tabs. Also in the CLI.

### Mac
- `mac_control`: volume, mute, dark mode, lock screen, sleep, screenshot,
  clipboard, notifications, typing and key presses in the front app, System
  Settings panes, Wi-Fi, running apps. Each action is shown and approved.
- `control_application` finds Finder and other system apps, and apps
  anywhere on disk through Spotlight.

### Platform
- MCP servers from `mcp.json`, command permissions kept across restarts
  (with safe `*` patterns), memories across conversations, everyday tools
  (time, calculator, units, dates, Mac status).

## [1.0.0] — 2026-11-07

The first release of Vyomara: a local-first AI agent for macOS with two
assistants, **Vyom** and **Vyomara**.

### Assistants and voice
- Two assistants with their own voices: Vyom (Aman, male) and Vyomara (Lekha,
  female). Switch between them from the sidebar.
- English, Hindi, and Hinglish, typed or spoken.
- On-device speech recognition (whisper.cpp), with a Hindi + English model
  and a fast English model.
- Voice conversations without a wake phrase. You can interrupt, and spoken
  approvals ("haan / nahi") work.

### Coding agent
- Finds projects by name, searches and reads code, edits files, and runs
  tests and commands.
- A live plan and a live step list for multi-step tasks.
- Proposed edits shown as diffs in Vyomara and side by side in VS Code.
- Undo for any request's approved file changes.
- Follows project instructions from `AGENTS.md`, `CLAUDE.md`,
  `.github/copilot-instructions.md`, and `.cursorrules`.
- Memories across conversations.
- Every reply ends with a list of verified actions.

### Apps and web
- Opens and controls Mac apps (focus, hide, maximize, full screen, quit).
- Web search, news headlines, and page reading answered in the chat. Links
  that do not come from a real source are removed.
- Chrome is used only when you ask for the browser.

### Desktop app
- Home screen with the animated orb, plus History (search, resume, delete),
  Models, Permissions, and Memories panels.
- **Mini Vyom:** a small always-on-top window for working in other apps. It
  is off by default; turn it on from the sidebar.
- A Models panel to download, switch, configure, and remove Ollama and
  Hugging Face models.
- The first reply arrives in about a second: the model reads the assistant's
  instructions in the background while it loads.
- Animations pause in windows you are not looking at, so they do not take GPU
  time from the model.
- An app icon that matches the logo on macOS 26.

### Safety
- Every edit, deletion, command, app launch, and web request needs your
  approval. Permissions you remember can be revoked.
- Protected system and credential locations are blocked, and symlinks are
  never followed.
- Text in files and web pages is treated as data, not instructions.

[1.0.0]: https://github.com/krnitish-shiv/Vyomara/releases/tag/v1.0.0
