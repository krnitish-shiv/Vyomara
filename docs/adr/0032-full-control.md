# ADR-0032: Full control, with a short list of steps that still ask

- **Status:** Accepted; amends ADR-0015 (approved actions)
- **Date:** 2026-11-22

## Context

ADR-0015 made every side effect wait for the user's approval. In real use, the owner found the approval cards a barrier: "Search the web?" for a weather question. They asked for the twins to act with full control.

## Decision

1. **Full control is a setting, on by default.**
   - It is saved in `permissions.json` as `fullControl`.
   - It is shown as a switch at the top of Permissions.
2. **While it is on, these run without asking** (`fullControlAllows`, wrapped around the approval port by `FullControlApproval`):
   - web searches and page reads
   - opening apps and links
   - window control, except quitting an app
   - Mac controls
   - MCP tools
   - terminal commands
   - file edits and new files (`approveEditsAutomatically`)
3. **These still ask**, because they cannot be taken back:
   - file deletions, still confirmed by typing DELETE
   - quitting an app, which may lose unsaved work
   - dangerous commands (`isDangerousCommand`):
     - `sudo`
     - `rm -rf` on `/`, `~`, `*` or `..`
     - disk erase and `dd`
     - force-push and branch deletion
     - `git reset --hard` and `git clean -f`
     - piping `curl` or `wget` into a shell
     - shutdown and reboot
     - recursive chmod/chown of `/` or `~`
     - unloading launch agents
     - killing system processes
     - publishing packages
4. **Everything stays visible.** Every action still appears in the step list and under "Verified actions", and edits can be undone ("undo karo").

## Consequences

- The agent's tools and the cached prompt do not change. Only the approval port does.
- Turning full control off restores per-action approval from ADR-0015.
- The dangerous-command list is a denylist and cannot catch everything. It covers the irreversible operations a coding assistant is likely to attempt.
