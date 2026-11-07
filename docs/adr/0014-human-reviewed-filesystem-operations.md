# ADR-0014: Human-Reviewed Filesystem Operations

- **Status:** Accepted; supersedes the selected-project edit workflow;
  amended by [ADR-0015](./0015-coding-agent-loop-and-approved-actions.md)
  (content search, ranged reads, diff review, `replace_all`, CLI edits with
  terminal approval, approved shell/app/web actions, larger size limits)
- **Date:** 2026-10-30

## Context

Vyomara must let users ask for files and folders by name and request ordinary
file changes without manually selecting a project. Machine-wide filesystem
access increases the impact of model mistakes, prompt injection, and accidental
deletion; OS privacy permissions and a strong per-action review boundary are
required.

## Decision

- The desktop filesystem scope is `/`, subject to the logged-in user's existing
  macOS permissions. The CLI remains read-only and uses `VYOM_ALLOWED_ROOTS`.
- System locations, the app's local data, and common credential stores are
  blocked. Symlinks are never followed for traversal or operation targets.
- Search is by case-insensitive file/folder name only. It is depth-, directory-,
  entry-, output-, and time-bounded; skipped locations and truncation are
  reported.
- File creation, empty-folder creation, and UTF-8 text edits are proposal tools,
  not direct write effects. The desktop displays the exact path and complete
  current/proposed text and waits for explicit approval of each operation.
- Each deletion requires the user to type `DELETE` for that exact item. It
  moves the selected file or folder to the system Trash. Deleting `/`, `/Users`,
  or `/Volumes` is not supported.
- Create operations require an existing parent directory. New files/folders
  are owner-only. Text edits are limited to 16 KiB, use a same-directory
  temporary file and atomic rename, and are rejected if the reviewed source
  changed. Deletions are revalidated before moving to Trash.
- Pending operations are in-memory and bound to the active chat request.
  Cancellation, timeout, rejection, or application restart cannot imply
  success. Direct writes, shell, arbitrary commands, package installation, and
  network access remain unavailable. The separate, narrowly allowlisted macOS
  app-launch capability requires explicit per-launch confirmation; arbitrary
  application control remains unavailable.

## Consequences

The desktop gains broad discovery and ordinary file-management capabilities
without manual project selection, but not content search, binary editing,
multi-file atomic transactions, recursive deletion outside the Trash flow,
arbitrary command execution, or elevated OS access. Read results and proposed
contents are stored in the local conversation history and sent only to the
configured local Ollama provider. The local database is not application-
encrypted.

Portable path-based APIs cannot eliminate every race with a hostile concurrent
local process. Operations revalidate immediately before changes but do not
claim complete TOCTOU protection.

## Verification

Unit and agent tests verify bounded filename search, protected-path denial,
proposal review, rejection without mutation, explicit application, stale-file
failure, per-item deletion approval, Trash routing, and cancellation.
