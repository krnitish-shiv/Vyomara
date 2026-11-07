# ADR-0023: Show proposed file changes as VS Code diffs

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

The owner works in VS Code and uses Vyomara as a controller over it
(ADR-0019). Reviewing a change in Vyomara's card means switching windows
away from the code.

## Decision

1. **Automatic diff.** When an edit or new file is proposed and VS Code is
   running, Vyomara opens a diff in the current VS Code window with
   `code --reuse-window --diff`:
   - **Left:** the real file. For a new file, an empty file.
   - **Right:** a private copy of the proposal, named like
     `cart (proposed).js` so the extension and syntax highlighting are kept.
   - VS Code counts as running when its main process is in `ps`. Vyomara
     never launches VS Code just to show a diff.
2. **On request.** **⇄ Open in VS Code** on the review card opens the same
   diff at any time while the change waits for review.
3. **Approval is unchanged.** The change is still applied only after approval
   in Vyomara.

## Storage

The proposal copies live in `diff-previews/` in the app's data folder:

- the folder is `0700` and the files are `0600`;
- the folder is cleared when Vyomara starts and quits.

## Consequences

- After approving, the diff tab still shows the proposal copy; the real file
  shows the applied change.
- Only the standard VS Code install at `/Applications` is used.
