# Recording fixtures

Tests never call a live engine. A fixture is recorded once from the real engine, cut to what the adapters read, and committed. Recording is manual.

| Fixture | Tool | Output |
|---|---|---|
| Claude (`packages/protocol/test/fixtures/*.jsonl`) | `record-fixture.ts` | SDK messages, one per line |
| OpenCode 1 (`test/fixtures/opencode/turn-*.json`) | `record-opencode.ts --v1`, then `cut-turn.ts --v1` | `{events, on?, abort?}` |
| OpenCode 2 (`test/fixtures/opencode2/turn-*.json`) | `record-opencode.ts --v2`, then `cut-turn.ts --v2` | list of steps |

Files named `rec-*` (`turn-rec-*.json`) are cut from a real recording by these tools. A JSON fixture has no header, so the name is the provenance. Recorded with Claude Haiku (subscription login), and OpenCode 1.19.5 / 2.3.0 with `deepseek/deepseek-flash` (DeepSeek V4.1 Flash). Never a free model.

## Scenarios

`plain`, `permission`, `question`, `interrupt` (the prompts are in the scripts). `permission` makes the model run `touch conformance.txt` (a read-only command such as `echo` runs without asking). The recorder answers allow once / the first option of the question; `interrupt` stops after three text deltas.

## Claude

```
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN npm run record-fixture -w @claude-ui/daemon -- <out.jsonl> --scenario permission|question|interrupt
```

Without `--scenario` the old behaviour stays: plain turns from the prompts given. The run refuses to start while an API key variable is set (ADR 0002). A scenario run uses a scratch folder (`/work/proj` in the file) and replaces the home folder by `/home/user`.

Besides the SDK messages, a scenario file holds, in the order they happened:

- `{"type":"__can_use_tool","toolName","toolUseID","input","reply"}`: the SDK called `canUseTool`, the recorder answered `reply` (a `PermissionResult`). A player calls `canUseTool` with `toolName` and `input` at this point and waits for the engine's answer (`test/conformance/fixture-query.ts`; the scenario decides the answer, `reply` is not compared).
- `{"type":"__action","action":"interrupt"}`: the recorder called `query.interrupt()`. A player holds the turn until the engine calls `interrupt()`, then plays the rest (the interrupted marker, the aborted `result`).

## OpenCode

```
# version 2: npm install --prefix <dir> @opencode/cli@2.3.0  (binary: <dir>/node_modules/.bin/opencode2)
npm run record-opencode -w @claude-ui/daemon -- --v1|--v2 --bin <opencode binary> --scenario plain|permission|question|interrupt --out <dir> [--model deepseek/deepseek-flash] [--auth <auth.json>]
npm run cut-turn -w @claude-ui/daemon -- --v1|--v2 <dir>/<scenario>.events.jsonl <out turn-rec-*.json>
```

- The server is started by the daemon's own code in a scratch folder with its own XDG dirs and only a minimal config. The login is not copied: `<dir>/data/opencode/auth.json` is a symlink to `--auth` (default `~/.local/share/opencode/auth.json`).
- `<dir>/<scenario>.events.jsonl` is the raw log (events of the stream and the recorder's actions). It holds machine paths: keep it out of git.
- The cut keeps the events the adapters read, replaces ids by the placeholders of the fake binaries, names the scratch folder `/work/proj`, and fails when a machine path or a name is left. It prints the event types it dropped. An event type of the session that is in neither the keep list nor the drop list of `cut-turn.ts` fails the cut: decide for the new type, then add it to a list. It also fails on a second tool call or more than nine assistant messages (the OpenCode 2 fake knows one `$CALL` and `$A1`..`$A9`): record a shorter scenario.
- OpenCode 2: the tool's `shell.*` events and the shell progress line are dropped; the call's own success ends the card.
- Check a new fixture by replaying it: a scenario of `test/conformance` that names it.
