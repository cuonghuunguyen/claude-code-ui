---
name: implement-issue
description: "Implement one GitHub issue of this repo end-to-end as dispatched workers in two stages: an opus plan stage (read context, write plan.md) and a sonnet implement stage (test first, build, verify in the real app against OpenCode, write notes, rebase, commit, report). Use when asked to implement, build or fix a GH-<n> issue in claude-ui, or when an Orca coordinator dispatches an issue task to this worktree."
---
# Implement an issue (claude-ui)

One issue, one worktree, one branch `GH-<n>-<slug>` (a prefix added by your worktree tool is fine) based on local `main`. Keep the diff to this issue.

## 0. Stages and models (coordinator)
Dispatch every worker with an explicit `model` (general rules: `CLAUDE.md` "Subagent model selection"). Never let a worker or its subagents inherit a model.

| Stage | Model | Sections | Output |
|---|---|---|---|
| Plan | `opus` | 1, then 1b | `development-docs/GH-<n>/plan.md`, no code |
| Implement | `sonnet` | 2-6, following `plan.md` | commit + `notes.md` |
| Review + acceptance | `opus` | (separate skill/prompt) | verdict |

- Review rejects the sonnet implementation twice: re-dispatch the implement stage with `opus`.
- Subagents spawned inside any stage (triage, search): set `model` explicitly; `haiku` or `sonnet` for search/triage.
- Skip the plan stage (implement directly with `sonnet`) when ALL hold: ≤2 files in one package, no protocol/part-model or `docs/spec.md` change, no new library/SDK API, acceptance criteria concrete in the issue. Any fails: plan first.
- Implement stage finds the issue bigger than judged: stop, report `failed` with "needs plan"; coordinator dispatches the plan stage.

## 1. Context (read before code)
- `gh issue view <n>` (read-only), `README.md`, `docs/spec.md`, `CONTEXT.md` (use its terms), `docs/adr/` (binding).
- UI issues: `development-docs/opencode-parity/reference.md` (tokens, layout, anatomy) and the `gaps.md` rows mapped to the issue. OpenCode source clone: `development-docs/opencode-parity/src`, screenshots: `.../screenshots`.
- Before using a library or SDK API (`@anthropic-ai/claude-agent-sdk`, `@pierre/diffs`, AI Elements): fetch current docs with context7. Check runtime behavior with a throwaway probe when types are not enough (e.g. `getSessionMessages()` strips `tool_use_result`); delete the probe after.
- Trace the data flow end to end before choosing a design: daemon (`packages/daemon`) → adapter/parts (`packages/protocol`) → client store (`packages/web/src/store.ts`) → component. Prefer deriving UI state from parts on the client; change the protocol only when the data does not reach the client.

## 1b. Plan (plan stage only)
Write `development-docs/GH-<n>/plan.md` so the implement stage needs no exploration:
- Files to change, with the functions/components and the exact edit per file.
- Existing helpers to reuse (paths), protocol/spec changes if any.
- Tests: file, test names, what each asserts; the test command.
- Per acceptance criterion: the evidence to produce (test name or screenshot pair).
- Library/SDK facts already checked via context7 or probe, so the implement stage does not re-fetch them.
- Risks and open questions. Then `worker_done` with `--report-path <dir>/plan.md`. Do not write code.

Implement stage: read `plan.md` first and follow it; skip section 1 except files the plan names. Plan wrong or missing a piece: fix locally if small, else `orchestration ask` / report `failed` with the gap. Do not re-explore the codebase broadly.

## 2. Scratch space
- Shared, gitignored: `<main checkout>/development-docs/GH-<n>/` (`mkdir -p`). Diary `notes.md`, logs, screenshots, test projects. Never commit it; never remove `development-docs/` from `.gitignore`.
- Other agents (reviewers, fixers) reuse the same folder: prefix your files, delete only files you created.

## 3. Build test first
- `npm ci` before any test run.
- Failing test first (tdd skill): pure logic in a `*.ts` module with a `*.test.ts`; components with `// @vitest-environment jsdom` + `createRoot` + `act` (see `tool-expand.test.tsx`, `changes-panel.test.tsx`); adapter changes in `packages/protocol/test/adapter.test.ts` against recorded fixtures.
- Reuse existing helpers (`diffStats`, `InputDiff`, `DIFF_OPTIONS`, `Button`, theme tokens) before writing new ones.
- UI: OpenCode tokens/anatomy; ui-ux-pro-max Quick Reference §1-§3 must hold (contrast, 44px touch targets below `md`, focus, no horizontal scroll at 390px). Focused checks: `python3 .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --domain ux`.
- Update `docs/spec.md` when behavior or the wire/part model changes.

## 4. Verify in the real app
- Start only on the assigned port and record the PID:
  `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN PORT=<port> nohup npm start > <dir>/app.log 2>&1 & echo $! > <dir>/app.pid`; pairing URL is in the log (`#token=...`).
- Drive with `playwright-cli -s=w<port>` (named session only). Create a session in a scratch project under the dev-docs folder, let Claude run real turns, answer permission requests.
- Per visible acceptance criterion: a claude-ui screenshot next to the OpenCode one (`<nn>-<what>-claudeui.png` / `-opencode.png`). Check 1440×900 and 390×844 (`scrollWidth` = 390). Restart the daemon once to check the restored-transcript path.
- Stop: `playwright-cli -s=w<port> close`; kill your process tree by PID (`ps --forest -g <sid>`). Never `pkill -f`/`killall`: other workers run the same command line.

## 5. Finish
- `npm run typecheck` and `npm test`; record pass/fail/skip counts.
- Commit (fix only) with message `GH-<n>: <what the user now sees>`.
- `git rebase main`, resolve conflicts, `npm ci`, re-run typecheck and tests.
- `notes.md`: design decisions, files, per acceptance criterion the evidence (test name or screenshot), start command and port, manual steps for a UI tester, out-of-scope findings (report, do not fix).
- Do not merge into main, do not comment on GitHub, do not push unless the user asks.

## 6. Report (Orca worker)
- Heartbeat every ~5 min; `orca-ide orchestration check` at checkpoints and before finishing; questions through `orchestration ask`, not local prompts.
- Exactly one `worker_done`: `--outcome succeeded|failed` (red tests = failed), 3-sentence body (what changed, what was found, what remains), `--files-modified`, `--report-path <dir>/notes.md`.
