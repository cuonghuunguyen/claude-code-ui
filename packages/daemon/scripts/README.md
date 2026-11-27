# Recording fixtures

Tests never call a live engine. A fixture is recorded once from the real engine, cut to what the adapters read, and committed. Recording is manual.

| Fixture | Tool | Output |
|---|---|---|
| Claude (`packages/protocol/test/fixtures/*.jsonl`) | `record-fixture.ts` | SDK messages, one per line |
| OpenCode 1 (`test/fixtures/opencode/turn-*.json`) | `record-opencode.ts --v1`, then `cut-turn.ts --v1` | `{events, on?, abort?}` |
| OpenCode 2 (`test/fixtures/opencode2/turn-*.json`) | `record-opencode.ts --v2`, then `cut-turn.ts --v2` | list of steps |

Files named `rec-*` (`turn-rec-*.json`) are cut from a real recording by these tools. A JSON fixture has no header, so the name is the provenance. Recorded with Claude Haiku (subscription login), and OpenCode 1.19.5 / 2.3.0 with `deepseek/deepseek-flash` (DeepSeek V4.1 Flash). Never a free model.

## Scenarios

`plain`, `permission`, `question`, `interrupt`, `subagent`, `inline` (the prompts are in the scripts). `permission` makes the model run `touch conformance.txt` (a read-only command such as `echo` runs without asking). The recorder answers allow once / the first option of the question; `interrupt` stops after three text deltas.

`subagent` and `inline` read `notes.txt` of the scratch folder (a read there asks for no permission). `subagent`: a subagent (Claude `Agent`, OpenCode 1 `task`, OpenCode 2 `subagent`) reads it. The Claude recorder gives the CLI the daemon's own environment (`CLAUDE_CODE_FORK_SUBAGENT=0`, `forwardSubagentText`): without it the CLI starts the agent in the background and the turn holds no child step. OpenCode 2 has no foreground subagent: the call returns at once and the parent reports in a second turn (the recorder waits until the stream is quiet). `inline`: Claude runs the daemon's own runner (`runInlineClaude`, Read granted) on the real SDK and records the query's messages; OpenCode records a plain turn with one read call, which is what the child session of an inline run does.

## Claude

```
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN npm run record-fixture -w @claude-ui/daemon -- <out.jsonl> --scenario permission|question|interrupt|subagent|inline
```

Without `--scenario` the old behaviour stays: plain turns from the prompts given. The run refuses to start while an API key variable is set (ADR 0002). A scenario run uses a scratch folder (`/work/proj` in the file) and replaces the home folder by `/home/user`.

Besides the SDK messages, a scenario file holds, in the order they happened:

- `{"type":"__can_use_tool","toolName","toolUseID","input","reply"}`: the SDK called `canUseTool`, the recorder answered `reply` (a `PermissionResult`). A player calls `canUseTool` with `toolName` and `input` at this point and waits for the engine's answer (`test/conformance/fixture-query.ts`; the scenario answers, and the player fails when the answer's `behavior` differs from `reply`).
- `{"type":"__action","action":"interrupt"}`: the recorder called `query.interrupt()`. A player holds the turn until the engine calls `interrupt()`, then plays the rest (the interrupted marker, the aborted `result`).

## OpenCode

```
# version 2: npm install --prefix <dir> @opencode/cli@2.3.0  (binary: <dir>/node_modules/.bin/opencode2)
npm run record-opencode -w @claude-ui/daemon -- --v1|--v2 --bin <opencode binary> --scenario plain|permission|question|interrupt|subagent|inline --out <dir> [--model deepseek/deepseek-flash] [--auth <auth.json>]
npm run cut-turn -w @claude-ui/daemon -- --v1|--v2 <dir>/<scenario>.events.jsonl <out turn-rec-*.json>
```

- The server is started by the daemon's own code in a scratch folder with its own XDG dirs and only a minimal config. The login is not copied: `<dir>/data/opencode/auth.json` is a symlink to `--auth` (default `~/.local/share/opencode/auth.json`).
- `<dir>/<scenario>.events.jsonl` is the raw log (events of the stream and the recorder's actions). It holds machine paths: keep it out of git.
- The cut keeps the events the adapters read, replaces ids by the placeholders of the fake binaries, names the scratch folder `/work/proj`, and fails when a machine path or a name is left. It prints the event types it dropped. An event type of the session that is in neither the keep list nor the drop list of `cut-turn.ts` fails the cut: decide for the new type, then add it to a list. It also fails on more than nine assistant messages of the prompted session (the OpenCode 2 fake knows `$A1`..`$A9`): record a shorter scenario.
- A subagent's session (named by the `task` call's metadata on OpenCode 1, by the `subagent` call's progress line on OpenCode 2) is cut with the prompted one: `ses_CHILD` (OpenCode 1, one subagent) or `ses_child` (OpenCode 2; the conformance driver lists it as a session). OpenCode 2: the first call is `$CALL`, the others `call_2`...; the synthetic inbox items (the subagent ended) are kept, the user's are not.
- OpenCode 2: the tool's `shell.*` events and the shell progress line are dropped; the call's own success ends the card.
- Check a new fixture by replaying it: a scenario of `test/conformance` that names it.

## Hand-written parent turns

`hand-inline-call` (`protocol/test/fixtures/hand-inline-call.jsonl`, `turn-hand-inline-call.json` of both OpenCode versions) is not cut from a recording: it is the parent turn of an inline task, one running call of the daemon's `inline_task` tool that the Stop ends (the real call needs the daemon's MCP server, which the recorders do not run). Its head and tail (the user message, the init line and session id of Claude, the interrupt) are taken from `rec-interrupt`, so the user text of the OpenCode 1 file is that recording's prompt; the call is what is hand-written. The inline run it starts is the `rec-inline` recording.
