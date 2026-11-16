# A Hub's coordinator drives workers on a Side

A coordinator on the Hub starts workers in projects of a Side (WSL, Docker, SSH) with the `worker_*` tools. The worker's session and CLI run on the Side, which owns the transcript (ADR 0001). The Hub keeps a link to it and follows it through a background subscription.

## Rules

- Two links per worker: the Hub link (`side` = the Side's ID) drives the tree, caps and tools; the Side link (`remote: true`, the Hub coordinator's ID) makes the Side treat it as a worker (escalated requests, list nesting, CLI lifecycle) and delivers no events there.
- The Hub derives worker events from the part stream of a subscription it owns (`background: true`, so the Side's close-when-finished and idle close stay in charge), with `sinceSeq` replay after a pipe drop. No event outbox on the Side.
- A Side that is not running, or whose `daemon_hello` lacks `caps: ["remoteWorkers"]`, is refused before anything is created. The wire additions are `session.create` `permissionMode`, `effort` and `worker`, `worker.keepOpen`, and `daemon_hello.caps`; the frame schema (`SIDE_SCHEMA`) does not change because no frame is added.
- The user answers a remote worker's request on the Hub, as for any Side session. The coordinator gets no event for it.
- A coordinator on a Side still starts workers on its own side only.

## Considered options

- **Hub coordinates through the Side's own orchestration** (a Side-local coordinator relays): needs a coordinator process on every Side and a second event path.
- **An event outbox on the Side, pulled by the Hub**: durable across Hub restarts, but a second delivery mechanism next to the part stream the Hub already reads.
- **Bumping `SIDE_SCHEMA`** for the new messages: ADR 0009 bumps it for a new frame; these are client messages, and a bump would refuse older Sides for everything else.

## Consequences

- The contract between independently updated Hubs is the three wire additions above and the Side link fields; a Hub must keep sending them as they are.
- Each Side applies its own Settings to the sessions it runs (Close finished workers, the Orchestration limits of workers that start workers there); the Hub's limits apply to what it started.
