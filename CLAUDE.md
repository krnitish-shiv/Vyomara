# Vyomara — notes for AI coding agents

Follow [CONTRIBUTING.md](./CONTRIBUTING.md): it holds the project rules, code standards, test conventions, and layout. Product intent: [docs/product-direction.md](./docs/product-direction.md); current agent design: [ADR-0015](./docs/adr/0015-coding-agent-loop-and-approved-actions.md).

- Run `pnpm check` before calling any change done; run `pnpm test:desktop-ui` after renderer/Electron changes; run `pnpm eval` after agent/prompt/tool changes (needs Ollama).
- In VS Code terminals `ELECTRON_RUN_AS_NODE=1` is set; unset it when launching Electron manually.
- Real-model checks: `VYOM_DATA_DIR=<private dir, chmod 700> pnpm dev -- "<task>"`; pipe `y` lines to answer approvals.
