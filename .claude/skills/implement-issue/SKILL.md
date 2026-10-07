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
acceptance:  playwright

## Commands
install:     npm ci
test:        npm test        scoped: npx vitest run <files>
typecheck:   npm run typecheck
app:         env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN PORT=<port> nohup npm start > <scratch>/app.log 2>&1 & echo $! > <scratch>/app.pid
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
- `notes.md`: design decisions, files, per acceptance criterion the evidence (test name or
  screenshot), start command and port, manual steps for a UI tester, out-of-scope findings
  (report, do not fix).
- Do not merge into main, do not comment on GitHub, do not push unless the user asks.

## Acceptance
- Start the app on the assigned port only (Commands › app) and record the PID.
- Drive it with `playwright-cli -s=w<port>` (a named session only). Create a session in a
  scratch project under the scratch folder, let Claude run real turns, answer permission
  requests.
- Per visible acceptance criterion: a claude-ui screenshot next to the OpenCode one
  (`<nn>-<what>-claudeui.png` / `-opencode.png`). Check 1440×900 and 390×844
  (`scrollWidth` = 390). Restart the daemon once to check the restored-transcript path.
- Stop: `playwright-cli -s=w<port> close`, then kill your own process tree by PID
  (`ps --forest -g <sid>`).

## Traps
1. **Never `pkill -f` or `killall`.** Other workers run the same command line; kill by PID.
2. **Never start the app on the user's daemon port**, and unset `ANTHROPIC_API_KEY` /
   `ANTHROPIC_AUTH_TOKEN` (subscription login only, ADR 0002).
3. **`getSessionMessages()` strips `tool_use_result`.** Types are not enough for SDK
   behaviour; probe it.

## Without a coordinator
Working an issue by hand: run the stages yourself in order (plan when the skip rules in
`orchestrate-tickets` › `references/planning.md` fail, implement, acceptance), with the model
table in `CLAUDE.md` for any subagent you dispatch.
