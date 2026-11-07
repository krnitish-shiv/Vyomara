# ADR-0013: Voice-first assistant operating existing macOS apps

- **Status:** Superseded

> Historical decision. The current direction is in
> [product-direction.md](../product-direction.md); manual project selection,
> project editing, settings, and direct app integrations are not part of the
> current desktop workflow.

## Context and problem

The current implementation and earlier MVP decisions emphasize text chat and
read-only tools. The user clarified on October 30, 2026 that Vyomara should
instead be a voice-first assistant whose own desktop app shows its activity,
approvals, and settings, while work happens in the applications already
installed on the Mac. The shared reference image reinforces a voice-centered
home screen, task progress, tool activity, reviewable approvals, and integrated
settings.

## Decision

- Make the Vyomara desktop app the assistant's control room, with voice as the
  primary interaction and a text fallback. Listening and speaking must be
  visible, controllable, and privacy-conscious.
- Do not build an editor, IDE, or general-purpose browser into Vyomara.
- Open or activate the user's existing VS Code and work in the user's existing
  project/workspace for coding requests.
- Open or activate the user's existing Google Chrome for explicitly requested
  searches. Do not claim success when app launch or search fails.
- Make active tasks, progress, application/tool activity, results, errors,
  cancellation, and pending approvals visible in Vyomara.
- Show code changes as a reviewable diff. Require explicit, action-scoped user
  approval before applying them. Sensitive and destructive actions also remain
  approval-gated.
- Put routine model/runner, permissions, voice, privacy, appearance, and
  diagnostics settings in the Vyomara interface.
- Preserve local-first behavior, least privilege, bounded execution, honest
  status reporting, and protection of secrets.

This decision supersedes earlier MVP and phase decisions wherever they
conflict, including the text-first interaction direction in ADR-0004 and the
first-shell decision in ADR-0012. Existing implementation remains reusable
only where it supports this target. See
[the product direction](../product-direction.md) for user-facing requirements
and [current requirements](../requirements.md) for precedence.

## Consequences

This is a product-level target, not a claim that voice, app control, code
editing, or the approval workflow already exists. These capabilities need
separate implementation, security boundaries, permission design, and tests.
App control must use narrow integrations; this decision does not authorize
arbitrary shell execution, unrestricted computer control, or unattended code
changes. Search must disclose external data flow. Existing text chat and
read-only tools may remain as fallback capabilities if they fit the target
experience.

Voice input now uses a bundled Swift helper linked to Apple Speech and
AVFoundation. The helper declares macOS microphone and speech usage
descriptions, and requests on-device-only recognition after the user presses
the listening control. Desktop builds require the local Swift compiler and
code-signing utility. Permission behavior still needs validation in a
distributed signed app.
