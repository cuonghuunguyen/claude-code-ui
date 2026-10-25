# Handoff: the one shape every stage receives

A stage worker (planner, implementer, ui-tester, reviewer) gets its input as exactly this
block, as the whole `prompt` of `worker_start`. No free-text summary of earlier work: a
verifier that reads the previous stage's opinion inherits its blind spots. The worker reads the
ticket, the repo playbook and the diff itself.

```
HANDOFF
role: <planner|implementer|ui-tester|reviewer>
ticket: <KEY> <url>
worktree: <absolute path>
branch: <name>
commit: <sha or ->
coordinator: <sender's worker name, or root>
attempts: <used>/<budget>
report-dir: <absolute path>
```

| Field | Meaning |
|---|---|
| `role` | Which agent type the receiver runs as; it must match its own role prompt. |
| `ticket` | Tracker key and URL. The receiver reads the ticket and its comments itself. Read-only. |
| `worktree`, `branch` | The one worktree of the ticket. Never create another. |
| `commit` | The commit under test or review (`-` for planner and first implement). A verifier states this SHA in its RESULT. |
| `coordinator` | Who started the receiver, for its own report line. `root` = the root coordinator. |
| `attempts` | Attempts used and allowed for this stage on this ticket. At the budget the receiver does not retry: it ends `RESULT: failed`. |
| `report-dir` | The ticket's scratch folder, `development-docs/<KEY>/` of the main checkout. Prefix your files with your role (`plan-`, `impl-`, `ui-`, `review-`); `notes.md` is the implementer's. The per-ticket ledger is `<report-dir>/ledger.md`. |

Extra, optional lines after the block are allowed only for facts the sender verified and the
receiver cannot read itself (an app port from the coordinator, the previous report path for a
delta review). Never an opinion on the result.
