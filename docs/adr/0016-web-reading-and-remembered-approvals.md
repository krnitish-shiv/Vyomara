# ADR-0016: Web reading and remembered approvals

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

Two gaps remained after [ADR-0015](./0015-coding-agent-loop-and-approved-actions.md).

First, the agent could open pages in the user's browser but not read them, so
"read this page and tell me", documentation lookups, and changelog checks
were impossible.

Second, coding loops run the same command (for example `pnpm test`) many
times, and approving every run is tedious enough that users stop reading the
approval cards.

## Decision

1. **`fetch_url`.** Vyomara downloads a public page itself after the user
   approves, and returns readable text (paged with `offset`/`nextOffset`), the
   title, and up to 25 links.
   - **Identification:** requests identify honestly as `Vyomara/0.1` and send
     no cookies or credentials.
   - **Bounds:** 20 s timeout, 3 MB, text content types only, at most 5
     redirects.
   - **Private networks:** loopback, private, link-local, and `.local` hosts
     are refused, including when reached through a redirect.
2. **`web_search` only through a legitimate backend.** Search uses a SearXNG
   instance the user configures (`VYOM_SEARXNG_URL`, with the JSON format
   enabled). Vyomara does not scrape search-engine result pages or work
   around bot checks. Without a backend, the agent fetches known URLs, or
   opens a Google search in the browser when the user wants to see results.
3. **The approval card names who receives data.** Each fetch or search shows
   the host, the address or search text, and that the page text then goes to
   the local model.
4. **Remembered approvals, scoped tightly and short-lived.**
   - **Commands:** "Always allow here" (CLI: `a`) remembers one exact command
     string in one exact folder.
   - **Web:** "Always allow \<host\>" remembers one web host.
   - **Lifetime:** both are kept in memory only, until the app or CLI process
     exits. Nothing is persisted.
   - **Still verified:** runs approved this way still appear in Verified
     actions, marked "(always-allowed)".

   File edits, deletions, app launches, and `open_url` are always asked.

## Consequences

- Page text is untrusted model input. The prompt tells the model never to
  follow instructions found on web pages, and every fetch is visible in the
  step list and the footer.
- Hostname-based private-network checks do not resolve DNS, so a public name
  that resolves to a private address (DNS rebinding) is not caught. Per-fetch
  approval is the mitigation.
- Remembering a command does not inspect what the command does. A remembered
  `pnpm test` runs whatever the project's test script says at that moment.

## Verification

`test/web-tools.test.ts` covers:
- HTML extraction and private-host detection;
- redirect-to-private refusal, with the private target never requested;
- non-text refusal, paging, rejection without any download, and per-host
  "always";
- SearXNG parsing, and that `web_search` is absent without a backend.

`test/agent.test.ts` covers exact-command, exact-folder remembering. A
real-model run read `https://react.dev/blog` and answered in about 30 s.
