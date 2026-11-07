# ADR-0003: Replaceable provider interface and local Ollama adapter

- **Status:** Accepted; default model, context window, thinking, and model
  selection updated by [ADR-0015](./0015-coding-agent-loop-and-approved-actions.md)

## Context and problem

The MVP requires a replaceable provider contract, local Ollama compatibility,
cancellation and typed provider errors, with no silent remote fallback. The
project owner states Ollama and `llama3.2` are available locally. This phase
requested an Ollama implementation using the local HTTP API, with loopback
defaults unless existing requirements say otherwise.

## Decision

Accept a provider-neutral interface between the primary agent and provider
adapters. The first adapter uses Ollama's non-streaming `/api/chat` endpoint.
Its defaults are `http://127.0.0.1:11434` and `llama3.2`; the URL may be
configured only to an HTTP loopback host, and model, timeout, and response
character limits are validated configuration. Keep all Ollama transport and
request/response translation inside the adapter. There is no remote fallback,
automatic tool-call execution, or model download.

## Alternatives considered

- Couple the agent directly to Ollama APIs: simpler initially, but violates
  replaceability and spreads provider-specific behavior.
- Add a multi-provider framework now: unnecessary and may encourage remote
  providers outside the local-first MVP.
- Silently fall back to a hosted provider: conflicts with privacy and FR-004.

## Consequences and trade-offs

A normalized contract adds a small adapter layer and contract tests. Ollama
compatibility may require translating model-specific capabilities and errors.
The MVP can support one adapter without committing to a provider framework.

## Security/privacy implications

Default to the configured local provider; fail visibly when unavailable.
Never transmit prompts or file content to a remote service through fallback.
Disclose provider identity/data flow before requests.

## Implementation implications

Use the existing normalized provider contract with injected `fetch` for
offline tests. Bound request time, response bytes, and assistant text; handle
cancellation and sanitize provider errors. Do not leak Ollama HTTP objects into
agent or tool modules. Verify compatibility against a real local Ollama
instance before claiming that live behavior is tested.

## Evidence

FR-003, FR-004, FR-016; NFR-005, NFR-007, NFR-018; Phase 2 local-first
principle; Phase 4 explicit default to Ollama HTTP, loopback URL, and
`llama3.2`.

## Remaining verification

A live request using the default endpoint and model succeeded against the
local Ollama instance in this task, but the installed server version was not
recorded. Compatibility with other Ollama versions remains unverified. The
exact context-window behavior is model/server-defined and is not configured
by this adapter.
