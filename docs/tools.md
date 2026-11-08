# Agent tools

Vyom works through a fixed set of tools. The model chooses which to call; the
tool registry validates every argument, the policy gateway decides whether the
effect is allowed, and approval ports ask the user before anything changes.
Tool results go back to the model as data, never as instructions.

All paths are absolute. Protected locations are always refused, including:
- `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/etc`, and `/var`
- `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, and
  `~/.config/gcloud`
- keychains, `.netrc`, `.npmrc`, and Vyomara's own data folder

Symlinks are never followed. `VYOM_ALLOWED_ROOTS` (JSON array) narrows access;
`[]` disables filesystem tools. The default is the whole Mac.

## Read-only (no approval)

| Tool | Arguments | Notes |
|---|---|---|
| `list_directory` | `path`, `maxEntries?` | Direct children only. |
| `directory_tree` | `path`, `maxDepth?`, `maxEntries?` | Recursive structure. `node_modules`, `.git`, `dist`, `build`, `.venv`, … are listed with `collapsed: true` and not expanded. |
| `find_files` | `query`, `path?`, `maxEntries?` | Name fragment (`vyomara`) or glob (`*.test.ts`). Without `path` it searches the whole Mac, home and project folders first. Dependency folders are skipped. |
| `search_text` | `pattern`, `path`, `glob?`, `ignore_case?`, `max_results?` | Content search like grep. Regex, or literal text when the regex is invalid. Skips binary files, files over 1 MiB, and dependency folders. Returns `path`, `line`, `text`. |
| `update_plan` | `plan` | The agent's checklist for multi-step tasks, one step per line: `- [x]` done, `- [>]` in progress, `- [ ]` to do. It has no side effects. The desktop shows it as a live checklist and the CLI prints it. |
| `read_file` | `path`, `offset?`, `limit?` | UTF-8 text, up to ~800 lines per call (max 2,000), within the output budget. Returns `startLine`, `endLine`, `totalLines`, `truncated`; continue with `offset = endLine + 1`. Files above `VYOM_MAX_FILE_BYTES` (2 MiB) are refused. |

## Everyday helpers

Local tools with no side effects and no approval, always available:

| Tool | Arguments | Notes |
|---|---|---|
| `current_time` | `timezone?` | Date, time, weekday, and UTC offset on this Mac; with `timezone` (a city such as `London` or an IANA zone such as `America/New_York`) also the time there. |
| `calculate` | `expression` | Exact arithmetic without `eval`: `+ - * / ^`, `mod`, parentheses, `%` and "15% of 2400", `!`, `sqrt`, `log`, `ln`, trig in degrees, `min`, `max`, `pi`, `e`. |
| `convert_units` | `value`, `from`, `to` | Length, mass (including quintal), volume, area (sq ft, acre, hectare), speed, data size, time, and temperature. |
| `date_math` | `date?`, `other_date?` or `add?` | Days between two dates, or a date plus `+45 days`, `-2 weeks`, `3 months`. |
| `system_info` | — | macOS version, model, chip, memory, free disk, battery and charging state, uptime. |

With web access, these ask once per host like other web requests (**Always allow** remembers the host):

| Tool | Arguments | Source |
|---|---|---|
| `weather` | `place`, `days?` | Open-Meteo: current conditions and up to 7 days (temperature, feels-like, humidity, rain chance, wind, sunrise, sunset). |
| `currency_convert` | `amount`, `from`, `to` | European Central Bank reference rates via frankfurter.dev (major currencies; not AED or crypto). |
| `software_version` | `name`, `ecosystem?` | The latest release from the official registry: npm (default), PyPI, Homebrew, or GitHub releases (`owner/repo`). |

The agent is told to use these instead of its memory. When a question asks for
current information ("latest", "today", prices, versions, weather) and the
model answers without any tool, or asks "should I fetch it?" instead of
reading, the app sends it back to look it up (at most twice per request).

## File changes (reviewed)

Each call waits for the user. The desktop shows a diff (the CLI prints one) and
nothing is written until approval.

| Tool | Arguments | Notes |
|---|---|---|
| `edit_file` | `path`, `old_text`, `new_text`, `replace_all?` | `old_text` must match exactly once (or every occurrence with `replace_all`). The error says when it is missing or ambiguous, so the model can retry. |
| `write_file` | `path`, `content` | Creates a new file or replaces an existing one. |
| `create_directory` | `path` | Parent must exist. |
| `delete_path` | `path` | User must type `DELETE`. Moves to Trash. `/`, `/Users`, and `/Volumes` are refused. |

All file changes follow these rules:
- **Atomic:** writes go to a temporary file in the same folder, then an atomic
  rename.
- **Stale-file check:** a change is refused if the file changed after review
  (device, inode, size, modification time, and SHA-256 are compared).
- **Permissions:** new files and folders are owner-only.

Results are `{status: "applied" | "rejected", operation, path}`.

## Actions (approved)

These tools exist only when the host provides an approval port (`fetch_url`
also needs a web client; `web_search` also needs a SearXNG backend). The desktop
and CLI both do. They are also gated by the policy effects `shell`, `launch`,
and `network`.

| Tool | Arguments | Notes |
|---|---|---|
| `run_command` | `command`, `cwd`, `timeout_seconds?` | Runs `zsh -l -c` in `cwd`, with `CI=1`, no color, no pager, no stdin, and an augmented `PATH`. The whole process group is stopped on timeout or Stop. Output keeps the first ~6 KB and last ~14 KB. Returns `exitCode`, `timedOut`, and `output`. |
| `open_application` | `application`, `path?`, `line?` | Any installed app, by name or alias (`vscode`, `chrome`, …). Optionally opens a file or folder in it. With `line`, VS Code jumps to that line (`code -g`). |
| `control_application` | `application`, `action` | Window-level control of a running app. `focus` brings it to the front, `hide` hides it, `minimize` sends all its windows to the Dock, `restore` brings minimized windows back, `maximize` fills the main screen (without the menu bar and Dock) with its front window, `fullscreen` toggles macOS full screen, and `quit` closes it. Window actions wait a few seconds for an app that is still starting. The app is found by its bundle on disk, so an unknown name never opens a macOS dialog. See the permissions list below the table. |
| `open_url` | `url`, `browser?` | Only `http`/`https`, without credentials. The approval card says the website receives the URL. Vyom cannot read the page. |

| `fetch_url` | `url`, `offset?` | Vyomara downloads a public page and returns its `title` and text `content`, paged with `nextOffset`. The first page of results also includes up to 25 `links`. See the limits below the table. |
| `web_search` | `query` | Only when `VYOM_SEARXNG_URL` points to a SearXNG instance with JSON output enabled. Returns up to 10 `{title, url, snippet}`. |

`control_application` needs these macOS permissions for Vyomara:
- **Automation:** for `hide` and `quit`. macOS asks the first time.
- **Accessibility:** for `minimize`, `restore`, `maximize`, and
  `fullscreen`, set in System Settings → Privacy & Security. The error
  message explains this.

A standing app grant covers every action except `quit`, which always asks.

`fetch_url` limits:
- Only `http`/`https`, text content types, 3 MB, a 20 s timeout, and at most 5
  redirects.
- Requests are sent as `Vyomara/0.1` with no cookies or credentials.
- Loopback, private, link-local, and `.local` hosts are refused, including
  through redirects.

A rejected action returns `status: "rejected"` with a note telling the model
not to retry it unchanged.

**Standing permissions ([ADR-0017](./adr/0017-standing-permissions.md)).**
"Always allow" on an approval card, or **Allow** in the desktop Permissions
panel, saves a grant that skips future prompts until it is revoked:

- `open_application` for that app;
- `open_url` for that browser;
- `fetch_url` and `web_search` for that host.

Grants are stored in `permissions.json` in the app's data folder.

**Remembered approvals.** For commands, "Always allow here" (CLI: answer `a`)
remembers that exact command in that exact folder until the app quits. Edits,
new files, and deletions always ask. Everything done without a prompt is still
listed in Verified actions, marked "(always-allowed)". See
[ADR-0016](./adr/0016-web-reading-and-remembered-approvals.md).

## Coding helpers

| Tool | Approval | Notes |
|---|---|---|
| `multi_edit` | Reviewed diff | Several `{old_text, new_text, replace_all?}` edits to one file, applied in order and reviewed as one diff. |
| `git_info` | None | Read-only git without a shell: `status`, `diff` (`staged`, `target` file/branch), `log`, `show`, `branches`. Targets cannot be options. |
| `git_commit` | Exact command | `git add -A` (or the listed files) and `git commit -m …`, shown before it runs. Never pushes. |
| `git_branch` | Changes: exact command | `list` (no approval), `create` (optionally `from`), `switch`, `delete` (merged only, `-d`), `stash`, `stash_pop`. |
| `git_sync` | Pull/push: exact command | `fetch` (no approval), `pull --ff-only`, `push` (sets upstream the first time). Never forced. |
| `github` | Writes: exact command, every time | Uses your `gh` login. Read: `pr_list`, `pr_view`, `pr_checks`, `pr_diff`, `issue_list`, `issue_view`, `run_list`, `run_log` (failed steps). Write: `pr_create`, `pr_comment`, `issue_create`, `issue_comment`. |
| `check_problems` | Exact command | Runs the project's own typecheck/lint script, or `tsc`, `cargo check`, `go vet`, `ruff`, `swift build`, and returns problems as `file:line:column` with a message. |
| `run_command` with `background: true` | Exact command | Starts a server or watcher that keeps running after the request; returns an id and its first output. |
| `command_output` | None | `read` new output of a background command, `stop` it, or `list` them. All stop when Vyomara quits. |
| `explore` | None | A read-only helper agent answers a code question in its own context and reports back with `path:line` references. It sees the same tools but can run only the read-only ones. |
| `notebook_edit` | Reviewed diff | Replace, insert, or delete one cell of a Jupyter notebook; stale outputs of a replaced code cell are cleared. |

## Slash commands and hooks

- **Commands:** start a message with `/review`, `/fix`, `/test`, `/commit`, or
  `/explain <what>`. Add your own as Markdown prompts in
  `<project>/.vyomara/commands/<name>.md` or `~/.vyomara/commands/<name>.md`;
  `$ARGUMENTS` is replaced by the rest of the line. Project and home commands
  override the built-ins.
- **Hooks:** `<project>/.vyomara/hooks.json` with `{"afterEdit": "pnpm exec eslint --fix ."}`
  runs that command after each applied edit, through the normal command
  approval (so a cloned repository cannot run code on its own; choose
  **Always allow here** once). If it fails, its output goes back to the model to fix.

## Long conversations, plan mode, and pictures

- **Summaries:** when a conversation no longer fits the context window, its
  oldest turns are summarised by the model and sent as a short note before
  the recent turns, instead of being dropped.
- **Plan first** (composer toggle): the agent investigates with read-only
  tools and replies with a numbered plan; edits, commands, and launches are
  refused until you press **Go ahead**.
- **Pictures:** attach, paste, or drop up to four images. They go with that
  message to a model marked **Vision** (for example `qwen2.5vl:7b` or
  `gemma3:12b`) and are not stored in history.

## MCP servers

Vyomara can use tools from [Model Context Protocol](https://modelcontextprotocol.io)
servers. Put them in `mcp.json` in the data folder
(`~/Library/Application Support/vyomara/mcp.json`, or `$VYOM_DATA_DIR/mcp.json`),
in the same format as Claude Desktop:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" }
    },
    "time": { "command": "uvx", "args": ["mcp-server-time"], "enabled": false }
  }
}
```

- Servers start with the app (stdio transport). Their tools appear to the
  model as `mcp_<server>_<tool>`, within a total limit of 64 tools.
- **Every call asks first**, showing the server, tool, and arguments.
  **Always allow** lasts until Vyomara quits.
- A server that fails to start is skipped; the CLI prints each server's state.
- MCP servers are programs you run with your own permissions. Only add ones
  you trust, and keep tokens in `env`, never in the chat.

## Bounds

| Bound | Limit | Setting |
|---|---|---|
| Tool output | 24,000 characters | `VYOM_MAX_TOOL_OUTPUT_CHARS` |
| Tool input | 400,000 characters | `VYOM_MAX_TOOL_INPUT_CHARS` |
| Read-only tool timeout | 30 s | `VYOM_TOOL_TIMEOUT_MS` |
| Command timeout | 120 s default, configurable | `VYOM_COMMAND_TIMEOUT_MS` |
| Approval-gated tool wait | up to 30 min | — |

Stop always cancels a pending approval or running tool.

## Privacy

Tool calls, file contents that were read, command output, and reviewed
proposals are stored in local conversation history and sent only to the local
Ollama service. Diagnostic events record tool IDs, timings, and outcomes, not
arguments or file contents. The database is not application-encrypted, so use
FileVault.

Portable path APIs cannot rule out every race with a hostile local process.
Vyomara revalidates right before each change but does not claim race-free
protection.

## Finding things on the web

When the user wants information, the agent finds it in the background and
answers in the chat with linked sources.

`browser` and `open_url` are offered to the model only when the user's message
asks to open, show, play, or use something in the browser, or to read, scroll,
or click what is open (`asksForBrowser`). A plain question never touches the
user's browser.

| Tool | What it does | Approval |
|---|---|---|
| `news_headlines` | Headlines from Google News RSS: title, publisher, time, link. Takes an optional topic and `hi` for Hindi. | `news.google.com` |
| `web_search` | Uses SearXNG when configured. Without it, searches Wikipedia's search API (facts) and Google News RSS (current events). | the search host |
| `fetch_url` | Reads a public page in the background. | per host |
| `browser` | Drives the user's own Chrome, visibly: `search` Google and read the results, `open`, `read` the front tab (including signed-in pages), `click` a numbered link, `scroll`, `back`. | One "Always allow" for Google Chrome covers browsing. |

The `browser` tool needs Chrome's **View → Developer → Allow JavaScript from
Apple Events**, and macOS permission for Vyomara to control Chrome. It stops at
CAPTCHA and sign-in pages and never tries to get around them.

`control_application` can also `scroll-down` / `scroll-up` any app. It sends
Page Down / Page Up and needs Accessibility access.
