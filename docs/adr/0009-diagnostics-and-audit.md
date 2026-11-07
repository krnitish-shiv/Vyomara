# ADR-0009: Privacy-conscious diagnostics and audit events

- **Status:** Accepted

## Context and problem

The product needs failures and tool/policy activity to be diagnosable, but
ordinary logs must not expose secrets or full sensitive content. Phase 4
selects minimal structured local diagnostics; retention and future user
controls remain open.

## Decision

Emit minimal structured local events with timestamps and bounded operational
metadata such as event category, tool identity, policy outcome, duration, and
safe error code. Never serialize error messages, prompts, secrets, or full
file contents by default. Do not add hosted telemetry.

## Alternatives considered

- Log all prompts and tool payloads: useful for debugging but violates data
  minimization.
- No diagnostics: makes failures and permission decisions hard to investigate.
- Add a hosted telemetry service: conflicts with local-first defaults and is
  not required.

## Consequences and trade-offs

Metadata-only diagnostics may make some model failures harder to reproduce.
The initial process writes structured events to stderr; retention/export policy
must be decided before long-running or production logging.

## Security/privacy implications

Redact secrets at the event boundary, bound event size, and test logs with
secret and private-content fixtures. Any future content logging requires
explicit opt-in, clear disclosure, and retention controls.

## Implementation implications for Phase 4

Define typed event categories before logging. Keep provider/tool error details
out of logs. Test audit coverage and verify ordinary logs omit prompts, file
contents, and credentials.

## Evidence

FR-013; NFR-006, NFR-014; Phase 2 observability and privacy principles.

## Remaining choice

Select rotation/retention limits and export behavior before persistent
diagnostic files or any opt-in content logging are introduced.
