# ADR-0017: Standing permissions for apps, browsers, and websites

- **Status:** Accepted; extends [ADR-0016](./0016-web-reading-and-remembered-approvals.md)
- **Date:** 2026-11-06

## Context

The owner asked that Vyom stop asking every time it opens VS Code or Chrome.
Approving the same harmless launch again and again adds friction without
adding safety, and trains people to click "approve" without reading. Earlier
decisions remembered approvals only until the app quit, and the desktop had no
place to see or change them.

## Decision

1. **Standing grants.** These grant types exist:
   - `app:<Application>`: open that app, optionally with a file or folder.
   - `browser:<Browser>` (or `browser:default browser`): open web pages in
     that browser.
   - `host:<host>`: let Vyom read pages from that website.
2. **Ways to grant.** A grant is created only by the user, in one of two ways:
   - **"Always allow …" on an approval card**, which also approves that
     action.
   - **The Permissions panel**, which has one-click "Quick allow" entries
     for VS Code, Chrome, web pages in Chrome or the default browser, Finder,
     and Terminal.
3. **Revoking.** The Permissions panel lists every grant with **Revoke**.
4. **Storage.** Grants are saved in `permissions.json` in the app's user-data
   folder (owner-only, written atomically) and loaded at startup. Invalid
   entries are ignored. The CLI keeps grants only for its own process.
5. **Never grantable:**
   - **File edits, new files, and deletions:** always reviewed.
   - **Shell commands:** "Always allow here" stays session-only and limited
     to one exact command in one exact folder, because commands can do
     anything.
6. **Transparency.** Actions taken under a grant still appear in the live step
   list and in Verified actions, marked "(always-allowed)".

## Later extension: app window control

`control_application` focuses, hides, minimizes, or quits a running app,
using AppleScript with arguments passed separately (never spliced into the
script). It reuses the `app:` grant for `focus`, `hide`, and `minimize`. Quit
is never covered by a grant.

## Consequences

- With `browser:` granted, the model can open any http(s) URL in that browser
  without a prompt. A prompt-injected page could make Vyom open other pages.
  Opening a page does not send local data, apart from what is in the URL
  itself. The opened page is visible to the user, and the footer lists every
  URL.
- With `app:` granted, the model can open any file or folder that is not
  protected in that app.

## Verification

`test/agent.test.ts`:
- **Grants:** skipping approval, the persistence callback, revoke, ignoring
  invalid saved grants, and round-tripping grant IDs.

`scripts/desktop-ui-smoke.mjs`:
- **Navigation:** the Permissions item is present.

A live desktop run:
1. "Open Visual Studio Code" was granted in the panel.
2. "vyomara project ko VS Code mein kholo" then opened VS Code with no card,
   reported as "(always-allowed)".
