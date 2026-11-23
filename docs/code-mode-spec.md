# Code mode (draft spec)

Status: on hold after the benchmark (no benefit shown with Bash available); phase 0 done (POC: `packages/daemon/src/code-mode.ts`, `code-mode-child.mjs`). To merge into `docs/spec.md`.

## Goal

One MCP tool `run_code` in the `claude-ui` MCP server. The model sends a JavaScript script; the Daemon runs it and calls tools from it. Only the script's return value goes to the model context. One implementation serves both Engines (Claude, OpenCode).

Use: a change repeated over many files, a search whose result needs filtering, several independent commands in parallel.

Not a goal: replace the Engine's own tools, run third-party code unreviewed, work around the permission flow.

## Background (facts)

- The official Claude Code "Code Mode" exists (env `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`, tool `REPL`). It does not work with the Agent SDK, so the Daemon cannot use it.
- The Agent SDK has no API to execute a built-in tool (`Bash`, `Read`, `Edit`) from the host. `canUseTool` and `PreToolUse` hooks can only allow, deny or rewrite the input.
- The Daemon already has the pattern: `inline_task` (MCP tool, permissions through the parent flow, run card, limits, Settings block). Code mode follows it.
- Daemon code to reuse: `bash.ts`, `grep.ts`, `fs-ops.ts`, `daemon-mcp.ts`, the `inlineTask` settings and protocol pattern.

## Decisions

| Topic | Decision | Reason |
|---|---|---|
| Script language | JavaScript | Node is already the Daemon runtime; no new runtime on any Side; models write it reliably; direct binding to Daemon functions |
| Shell binding | `$` tagged template in the style of zx (`.text()`, `.json()`, `.nothrow()`, `.quiet()`) | Models know the syntax; zx itself is not run because it bypasses approval |
| Tool implementation | Daemon-owned clones, not the Engine's tools | The SDK cannot execute built-in tools from the host |
| Permissions | Every inner call goes through the parent session's permission flow, with the tool name and input of the equivalent built-in call. The Daemon evaluates the parent's effective allow, deny and ask rules itself before it asks | `askPermission` only runs when the CLI decided to ask; saved rules never reach it |
| Network in the child | Allowed. Accepted risk | Node `--permission` does not restrict network; OS-level isolation differs per platform |
| Claude Code tool clones | Written from the public behaviour docs only (clean room); no copied code | Proprietary code |
| OpenCode code | May be adapted for gaps the docs do not specify, MIT notice in `THIRD_PARTY_NOTICES.md` | License check needed first |
| Default | Off | Experimental |

## Script API

Declared to the model as TypeScript declarations in the tool description.

| Function | Equivalent tool | Approval |
|---|---|---|
| `` $`cmd` `` / `sh(cmd, opts?)` | `Bash` | as `Bash` |
| `read(path, {offset?, limit?})` | `Read` | as `Read` |
| `grep(pattern, opts?)` | `Grep` | as `Grep` |
| `glob(pattern, opts?)` | `Glob` | as `Glob` |
| `edit(path, old, new, {all?})` | `Edit` | as `Edit` |
| `write(path, content)` | `Write` | as `Write` |
| `fetch(url)` (phase 3) | `WebFetch` | as `WebFetch` |

- `$` returns a promise. Fields: `stdout`, `stderr`, `exitCode`. Non-zero exit throws unless `.nothrow()`. Interpolated values are shell-escaped.
- All functions are async; `Promise.all` runs calls in parallel. Parallel approval requests queue in the UI.
- Paths: relative to the session cwd or absolute; same rules as the Engine's tools (real path check, additional directories).
- The result is the value of a script that is a single expression, or the `return` value of a statement body. A statement body without `return` gives `null`. (A completion value is not available with top-level `await`.)
- The result It is JSON-serialized; at most 16,000 chars (tail kept, `truncated: true`).
- `console.log` output is captured as `logs`, at most 16,000 chars.
- Behaviour rules copied from the tool docs: `Edit` needs a unique match unless `all`; `Edit` and `Write` of an existing file need a prior `read` in the same session; `read` returns line-numbered text; output truncation limits as in the docs.
- No `require`, `import`, `process`, `fs`, `child_process` or env access outside this API. Network is not blocked by the flags; it is reachable only if the script escapes the `vm` context (see Sandbox).

## Tool `run_code`

- Input: `code` (string, 1 to 50,000 chars), `timeoutMs?` (1,000 to 600,000; default 120,000).
- Result JSON: `{status, error?, result, logs, calls: [{tool, summary, ok}], filesChanged: string[], durationMs}`.
- `status`: `ok`, `error` (script threw), `denied` (user denied a call; script stops), `limit` (`time`, `calls`, `output`), `stopped`.
- Limits: 200 inner calls per run, wall clock 10 min, 3 running scripts per session, 16 MB captured output per call.
- A denied call with a comment: the call throws a catchable error with the comment. A denied call without a comment, or Stop: the script aborts, finished changes stay.
- Stop from the card or an interrupt of the parent turn aborts the script and kills only the processes the script started. No other process is touched.

## Sandbox

- The script runs in a child process with no inherited environment, started with `node --permission` and no grants except reading the child script itself, and communicates with the Daemon over the IPC pipe. The child has no file, process or worker access; all effects are requests to the Daemon.
- Network: `--permission` does not block it (a raw TCP connect succeeds in the child). Accepted risk: a script that escapes the `vm` context could send data it got through approved calls to an outside host. Approved `$` commands can use the network anyway, as `Bash` does.
- Inside the child, the script runs in a `node:vm` context created with string code generation and wasm off. A plain context is not enough (`this.constructor.constructor("return process")()` escapes it). Layers:
  - all API functions are built inside the context by a bootstrap script, so their constructors are context-realm;
  - the one main-realm function, `bridge`, stays in a closure of the bootstrap and takes and returns only strings;
  - no main-realm object, including an error, may cross into the context.
- The Daemon, not the child, runs every inner call after approval.
- The child is killed on Stop, timeout and session end.
- Phase 0 verified the flag on Node 22.23 only. Verify it in the minimum Node version of the Daemon; fall back to a plain subprocess with the request pipe as the only channel.

## Permissions

- Each inner call builds the request the Engine would build (tool name, input). The Daemon first evaluates the parent's effective permission rules (as `inline-claude.ts` reads them through `parentSettings`): deny refuses, allow runs, ask or no match goes to the parent's flow: Claude (rules, mode, auto-mode classifier through the Daemon's `canUseTool`), OpenCode (the mode's actions).
- The request card appears in the `run_code` card as a step, as with `inline_task`.
- "Always allow for this session" adds the grant to the parent session.
- `PreToolUse` hooks of the parent do not run for inner calls (same gap as `inline_task`); permission rules do.
- The script never gets a wider permission than the session mode.

## UI

- Card under the tool call `run_code`: status, first line of the code, `calls · duration`, Stop while running.
- Body: the calls as steps (collapsed, "N steps"), edit diffs for `edit` and `write`, the result, the logs, changed files.
- The code is available in an expandable "Code" block, collapsed by default.
- After a Daemon restart or history reload: result, calls summary and files from the stored tool result; note "Steps are not kept after the daemon restarts."
- Rewind: local history does not undo edits made by `run_code`.

## Engines

- Claude: `run_code` registered in the `claude-ui` SDK MCP server beside `inline_task`.
- OpenCode: same server attached by URL as today. Permission requests map to OpenCode's permission replies.
- Both: same API, same limits, same card. A capability the Engine cannot support is hidden (Engine interface and capability flags).

## Setting `codeMode` (Settings › Sessions › Code mode)

| Key | Default | Rule |
|---|---|---|
| `enabled` | `false` | off: a query or attach that starts afterwards has no `run_code`; a running query keeps it and the call fails with "turned off" |
| `maxCalls` | 200 | 1 to 1,000 |
| `timeoutMs` | 120,000 | 1,000 to 600,000 |

Text in `en` and `vi` i18n.

## Security

- Script input is model output, treated as untrusted.
- Auto mode classifier sees each inner call as a normal request, not the script.
- Secrets: the child has no environment; `$` commands run with the session's environment as `Bash` does.
- Hooks gap, rewind gap and the permission queue under parallel calls are documented limits.
- Child messages are untrusted: the Daemon validates their shape, accepts only known function names (own keys) and never throws out of the message handler.
- The call limit is counted before approval, so parallel calls cannot pass it together.
- Paths: the real path of a new file is its nearest existing ancestor's real path plus the rest, so a symlinked folder cannot lead out of the project. `glob` rejects absolute patterns and `..`, and drops matches whose real path is outside.
- The child heap is capped (256 MB in the POC); running out ends the run with an error that says so.

### Security test (POC, Node 22.23)

| Probe | Before fix | After fix |
|---|---|---|
| Replace `JSON.stringify` so the bridge's `JSON.parse` throws a main-realm `SyntaxError`, then `e.constructor.constructor("return process")()` | **Escape** (process, network) | Blocked |
| Stack overflow inside the bridge, `Error.prepareStackTrace` frames | Blocked | Blocked |
| `eval`, `Function`, `import()`, wasm compile, `process`/`require`/`fetch` globals | Blocked | Blocked |
| After an escape: fs, `child_process`, workers, `process.binding`, `dlopen` | Blocked by `--permission` | Not reachable |
| After an escape: TCP and `fetch` to an outside host | Works (accepted risk) | Not reachable |
| After an escape: forged IPC call | Still asks for approval; `args: null` caused an unhandled rejection in the parent | Ignored |
| `write` of a new file through a symlinked folder | **Wrote outside the project** | Refused |
| `glob("../*")`, absolute pattern, through a symlinked folder | **Listed names outside** | Refused or filtered |
| `read` of a symlink, `..`, absolute path; `grep` path through a symlink | Refused | Refused |
| 5,000 parallel calls with limit 200 | **4,985 approval requests** | 200 |
| Shell quote injection through `$` interpolation | Escaped | Escaped |
| Memory bomb, log flood, infinite loop, `Atomics.wait` | Child killed or limited | Same; memory error named |
| Non-string `edit`/`write` arguments | Reached approval | Refused before approval |

## Phases

| Phase | Content | Exit criterion |
|---|---|---|
| 0 | Read-only check: can the Daemon's approval function be called for a synthetic request on both Engines; Node permission flag; zx and OpenCode license and structure | Done for the Claude engine and Node 22.23; spec updated. OpenCode reply mapping open |
| 1 | Daemon-side permission rule evaluation; `run_code` with `$`, `read`, `grep`, `glob`; child process sandbox; approvals; card; Settings toggle | Works on both Engines; denial, stop and timeout tested |
| 2 | `edit`, `write`; diff rendering; read-before-edit rule | Edit behaviour matches the tool docs in black-box comparison |
| 3 | `fetch`; bridge to other MCP tools (needs an MCP client in the Daemon) | Optional; decide after phase 2 measurements |

Measure before phase 2: calls and tokens for a multi-file task with and without `run_code`.

### Benchmark (POC, 2026-11-23)

Overhead of `runCode` (Node 22.23, macOS, median of 15): child start 33 ms; 100 serial reads 47 ms; 100 parallel reads 38 ms; 10 serial `$` 72 ms.

Model run: Sonnet through the Agent SDK, `bypassPermissions`, fixture of 25 TypeScript files, 2 runs per cell, means. Tasks: `rename` (rename a function in definition, imports, calls, property key: 97 sites), `meta` (add `index: N` per file, value taken from the file name), `todos` (count TODOs per file, reply JSON).

| Task | Mode | Correct | Tool calls | Input tokens | Output tokens | Cost USD | Seconds |
|---|---|---|---|---|---|---|---|
| rename | Bash | 2/2 | 2 | 51,763 | 310 | 0.036 | 7.7 |
| rename | Bash + `run_code` | 2/2 | 2.5 | 65,508 | 333 | 0.040 | 8.7 |
| rename | no Bash | 2/2 | 51 | 137,883 | 7,482 | 0.307 | 48.9 |
| rename | no Bash + `run_code` | 2/2 | 3.5 | 87,603 | 907 | 0.100 | 11.0 |
| meta | Bash | 2/2 | 2 | 50,417 | 305 | 0.036 | 8.6 |
| meta | Bash + `run_code` | 2/2 | 2 | 53,946 | 339 | 0.042 | 6.9 |
| meta | no Bash | 0/2 (a space missing after `index: N,`; logic right) | 49 | 132,629 | 6,625 | 0.250 | 42.0 |
| meta | no Bash + `run_code` | 2/2 | 2.5 | 61,023 | 571 | 0.046 | 9.0 |
| todos | all four modes | 2/2 | 1 (one `Grep`) | 23,466 to 27,301 | about 390 | 0.022 to 0.023 | 5.4 to 6.9 |

Findings:
- With Bash available, the model mostly keeps using Bash (`sed`, `grep -c`). It chose `run_code` in 3 of 6 Bash + `run_code` runs, all for `meta`. No gain over Bash; the tool description adds about 1,000 to 3,500 input tokens.
- Without Bash (a Bash deny rule, an OpenCode agent with bash denied; rare in practice), `run_code` replaces about 50 Read/Edit calls with 2 to 4 calls: 3 to 6 times cheaper, 4 to 5 times faster, 8 to 12 times fewer output tokens.
- A search that one `Grep` answers gains nothing.
- Limits: one model, one fixture, 2 runs per cell; the POC result is returned whole (no per-call trim).

Multi-hop run on a copy of this repo (Sonnet, Bash available in both modes, 2 runs per cell, means; all 12 runs correct):

| Task | Mode | Tool calls | Input tokens | Cost USD | Seconds | `run_code` used |
|---|---|---|---|---|---|---|
| Exports kept only for tests (387 exports checked, 62 found) | Bash | 2 | 49,163 | 0.046 | 59 | — |
| | Bash + `run_code` | 3.5 | 113,083 | 0.153 | 95 | 2 of 2 runs; each first script failed, each second hit the 200-call limit (one `grep` per export), then Bash |
| Rename `runBash` with 4 unrelated same-name identifiers, then `tsc` | Bash | 4 | 105,205 | 0.068 | 21 | — |
| | Bash + `run_code` | 3.5 | 80,492 | 0.060 | 17 | never |
| Trace `!` command from WebSocket handler to spawn (5 files) | Bash | 9 | 147,576 | 0.104 | 20 | — |
| | Bash + `run_code` | 7.5 | 123,919 | 0.085 | 20 | never |

Conclusion: in realistic sessions the model does dependent hops with `Grep`/`Read` and loops with Bash. It did not batch hops into `run_code`; where it used it, the run cost 3.3 times more. Differences in rename and trace come from runs that never called `run_code` (noise). No token or time benefit is shown; the remaining value is per-call permission checks and `Edit` rules.

## Tests (risk based)

- Contract: script API surface and result JSON.
- Regression of the permission path: a denied call stops the script; a denied call with a comment is catchable.
- User-visible: the card shows steps, diff and Stop.
- Sandbox: the child cannot read a file or open a network connection outside the API.
- E2E only if added to the critical journeys in `docs/testing.md`.

## Open questions

1. Closed for Claude: yes, `askPermission` in `claude-engine.ts` is already called with a bridge by `inline_task`.
2. Does `$` need a custom executor in zx, or is our own tag function enough?
3. Output format of `read` and `grep`: copy the Engine's format or return structured data? Structured data is easier for scripts; the Engine format is closer to model training.
4. Do OpenCode permission replies support a request without a tool call id?
5. Windows: shell used by `$` when no bash exists.

## Licenses

- Claude Code tools: behaviour only, no code.
- zx: API shape only unless its code is reused; verify the license, add a notice if used.
- OpenCode: verify the license; add a notice to `THIRD_PARTY_NOTICES.md` for any adapted code.
