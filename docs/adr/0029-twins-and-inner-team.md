# ADR-0029: Two twins in front, an inner team behind them

- **Status:** Accepted; supersedes the user-facing specialists from the 2026-11-15 change (Kavach, Yatra, Khoj, Lipi as pickable assistants) and extends ADR-0021 (two assistants)
- **Date:** 2026-11-21

## Context

The owner wants a product with two characters: the twins **Vyom** and **Vyomara**, who run everything. The user talks only to them. Other agents may exist, but the twins manage them; the user never picks or addresses a specialist. Choosing which agent, model and tools to use for a task is the twins' job (memory: `vyomara-twins-only`).

Before this change, the four specialists sat in the assistant picker next to the twins and in the CLI `--agent` flag. Each one changed the system prompt through a `focus` field, so switching assistant also invalidated Ollama's cached prompt prefix.

## Decision

1. **Only two personas.** `PersonaId` is `'vyom' | 'vyomara'`. Each twin's system prompt names the other twin and says the two of them are the only assistants the user talks to. A saved specialist choice from an older version falls back to Vyom (`isPersonaId` uses `Object.hasOwn`).
2. **The inner team** (`src/agent/team.ts`):
   - **Khoj:** research
   - **Yatra:** travel
   - **Kavach:** Mac health and screen time
   - **Lipi:** writing

   Each member has a brief, a one-line "when to use", and a tool whitelist. Members cannot delegate further.
3. **The `delegate` tool** (`{member, task}`) is how a twin hands over work. `runTeamMember` runs the member in a fresh session:
   - **Cache-safe:** the member keeps the twin's system prompt and the full tool list, including the user's character text. That keeps Ollama's cached prefix valid. The member's role arrives in the first message.
   - **Tool limits:** the agent loop refuses any tool outside the member's whitelist.
   - **Approvals:** side effects still need the user's approval.
   - **Budget:** at most 20 steps and 40 tool calls, and the report is cut to 8,000 characters.
4. **Visible delegation.**
   - Activity rows read "Handing to Yatra: …", and the member's own steps appear as "Yatra: Getting the weather…".
   - The twin tells the user who is on the task, then passes the report on in its own words.
   - The system prompt includes team guidance only when the `delegate` tool is present.
5. **Long-running helper tools.** Tools that run a helper agent (`delegate`, `explore`) are marked `longRunning`. They get the 30-minute approval ceiling instead of the 30-second read-tool timeout. Before this, real delegations timed out after the member's first model step. Stop still cancels them immediately.
6. **`explore` now passes the twin's character as well.** Without it, a twin with a character set would miss the cache whenever it explored.

## Consequences

- The picker and the CLI offer only Vyom and Vyomara. The picker renders from `PERSONAS`, so it now shows exactly the twins.
- The user writes characters only for the twins. Stored characters for removed specialists are ignored.
- Adding a team member means one entry in `TEAM`, with no UI work and no change to the cached prefix. The delegate tool's description, and with it the tool list, changes only when a member is added.
- Checked with qwen3:14b: a Hinglish request for a Goa trip was handed to Yatra. Yatra asked for weather approvals, and Vyomara relayed a day-wise plan. The final reply repeated one sentence, a weakness of this model that the model work in roadmap milestone 3 should fix.
- Future (roadmap milestones 3 and 5): the twins also choose the model for each delegated task, with a fast talker model and a stronger worker model.
