# ADR-0008: Configuration and secret handling

- **Status:** Accepted

## Context and problem

The application needs bounded runtime settings and a provider choice. The
Phase 4 defaults select environment variables and safe defaults. The current
placeholder provider needs no credentials; secret storage for a future
credential-bearing provider remains unresolved.

## Decision

Use validated environment variables with safe defaults. Reject unsupported
providers and invalid bounds without echoing supplied values. Do not persist
secrets in tracked files or ordinary configuration/logs. No secret-management
service is introduced. If a future provider requires credentials, decide its
secret source separately before implementation.

## Alternatives considered

- Hard-code endpoint, model, roots, and credentials: inflexible and risks
  exposing private data.
- Commit `.env` values: prohibited for secrets and machine-specific state.
- Add a keychain/configuration dependency now: no current credential need or
  confirmed implementation choice.

## Consequences and trade-offs

Validation and environment defaults are simple and reproducible, but future
provider credentials and allowed-root persistence are not resolved. Do not
add a config framework or secrets service.

## Security/privacy implications

Reject invalid or out-of-range settings; fail closed on missing roots/provider
configuration. Never log secret values. Do not silently change a local
provider to a remote one. Credentials must never enter source control.

## Implementation implications for Phase 4

Define a typed configuration contract and validate it at startup. Keep current
settings non-secret and error messages value-free. Resolve credential
injection before adding a credential-bearing provider.

## Evidence

FR-004, FR-007, FR-013, FR-015; NFR-006, NFR-007; Phase 2 secret and provider
constraints.

## Remaining choice

For a later credential-bearing provider, choose whether credentials are
injected via environment or an OS secret store; no current provider needs a
secret.
