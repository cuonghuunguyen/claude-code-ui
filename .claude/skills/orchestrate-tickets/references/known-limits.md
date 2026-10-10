# Known limits, and calling a batch off

State these when they bite.

---

## Orchestration

1. **The coordinator must be a claude-ui session.** A Claude Code CLI session in a terminal
   does not get the `worker_*` tools, and neither does a worker.
2. **Workers start on the coordinator's side only.** A coordinator in a Windows project cannot
   start workers in a WSL path, and the reverse. Start the coordinator in a project on the side
   where the repos, skills and MCP servers are.
3. **Workers belong to one coordinator session.** Resume that session to keep driving them; a
   new session cannot adopt them (`workers.md` "Restarts"). The ledger is what makes a
   hand-finish possible.
4. **The result is cut after 4000 characters from the start.** A worker that writes its RESULT
   block at the end of a long reply loses it. The prompts say so; enforce it.
5. **A worker that ends its turn without a result is not finished.** It may have run out of
   turns, misunderstood, or be waiting on something. `worker_read` before deciding anything.
6. **Every command is a high-tier permission.** Only the user approves those. A worker in
   `default` mode (a model without auto support, or a coordinator that is not in auto) asks
   for each one. Watch `modeNote` in every `worker_start` result.
7. **Escalated means gone from your view.** After `worker_escalate` you get no events for that
   request and cannot stop the worker while it waits. Tell the user what is waiting on them.
8. **The worktree outlives the worker, the branch outlives the worktree.** `worker_close`
   removes neither. Removing a worktree in the web app deletes only `worktree-*` branches, so
   ticket branches stay until someone deletes them.
9. **No conflict detection, no scheduling.** claude-ui runs what it is told. Sequencing is the
   coordinator's job (`planning.md`).

## Machine

10. **One worktree per ticket is a real checkout** plus a dependency install. Cheap on small
    repos, minutes on large ones.
11. **Parallel full test suites can produce phantom failures.** A worker can report red for a
    reason that is not in its diff. Scope parallel runs to the diff, or serialize full ones.
12. **An acceptance run needs a free port and a real browser.** Two acceptance workers on one
    port collide and both report red. Assign ports.
13. **Screenshots are the only durable evidence of stage 2**, and they live in an ignored
    folder inside a worktree. If the user wants them after cleanup, say so before anything is
    removed.
14. **A CI skill needs credentials, not just presence.** Check them in the gate (the adapter
    says how), or stage 3 fails halfway.

---

## Calling a batch off

| Call | Does | Use when |
|---|---|---|
| `worker_stop` | Interrupts a running turn, cancels its pending requests | Stop work in flight |
| `worker_close` | Ends the process; session, transcript, worktree stay | After `worker_stop`, or any settled worker |
| `worker_list` | States of every worker of this coordinator | Before ending: nothing of this batch may still run |

Nothing here deletes a worktree or a branch, and nothing under the scratch folder was ever
committed, so nothing is lost. Leave the worktrees for the user unless they ask for cleanup,
and mention limit 13 first if they do. Update the ledger with where each ticket stopped.
