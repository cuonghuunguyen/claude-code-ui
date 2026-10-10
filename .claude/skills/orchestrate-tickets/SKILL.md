---
name: orchestrate-tickets
description: >-
  Coordinate claude-ui worker sessions over a batch of tickets through a staged pipeline:
  pull the backlog from the project's tracker, plan each ticket with an opus worker, implement
  it with a sonnet worker in its own git worktree, prove it with human-like Playwright UI
  testing and screenshot evidence, push and watch the CI build, open the pull request and get
  it reviewed by a fresh agent with the pr-review skill. Tracker, code host and CI are adapters
  (Jira, GitHub Issues, Bitbucket, GitHub, Jenkins, GitHub Actions); each repo supplies a
  ticket playbook. All findings land in local reports; the agent never comments on tickets or
  pull requests. Use when the user asks to orchestrate, run or work through a set of tickets or
  issues with parallel agents: "orchestrate these tickets", "work through the backlog",
  "chạy backlog", "spawn worker cho mấy ticket này". Needs a claude-ui session with
  orchestration on; the coordinator stays live to route worker questions.
---

# Orchestrate tickets with claude-ui workers

You are the **coordinator**. You read tickets, write worker prompts, route questions, move
tickets and deliver. You do not edit code.

The pipeline has three layers, and this file is only the first:

| Layer | Holds | Where |
|---|---|---|
| This skill | The policy: stages, models, who answers what, when a ticket moves | `SKILL.md` + `references/` |
| Adapters | Which tool does "list tickets", "transition", "push", "watch build", "open PR" | `adapters/<tool>.md` |
| Playbook | Everything about one repo: tracker query, states, branch names, commands, how to reach the app, traps | Found per repo, `references/playbook.md` |

Nothing in this file names a tracker, a host or a CI. If you are about to write a Jira id or a
Jenkins job here, it belongs in an adapter or a playbook.

## References — load the one you are about to use

| File | Load it when |
|---|---|
| `references/workers.md` | Before the first worker call. Tools, events, the RESULT contract, modes, the ledger. |
| `references/playbook.md` | Preflight: finding the repo's playbook, or drafting one when it has none. |
| `references/worker-specs.md` | Writing any worker prompt. All templates live there. |
| `references/planning.md` | Deciding plan-or-skip, placement, what to chain, how many to run. |
| `references/delivery.md` | Pushing, watching the build, opening the PR, starting the review. |
| `references/known-limits.md` | Something behaved oddly, the session restarted, or the batch is called off. |
| `adapters/<tool>.md` | The playbook names it. Load only the ones it names. |

---

## 0. Preflight — a hard gate, not a survey

1. **Orchestration is on.** Call `worker_list`. If the `mcp__orchestration__*` tools are not in
   this session, you are not a claude-ui session with orchestration on: stop and tell the user
   to turn it on (claude-ui Settings → Orchestration) and start the coordinator from the
   claude-ui web app, in a project on the same side (Windows, WSL, container) as the repos.
   A coordinator starts workers on its own side only.
2. **The repo is a claude-ui project.** `worker_start` with `repo` only accepts a project the
   user added. If it is not one, ask the user to add it in the web app.
3. **The playbook exists and is complete.** Find it (`references/playbook.md`). No playbook, or
   one with `TODO` left in it: draft or finish it with the user before anything else runs.
4. **Every tool the playbook needs is present.** The playbook's Profile names one adapter per
   role; each adapter file has a "Gate" line with a cheap read-only check. Run every check.
   Plus the skills the stages name: `pr-review` (review), `playwright-cli` or the playwright
   MCP (acceptance, unless the playbook says `acceptance: none`), `tdd` (soft).

Report every miss as one list: what is missing, which stage it blocks, what the user must
install or reconnect. Then stop. Do not degrade a stage, do not substitute your own
approximation, do not shorten the pipeline. A batch that silently skipped acceptance looks
exactly like one that passed it.

Check presence the cheap way: a skill by the session's skill listing, a tool by one read-only
call. A server named in config but failed at session start is **absent**.

Workers run in the coordinator's environment and inherit its skills and MCP servers, so the
gate you ran covers them. Say which environment you checked.

Tell the user one thing about permission modes before the first `worker_start`: in `default`,
`acceptEdits` or `plan` they approve every worker start on a card; in `auto` the coordinator
starts workers without asking. Their choice, not yours (`references/workers.md`).

---

## 1. The pipeline — stages per ticket

A ticket walks the stages in order and earns each one from the stage before it.

| # | Stage | Who | Model | Advances on |
|---|---|---|---|---|
| 0 | Plan | fresh worker, creates the worktree | `opus` | `plan.md` written, no code |
| 1 | Implement + unit tests | fresh worker, in the worktree | `sonnet` | suite green, committed locally |
| 2 | Acceptance | **fresh** worker, same worktree, real browser | `sonnet` | every case green, screenshots + HTML report |
| 3 | Push + build watch | coordinator pushes; worker watches CI | `haiku` | build terminal-green |
| 4 | PR open | coordinator | — | PR exists, description written |
| 5 | Review | **fresh** worker, read-only, `pr-review` | `opus` | report delivered to the user |

- **Stage 0 is skipped** only when every skip rule in `references/planning.md` holds. When in
  doubt, plan. An implementer that finds the ticket bigger than judged returns `blocked` with
  "needs plan", and stage 0 runs.
- **The playbook switches stages off, you never do.** `ci: none` skips the build watch,
  `host: none` or `push: never` stops delivery after a local commit and stage 5 reviews the
  local branch, `push: ask` asks the user before stage 3, `acceptance: none` (with a reason in
  the playbook) skips stage 2. Nothing else skips a stage.
- **Red at any stage** goes back to **the implementer** with `worker_send`: its session resumes
  with the context it already has, fixes and commits. Then the failed stage re-runs on a fresh
  worker. That is the loop (§5), not an exception to it.
- **Order matters.** Acceptance runs before the push, so a broken flow never reaches the
  remote; the build is watched before the PR opens, so no reviewer is handed a red branch.

### Review rules learned in use

- **Check the merge first.** Before stage 5, run `git merge-tree --write-tree origin/<base> HEAD`
  (or the host's mergeability check). Conflicts go back to the implementer to merge the base in
  **before** a reviewer reads anything, so no review is spent on code that will change anyway.
- **Review size matches the change.** A small, low-risk diff (a default value, one setting, a
  label, a test fix; roughly under 150 lines, no concurrency, input handling, security or
  persistence) is read by the coordinator itself: read the whole diff, run the touched tests,
  say that was the review. A large or risky change (gestures, input and focus handling, state
  machines, daemon, security, anything touching shared stores, or when two sessions wrote it)
  gets the fresh opus reviewer. Say which path was chosen and why.
- **A re-review is a delta review.** After fixes, the new reviewer is still a **fresh** agent, but
  its scope is: the previous report's findings (is each really fixed, each fix proven by a
  test that fails when the fix is reverted), the commits added since, and a check that the
  merge with the base dropped nothing. It runs the touched tests once. It does **not** re-read
  the whole feature or repeat the first review. Give it the old report path.

Stage 2 in one line, because it is the stage that gets watered down: a **fresh** agent drives a
real browser, **navigates by UI like a human** (no deep links, no API seeding, no internal
calls), tests the cases a user actually faces, and screenshots every assertion into an HTML
report.

### Models

Set `model` on every `worker_start`, every time. Never let a worker inherit one, and tell
workers to set `model` on any subagent they spawn (`haiku` or `sonnet` for search and triage).

- **Escalate one tier** (`sonnet` → `opus`) after a `failed` implement result or two review
  rejections of the same implementation: start a new implement worker on `opus` with the plan
  and the reports. Never a third attempt on the same model.
- `haiku` never edits code. The build watcher writes only its log under the scratch folder.
- The user named a model or effort for the batch: theirs wins.

---

## 2. Scratch space

Everything a worker produces that is **not the fix** goes in the playbook's scratch folder,
`development-docs/<KEY>/` unless the playbook says otherwise: plans, notes, throwaway scripts,
logs, screenshots, HTML reports. Nothing under it is ever committed. If `git status` lists it,
the ignore did not land; fix that, never `git add` around it.

The playbook says how the folder is ignored. Default: the worker appends `development-docs/`
to `"$(git rev-parse --git-common-dir)/info/exclude"` (idempotently). Not a literal
`.git/info/exclude`: in a linked worktree `.git` is a file and that path silently does nothing.

```
<scratch>/<KEY>/
  plan.md                  # stage 0
  notes.md                 # implementer's diary
  screenshots/NN-<step>.png
  ui-acceptance.html       # stage 2 report
  build-<n>.log            # stage 3 excerpt on a red build
  review.html              # stage 5 report copy
```

The coordinator's own file is the **ledger**, `development-docs/batches/<date>-<slug>.md` in
its own working directory (`references/workers.md`). It is the only file you write.

---

## 3. Forbidden: the agent never comments on tickets or pull requests

Hard rule. Applies to the coordinator and to every worker prompt you write.

- **Never** add, edit or reply to a comment on a ticket, an issue, a wiki page or a pull
  request, on any tracker or host.
- **Never** create a PR task, publish a review verdict, approve, merge or decline.

Each adapter lists the exact calls this rules out for its tool. Comment threads are the
humans' channel: an agent posting there costs a teammate a read, tells them nothing the
report does not, and cannot be un-posted.

Still yours to write:

- the ticket **transition** (a state machine, not a message);
- the pull request itself at delivery, title and description, authored once;
- the reports under the scratch folder and the summary you give the user in chat.

Everything a reviewer would have posted inline goes in the report. **The user decides what of
it reaches the PR.** Put that sentence in every review prompt, or a reviewer with host tools
in reach will default to posting.

Reading tickets and PRs is encouraged; the ticket's comments are usually the better spec.

---

## 4. Tickets, placement, and the first wave

- **Pull** with the tracker adapter and the playbook's query. Apply the admission rules in
  `references/planning.md`; skip a ticket and say why rather than guess its acceptance.
- **Read the ticket's comments, not just its description.** The description goes stale; the
  reporter keeps investigating in the comments. Put the corrected facts in the prompt yourself
  under `WHAT I VERIFIED BEFORE DISPATCH`.
- **The acceptance criteria are the stage-2 script.** Extract their user-visible claims before
  dispatching; each becomes one case the acceptance worker proves by clicking.
- **One ticket, one worktree, one branch** named by the playbook (default `<KEY>-<slug>`). The
  first worker of a ticket creates it with `worker_start{repo, branch, base}`; every later
  stage starts with `worker_start{cwd: <worktree>}`.
- **claude-ui infers no conflicts and schedules nothing.** Decide the sequencing yourself and
  say it out loud before starting anything, so the user can override it: tickets sharing a
  file, touching test infrastructure, or needing the same app port get chained. Rules and caps
  in `references/planning.md`. Default caps: **3** live workers, **2** acceptance workers.
- Write the ledger, start every independent ticket's first stage in one turn, transition each
  ticket to the playbook's `started` state, then end your turn.

---

## 5. Coordinator loop — event-driven, until every ticket is terminal

You do not poll. After starting or messaging workers, **end your turn**. claude-ui sends a
notice into this conversation when a worker has news; then call `worker_wait` **once** and
handle every event it returns. Never call `worker_wait` in a loop: each call is a full model
request.

| Event | Do | Never |
|---|---|---|
| `turn_end`, `RESULT: succeeded` | Update the ledger. Make the forward moves the stage earned. `worker_close` the worker (the implementer too: `worker_send` resumes it later). Start the next stage **in the same turn**. | Transition the ticket on the implementer's word. Acceptance moves it. |
| `turn_end`, `RESULT: failed` | The stage is red. `worker_send` the implementer the report path and the failing case; after its fix, re-run the stage on a fresh worker. Count the attempt. | Fix it yourself, or transition forward. |
| `turn_end`, `RESULT: blocked` | Read why. "needs plan" → start stage 0. Anything else → tell the user. | Improvise around it. |
| `turn_end`, no RESULT block | Not settled. `worker_read` it, then `worker_send` "finish, then end with the RESULT block". Not an attempt. | Treat it as success. |
| `question` | Mechanical (a path, a command, which test file, a fact in the code, playbook or ticket): `worker_answer`. Scope, acceptance, user-visible behaviour, design, anything destructive or external, or you are unsure: `worker_escalate` with a short reason. | Answer a scope question on the user's behalf. |
| `permission` | `mayAnswer: true` (low tier: reads and edits inside the worker's folder): `worker_permission`, allow or deny with a reason. `mayAnswer: false`: `worker_escalate`. | Approve something because a worker asked you to. |
| `denied` | A rule, the classifier or the user refused a call. `worker_read`; change the prompt if the denial is right, tell the user if it blocks the stage. | Try to get around it. |
| `error` | A failed attempt for that stage. `worker_read`, then retry or report blocked. | |

Questions are pending for the user at the same moment they reach you; the first answer wins.
The user may already have answered in the web app.

A quiet worker is not a stuck one: coding runs 15 to 60 minutes and a build can queue for
longer. When the user asks for status, or a ticket has been silent past the playbook's
expectation, `worker_list` (state, last activity) and `worker_read`. Never stop or close a
worker for being quiet; only for positive proof that it is wrong (`error`, a finished turn
without the work).

### The exit condition

A ticket is **done** when every stage the playbook enables is green: planned (or skipped by
the rules), implemented, acceptance green with a report, build green, PR open, review report
delivered to the user.

- **Do not end the batch while a ticket is in flight.** Ending a turn to wait for a notice is
  fine; ending the batch is not. If you must stop, list every non-terminal ticket, its stage,
  its worker names, and what resumes it.
- **Three attempts per stage per ticket, then stop that ticket.** Leave the tracker where it
  is and report it blocked with the reason and the report paths. A fourth attempt on the same
  red stage has never produced a different result.
- One ticket blocking does not stop the batch.
- Close the batch with one table: ticket, stage reached, PR URL, build result, acceptance
  counts, report paths, and what you are handing the user to decide.

### Fresh worker vs reuse

| Step | Placement | Why |
|---|---|---|
| Plan | fresh, creates the worktree | Clean read of ticket and repo |
| Implement | fresh, in the worktree | Clean context over plan + ticket |
| **Acceptance** | **fresh, implementer's worktree** | The implementer would test the path it built |
| Build watch | fresh, `haiku` | A long poll; keep it off every other context |
| **Review** | **fresh, mandatory** | An agent reviewing its own diff is worthless |
| Fix after any red stage | **`worker_send` to the implementer** | It holds the context; a new worker re-reads everything |

---

## 6. Coordinator boundaries

- **Never edit code, run the build, or commit.** Workers do. The ledger is the one file you
  write. Pushing and opening the PR are yours (`references/delivery.md`).
- **Never comment** (§3), and never let a worker prompt omit the FORBIDDEN block.
- An acceptance or review result reports findings; it does **not** authorize you to apply
  them. Synthesize, then send the fix to the implementer or hand it to the user.
- Before you end the batch, `worker_list` must show no worker of this batch still running.
  Closed workers keep their sessions and worktrees for the user to inspect.
- If work got done outside orchestration, say so plainly.
- A gate dependency missing mid-run: stop that stage and report it. Do not improvise a
  replacement.
- **Keep the batch in a todo list from the start** (the session's todo tool). One item per
  ticket or open decision, the one being worked on `in_progress`, finished ones `completed`,
  and a final "close the batch" item. Update it at every state change (a worker starts, a
  review verdict, a merge, a user answer). The user should never have to ask for it, and it is
  what a goal check-in or a resumed session reads first.
- **Blocking decisions go through the question tool, not prose.** When progress needs the
  user's choice (scope, a duplicate fix, who owns a worktree, whether to run something
  risky, a destructive step, a milestone), call the question tool with concrete options and a
  recommended first option. A question written in chat text is easy to miss and cannot be
  answered with one click; a decision asked only in prose is treated as not asked. Plain chat
  is for status. Do not ask what a sensible default settles: pick it and say so.

---

## 7. Skills the pipeline names

Named **inside worker prompts**, never run in the coordinator's own context.

| Skill | Stage | Role |
|---|---|---|
| `pr-review` | 5 | Full review, HTML artifact, findings never posted. **Required.** |
| `playwright-cli` (or playwright MCP) | 2 | Human-path acceptance, screenshots, HTML report. **Required** unless `acceptance: none`. |
| CI skill from the adapter (e.g. `jenkins`) | 3 | Watch the build to a terminal state. **Required** when the adapter names one. |
| `tdd` | 1 | Named in the method block. Soft: note its absence, do not block. |
| `to-tickets` | pre | Ticket too coarse: a read-only worker slices it. Soft. |
| `resolving-merge-conflicts` | any | After parallel work collides. Soft. |

Name a skill as an instruction ("use the tdd skill"), not as a `/slash` command.

Grilling skills are human-in-the-loop by design. They belong to planning with the user present,
**never** inside an unattended worker.
