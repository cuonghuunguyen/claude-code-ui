---
name: implement-issue
description: "Ticket playbook for claude-ui: how to plan, build, test and verify one GitHub issue (GH-<n>) of this repo in its own worktree: context to read, plan contents, test-first build, real-app verification against OpenCode, finish and commit. Use when asked to implement, build or fix a GH-<n> issue in claude-ui, and when an orchestrate-tickets worker reads this repo's playbook."
---
# Ticket playbook: claude-code-ui

This is the repo's playbook for the `orchestrate-tickets` skill (stages, models and the
RESULT contract live there), and the how-to for anyone implementing an issue by hand. One
issue, one worktree, one branch, one diff.

## Profile
tracker:     github-issues   (https://github.com/cuonghuunguyen/claude-code-ui/issues/<n>)
query:       --label ready-for-agent
states:      started → —, implemented → —, in-review → —
host:        github
push:        ask
remote-branch: same
ci:          none
base:        main
branch:      GH-<n>-<slug>   (a prefix added by a worktree tool is fine)
scratch:     <main checkout>/development-docs/GH-<n>/   ignored by: .gitignore
acceptance:  playwright-bdd

## Commands
install:     npm ci
test:        npm test        scoped: npx vitest run <files>
typecheck:   npm run typecheck
e2e:         E2E_PORT=<port> E2E_SCRATCH=<scratch>/e2e E2E_EVIDENCE_DIR=<scratch>/evidence npm run e2e -- <feature> [-g "<scenario>"]
             (packages/e2e: Cucumber via playwright-bdd, real Claude on Haiku, own isolated daemon; see its README)
             steps: npm run e2e:steps   (lists every step, from `bddgen export`)
app:         mkdir -p <scratch>/ui-config; env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN XDG_CONFIG_HOME=<scratch>/ui-config PORT=<port> nohup npm start > <scratch>/app.log 2>&1 & echo $! > <scratch>/app.pid
             (the pairing URL is in the log: #token=...)   stop: kill that PID's process tree
ports:       one per worker, assigned by the coordinator; never the user's own daemon port

## Plan skip rules
Also plan first when the issue changes the protocol or part model, or `docs/spec.md`.

## Plan: read before designing
- `gh issue view <n> --comments` (read-only), `README.md`, `docs/spec.md`, `CONTEXT.md` (use
  its terms), `docs/adr/` (binding).
- UI issues: `development-docs/opencode-parity/reference.md` (tokens, layout, anatomy) and the
  `gaps.md` rows mapped to the issue. OpenCode source: `development-docs/opencode-parity/src`;
  screenshots: `.../screenshots`.
- Before using a library or SDK API (`@anthropic-ai/claude-agent-sdk`, `@pierre/diffs`,
  AI Elements): current docs via context7. Check runtime behaviour with a throwaway probe when
  types are not enough (e.g. `getSessionMessages()` strips `tool_use_result`); delete it after.
- Trace the data flow end to end: daemon (`packages/daemon`) → adapter/parts
  (`packages/protocol`) → client store (`packages/web/src/store.ts`) → component. Prefer
  deriving UI state from parts on the client; change the protocol only when the data does not
  reach the client.

## Implement
- Scratch: the folder is shared by every worker on the issue (planner, implementer, tester,
  reviewer): prefix your files, delete only files you created. Never commit it; never remove
  `development-docs/` from `.gitignore`.
- Failing test first (tdd skill): pure logic in a `*.ts` module with a `*.test.ts`; components
  with `// @vitest-environment jsdom` + `createRoot` + `act` (see `tool-expand.test.tsx`,
  `changes-panel.test.tsx`); adapter changes in `packages/protocol/test/adapter.test.ts`
  against recorded fixtures.
- Reuse existing helpers (`diffStats`, `InputDiff`, `DIFF_OPTIONS`, `Button`, theme tokens)
  before writing new ones.
- UI: OpenCode tokens and anatomy; ui-ux-pro-max Quick Reference §1-§3 must hold (contrast,
  44px touch targets below `md`, focus, no horizontal scroll at 390px). Focused checks:
  `python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain ux`.
- Update `docs/spec.md` when behaviour or the wire/part model changes.
- Finish: `npm run typecheck` and `npm test` (record pass/fail/skip); commit the fix only as
  `GH-<n>: <what the user now sees>`; `git rebase main`, resolve, `npm ci`, re-run both.
- `notes.md`: design decisions, files, per acceptance criterion the evidence (test name,
  scenario name or screenshot), start command and port, manual steps for a UI tester,
  out-of-scope findings (report, do not fix).
- Do not merge into main, do not comment on GitHub, do not push unless the user asks.

## Acceptance
Scripted: each visible acceptance criterion is a Cucumber scenario in `packages/e2e/features`,
run against a real daemon and real Claude (Commands › e2e). The run starts its own daemon on
`E2E_PORT` with `XDG_CONFIG_HOME=<run>/ui-config` and the API key variables unset, stops it by
PID, and fails if anything of the run landed in the real config dir.

1. Write or extend the `.feature` scenario for each visible acceptance criterion. Reuse steps
   (`npm run e2e:steps`); add a step only when none fits. Assert structure (reply shown, card
   shown, turn stopped), never reply wording. End each scenario with `Then I capture "<name>"`;
   cover 1440×900 and 390×844 (`scrollWidth` = viewport width) for layout criteria, and the
   daemon-restart step for the restored-transcript path.
2. Run it: Commands › e2e with `-- <feature>`.
3. Green: look at every captured screenshot in `<scratch>/evidence` and record them per
   criterion in `notes.md`. For OpenCode parity, put each next to its OpenCode screenshot
   (`<nn>-<what>-claudeui.png` / `-opencode.png`).
4. Red, or a new step is needed: re-run that one scenario in the background with
   `-g "<scenario>" --debug=cli`, record the runner PID, wait for `Debugging Instructions`, then
   `playwright-cli attach tw-XXXX` and `playwright-cli -s=tw-XXXX pause-at <file>.steps.ts:<line>`
   (bare file name: a path never matches on Windows). Drive the page from the failing step,
   copy the printed Playwright code into the step or fix the app, stop the run by killing the
   runner's PID tree (`close` only detaches, and a debug run never times out), go to 2.
5. Clean up: every background run stopped, every PID you started killed (plus any in
   `<scratch>/e2e/*/*.pid`), `<scratch>/e2e` deleted. Evidence stays.

Hand-driving `playwright-cli -s=w<port> open` against Commands › app is only for a check a
scenario cannot express; say why in `notes.md`, and stop it by PID the same way.

Under the coordinator this loop is the stage-2 worker's: it fixes steps, never the app; a
broken app is a failed case that goes back to the implementer.

## Traps
1. **Never `pkill -f` or `killall`.** Other workers run the same command line; kill by PID.
2. **Never start the app on the user's daemon port**, and unset `ANTHROPIC_API_KEY` /
   `ANTHROPIC_AUTH_TOKEN` (subscription login only, ADR 0002).
3. **`getSessionMessages()` strips `tool_use_result`.** Types are not enough for SDK
   behaviour; probe it.
4. **Never run a test app on the real config dir** (`%APPDATA%\claude-ui` on Windows,
   `~/.config/claude-ui` elsewhere): it adds test projects and sessions to the user's install.
   Always `XDG_CONFIG_HOME=<scratch>/ui-config` (the e2e run does this itself).

## Without a coordinator
Working an issue by hand: run the stages yourself in order (plan when the skip rules in
`orchestrate-tickets` › `references/planning.md` fail, implement, acceptance), with the model
table in `CLAUDE.md` for any subagent you dispatch.
