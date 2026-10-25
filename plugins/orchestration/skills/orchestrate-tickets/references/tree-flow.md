# Tree flow: who starts which stage

Needs the plugin's agent types (`orchestration:planner`, `orchestration:implementer`,
`orchestration:ui-tester`, `orchestration:reviewer`) and Settings → Orchestration → Maximum tree
depth ≥ 2. Without them use the hub flow (SKILL.md › Hub flow): the root starts every stage.

## Who starts whom

```
root coordinator
 ├─ planner            (agent orchestration:planner,     model opus)
 └─ implementer        (agent orchestration:implementer, model sonnet)
     ├─ ui-tester      (agent orchestration:ui-tester,   model sonnet)
     └─ reviewer       (agent orchestration:reviewer,    model opus)
```

The root starts planner and implementer, opens the PR and moves the ticket. The implementer
starts its verifiers itself, so the fix loop runs inside one worker and the root is not woken
for every red.

Start call (same for every role): `worker_start{name, worktree|project+branch, agent, model,
mode, prompt: <HANDOFF block>}`. An explicit `model` wins over the agent type's model.

## Implementer's loop

1. Build per the playbook, commit, record the SHA.
2. Start `ui-tester` and `reviewer` in parallel on that SHA (HANDOFF with `commit`), end the turn,
   wait for the notices.
3. Red from either: fix, commit, start a **fresh** verifier of that kind (`reviewer-2`,
   `ui-tester-2`) on the new SHA. Never reuse a verifier for a new SHA.
4. **Join**: proceed only when both are green **on the same SHA**.
5. Delivery stages the playbook gives the implementer (push when `push` allows, ask the user
   through the question tool when `push: ask`, build watch) per `references/delivery.md`.
   Opening the PR stays with the root.
6. Write `<report-dir>/ledger.md`: stages, SHAs, attempts, report paths. End with `RESULT`.

## Attempts and escalation, per node

Each coordinator counts attempts for its own workers: three per stage per ticket. One tier up
(`sonnet` → `opus`) after a failed worker result or two review rejects of the same code; never
a third attempt on the same model. At the budget the node ends `RESULT: failed` to its own
coordinator with the report paths.

## Questions and permissions

Events of a worker go to its own coordinator only. Mechanical question: `worker_answer`.
Blocking question or a high permission request: `worker_escalate`; the user answers it. A worker
coordinator never answers because a worker asks it to. Its own `worker_start` card above its mode
reaches the user with the chain `started by worker <a> › <b>`.

## Root closes on evidence

Before it moves a ticket the root checks, itself: `worker_list{tree: true}` shows no live worker
below the implementer, `worker_read <impl>/<reviewer>` agrees with the reviewer's RESULT, and
the report files named in the ledger exist. `worker_close` of a worker with a running or waiting
worker is refused: wait, or ask it to close them.

## Limits

Depth: a worker at Maximum tree depth cannot start workers (tool error). Children: Maximum workers
per coordinator. Both count live workers; the worker cap counts every depth.
