# ADR-0001: Modular monolith and module boundaries

- **Status:** Accepted

## Context and problem

Vyomara needs one primary agent, replaceable provider integration, controlled
tools, local session/history boundaries, and incremental delivery. Requirements
do not justify distributed services or worker-agent orchestration in the MVP.

## Decision

Use one process organized as a modular monolith with interaction/session,
agent, provider port/adapters, tool registry, policy gateway, persistence
ports, and diagnostics boundaries. Keep one primary agent. These are logical
module boundaries, not independently deployed services.

## Alternatives considered

- Distributed services or microservices: unnecessary operational complexity
  for a single-user MVP.
- A single unstructured application module: weakens testability and makes
  provider/policy boundaries easy to bypass.
- Multiple cooperating agents: explicitly later phase, not MVP.

## Consequences and trade-offs

The design is simple to run and test, while internal interfaces preserve
replacement options. In-process boundaries need disciplined dependency
direction and tests; they are not a security sandbox against malicious code.

## Security/privacy implications

The policy gateway remains the authorization boundary for tool capabilities.
Module boundaries reduce accidental bypass but do not replace runtime
validation, least privilege, or OS controls.

## Implementation implications for Phase 4

Create a composition root and isolated modules for sessions, agent, provider,
tools/policy, persistence contracts, and diagnostics. Do not add a service
framework or agent runtime.

## Evidence

Phase 2 principles and scope; FR-001, FR-002, FR-005, NFR-012.
