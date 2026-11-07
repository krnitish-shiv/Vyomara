# ADR-0012: macOS desktop interaction shell

- **Status:** Superseded by [ADR-0013](./0013-voice-first-app-integrations.md)

## Context and problem

> This ADR records a historical implementation decision. The current product
> direction is defined by [ADR-0013](./0013-voice-first-app-integrations.md)
> and [the product direction](../product-direction.md).

The CLI has validated the local agent, tool, and persistence boundaries, but
the product charter calls for a usable macOS desktop application. The first
desktop increment should expose real chat and task activity without creating a
second agent implementation or expanding tool permissions.

## Decision

Use Electron for the macOS shell and React + TypeScript + Vite for the
renderer. The Electron main process composes the existing application service.
Renderer requests cross a narrow, typed preload bridge; the renderer never
imports Node APIs, accesses files, or invokes providers/tools directly.

Enable context isolation, renderer sandboxing, disabled Node integration,
web security, and a restrictive content security policy. The app does not load
remote fonts or send renderer content to a remote service. Ollama requests
continue through the existing local-only provider configuration.

The first increment provides text chat, configured provider/model status,
request cancellation, and request-scoped task/tool activity. Provider/model
configuration is distinct from reachability. A later explicit user action can
check the configured loopback Ollama `/api/tags` endpoint; it does not run
automatically or claim that the configured model is installed. The CLI remains
supported. A native folder picker grants narrowly scoped read-only roots; the
desktop shows current grants and supports revoking each one. Roots are
persisted locally.

## Alternatives considered

- Continue with CLI only: preserves a small runtime but does not advance the
  desktop product target.
- Build a browser-only web UI: conflicts with the explicit macOS application
  requirement.
- Add a separate local HTTP service: creates a new network boundary without a
  current need; direct main-process composition is sufficient.

## Consequences and trade-offs

Electron and React add package size and build complexity. They provide a
replaceable desktop shell while keeping agent, policy, and storage logic in
the existing Node process. Packaging, project selection, settings, voice, and
any side-effect UI remain future work;
visible planned areas must not be presented as working.

## Security/privacy implications

Only the preload bridge is exposed to the renderer. IPC validates payload
shape, size, and session IDs. There are no shell, web-search, write, or delete
tools. Chat history remains in the existing local SQLite store. Renderer
messages are rendered as text, not executable HTML or Markdown.

## Evidence

The project charter and first-screen guidance in the shared Vyomara product
brief specify a native macOS app with visible model/provider and task status.
This ADR records the first, deliberately bounded desktop implementation.
