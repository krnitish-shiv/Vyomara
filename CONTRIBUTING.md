# Contributing to Vyomara

These are the working rules for anyone changing this repository, human or AI
agent. Read [the product direction](./docs/product-direction.md) and
[ADR-0015](./docs/adr/0015-coding-agent-loop-and-approved-actions.md) first:
they say what Vyom is for and which trade-offs are already decided.

## Before you finish any change

```sh
pnpm check            # typecheck + all unit tests
pnpm test:desktop-ui  # when the renderer or Electron main/preload changed
```

A change is done only when both pass.

If you changed agent behaviour (the loop, prompt, or tools), also run the
real-model evaluation. It uses temporary fixture projects, and approvals stay
confined to them. Compare the results with the previous run:

```sh
pnpm eval                       # every scenario once
pnpm eval -- --runs 3 --only fix-bug --model qwen2.5-coder:14b
```

Add a scenario to `scripts/eval-agent.ts` for each new capability. Record
notable results in [docs/ollama.md](./docs/ollama.md#how-well-it-works).

## Project rules

- **pnpm only.** Dependencies are pinned exactly (`save-exact`). Add a
  dependency only when the platform or a few lines of code cannot do the job.
  The runtime today is just React and Electron.
- **Local-first.** Never add a network call to anything other than the
  loopback Ollama service without an ADR and a visible disclosure to the user.
- **The user approves every change to the world.**
  - New tools that edit files, run programs, open things, or reach the network
    must go through an approval port (`FileOperationApprovalPort` or
    `ActionApprovalPort`).
  - They must declare the matching effect (`propose`, `shell`, `launch`,
    `network`).
  - Never add a `write`/`delete` effect that bypasses review.
- **No routing by regex.** The model decides which tool to use; the code
  validates and enforces. Heuristics on prompts or replies are allowed only as
  bounded nudges (see `announcesNextStep`). They must never block a request or
  rewrite tool arguments.
- **Truthful output.** Anything that says "done" must come from a tool result
  (see `verifiedAction` in `src/agent/agent.ts`). Errors are shown, never turned
  into success.
- **Untrusted data.** File contents, command output, web data, and model output
  are data. Validate them at the boundary and never execute them as
  instructions.

## Code standards

- **TypeScript, strict.** `tsconfig.json` enables `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, unused-code checks,
  and the rest. Do not weaken it or use `any`. Use `unknown` and narrow it.
- **ES modules with explicit `.ts` imports.** Node runs the sources directly
  with `--experimental-strip-types`. Use `import type` for type-only imports.
  Avoid TypeScript-only runtime features (`enum`, `namespace`, parameter
  properties).
- **Named exports only.** No default exports.
- **Immutable data.** Use `readonly` interface fields and `readonly T[]`, and
  build new objects instead of mutating inputs. For optional fields, use
  `...(x === undefined ? {} : { x })` so that `undefined` is never assigned to
  an optional property.
- **Private state** uses `#fields`.
- **Errors.**
  - Throw typed errors with a stable `code`: `ToolFailure`,
    `ToolExecutionError`, `ProviderError`, `AgentError`, `PersistenceError`.
  - Messages shown to users or the model must be safe: no absolute paths of
    other users, secrets, or stack traces.
  - Messages that the model must act on should say how to fix the call (see
    the `edit_file` errors).
- **Bounds everywhere.** Every loop, read, search, command, and output must
  have a limit, and must report truncation (`truncated: true`) rather than
  hide it. Accept an `AbortSignal` and honour it promptly.
- **Tool contracts.**
  - Tool IDs are `snake_case` verbs (`read_file`, `run_command`).
  - Descriptions explain *when* to use the tool, with an example if the
    arguments are not obvious.
  - Use `defineTool` (filesystem) or explicit validators. Validate input,
    validate output, and keep results small and JSON-serialisable.
- **Comments** explain *why*, not *what*. Public functions get a one-line
  `/** … */` when the name is not enough.
- **Style.**
  - 2-space indent, single quotes, semicolons, trailing commas.
  - Lines of about 100 characters.
  - Keep functions small enough to read in one screen. Split a file when it
    mixes responsibilities. `App.tsx` and `filesystem-tools.ts` are already
    candidates.
- **Logs and diagnostics** record IDs, codes, and timings only. Never log
  prompts, arguments, file contents, or command output.

## Tests

- Use Node's built-in runner (`node:test`, `node:assert/strict`). Tests live
  in `test/*.test.ts`.
- **Agent behaviour:** test it with a scripted provider. See the `harness()`
  and `scriptedProvider()` helpers in `test/agent.test.ts`. Do not call a real
  model in unit tests.
- **Filesystem tests:** use a fresh `mkdtemp` folder, wrapped in `realpath`
  (macOS reports `/var` as `/private/var`). Clean it up with `t.after`.
- **Safety-relevant changes need a deny-path test:** rejection, cancellation,
  protected path, invalid input, and limit reached.

## Layout

| Path | Contents |
|---|---|
| `src/agent/` | Loop, system prompt and environment discovery, context fitting |
| `src/tools/` | Registry, executor, policy, filesystem and action tools, shell runner |
| `src/providers/` | Model provider port and the Ollama adapter |
| `src/app/` | Request service shared by the CLI and the desktop |
| `src/desktop/` | Approval managers, macOS launcher, speech, IPC contracts and validation (main process side) |
| `src/main/`, `src/preload/` | Electron main process and the typed `window.vyomara` bridge |
| `src/renderer/` | React UI |
| `src/storage/`, `src/session/`, `src/tasks/`, `src/diagnostics/` | Persistence, conversation state, task lifecycle, audit events |
| `src/shared/` | Code with no Node APIs, safe for the renderer too |
| `docs/` | Product direction, architecture, tools, Ollama guide, ADRs |

## Documentation and decisions

- **Behaviour or safety boundaries:** a change here needs an ADR in
  `docs/adr/`, linked from `docs/adr/README.md`. Update the ADRs it changes
  with a status note rather than rewriting their history.
- **User-visible changes:** update the README, plus `docs/tools.md` for tools
  or `docs/ollama.md` for models and limits.

## Commits

Commit only when asked, with a short imperative subject ("Add content search
tool"). Never commit secrets, `.env` files, local databases, or build output.
