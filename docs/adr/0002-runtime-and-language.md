# ADR-0002: Runtime and implementation language

- **Status:** Accepted

## Context and problem

The project manifest requires Node.js `>=22.22.1` and pnpm `12.16.1`. The
Phase 4 direction explicitly selects TypeScript on this runtime.

## Decision

Use TypeScript on the existing Node.js runtime for the core and pnpm only.
Node's built-in type stripping runs TypeScript without a transpiler dependency,
but does not perform static type checking. Use TypeScript as a development
dependency for type checking and Node type declarations for built-in APIs.

## Alternatives considered

- Plain JavaScript on Node.js: fewer compile-time guarantees at tool/provider
  trust boundaries.
- Swift: native macOS integration, but introduces a second runtime/tooling
  direction not present in the current package foundation.
- Rust or another systems language: potentially useful for native components,
  but premature for the modular MVP.

## Consequences and trade-offs

Node's built-in test runner and TypeScript type stripping avoid a separate
runtime/test framework. A compiler is still needed for static type checking.

## Security/privacy implications

Types do not validate untrusted runtime data. Provider output, tool arguments,
tool results, configuration, and persisted records still require runtime
validation and fail-closed behavior.

## Implementation implications for Phase 4

Use Node's TypeScript stripping and built-in test runner for execution; use
`tsc --noEmit` for static checks. Keep imports erasable by Node's type stripper
and validate untrusted data at runtime.

## Evidence

Phase 4 explicitly selects TypeScript; package manifest `engines.node`;
NFR-012 and NFR-013.
