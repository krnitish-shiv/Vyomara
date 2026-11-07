# ADR-0010: Testing strategy and repeatable agent evaluation

- **Status:** Accepted

## Context and problem

Safety boundaries and agent behavior require repeatable tests. The Phase 4
defaults select Node's built-in test runner; deterministic policy tests remain
separate from model quality evaluation.

## Decision

Use Node's built-in test runner for deterministic unit tests for validation/policy/path
containment; provider and tool contract tests using fakes; integration tests
for session lifecycle and persistence; security regression tests; and a
privacy-safe agent evaluation set when defined. Use `tsc --noEmit` for
TypeScript static checks. Model-based evaluations are diagnostic and must not
replace deterministic policy tests. No third-party test framework is needed.

## Alternatives considered

- Manual testing only: inadequate for regression-sensitive safety controls.
- One end-to-end test against a live model: nondeterministic and difficult to
  isolate.
- Select a third-party framework immediately: unjustified before language and
  test-runner decisions.

## Consequences and trade-offs

Layering gives fast, deterministic safety feedback while preserving a place
for future model quality evaluation. Maintaining evaluation fixtures costs
effort; fixtures must avoid real user data and secrets.

## Security/privacy implications

Use synthetic requests, tool outputs, and filesystem fixtures. Test prompt
injection as untrusted content, path traversal/symlink escapes, approval
denial, secret redaction, cancellation, and resource limits. Never put private
user history in a committed corpus.

## Implementation implications for Phase 4

Use Node's test runner with injected fakes. Establish deterministic policy and
path tests before connecting an agent to tools. Record model, provider, and
evaluation-set versions if/when evaluations are added; keep thresholds
provisional until baseline runs exist.

## Evidence

FR-003, FR-005, FR-007, FR-008, FR-011 through FR-014; NFR-002 through NFR-006,
NFR-013.

## Remaining choice

Before formal model evaluation, decide dataset ownership, benchmark
environment, and release thresholds for model behavior.
