# ADR-0026: A cached system prompt, per-turn context, and built-in web search

- **Status:** Accepted; amends ADR-0015 (system prompt), ADR-0024 (project
  context), and ADR-0025 (memories in the prompt)
- **Date:** 2026-11-15

## Context

Vyomara felt slow. Measured on the owner's M4 Pro (24 GB) with `qwen3:14b`:
the system prompt plus the tool list is about 7,300 tokens, and Ollama reads
them at ~170 tokens/s, so a request whose prefix is not in Ollama's prompt
cache waits ~42 s before the model writes a word. Priming at app start
(ADR-0015) covers the first message only, because the prefix kept changing:

- the active project's git summary ("3 changed files") sat near the top of the
  system prompt, so every edit the agent made invalidated the cache for the
  next step;
- the "project this conversation is working in", the remembered facts, and
  the project instructions were in the system prompt too, so they changed it
  on the first tool call of a chat;
- the tool list was filtered per request (no file-changing tools for a
  "don't change anything" request; browser tools only when asked), and a
  different tool list means a different prefix.

Ollama (the llama.cpp server) matches the longest common prefix, and the
chat template renders the system text before the tools, so any change to the
system text also re-reads every tool.

Web search had the same shape of problem: `web_search` existed, but without
a SearXNG instance it only searched Wikipedia and Google News, which cannot
answer "latest version of X", "docs for Y", or prices. `fetch_url` cannot
read Google. So most "find out and tell me" requests failed or guessed.

## Decision

1. **The system prompt and tool list are fixed for a conversation.** They
   depend only on the model (tool support), the persona, the home folder, the
   project folders, and the registered tools. `primeAgent` builds exactly
   the same text, and every later turn reuses Ollama's cached copy.
2. **Per-turn facts travel with the user's message.** `buildTurnContext`
   writes a block headed `[Context from the app, not from the user]` with
   today's date, the active project and its git summary, remembered facts,
   and a "no changes" note when the request forbids edits. The block is
   stored on the user message as `context` (persisted, so the history stays
   byte-identical between turns) and sent ahead of the user's words. The
   chat window shows only the user's words.
3. **Project instructions once per project.** `AGENTS.md` / `CLAUDE.md`
   text (up to 8,000 characters) is included in the context of the first
   turn in a project and again when it has left the last eight turns.
4. **Request-specific restrictions are enforced, not hidden.** Every request
   lists every tool. File-changing tools are refused with an explanation
   when the user asked for no changes; browser tools are refused unless the
   user asked to open, show, search, or use the browser. The refusal goes
   back to the model as a tool result, as plan mode already did.
5. **Built-in web search through DuckDuckGo.** Without `VYOM_SEARXNG_URL`,
   `web_search` sends the query as a form POST to
   `https://html.duckduckgo.com/html/` (no key, no account) and parses the
   organic results. The request carries a browser user agent, because the
   endpoint answers only browsers; cookies and credentials are never sent.
   The approval card names `html.duckduckgo.com` as the host that receives
   the query; "Always allow" covers that host only. If DuckDuckGo fails or
   asks for a bot check, the tool falls back to Wikipedia + Google News
   after a separate approval for those hosts, and says so in the result.
6. **Apps are found through Spotlight too.** `control_application` looks
   for the bundle in the application folders, then in
   `/System/Library/CoreServices` (Finder), then asks `mdfind` for an
   application bundle with that display name. Bundles in the Trash are
   ignored.

## Consequences

- With the same model, a turn after an edit now starts in ~1 s instead of
  ~42 s (measured: 8,063-token prompt, 271 ms prompt evaluation when the git
  state changed, 2 s when the project instructions were added). The first
  message of a chat still pays the full read unless priming finished.
- The user's query goes to DuckDuckGo (or the configured SearXNG) after
  approval. This is a new external host; the card discloses it. Fallback
  sources are disclosed in the result and need their own approval.
- Each stored user message grows by the context block (a few hundred
  characters, more on the turn that carries project instructions).
- The browser-gating words now include "search", "google", "dhoondo", and
  similar, so "google karo" may use Chrome when background search is not
  enough. The model is still told to work in the background first.

## Verification

`test/agent.test.ts`: the system prompt and tools stay identical across
turns while the context changes; the context carries the project, git state,
memories, and instructions once per project; refusals for read-only and
browser requests. `test/web-tools.test.ts`: DuckDuckGo results are parsed,
wrapped links are unwrapped, ads are dropped, and the Wikipedia/News fallback
asks for its own approval. Real-model timings above come from
`qwen3:14b` on 2026-11-15.
