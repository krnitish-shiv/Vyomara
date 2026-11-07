# Vyomara Product Requirements

> **Historical document.** [Vyomara Product Direction](./product-direction.md)
> and [ADR-0015](./adr/0015-coding-agent-loop-and-approved-actions.md) are
> authoritative and supersede any conflicting MVP, phase, interaction, scope,
> or acceptance decision below. In particular, Vyomara is now a coding agent
> that is typed first and voice later. It edits files through reviewed
> operations and runs shell commands, opens apps, and opens web pages only
> after per-action approval. See [the agent tools](./tools.md). The read-only,
> no-shell, and "out of scope for MVP" statements below describe the original
> MVP, not the current product. The wake phrase is now “Hello Vyomara”, with
> no end phrase; listening stays on until it is turned off.

## 1. Product vision and target user

Vyomara is a local-first personal AI assistant for macOS. Its spoken name is
**Vyom**; the wake phrase and end phrase are **“Hello, Vyom”** and **“Goodbye,
Vyom.”** It should help one person understand requests, use a small set of
controlled tools, and manage explicit memory without surrendering control of
their files or actions.

The initial target user is a technically comfortable individual using an
Apple Silicon Mac, willing to run a local model provider and approve sensitive
actions. The MVP is a foundation, not a general-purpose autonomous agent.

## 2. Product principles

- **Local-first:** Prefer local processing and storage; clearly disclose any
  data sent outside the Mac.
- **Privacy:** Collect and retain only what is needed; do not expose secrets in
  logs, prompts, or source control.
- **User control:** Make tool effects visible, ask before sensitive effects,
  and support cancellation and deletion.
- **Modularity:** Keep the application a modular monolith with one primary
  agent, a replaceable model-provider interface, and explicit tool contracts.
- **Observability:** Make failures and tool activity diagnosable without
  logging sensitive content by default.
- **Incremental development:** Deliver and evaluate a small safe text MVP
  before adding voice, UI, agents, or autonomous capabilities.

## 3. Scope

### MVP — mandatory

- A text interaction surface; exact UI form remains an implementation decision.
- One primary agent and a provider interface, initially compatible with a
  locally hosted Ollama service.
- A small registry of structured, read-only filesystem tools constrained to
  user-approved roots.
- Explicit user-approved memory operations and locally stored session history.
- Policy checks, approval gates, cancellation, bounded execution, and
  privacy-conscious diagnostics.
- macOS on Apple Silicon as the first supported platform.

### Explicitly out of scope for MVP

- Always-on listening, wake-word detection, speech recognition, or speech
  synthesis.
- Worker/multi-agent orchestration, autonomous task loops, or unrestricted
  background work.
- Shell/terminal execution, writes or deletes to user files, or unattended
  external network actions.
- Browser automation, arbitrary application control, or broad computer-use
  capabilities.
- Autonomous code changes, self-modification, self-training, or self-updating.
- Cloud model providers as a default or silent fallback.
- A commitment to a specific UI framework, database, IPC design, or model.

## 4. Functional requirements

“MVP” requirements are required for the initial implementation. Future items
are explicitly not MVP acceptance gates.

| ID | Priority / phase | Requirement | Acceptance criterion |
|---|---|---|---|
| FR-001 | MUST / MVP | Provide a text-based interaction that accepts a user request and returns a response from one primary agent. | An automated interaction test submits a text request and receives one response without creating a worker agent. |
| FR-002 | MUST / MVP | Support a clear session lifecycle: start, accept turns, show progress/status, finish, and recover or report failure. | Tests cover session start, a successful turn, a failed turn, and session end; each reaches a documented state and no failed turn is reported as successful. |
| FR-003 | MUST / MVP | Define a replaceable model-provider contract for request/response, cancellation, and provider errors; provide initial compatibility with a locally hosted Ollama provider. | A provider contract test suite runs against a fake provider and an Ollama-compatible test endpoint; swapping provider implementations does not change agent/tool contracts. |
| FR-004 | MUST / MVP | Use only an explicitly configured local provider by default; do not silently fall back to a remote provider. | With the local provider unavailable, a test verifies a clear error and verifies that no remote request is made. |
| FR-005 | MUST / MVP | Register tools by stable name and schema. Validate arguments before execution and validate/limit results before returning them to the agent. Treat model output and tool-returned content as untrusted data, not instructions. | Registry tests reject unknown tools, invalid arguments, and oversized/invalid results; a fixture containing instruction-like external text is returned as data and cannot change policy or invoke another tool by itself. |
| FR-006 | MUST / MVP | Provide a minimal read-only filesystem tool set, initially listing and reading files only within user-approved roots. | Tests show permitted paths can be listed/read and unapproved roots are denied; no filesystem tool can write, rename, or delete. |
| FR-007 | MUST / MVP | Enforce allowed roots after path normalization and defend against traversal and symlink escapes. | Security tests for `..` traversal, absolute paths outside roots, and symlinks resolving outside roots all deny access without reading the target. |
| FR-008 | MUST / MVP | Apply a policy check before every tool call. Any write, delete, shell command, external network action, or other side effect requires a specific user approval before execution; denial must prevent the action. | For each side-effect category, a test verifies no action occurs without approval, approval is scoped to the displayed action, and denial/cancellation leaves the target unchanged. These actions remain unavailable unless separately implemented and reviewed. |
| FR-009 | MUST / MVP | Keep memory explicit and inspectable. The user must explicitly request saving a memory; show its content before saving, and support listing, reviewing, and deleting saved memories. | Tests verify no memory is created from ordinary conversation, an explicit save stores only the confirmed content, listing reveals stored entries, and deletion removes the selected entry. |
| FR-010 | MUST / MVP | Store session history locally with a user-visible way to inspect and delete it. Clearly communicate what is retained; do not treat transient conversation context as durable memory. | A persistence test confirms a completed session can be reviewed locally, is distinct from explicit memory, and can be deleted through the supported interface. |
| FR-011 | MUST / MVP | Provide cancellation for an active request and enforce bounded request time, tool output, and agent iterations. | Tests cancel a pending provider/tool operation, verify no later tool begins, and verify configured timeout, output-size, and iteration limits stop work with an explicit status. |
| FR-012 | MUST / MVP | Report provider, policy, validation, and tool failures clearly and allow a safe retry where appropriate. Never convert an error into a success-shaped response. | Injected failures produce a visible error state, no false success, and a retry is possible only after the failed operation has ended and policy is rechecked. |
| FR-013 | MUST / MVP | Record diagnostic and audit events for session transitions, policy decisions, tool identity/outcome, and errors without recording secrets or full sensitive content by default. | Tests assert the required event metadata is present, and known secret/file-content fixtures do not appear in ordinary logs. |
| FR-014 | MUST / MVP | Keep runtime access least-privileged: read-only file access by default and no arbitrary shell execution. | Automated policy tests deny writes and shell execution by default; inspection confirms the MVP tool registry does not expose a generic command runner. |
| FR-015 | MUST / MVP | Provide a visible permission state and a way to revoke an allowed filesystem root. | A test adds and revokes a root; reads succeed only while that root is allowed and subsequent reads are denied after revocation. |
| FR-016 | SHOULD / MVP | Explain when data is sent to a configured provider and distinguish local processing from any future external provider. | With the local provider configured, the user-facing provider status identifies it as local; any non-local provider configuration requires an explicit disclosure and approval before its first request. Remote providers are not required for MVP. |
| FR-101 | LATER | Add optional push-to-talk voice input/output, followed by wake phrase “Hello, Vyom” and end phrase “Goodbye, Vyom.” | Later-phase acceptance must verify opt-in, visible microphone state, easy disablement, and no capture while disabled. Not an MVP gate. |
| FR-102 | LATER | Add a graphical interface for conversation, permissions, memory, history, and diagnostics. | Later-phase acceptance must make these functions accessible without weakening existing policy. Not an MVP gate. |
| FR-103 | LATER | Add worker agents for bounded, isolated subtasks under the primary agent’s policy. | Later-phase acceptance must enforce per-agent iteration/resource limits and shared approval policy. Not an MVP gate. |
| FR-104 | LATER | Consider controlled self-improvement workflows. Changes must be isolated, reviewable as diffs, tested, and approved by a human; autonomous unrestricted self-modification is prohibited. | No self-modification is available in MVP; future workflows cannot apply or publish changes without explicit human approval. |

## 5. Interaction and session lifecycle

MVP interaction is text-first; a terminal interface is a plausible starting
point, not a finalized technology decision. A session begins when the user
opens or starts one, accepts requests in order, and ends explicitly or when
the user closes it. The system should display whether it is waiting, thinking,
calling a tool, awaiting approval, cancelled, complete, or failed. A new
request must not obscure an unresolved approval or imply that a cancelled
operation completed.

The agent may propose a tool call, but the registry and policy layer—not the
model—decide whether it is valid and executable. Tool results are presented as
untrusted data. If a provider or tool fails, explain the failure, preserve
already completed safe results, and let the user retry or end the session.

## 6. Provider, tools, permissions, and data

- **Provider boundary:** Agent logic depends on a narrow provider interface,
  not Ollama-specific APIs. Ollama is the initial local compatibility target;
  its version, model, and API details remain to be selected and tested.
- **Tool contract:** Each tool declares a stable name, purpose, input schema,
  output schema, side-effect classification, timeout, and output bound.
  Validate both directions. No tool may elevate its own permissions.
- **Approval:** Show the proposed action, target, and relevant data before
  approval. Approval is specific to that action, can be denied or cancelled,
  and is not inferred from prior unrelated approvals.
- **Filesystem boundary:** Access only roots the user explicitly allows.
  Resolve paths safely and recheck symlink destinations at access time. Deny
  access outside roots and to sensitive locations unless a future explicit
  decision safely defines an exception.
- **Memory and history:** Memory is a separate, user-managed collection, never
  silently inferred. Session history is local and distinguishable from memory.
  Storage technology, encryption, retention defaults, and backup behavior
  remain open decisions.

## 7. Mandatory safety constraints

These are non-negotiable design constraints for MVP and future phases:

1. Filesystem access is read-only by default.
2. Filesystem tools enforce explicitly allowed roots and defend against path
   traversal and symlink escapes.
3. Writes, deletes, shell commands, external network actions, and other side
   effects require appropriate policy checks and user approval.
4. Tool inputs and outputs are validated. External content and model-generated
   plans are untrusted data.
5. Enforce timeouts, bounded tool output, bounded agent iterations, and
   resource limits.
6. Never store API keys, passwords, or other secrets in source control or
   ordinary logs.
7. Future self-modification requires isolated changes, diffs, tests, and human
   approval. Autonomous unrestricted self-modification is out of scope.
8. Never execute arbitrary model-generated shell commands without a policy
   and approval layer; shell execution is out of MVP scope.
9. Memory is explicit and inspectable; conversation context alone is not
   durable memory.
10. Any future always-on microphone access is opt-in, visibly indicated, and
    easy to disable; always-on listening is out of MVP scope.

## 8. Assumptions, open questions, and pre-implementation decisions

### Working assumptions

- The first supported host is an Apple Silicon Mac with Node.js `>=22.22.1`
  and pnpm `12.16.1`, consistent with the project manifest.
- MVP is single-user and local-first, with one primary agent and a small tool
  set. No account system or multi-user boundary is required.
- A local Ollama-compatible service is available for provider integration
  testing; the application must still fail safely if it is unavailable.
- Users will explicitly select filesystem roots and understand that file
  contents sent to a model are disclosed to that configured provider.

### Decisions required before implementation

- Which text interface to implement first: terminal CLI or another minimal
  interface?
- Which Ollama API/version and initial model should be the compatibility
  baseline, and what context-size/resource policy should apply?
- How will filesystem roots be selected, displayed, persisted, and revoked?
- Which small read-only tools are in the first deliverable, and what are their
  per-tool size and timeout limits?
- **Decided in ADR-0005:** local SQLite history retained until user deletion,
  owner-only macOS permissions, explicit-only memory, no app-level database
  encryption, and no automatic backup/export. See
  [ADR-0005](./adr/0005-persistence.md) for limitations.
- What exact approval UX and action scope are required for future side effects?
- What events and retention period are acceptable for audit logs, and which
  content, if any, may users explicitly opt into logging?
- Which macOS versions are supported, and what packaging/distribution approach
  is intended?
- Which accessibility requirements apply to the first text interface, and how
  should voice accessibility be evaluated in its later phase?
