# ADR-0027: VS Code, Mac control, and wider GitHub and browser tools

- **Status:** Accepted; extends ADR-0015 (approved actions) and ADR-0026
- **Date:** 2026-11-15

## Context

The owner wants Vyom to cover the whole loop they do by hand: GitHub (merge,
review, release), VS Code (open a file at a line, compare files), the browser
(type into a site's own search box, manage tabs), and the Mac itself (volume,
dark mode, lock, clipboard, keystrokes, settings panes, Wi-Fi). Each of these
was either missing or only reachable through `run_command` with AppleScript,
which the system prompt forbids.

## Decision

1. **`github` grows** (same tool, same approval rule): reads `repo_view` and
   `release_list`; writes `repo_clone`, `pr_review`, `pr_merge`, `pr_close`,
   `pr_checkout`, `issue_close`, `run_rerun`, `release_create`. Every write is
   shown as the exact `gh` command naming the repository, and is never
   "always allowed".
2. **`vscode`** opens a file or folder (at a line), shows a diff of two files,
   adds a folder to the workspace, installs an extension, and lists
   extensions, through the `code` command of the installed app. Opening uses
   the existing "Open Visual Studio Code" approval (one "Always allow" covers
   it); installing an extension is shown as a command.
3. **`browser` grows**: `type` into a numbered visible input (search boxes,
   forms; optional submit), `find` text on the page, `tabs`, `switch`,
   `close`. Page reads number inputs as they number links. The CLI now has
   the same Chrome port as the desktop app.
4. **`mac_control`** is a new tool with a new approval kind `system`. Every
   action except `running_apps` is shown with a plain sentence of what will
   happen ("Set the output volume to 40%", "Type into the front app: …") and
   asks every time; there is no "always allow". Implementation
   (`MacSystemControl`) calls the system's own programs with arguments:
   `osascript` scripts are fixed text and receive values through `argv`,
   clipboard text goes through `pbcopy` stdin, Wi-Fi through `networksetup`
   on the detected interface, screenshots through `screencapture` to the
   Desktop. Typing and key presses need Accessibility; dark mode and
   notifications need Automation for System Events; the errors say so.
5. **Prompt guidance**: `open_url` is only for showing a page; a request to
   search or read in Chrome and answer uses `browser`. `remember` is for
   explicit requests and lasting preferences, never for a task to do now.

## Consequences

- Keystrokes go to whichever app is in front; the card says so. Reading the
  clipboard sends its text to the local model; the card says so.
- The tool list grows by two tools (~1,200 tokens); the prompt is cached per
  conversation (ADR-0026), so this costs once per chat.
- Verified live on 2026-11-15 with `qwen3:14b`: edit → branch → commit →
  push → PR → issue in one request; web search with sources.

## Verification

`test/system-tools.test.ts` (approval kind, no-approval listing, argument
passing, key combinations, Wi-Fi interface, VS Code CLI calls and approvals),
`test/dev-tools.test.ts` (new `gh` commands), `test/web-tools.test.ts`
(type/find/tabs through the port, tab parsing, missing input).
