# ADR-0025: Memories across conversations

- **Status:** Accepted
- **Date:** 2026-11-07

## Context

Every conversation started from zero. The owner had to repeat things like
"my main project is KeylessRN" or "tests run with pnpm check". Claude Code
keeps such facts in memory files; Vyomara should do the same, visibly and
locally.

## Decision

1. **Store.** `MemoryStore` keeps short facts in `memories.json` in the
   app's data folder.
   - The file is `0600` and written atomically.
   - Up to 200 facts, each up to 300 characters.
   - A repeated fact is not saved twice.
   - Each fact is either general or tied to a project root.
2. **Tool.** `remember` saves one fact, written in English in the third
   person ("The user's main project is KeylessRN."). It is used when the user
   says "yaad rakhna" / "remember that…" or states a lasting preference.
   - It changes only Vyomara's own list, never the user's files, so it does
     not ask for review.
   - Each save shows in **Verified actions**.
   - Text that looks like a password, key or token is refused.
3. **Prompt.** Saved facts appear in "What you remember about the user",
   within a 4,000-character budget. General facts and the active project's
   facts come first, then other projects' facts, each labelled with its
   project. The user's current words win over a stale memory.
4. **Memories panel.** The panel under **Your data** lists the facts by
   general and by project. Each fact has a **Forget** button.

## Consequences

- Live test with qwen3:14b: after "Yaad rakhna: mera main project KeylessRN
  hai…", a new conversation answered "Main project KeylessRN hai, aur tests
  pnpm check se chalate hain."
- Saving a fact depends on the model calling `remember`; the user can always
  check the panel.
