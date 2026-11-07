# ADR-0024: Project instructions, language, and batch edit approval

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

The owner wants the coding agent to work like Claude Code. Compared with it,
the agent had four gaps:

1. **It ignored a project's own notes for agents** (`AGENTS.md`,
   `CLAUDE.md`), so it ran the wrong test command.
2. **It found the active project only from its own earlier tool calls,** so
   the first request never had project context.
3. **It replied in Devanagari to English questions.**
4. **Every edit needed its own approval,** even in a long, already-reviewed
   task.

## Decision

1. **Active project.** The active project is the newest absolute or `~` path,
   or the name of a project from the project-folder list, found in the user's
   messages or the agent's tool calls. The project root search climbs to the
   filesystem root when the path is outside home.
2. **Project instructions.** The first of `AGENTS.md`, `CLAUDE.md`,
   `.github/copilot-instructions.md` and `.cursorrules` that exist in the
   active project are read into a "Project instructions" section:
   - 8,000 characters in total;
   - regular files only, no symlinks.
   They guide how to build, test and style code. They never override the
   safety rules.
3. **Language.** The language rule now sits at the top of the prompt: reply
   in the language of the latest message.
   - English gets English.
   - Roman Hinglish gets Roman Hinglish.
   - Devanagari Hindi gets Hindi.
   Code is cited as `path:line`.
4. **Approve all edits in this task.** A review-card button approves this
   change and every later edit, new file and new folder in the same request.
   - Later changes apply without a card. They are still recorded for undo and
     shown in the activity list.
   - Deletions keep their typed `DELETE` confirmation.
   - The next request asks again.

5. **Read-only requests.** "Don't change anything", "just tell me", "kuch
   mat badlo" or "sirf batao" (`forbidsChanges`) remove the file-changing
   tools from that request. A model that ignores the words still cannot edit.
6. **Unfinished plans.** A final answer that is mostly a checklist with open
   steps (`- [ ] …`) gets a nudge to carry out the steps. Before this, the
   model sometimes "answered" with its plan and stopped.
7. **Finding code by name.** "Not found" errors say that a function or class
   is found with `search_text`, not by guessing `cartTotal.js`. A search with
   no matches returns a hint to widen it (drop the glob, ignore case), so the
   model does not decide the code is missing.
8. **Model memory.** On quit, Vyomara asks Ollama to unload the model
   (`keep_alive: 0`). When the model is switched in the Models panel, the
   previous model is unloaded at once. While Vyomara runs, the model stays
   loaded for 30 minutes so replies stay fast.

## Evaluation

`pnpm eval` gained four scenarios:

- `english-reply`
- `project-instructions` (must run `npm run check` from `AGENTS.md`)
- `rename-everywhere`
- `question-only` (must not edit)

Results with qwen3:14b:

| Scenario | Before | After |
|---|---|---|
| `fix-bug` | 0/2 (stopped at its plan) | 2/2 |
| `rename-everywhere` | 1/2 | 2/2 |
| `question-only` | 0/2 (guessed `cartTotal.js`) | 3/3 |
| `explain-hinglish` | 0/1 | 1/1 |
