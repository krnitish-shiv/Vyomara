# ADR-0011: Initial platform and runtime compatibility boundary

- **Status:** Accepted

## Context and problem

The project manifest already declares Node.js `>=22.22.1`; Phase 2 identifies
macOS on Apple Silicon as the first supported host. The minimum macOS version,
packaging/distribution, and whether the Node engine is a release baseline
remain open.

## Decision

Accept macOS on Apple Silicon as the initial platform boundary and preserve
the manifest’s Node.js `>=22.22.1` engine requirement for development and
validation. Do not claim compatibility with other operating systems or
architectures. Treat the minimum macOS release and distribution method as
unresolved; confirm Node.js as a production runtime baseline before release.

## Alternatives considered

- Promise cross-platform support now: expands test and support scope without
  user requirement.
- Add native macOS integration before a text MVP: premature.
- Ignore the existing Node engine declaration: inconsistent with current
  project configuration.

## Consequences and trade-offs

An Apple Silicon-first boundary narrows initial testing and allows future
platform-specific adapters. It does not settle macOS APIs or distribution.

## Security/privacy implications

Keep filesystem and microphone permissions explicit and least-privileged.
Do not infer OS permission state from model/provider configuration.

## Implementation implications for Phase 4

Run documented tests on an Apple Silicon Mac with Node.js `>=22.22.1` and pnpm
`12.16.1`. Isolate platform-specific code; report unsupported hosts clearly.
Do not add packaging frameworks until distribution is decided.

## Evidence

Package manifest `engines.node`; Phase 2 target user, MVP scope, and NFR-016.

## Remaining choice

Confirm the minimum macOS version, distribution/packaging plan, and whether
the Node engine declaration is also the supported production runtime baseline.
