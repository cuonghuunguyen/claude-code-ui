# Orchestration (workers)

One session (the **coordinator**) can start and steer other sessions (the **workers**). Off by default.

## How to use

1. Open **Settings › Orchestration** and turn on **Enable orchestration**.
2. Start a new session (or send the next prompt in an existing one; the setting applies at a session's next start).
3. Ask it to use workers, for example: "Split this into two tasks and start a worker for each in its own worktree."
4. Workers show in the sidebar under their coordinator, as normal sessions you can open. A worker's own workers show under the same coordinator, named `parent › child`.
5. Questions and permission requests a worker hands to you show up like any other request, and on the [Focus page](focus).

## Settings

| Setting | Does |
| --- | --- |
| **Enable orchestration** | Every session, workers too, gets the worker tools. |
| **Maximum workers per tree** | How many workers one coordinator you start may run at once, counting its workers' workers (1 to 20, default 4). Each coordinator has its own count. |
| **Maximum workers in total** | How many workers may run at once on this daemon across every coordinator (0 to 100; 0, the default, = no limit). |
| **Maximum tree depth** | How deep workers may start workers of their own (1 to 5). 1: only you start workers. 2 (default): a worker may start its own, for example a tester and a reviewer. |
| **Maximum workers per coordinator** | How many workers one session (you or a worker) may run at once (1 to 20, default 4). |
| **Close finished workers** | A worker that ends its turn with nothing pending closes its Claude process and stops counting toward the limits (default on). Not while you have it open in a tab. The coordinator can keep a worker open. |
| **Stall alert after (minutes)** | Tells the coordinator when a running worker sends nothing for this long (0 to 240, default 20; 0 = off). |
| **Keep coordinator cache warm (minutes)** | While a coordinator (a session that has started workers; never a plain session) waits on running workers, subagents or background commands, wakes it this long after its last turn with a one-line message so its prompt cache stays warm instead of being rewritten at full price when the next worker event arrives (0 to 59, default 55; 0 = off). Keep it under the cache lifetime: 55 for the 1-hour cache, 4 for the 5-minute cache. The message shows as a small notice row. |
| **Worker mode** | The [permission mode](permissions) of a new worker when the coordinator does not pick one. Default: the coordinator's own mode (bypass becomes auto). |
| **Notifications from workers** | Turn it off and a worker that finishes, needs input or fails sends no push, desktop or in-app notification. Its coordinator still hears. A request the coordinator passes on to you still notifies you. |
| **Coordinator may answer permission requests** | Lets the coordinator allow or deny, once, a worker's low-risk requests: reads and edits inside the worker's folder, reads of the repo's agent docs, read-only git. Everything else waits for you. |

## Worker trees and the orchestration plugin

A worker can start workers of its own (up to **Maximum tree depth**). Its `worker_start` card for a higher mode names the chain, for example `started by worker implementer`. Each coordinator hears only its own workers.

The `orchestration` plugin of this repository adds four agent types a worker can run as (`worker_start` with `agent`): `orchestration:planner`, `orchestration:implementer`, `orchestration:ui-tester` and `orchestration:reviewer`, and the `orchestrate-tickets` skill that runs a ticket through them. Install it once:

```
claude plugin marketplace add cuonghuunguyen/claude-code-ui
claude plugin install orchestration@claude-ui
```

Or use the Plugins dialog. The reviewer needs the `pr-review` skill; acceptance uses `playwright-cli`.

## The worker tools

<details>
<summary>The 12 tools the coordinator gets (an MCP server inside the daemon)</summary>

| Tool | Does |
| --- | --- |
| `worker_start` | Start a worker in a folder or in a new git worktree, with a first prompt, optionally as an agent type |
| `worker_send` | Send a message to a worker (steers a running turn) |
| `worker_wait` | Wait for a worker event: question, permission, denied, turn end, error, stalled |
| `worker_read` | Read a worker's recent timeline (a path such as `implementer/reviewer` reads a worker below you). `part` and `offset` read one long reply whole, page by page |
| `worker_list` | List workers and their state (`tree` lists every worker below you) |
| `worker_answer` | Answer a worker's simple factual question |
| `worker_permission` | Allow once or deny a worker's low-tier permission request |
| `worker_escalate` | Hand a worker's question or request to you |
| `worker_stop` | Interrupt a worker's running turn |
| `worker_close` | Close a worker's Claude process (the session stays) |
| `worker_keep_open` | Keep a worker's Claude process after its turns |
| `worker_remove` | Delete a finished worker's session for good |

</details>

## Good to know

- A worker is a normal session. You can open it, type in it and answer its requests yourself. The first answer wins.
- A worker in a more permissive mode than its coordinator needs your OK on the `worker_start` card.
- A turn end event holds the first 4000 characters of the worker's reply. For a longer reply the coordinator reads the rest with `worker_read` (`part`, `offset`).
- A **stalled** event tells the coordinator that a worker needs a look. Reasons: the Claude process ended in the middle of a turn, a new turn never started, or the worker sent nothing for **Stall alert after** minutes. The worker is not stopped, and the coordinator decides. The worker's `stalled` field in `worker_list` clears with its next message.
- A finished worker resumes on its next message (about 4 s plus MCP start).
- `worker_close` refuses a worker that has running workers of its own; `worker_remove` refuses a worker that has any worker below it (remove those first).
- A `worker_start` over a limit asks you nothing: the worker gets the error at once.
- High-tier requests are always yours. The coordinator can still stop or close the worker.
- Workers count toward your plan usage like any session.
