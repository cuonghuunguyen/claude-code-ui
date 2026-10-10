# Worker prompts

A worker prompt is the first user turn of a fresh session. Write it for someone with no memory
of the coordinator's conversation. Every prompt names five things: the target, the change or
check, the constraints, what it may edit, and the observable result.

Every prompt, no exceptions, carries the four blocks below. A prompt missing one is a prompt
you rewrite before starting the worker.

```
PLAYBOOK
- Read <absolute playbook path> first and follow its sections for this stage. Where this
  prompt and the playbook disagree, this prompt wins; say so in your result.

SCRATCH SPACE
- Your scratch folder is <scratch>/<KEY>/. If the playbook ignores it by git exclude: run
  `mkdir -p development-docs` and append `development-docs/` to
  "$(git rev-parse --git-common-dir)/info/exclude" unless the line is already there. Not a
  literal `.git/info/exclude`: in a worktree `.git` is a file.
- Every artefact that is not the fix goes there. Commit none of it. If `git status` shows it,
  the ignore did not land: fix that, do not `git add` around it.

FORBIDDEN
- Do NOT add, edit or reply to comments on the ticket or any pull request, and do NOT create
  PR tasks, approve, merge or decline. Those channels belong to humans. Report to me instead.
- Do NOT push and do NOT open a pull request. The coordinator delivers.
- Any subagent you spawn gets an explicit model: haiku or sonnet for search and triage.

RESULT
- Ask me questions with your normal question tool; I or the user will answer.
- Your final reply STARTS with this block (anything after line 3 may be cut):
    RESULT: succeeded | failed | blocked
    REPORT: <path under your scratch folder, or ->
    <stage lines below>
    <up to three sentences: what changed or was found, what remains>
- Never end your last turn without it.
```

---

## 0. Plan worker — `opus`, creates the worktree

`worker_start{name: <key>-plan, repo, branch, base, model: "opus", mode: "auto"}`

```
TICKET: <KEY> — <summary>
LINK:   <ticket url>   (read-only, see FORBIDDEN)
STAGE:  Plan. Write a plan, no code.

CONTEXT (from the ticket and its comments)
  <current behaviour / cause / acceptance criteria, verbatim>

WHAT I VERIFIED BEFORE DISPATCH (trust this over the ticket text)
  <real file:line sites, what is already fixed on base, decisions taken>

<PLAYBOOK> <SCRATCH SPACE> <FORBIDDEN>

METHOD
- Run the playbook's install command first.
- Read what the playbook's "Plan: read before designing" section names, then trace the data
  flow end to end before choosing a design.
- Before relying on a library or SDK API, check its current docs (context7) or a throwaway
  probe; delete the probe after.

WRITE <scratch>/<KEY>/plan.md so the implementer needs no exploration:
- Files to change, with the function or component and the exact edit per file.
- Existing helpers to reuse (paths). Interface, schema or doc changes, if any.
- Tests: file, test names, what each asserts; the command to run them.
- Per acceptance criterion: the evidence that will prove it (a test name or a UI case).
- Library facts already checked, so the implementer does not re-fetch them.
- Risks and open questions.

<RESULT>  REPORT is plan.md. No stage lines.
```

---

## 1. Implementation worker — `sonnet`

After a plan: `worker_start{name: <key>-impl, cwd: <worktree>, model: "sonnet", mode: "auto"}`.
Plan skipped: it creates the worktree with `repo`/`branch`/`base` instead.

```
TICKET: <KEY> — <summary>
LINK:   <ticket url>   (read-only, see FORBIDDEN)
STAGE:  Implement.

PLAN: <scratch>/<KEY>/plan.md — read it first and follow it. Do not re-explore the codebase
      broadly. Plan wrong or missing a small piece: fix it locally and say so in notes.md.
      Missing a big piece: stop with RESULT: blocked and the gap.
(no plan) CONTEXT + WHAT I VERIFIED BEFORE DISPATCH, as in the plan template. If the ticket
      turns out bigger than it looked, stop with RESULT: blocked, "needs plan".

SCOPE
- Fix only what this ticket describes. Anything else you notice: report it, do not fix it.

<PLAYBOOK> <SCRATCH SPACE> <FORBIDDEN>

METHOD
- RUN THE PLAYBOOK'S INSTALL COMMAND FIRST. A fresh worktree has no dependencies, and a test
  command that dies on a missing tool can look exactly like a passing run.
- Use the tdd skill: a failing test first, where a test is meaningful.
- Follow the playbook's Implement section.
- Run the full suite and the typecheck before reporting. A red suite is RESULT: failed, not a
  caveat in prose.
- Commit on this worktree's branch: the fix only, scratch excluded, message per the playbook.
- Write notes.md: decisions, files, per acceptance criterion the evidence, out-of-scope
  findings, and manual steps a UI tester needs.

<RESULT> stage lines:
    APP: <start command> on port <n>
    COMMIT: <sha>
    TESTS: <passed>/<failed>/<skipped>
```

### Fix message (`worker_send` to the implementer after a red stage)

```
<Stage> failed for <KEY>, attempt <n>.
Report: <path>. Failing: <case or step, the first real error line>.
Fix it, add or adjust a test that would have caught it, re-run the suite, commit, and reply
starting with the RESULT block as before.
```

---

## 2. Acceptance worker — `sonnet`, test it the way the user meets it

Unit tests prove the code does what the author meant. This stage proves the acceptance
criteria hold for a person clicking through the product. **Fresh worker, never the
implementer.** Read-only in the worktree except for the scratch folder.

`worker_start{name: <key>-ui, cwd: <worktree>, model: "sonnet", mode: "auto"}`

```
TICKET: <KEY> — <summary>
STAGE:  Acceptance. You do not write product code. You prove the fix from outside.

WHAT MUST BE TRUE (from the ticket, verbatim)
  <acceptance criteria>

USER-VISIBLE CLAIMS TO PROVE (my extraction — each one gets its own case)
  1. <claim>
  2. <claim>

APP
- Start it with: <command from the implementer's APP line>, on port <assigned port>.
  Dependencies are installed. Stop it when you are done, by its own PID only.

<PLAYBOOK> <SCRATCH SPACE> <FORBIDDEN — plus: do NOT fix what you find, report it>

METHOD
- Use the playwright-cli skill (or the playwright MCP) with a session named after your port,
  and drive a real browser. Follow the playbook's Acceptance section for login and test data.
- NAVIGATE BY UI, LIKE A HUMAN. Start at the app's entry point and click, type, tab and scroll
  to the state under test. Do NOT deep-link past setup, do NOT seed state through an API or a
  database, do NOT call internal functions. The path is part of what is tested.
- Test what a user faces: the happy path, plus empty state, invalid input, a second attempt,
  navigating back, refreshing mid-flow, and the one thing the ticket says used to break.
- SCREENSHOT EVERY ASSERTION into <scratch>/<KEY>/screenshots/NN-<what>.png. A claim without
  a screenshot is untested.
- Watch the browser console and network. An unhandled error or a failed request is a finding
  even when the UI looks right.

REPORT
- <scratch>/<KEY>/ui-acceptance.html: one self-contained file that opens with no server.
  Verdict and counts at the top; per case, the numbered steps, the screenshots inline
  (relative src), pass/fail, console and network errors.

<RESULT> stage line: CASES: <passed>/<total>. Any failed case is RESULT: failed.
```

---

## 3. Build-watch worker — `haiku`

A build watch is a long poll. Start it; do not run it in the coordinator's context.

`worker_start{name: <key>-ci, cwd: <worktree>, model: "haiku", mode: "auto"}`

```
BRANCH: <remote branch>   (already pushed)
STAGE:  Build watch. You change nothing. You report what CI did.

<PLAYBOOK> <SCRATCH SPACE> <FORBIDDEN — plus: no code edits, no commits, no re-triggers>

METHOD
- <the CI adapter's watch instructions, pasted from adapters/<ci>.md>
- Queued-and-not-started is not a failure. Keep waiting.
- Never re-trigger a build to see if it passes this time.

<RESULT> stage line: BUILD: <job> #<n> <duration>.
  Red: write the failing step's console excerpt to <scratch>/<KEY>/build-<n>.log and make it
  the REPORT; the sentences name the step and its first real error line, not the last line.
```

---

## 4. Review worker — `opus`

**Fresh agent, mandatory.** Fresh agent, not a fresh checkout: point it at the implementer's
worktree, which sits on the PR head with dependencies installed.

`worker_start{name: <key>-review, cwd: <worktree>, model: "opus", mode: "auto"}`

```
PR:     <url, or "local branch <branch> against <base>" when the playbook delivers no PR>
TICKET: <KEY> — <summary>
STAGE:  Review. Read-only in this worktree: no edits, no commits, no rebases, except your
        scratch folder.

<PLAYBOOK> <SCRATCH SPACE>

<FORBIDDEN — plus, spelled out:>
- Do NOT post findings to the PR or the ticket: no comments, no tasks, no approval or verdict.
  The user reads your report and decides what of it reaches the PR.

METHOD
- Invoke the pr-review skill first and follow all its phases in order, including publishing
  the artifact before you read the diff. Every PR, regardless of size.
- Scope test runs to the diff (the playbook's scoped test command): other workers run in
  parallel.
- Name where the author's judgement beat yours. A review that only finds fault earns no right
  to block on the one thing that should block.

REPORT
- The pr-review artifact URL, and a copy at <scratch>/<KEY>/review.html.
- Lead with the blockers. Keep the long tail short.

<RESULT> stage lines: VERDICT, BLOCKERS: <n>, ARTIFACT: <url>.
  Blockers > 0 is RESULT: failed.
```

A review does not authorize applying its findings. Blockers go to the implementer as a fix
message; the stages the fix invalidates re-run. Non-blocking findings go to the user.

---

## 5. Slicing worker (soft, when a ticket is too coarse)

Read-only, `model: "sonnet"`, in the main checkout. Uses the to-tickets skill if present and
writes `<scratch>/<KEY>/slices.md`. You read it and plan one ticket per slice, chained.

---

## 6. Playbook drafter — `sonnet`, read-only

`worker_start{name: <repo>-playbook, cwd: <main checkout>, model: "sonnet", mode: "auto"}`

```
STAGE: Draft a ticket playbook for this repo. Read-only except your scratch folder.

<SCRATCH SPACE (folder: development-docs/playbook/)> <FORBIDDEN>

FORMAT: <paste the format block from references/playbook.md>

METHOD
- Read README, CLAUDE.md, package manifests, CI config (Jenkinsfile, .github/workflows/),
  `git remote -v`, recent branch names, and docs a new contributor would read.
- Establish every Profile and Commands value from evidence. Write TODO for anything you could
  not establish, and say what would settle it. Do not guess.
- Under Traps, record only what the repo itself documents.

<RESULT> REPORT is development-docs/playbook/playbook-draft.md.
```

---

## Hygiene

- After every `worker_start`, check the result: a `modeNote` means the worker fell back to
  `default` and will ask for every command. Tell the user.
- Name a skill as an instruction ("use the tdd skill"), not as a `/slash` command.
- Follow-ups go through `worker_send`; it reaches a running turn at once.
