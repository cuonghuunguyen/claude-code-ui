# @claude-ui/e2e

Scripted acceptance tests: Cucumber `.feature` files compiled by [playwright-bdd](https://vitalets.github.io/playwright-bdd/) and run by Playwright against a **real daemon and real Claude** (Haiku). Local only: it needs the subscription login (`claude login`, ADR 0002), so it is not part of `npm test` and not run in CI.

The suite holds the critical journeys listed in `docs/testing.md`; nothing else belongs here.

## One-time

```sh
npm ci
npx playwright install chromium     # once per machine (from the repo root or packages/e2e)
```

## Run

```sh
npm run e2e                                                  # every feature
npm run e2e -- permission.feature                            # one feature (a path regex)
npm run e2e -- permission.feature -g "Deny"                  # one scenario
npm run e2e:steps                                            # list the steps (bddgen export)
```

Everything after `--` goes to `playwright test`. Environment:

| Variable | Effect |
|---|---|
| `E2E_SCRATCH` | Where run folders go (default `<tmp>/claude-ui-e2e`) |
| `E2E_EVIDENCE_DIR` | Where `Then I capture` screenshots go (default `<run>/evidence`) |
| `E2E_PORT` | Daemon port (default: a free one; never 4280 or the port of your own daemon) |
| `E2E_SKIP_BUILD=1` | Skip the `packages/web` build at the start (the daemon serves `packages/web/dist`) |
| `E2E_KEEP=1` | Keep the run folder after a passing run |

## What a run does

- Builds the web app, then starts its **own daemon**: a free port, `XDG_CONFIG_HOME=<run>/ui-config`, `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` unset (subscription login only), `ANTHROPIC_MODEL=haiku`, every inherited `CLAUDE_UI_*` unset, on Windows `LOCALAPPDATA=<run>/localappdata` (the daemon keeps uploads there, not under `XDG_CONFIG_HOME`), roots `<run>/projects`. The daemon is stopped by PID tree (`taskkill /T /F /PID` on Windows, the process group elsewhere), never by name.
- Each scenario gets a scratch project `<run>/projects/<scenario>-r<retry>` whose `.claude/settings.json` sets `permissions.defaultMode` to `default`, so a write asks first whatever your own Claude settings say. The session picks Haiku in the model chooser.
- Before each scenario the remembered new-session engine (Settings `sessions.engine`) is reset, so scenario order does not change the engine.
- A guard fails the run if the run folder shows up in your real claude-ui config (`%APPDATA%\claude-ui`, `~/.config/claude-ui`) or if the daemon did not write its `daemon.json` under `<run>/ui-config`.
- Claude Code keeps transcripts of the scratch projects in `~/.claude/projects/<encoded path>` (the login lives there); the run does not delete them.
- One worker, one retry at most, 240 s per scenario, 120 s for each turn. Assertions are on structure (reply shown, card shown, turn ended), never on reply wording.

## Add a step

1. `npm run e2e:steps`: reuse a step when one fits.
2. Otherwise add it to the matching `steps/*.steps.ts` (`app`, `composer`, `permission`, `daemon`, `layout`, `evidence`); shared locators and flows live in `support/ui.ts` and `support/flow.ts`. Keep the vocabulary small and the steps worded as what the user does or sees.
3. Pure helpers (ports, kill command, paths) go in `support/` without a Playwright import and get a vitest test in `test/` (`npm test` runs those).
4. Every scenario ends with `Then I capture "<name>"`.

## Debug loop

A paused run you drive with `playwright-cli`. Run it in the background; the runner writes its own PID to `<run>/runner.pid`. The run folder is printed as `e2e run folder: <path>` at the top of `debug.log` (it is `<E2E_SCRATCH or tmp/claude-ui-e2e>/<stamp>-<pid>`, also in `E2E_RUN_DIR` inside the run).

```sh
npm run e2e -- permission.feature -g "Deny" --debug=cli > debug.log 2>&1 &
# wait for "Debugging Instructions" in debug.log; it prints: playwright-cli attach tw-XXXXXX
playwright-cli attach tw-XXXXXX
playwright-cli -s=tw-XXXXXX pause-at permission.steps.ts:17     # a line of a step file; see the Windows caveat below
playwright-cli -s=tw-XXXXXX snapshot
playwright-cli -s=tw-XXXXXX click "getByTestId('permission-panel')"
playwright-cli -s=tw-XXXXXX step-over                           # or: resume
```

- The run pauses at the first page call (the daemon is already up, the scratch project made). `--debug` sets `--timeout=0 --workers=1 --max-failures=1`.
- **Windows: `pause-at` takes the bare file name** (`permission.steps.ts:17`), not `steps/permission.steps.ts:17`: the location is matched with `includes` against a backslash path. The line is in a step definition or fixture file, not in the `.feature`.
- `--debug=cli` does not pause on a failure, it fails and exits. Pause before the failing step.
- Copy the `### Ran Playwright code` that `playwright-cli` prints into the step.
- **Stopping:** `playwright-cli -s=tw-XXXXXX close` only detaches; the run stays paused. Stop it with `npm run e2e:stop -- <absolute run folder>` (from the repo root): it kills the runner's tree by the PID in `<run>/runner.pid` and any live daemon of that run (`daemon-w*.pid`, only when its command line holds the run folder), by PID, never by name. Never take the PID from `$!` in Git Bash (an MSYS PID, not a Windows PID). Manual fallback only: `MSYS_NO_PATHCONV=1 taskkill /T /F /PID <pid from runner.pid>`; on POSIX start the run with `setsid` and `kill -- -<pgid>`. A hard kill skips the fixture teardown, so delete the run folder afterwards.
- Before you finish, list processes whose command line holds your worktree or run folder and kill your own by PID.

## Output

- Screenshots: `<evidence>/<feature>--<scenario>--<nn>-<name>--<w>x<h>.png` (`E2E_EVIDENCE_DIR`, default `<run>/evidence`), also attached to the HTML report. One folder per run.
- HTML report: `npx playwright show-report` (from `packages/e2e`, folder `playwright-report/`).
- Traces of failed scenarios (and failure screenshots): `npx playwright show-trace test-results/<scenario>/trace.zip`.
- Daemon log: `<run>/daemon-w0.log`. After a clean pass the run folder is emptied (the evidence stays when it lives inside it); after a failure, or a retry that saved the run, it is kept whole.

## Reconnect burst harness (GH-760)

Not part of `npm test` or the Cucumber suite: a phone reconnecting over a slow link to a daemon with hundreds of sessions. Needs `npm run build` first (the daemon serves `packages/web/dist`) and `npx playwright install chromium`.

```sh
npx tsx packages/e2e/perf/reconnect-burst.ts [--sessions 300 --live 40 --tabs 8 --cpu 6 --kbps 1000 --reconnects 10 --quiet 0 --reload 0 --stream --port 4321 --label run --report-dir <dir> --ping-ms 15000]
```

It starts its own daemon (temp `XDG_CONFIG_HOME` and `CLAUDE_CONFIG_DIR`, API key variables unset, a fake query that streams long turns) on `--port + 1` behind a throttling TCP proxy on `--port`, opens a 390x844 Chromium page with CPU throttling, cuts the socket `--reconnects` times and prints per reconnect the time to settle, MB received and the daemon's drop/kept lines. Per reconnect it also prints the bytes received by message class (`event live`, `event replay`, `reply <type>`; the replies of `session.subscribe` say `(snapshot)` and `bg`), the live generation rate of the harness client next to the link rate, and `shown` (the list reply arrived and the shown tab holds every event the daemon had at the cut). `--stream`: the fake turns emit text deltas (streamed parts). `--quiet N`: after the live reconnects, waits until the turns ended and then reconnects N more times with nothing changed. After the last reconnect it compares the page's last seq of every followed live session with the daemon's. `--reload N`: after the quiet rows (and, with `--quiet 0`, after the turns ended), N rows where the page is reloaded with `page.reload()` instead of a proxy cut. A reload row reports the WebSocket bytes down and up by message class (the `up <type>` classes are the frames the page sent), the HTTP bytes (CDP, info only), `cachedMs` (navigation start until the shown tab's timeline is in the DOM while `connection-status` is not `connected`; `-` when that never happens, as on code without a view cache), `shown` and `settled`. The missed-events check runs after the reload rows. Use `--reconnects 0` to skip the live rows. Writes `<report-dir>/perf-<label>.json`. Exit code 1 when a "no pong ... dropped" line appears, 2 when a followed session's seq differs (missed events). Not typechecked by `npm run typecheck` of this package (it imports daemon sources).
