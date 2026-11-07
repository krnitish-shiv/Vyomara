# Local Ollama provider

Vyomara talks only to a local [Ollama](https://ollama.com) service, by default
at `http://127.0.0.1:11434`. The URL must use HTTP on `localhost`,
`127.0.0.1`, or `::1`. There is no cloud fallback. Vyomara never follows
redirects and needs no API key.

## Choosing a model

The agent needs a model with **tool calling**. Bigger models follow multi-step
instructions far better.

| Model | Size | Notes |
|---|---|---|
| `qwen3:14b` (default) | ~9.3 GB | Best balance on 24 GB Macs. Reliable tool calls. |
| `qwen2.5-coder:14b` | ~9 GB | Strong at code; slightly weaker at long tool sequences. |
| `qwen3:8b`, `qwen2.5-coder:7b` | ~5 GB | Faster, noticeably less reliable on multi-step tasks. |
| `qwen3:30b-a3b` | ~19 GB | Better quality; needs 32 GB+ RAM. |
| `llama3.2` (3B) | ~2 GB | Answers simple questions; not recommended for coding. |

## Running any local model from the app

Everything below happens in the **Models** panel (sidebar, or the model name in
the header). No code or configuration changes are needed.

| Task | How |
|---|---|
| Use a new model | Type its name under **Download another model**. Use a name from [ollama.com/library](https://ollama.com/library) (for example `deepseek-r1:14b`), or a GGUF model from Hugging Face as `hf.co/<user>/<repo>:<quantization>`. Then click the model to use it. |
| See what a model can do | Each model shows its size, its maximum context, and badges. **Tools** means it can read and edit code, run commands, and open apps. **Thinking** and **Vision** are optional extras. **Chat only** means no tools. |
| Change memory and speed | Under **Settings for \<model\>**, choose a context window (capped at the model's maximum), and turn **thinking** on or off (only for models that support it). |
| Free disk space | Click **Remove…** next to an unused model and type `DELETE`. |
| Start Ollama | If Ollama is not running, the panel offers **Start Ollama**. |

The model choice, context window, and thinking setting are saved locally and
take precedence over the `VYOM_OLLAMA_*` environment variables. The CLI uses
them too, unless an environment variable or `--model` is given.

**Chat-only models** (no tool support) still work for conversation. Vyomara
sends them no tools, tells them their limits, and adds a fixed notice under
every reply, because small models often ignore instructions and claim to have
read files they cannot access. If Ollama rejects tools at request time,
Vyomara retries the request without tools and treats the model as chat-only.

From a terminal, the same steps are:

```sh
ollama pull deepseek-r1:14b
ollama show deepseek-r1:14b   # "tools" under Capabilities = full agent
pnpm dev -- --model deepseek-r1:14b "your task"
pnpm eval -- --model deepseek-r1:14b --runs 2   # compare quality with qwen3:14b
```

## Context window and thinking

Ollama's built-in context window is only a few thousand tokens. That is far
too small for reading code, and longer prompts are silently cut. Vyomara
therefore always sends `options.num_ctx`:

- `VYOM_OLLAMA_NUM_CTX` (default `32768`, range 2,048–262,144). The KV cache
  grows with this value. For `qwen3:14b`, 32K adds roughly 5 GB on top of the
  model. Lower it to `16384` if memory is tight.
- Before each model call, the agent fits the conversation into this budget:
  1. It shortens tool output from earlier turns.
  2. It drops the oldest turns.
  3. As a last resort, it shortens older results within the current request.

For models that report the `thinking` capability (such as qwen3), Vyomara
sends `think: false` unless `VYOM_OLLAMA_THINK=true`. Any `<think>` blocks a
model prints are removed from replies.

## How well it works

Real runs on an Apple M4 Pro (24 GB) with `qwen3:14b`, 32K context, through
the CLI with approvals answered "yes":

- **"Where is `num_ctx` set in my vyomara project?"** No path was given. The
  agent found the project from the project-folder list, ran `search_text`, and
  answered with the correct file and line in about 40 s.
- **"A test is failing in this project — find the bug, fix it, and verify":**
  - **Thinking off, before nudges:** 2 of 3 runs succeeded. The failed run
    announced a next step and stopped, or pasted a fix instead of applying it.
  - **Thinking off, with nudges:** the agent now nudges the model to continue
    or to apply the change (at most twice per request). 4 of 4 runs
    succeeded, in 63–192 s and 8–13 steps:
    1. Ran the tests.
    2. Read the test and the source.
    3. Edited `price * quantity`, and only that file.
    4. Re-ran the tests to confirm they pass.
  - **Thinking on:** 0 of 2 succeeded and took 3–4 minutes each, so it stays
    off by default.

### `pnpm eval` results (qwen3:14b, 32K context, 2 runs per scenario)

| Scenario | Before `update_plan` | With `update_plan` and later fixes |
|---|---|---|
| locate-code (file + line of a function) | 2/2, 9–24 s | 2/2, 10–20 s |
| fix-bug (failing test, fix code not test) | 1/2, 47–60 s | 2/2, 77–118 s |
| add-feature (new function + test + fix) | 2/2, 111–379 s | 2/2, 153–266 s |
| explain-hinglish (Roman Hinglish summary) | 0/2 | 0/2 — still replies in Devanagari |
| **Total** | **5/8** | **6/8** |

These samples are small, and timings are noisy because other work shared
Ollama during the runs. The plan checklist made fixes more reliable at the
cost of a few extra steps. Roman-script Hinglish replies remain a weakness of
this model.

Local models are not deterministic. If a task stalls, ask Vyom to continue or
rephrase with more detail (a file name, the error message). A larger model
gives the biggest improvement.

## Request flow

1. The agent builds a system prompt containing:
   - Today's date and the OS.
   - Your home folder.
   - Project folders (for example `~/Projects`) and the projects in them.
   - The project this conversation last worked in.
   - Working rules for the tools that are available.
2. It calls `/api/chat` with every registered tool. In the desktop the response
   streams, so text appears live.
3. Each tool call goes through:
   - argument validation, after `null` options are dropped and numeric
     strings are coerced;
   - policy;
   - approval, if needed;
   - execution.

   The result, or the error, goes back to the model.
4. The loop ends when the model answers without tool calls, or when a step
   limit is reached. The reply ends with **Verified actions**, built from tool
   results.

Streaming responses may spread tool calls over several chunks; all of them are
kept.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Ollama is unavailable" | Start Ollama (`ollama serve` or the app). Check `VYOM_OLLAMA_BASE_URL`. |
| "model is not installed" | `ollama pull <model>` or download it in **Models**. |
| Very slow first reply | The model is loading into memory. Vyomara keeps it loaded for 30 minutes while the app runs, unloads it when you quit, and unloads the old model when you switch. Check with `ollama ps`. |
| Replies ignore files or forget earlier steps | Raise `VYOM_OLLAMA_NUM_CTX` (memory permitting) or use a stronger model. |
| "took too long to respond" | Raise `VYOM_REQUEST_TIMEOUT_MS` (default 300,000 ms per model call). |
| Agent stops early | Ask it to continue. Raise `VYOM_MAX_AGENT_ITERATIONS` or `VYOM_MAX_TOOL_CALLS` for very large tasks. |

Set `VYOM_PROVIDER=placeholder` to run the app without any model (it returns a
fixed reply).
