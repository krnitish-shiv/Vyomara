# ADR-0006: Structured tool registry and execution boundary

- **Status:** Accepted; amended by [ADR-0015](./0015-coding-agent-loop-and-approved-actions.md) — the registry now also holds
  reviewed file-change tools and approval-gated `run_command`, `open_application`,
  and `open_url`. The model still cannot execute anything directly: every call is
  a validated, registered tool, and commands run only after per-command approval.

## Context and problem

The agent needs narrowly scoped capabilities without allowing model output to
become executable code. The MVP requires structured registration, validation,
bounded execution, and read-only filesystem tools.

## Decision

Use an explicit in-process registry of stable tool names and typed schemas.
Each tool declares purpose, input/output schema, effect classification,
timeout, and output bound. Validate input before execution and validate and
bound results before returning them to the agent. MVP tools are read-only
filesystem operations over user-approved roots. Unknown tools and arbitrary
model-generated shell commands are rejected.

## Alternatives considered

- Let the model generate code or shell commands: unsafe and explicitly out of
  MVP scope.
- Discover and load arbitrary plugins dynamically: unnecessary trust and
  supply-chain surface for a small first tool set.
- Add an MCP framework: not required by current requirements and would add
  protocol/dependency complexity prematurely.

## Consequences and trade-offs

Explicit schemas and registration constrain flexibility but make capabilities
auditable and testable. New tools require reviewed code and policy metadata.

## Security/privacy implications

Treat model proposals and tool-returned content as untrusted. Enforce
allowlisted roots after normalization and at access time; prevent traversal
and symlink escape. Bound output and avoid returning unnecessary file content.

## Implementation implications for Phase 4

Define a tool descriptor and registry independent of the model provider.
Implement validation and timeout/output limits centrally. Add only list/read
tools first; no writes, deletes, shell, browser, or arbitrary network tools.

## Evidence

FR-005, FR-006, FR-007, FR-011, FR-014; NFR-001, NFR-002, NFR-004, NFR-005.
