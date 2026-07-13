# mcp-grok-executor

**An MCP server that turns [Grok CLI](https://x.ai) into the execution agent for Claude Code.**

Claude plans, reviews, and verifies. Grok implements, runs tests, and fixes failures. This server is the bridge: it exposes Grok's headless CLI as a set of MCP tools — including a fully orchestrated *execute → verify → auto-fix* loop — so the advisor model never has to babysit the executor.

```
You ──► Claude Code  (advisor: plan / review / judge evidence)
              │
              │  MCP (stdio)
              ▼
      mcp-grok-executor
              │  grok -p … --always-approve   (subscription OAuth)
              ▼
         Grok CLI  (executor: edit files / run tests / fix)
              │
              ▼
       your project (cwd)
```

## Why

Pairing two models works best with a clear division of labor: a strong reasoning model that owns the design and the acceptance criteria, and a fast execution model that grinds through implementation. Doing that by hand means endless copy-paste. This server makes the loop native to Claude Code:

1. You approve a plan.
2. Claude calls **`run_task`** with a prompt and a `verify_command` (e.g. `npm test`).
3. The server runs Grok, collects `git status` + `diff`, runs your verify command, and — if it fails — automatically sends the failure output back to the *same Grok session*, up to `max_fix_attempts` times.
4. Claude receives a single structured result: every attempt, the diff, the changed files, the verify output. It judges the evidence instead of orchestrating the steps.

## Requirements

- **Node.js ≥ 20**
- **Grok CLI** on your `PATH`, logged in via subscription OAuth:

  ```bash
  grok login
  grok --no-auto-update -p "Say ok."   # sanity check
  ```

  No `XAI_API_KEY` needed — auth comes from `~/.grok/auth.json`.
- **Claude Code** (or any MCP client that speaks stdio).

## Install

```bash
git clone https://github.com/emigrete/mcp-grok-executor.git
cd mcp-grok-executor
npm install
npm run build
```

## Connect to Claude Code

**Globally (recommended)** — available in every project:

```bash
claude mcp add --scope user grok -- node /absolute/path/to/mcp-grok-executor/dist/index.js
```

**Per project** — drop a `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "grok": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-grok-executor/dist/index.js"]
    }
  }
}
```

If the `grok` binary is not on the `PATH` Claude Code inherits, add `"env": { "GROK_BIN": "/path/to/grok" }`.

## Tools

| Tool | Mutates? | Purpose |
|------|----------|---------|
| `auth_status` | No | Check Grok login (`~/.grok/auth.json`) |
| `review_task` | No | Read-only analysis: Grok runs with write/shell tools disabled |
| `execute_task` | **Yes** | One-shot implementation run (`--always-approve`) |
| `run_task` | **Yes** | **Orchestrated loop**: execute → git evidence → verify → auto-fix |
| `continue_task` | Optional | Follow-up prompt into a previous Grok session |
| `task_status` | No | Poll background jobs, read the live activity log |
| `cancel_task` | No | Cancel a running background job |

### Common arguments

Every Grok-running tool takes:

- `prompt` *(string, required)* — self-contained task brief for Grok
- `cwd` *(string, required)* — **absolute** path to the target project
- `model`, `max_turns`, `timeout_sec` *(optional)* — per-run overrides
- `background` *(optional bool)* — return a `job_id` immediately; poll with `task_status`

### `run_task` — the orchestrated loop

```
run_task({
  prompt:             "Fix the failing suite. Don't touch the tests.",
  cwd:                "/abs/path/to/project",
  verify_command:     "npm test",        // omitted → git evidence only
  max_fix_attempts:   2,                 // default 2; 0 disables auto-fix
  verify_timeout_sec: 300                // default 300
})
```

Returns structured evidence:

```json
{
  "ok": true,
  "sessionId": "…",
  "attempts": [
    { "type": "execute", "exitCode": 0, "summary": "…", "durationMs": 12314 }
  ],
  "git": {
    "isRepo": true,
    "changedFiles": ["src/foo.js"],
    "statusAfter": " M src/foo.js\n",
    "diff": "diff --git a/src/foo.js …",
    "noChanges": false
  },
  "verify": { "command": "npm test", "ran": true, "exitCode": 0, "output": "…", "attemptsUsed": 1 }
}
```

Loop policy:

- Auto-retry triggers **only** on `verify_command` failure. Each retry continues the *same* Grok session with the failure output and a fixed instruction to fix the underlying issue (never to weaken or delete tests).
- A failed Grok run aborts immediately — there is no verification signal to feed back.
- An empty diff never consumes retries; it is reported as `git.noChanges: true` for the advisor to judge (it may be legitimate).
- A verify timeout counts as a failure and enters the fix loop.
- `ok` is true only when Grok succeeded **and** the final verify passed (or none was requested).

## Watching Grok work live

The server runs Grok with `--output-format streaming-json` and parses the stream as it arrives. Two layers of visibility:

1. **MCP progress notifications** — during any synchronous call, Grok's narration (`[thought] …`, `[grok] …`) streams into the client's progress UI. In Claude Code you watch it think and act in the tool spinner.
2. **Live job log** — every event is appended to the job log in real time. For background jobs, `task_status` returns the growing feed, or just:

   ```bash
   tail -f ~/.cache/mcp-grok-executor/jobs/<job_id>.log
   ```

## Sessions

`execute_task` and `run_task` return a `sessionId`. Pass it to `continue_task` for stateful follow-ups ("now update the changelog", "fix the two remaining test failures") — Grok resumes with full context of what it just did.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `GROK_BIN` | `grok` | Path to the Grok CLI |
| `GROK_AUTH_PATH` | `~/.grok/auth.json` | Auth file checked by `auth_status` |
| `MCP_GROK_TIMEOUT_SEC` | `600` | Default timeout per Grok run |
| `MCP_GROK_MAX_OUTPUT_CHARS` | `80000` | Truncation budget for inline output |
| `MCP_GROK_MODEL` | (CLI default) | Default `-m` passed to Grok |
| `MCP_GROK_CACHE_DIR` | `~/.cache/mcp-grok-executor` | Job records + logs |
| `MCP_GROK_REVIEW_TOOLS` | read-only set | Tool allowlist for `review_task` |
| `MCP_GROK_REVIEW_DISALLOWED` | write/shell set | Tools stripped in `review_task` |

## Advisor policy

[`CLAUDE.md`](CLAUDE.md) ships the advisor/executor policy for Claude Code: plan first, delegate after approval, prefer `run_task` with a `verify_command`, always judge the returned evidence. Copy it (or merge it into your own `CLAUDE.md`) in projects where you want the full workflow, and optionally install [`agents/fable-advisor.md`](agents/fable-advisor.md) into `~/.claude/agents/`.

## Development

```bash
npm run typecheck   # tsc --noEmit (includes tests)
npm test            # unit tests (node:test + tsx)
npm run build       # compile to dist/ (tests excluded)
npm run smoke       # build + tests + real grok hello + MCP round-trip
```

The test suite covers the stream parser, the runner (against a fake `grok` binary), git evidence, the shell runner, the orchestrator loop policy, and progress-notification throttling.

## Security notes

- `execute_task` and `run_task` run Grok with `--always-approve` — treat them like giving an autonomous agent full access to `cwd`. Gate them behind manual approval in your MCP client; leave `review_task`/`auth_status` unrestricted.
- `verify_command` is arbitrary shell executed in `cwd` — same trust level as the execution tools. Only pass commands you'd run yourself.
- `review_task` disables Grok's write and shell tools and injects a read-only constraint, but it still runs a model with read access. Spot-check `git status` if in doubt.
- Never add `--debug` / `--debug-file` to the Grok invocation: the Grok debug log prints the OAuth bearer token in plaintext.
- Job logs under `~/.cache/mcp-grok-executor` contain prompts and outputs — don't put secrets in prompts.

## Roadmap

- ACP transport (`grok agent stdio`) for tool-call-level visibility (which file Grok edits, which command it runs — today you get its live narration).
- MCP resource exposing recent job results.
- Reverse bridge: let Grok pause mid-run and ask the advisor a question.

## License

[MIT](LICENSE)
