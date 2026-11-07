# ADR-0007: Central policy and approval gateway

- **Status:** Accepted; approval scope updated by [ADR-0015](./0015-coding-agent-loop-and-approved-actions.md)

## Context and problem

Model proposals and registered tools must not grant themselves authority.
Filesystem access spans the machine (or `VYOM_ALLOWED_ROOTS`) with protected
paths excluded, in both the desktop and the CLI. Every mutation and every
external action must be approved by the user.

## Decision

Route every tool execution through one policy gateway that validates
capability, roots, effect class, and current approval. Deny by default when
policy or approval state is missing or ambiguous. Desktop file creation,
folder creation, and text edits require approval of the exact destination and
content. Each deletion requires a separate typed confirmation and moves the
item to Trash. Shell commands, application launches, and web pages
(`shell`, `launch`, and `network` effects) are allowed only when the host
supplies an approval port, and each call is approved individually after the
exact command and folder, app and target, or URL is shown. Raw `write` and
`delete` effects are always denied. Rejection, cancellation, or a missing
approval window prevents the action. See ADR-0014 for filesystem approval
details and ADR-0015 for actions.

## Alternatives considered

- Let each tool implement its own approval: risks inconsistent checks and
  bypasses.
- Trust the model's claim that the user approved: invalid authority source.
- Enable broad approval for a whole session: not justified and weakens
  least-privilege consent.

## Consequences and trade-offs

The gateway adds a central interface and interrupts automation for reviewed
filesystem actions and app launches. This cost is intentional; user consent
and auditability take precedence over convenience.

## Security/privacy implications

The gateway is a policy enforcement point, not a guarantee against malicious
in-process code; keep capabilities narrow and test deny paths. Path
containment remains enforced by filesystem tools as defense in depth.

## Implementation implications

Create policy decisions as explicit allow/deny/approval-required outcomes.
Record decision metadata without sensitive content. Keep each approval scoped
to one displayed filesystem operation, command, launch, or URL and the active
request. Do not infer authorization from model output or general conversation
context.

## Evidence

FR-006, FR-007, FR-008, FR-014, FR-015; NFR-001 through NFR-005.

## Approval scope

Approval-gated side effects: reviewed file changes, `run_command`,
`open_application`, and `open_url`. There is no session-wide or remembered
approval yet; pre-approving safe commands per project is an open decision.
UI automation of other apps (clicking, typing into them) remains unavailable.
