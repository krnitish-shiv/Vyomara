# ADR-0015: Coding-agent loop, approved actions, and selectable models

- **Status:** Accepted; amends ADR-0014 and supersedes the remaining parts of ADR-0013
- **Date:** 2026-11-06

## Context

The product goal is an assistant that works like a capable coding agent: the
user describes an outcome ("cart total is wrong in my shop project, fix it",
"open vyomara in VS Code", "google React Native in Chrome") and the agent finds
the right files, reads and changes code, runs tests, and opens apps — first
by typing, later by voice.

The previous agent could not do this:

- It routed requests with regular expressions over the prompt. Keyword
  matches decided which tools the model could see, and phrases such as
  "run", "terminal", or "search online" were refused before the model ran.
  Paraphrases, Hinglish, and multi-step tasks fell through these rules.
- It allowed at most 3 model iterations and 2 tool calls per request, so
  "find → read → edit → verify" could not complete.
- Tool results were capped at 4,000 characters, so most source files could
  not be read. Ollama's context window was never set, so long prompts were
  silently truncated to Ollama's small default.
- There was no content search, no line-ranged reads, and no way to run tests.
- The default model (`llama3.2`, 3B) is too weak for multi-step tool use.

## Decision

1. **Model-driven loop.** The agent (`src/agent/agent.ts`) sends the full tool
   set and an environment-aware system prompt every turn, and loops until the
   model gives a final answer: up to `VYOM_MAX_AGENT_ITERATIONS` (default 40)
   steps and `VYOM_MAX_TOOL_CALLS` (default 80) calls. Tool errors are returned
   to the model as data so it can correct itself. Identical read-only calls are
   short-circuited after two attempts. When a step limit is hit, the agent
   stops honestly and says how to continue. The regex routing, refusal, and
   "claim detection" layers are removed.
2. **Environment, not project selection.** The system prompt lists the user's
   home directory, common project folders and the projects in them, and the
   project the conversation last worked in (derived from earlier tool paths).
3. **Coding tools.** `find_files` (name or glob), `search_text` (grep-like
   content search), `directory_tree`, `list_directory`, `read_file` (line
   windows with `offset`/`limit`), `edit_file` (exact `old_text` → `new_text`,
   optional `replace_all`), `write_file`, `create_directory`, `delete_path`.
   Dependency and build folders (`node_modules`, `.git`, `dist`, …) are not
   expanded or searched.
4. **Approved actions.** `run_command` (zsh, non-interactive, bounded output
   and timeout), `open_application` (any installed app, optionally with a file
   or folder), and `open_url` (http/https only). Every call shows the exact
   command, app/target, or URL and runs only after the user approves that
   specific action. File changes are still reviewed per operation (now as a
   diff), and deletions still require typing `DELETE` and go to Trash.
   `PolicyGateway` enables `shell`, `launch`, and `network` effects only when
   the host provides approval ports; raw `write`/`delete` effects stay denied.
5. **Verified-actions footer.** The final reply ends with a list built from
   tool results (edited, ran with exit code, opened, rejected, failed). This
   replaces prompt-regex "claim detection" as the guarantee that Vyomara does
   not report work that did not happen.
6. **Local-model robustness.** Ollama requests set `options.num_ctx`
   (`VYOM_OLLAMA_NUM_CTX`, default 32,768) and `think` (`VYOM_OLLAMA_THINK`,
   default `false`) when the model supports thinking. Conversation history is
   fitted to the context budget by shortening older tool output and dropping
   the oldest turns. When a model ends with "Let me search…" or pastes code
   instead of applying a requested change, the agent nudges it (at most twice)
   to continue.
7. **Selectable models.** The default model is `qwen3:14b`. The desktop
   **Models** panel lists installed Ollama models, switches between them
   (stored locally), and downloads new ones through Ollama. The CLI accepts
   `--model` and otherwise uses `VYOM_OLLAMA_MODEL` or the saved choice.
   Later extension: the panel shows capability badges and each model's maximum
   context. It saves the context window and thinking settings, removes models
   after a typed `DELETE`, and can start Ollama. Models without tool support
   run chat-only, and every reply carries a fixed notice that they could not
   access files.
8. **CLI parity.** The CLI uses the same tools and asks for approvals in the
   terminal (diff for edits, y/N for commands and apps). `VYOM_ALLOWED_ROOTS`
   now defaults to the whole machine minus protected paths; `[]` disables
   filesystem tools.

## Consequences

- Shell commands run with the user's permissions after approval. A user who
  approves a destructive command can lose data; the approval card shows the
  exact command and working directory, and the system prompt forbids
  destructive commands unless requested. There is no sandbox.
- `open_url` sends the URL (including search words) to the website; the
  approval card says so. Vyomara cannot read web pages.
- Quality depends on the local model. On an M4 Pro (24 GB) with `qwen3:14b`,
  a find → reproduce → fix → verify task took 1–3 minutes and succeeded in
  4 of 4 runs after the nudges were added (2 of 3 before). Thinking mode was
  slower and less reliable in our runs. These are small samples, not a
  guarantee.
- Tool results and file contents are stored in local history and sent only
  to the local Ollama service, as before.

## Verification

`test/agent.test.ts` covers the multi-step loop, error recovery, rejected
actions, approvals for apps and URLs, cancellation during approval, repeated
calls, content search and globs, context fitting, the shell runner, policy
gating, streamed tool calls, thinking/`num_ctx` request fields, nudges, and
the diff used for reviews. Real-model runs are described in
[the Ollama guide](../ollama.md#how-well-it-works).
