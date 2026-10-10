# Admission, plan-or-skip, placement, sequencing, concurrency

Read once per batch, before starting anything.

---

## Admission — skip a ticket and say why

- **No acceptance criteria** (no `Expected:`, no "Acceptance criteria", nothing a person could
  check): the spec is too thin to hand an agent. Report it back as needing a grilling pass with
  the user; do not invent the criteria.
- **Wrong repo.** The ticket's files or parent item belong to another repo than the playbook's.
- **A parent with children** (epic, requirement with sub-tasks): orchestrate the children.
- **Already fixed on base.** The comments often say so; check before dispatching.

---

## Plan or skip (stage 0)

Skip the plan and start the implementer directly only when **all** hold:

- at most 2 files, in one package or module;
- no change to a public interface, wire or schema format, or a spec document;
- no library or SDK API the repo does not already use;
- acceptance criteria concrete in the ticket.

Any one fails: plan first. The playbook's "Plan skip rules" can tighten these, never loosen.
State the decision per ticket in the ledger.

An implementer that finds the ticket bigger than judged stops with `RESULT: blocked`,
"needs plan". Then stage 0 runs and the implementer starts again from the plan, as a new
worker (it saw the wrong scope).

---

## One ticket, one worktree

- Branch per the playbook (default `<KEY>-<slug>`, slug 2 to 4 words). The key must be in it:
  it is the only link between the worktree, the branch and the ticket.
- Base per the playbook. Never the coordinator's current branch unless the user asks for
  stacked work; then say so in every PR it produces.
- The first worker of the ticket (plan, or implement when plan is skipped) creates the
  worktree. Record its path in the ledger from the `worker_start` result; every later stage
  uses it as `cwd`.

---

## Conflicts — nothing infers them for you

Decide sequencing before fanning out:

1. Collect the file paths each ticket names (cause, plan, comments).
2. Two tickets sharing a path → chain them: the second starts when the first's PR is open
   (or its commit exists, for local-only delivery), based on the first's branch only if the
   user asked for stacking; otherwise on base, after the first merges.
3. A ticket that names **no** files → search the repo for the symptom to locate its area
   first. No paths is not evidence of independence.
4. Tickets touching test infrastructure (runners, fixtures, CI config) collide far more often
   than feature code. Chain them by default.
5. Tickets whose acceptance needs the **same app on the same port** collide at stage 2 even
   when their code does not. Give each acceptance worker its own port from the playbook's
   range, or chain them.

State the decision out loud before starting anything, so the user can override it, and write
it at the top of the ledger.

---

## Concurrency

- **3** live workers unless the user or the playbook raises it. More than that and the user
  cannot read the output as fast as it arrives.
- **2** acceptance workers at once: each drives a real browser and a real app.
- claude-ui enforces its own cap (Settings → Orchestration → Maximum workers, default 4) on
  workers with a running process. Closed workers do not count; a `worker_send` to a closed
  worker counts again. `Worker cap reached` from `worker_start` or `worker_send` is not a
  failure: close a settled worker, or wait for one.
- Close every worker as soon as its stage settles. The implementer too: `worker_send` resumes
  it when a fix is needed.
- Full test suites in parallel can flake on a busy machine. Workers that only need confidence
  in their diff run the playbook's scoped test command.
