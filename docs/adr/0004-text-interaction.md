# ADR-0004: First text interaction interface

- **Status:** Accepted; amended by [ADR-0015](./0015-coding-agent-loop-and-approved-actions.md) — the CLI now uses the full agent
  (interactive chat, terminal diff/command approvals). The "no write/delete/shell"
  statement below describes the original MVP.

## Context and problem

The MVP requires text interaction and visible lifecycle/status. Phase 2 leaves
the exact interface open; the Phase 4 defaults select a simple terminal CLI.
Full graphical UI and voice are later phases.

## Decision

Use a small terminal CLI as the first adapter, with one request/session flow
and explicit status, errors, and cancellation. Do not add a TUI framework or
Electron. Root management and memory/history review remain future work until
their persistence/permission decisions are resolved.

## Alternatives considered

- Minimal terminal CLI: smallest path to exercise the agent and policy
  boundaries, but accessibility and approval interactions need deliberate
  design.
- Native macOS graphical app: richer user control, but framework and packaging
  choices are open and outside the smallest initial interface.
- Electron: not required by the product documents and adds a runtime/tooling
  footprint.

## Consequences and trade-offs

A CLI supports fast feedback and repeatable tests. It can be less discoverable
and requires careful keyboard/status semantics; it must not make approvals
ambiguous or inaccessible.

## Security/privacy implications

Never echo secrets or full sensitive content to terminal logs by default.
Clearly identify action/target before any future approval prompt. MVP exposes
no write/delete/shell capability.

## Implementation implications for Phase 4

Keep interaction behind an adapter boundary so another UI can be added later.
Provide non-interactive invocation for tests and safe cancellation behavior;
do not let UI code invoke providers/tools directly.

## Evidence

Phase 4 selects a terminal CLI; FR-001, FR-002; NFR-015; Phase 2 defers full
GUI/voice.
