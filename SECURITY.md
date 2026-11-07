# Security policy

Vyomara reads files, runs commands, and opens apps on your Mac, so security
reports matter to us.

## Reporting a problem

Please **do not open a public issue**. Report it privately through
[GitHub security advisories](https://github.com/krnitish-shiv/Vyomara/security/advisories/new).
Include what you found, how to reproduce it, and what an attacker could do.

## What counts

- Any way to edit, delete, run, or open something **without the user's approval**
- Reading protected locations (`~/.ssh`, keychains, cloud credentials, `/System`)
- Prompt injection from files or web pages that leads to an unapproved action
- Data leaving the Mac, other than requests the user approved

## Design

The safety model is described in the [README](README.md#-safety-first),
[ADR-0007](docs/adr/0007-permission-gateway.md), and
[ADR-0015](docs/adr/0015-coding-agent-loop-and-approved-actions.md).
