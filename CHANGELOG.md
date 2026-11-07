# Changelog

All notable changes to Vyomara are listed here. Versions follow
[Semantic Versioning](https://semver.org/).

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
