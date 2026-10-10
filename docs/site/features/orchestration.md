# Orchestration (workers)

One session (the **coordinator**) can start and steer other sessions (the **workers**). Off by default.

## How to use

1. Open **Settings › Orchestration** and turn on **Enable orchestration**.
2. Start a new session (or send the next prompt in an existing one; the setting applies at a session's next start).
3. Ask it to use workers, for example: "Split this into two tasks and start a worker for each in its own worktree."
4. Workers show in the sidebar under their coordinator, as normal sessions you can open.
5. Questions and permission requests a worker hands to you show up like any other request, and on the [Focus page](focus).

## Settings

| Setting | Does |
| --- | --- |
| **Enable orchestration** | Every session except a worker gets the worker tools. |
| **Maximum workers** | How many workers may run at once (1 to 20). |
| **Worker mode** | The [permission mode](permissions) of a new worker when the coordinator does not pick one. Default: the coordinator's own mode (bypass becomes auto). |
| **Coordinator may answer permission requests** | Lets the coordinator allow or deny, once, a worker's low-risk requests: reads and edits inside the worker's folder, reads of the repo's agent docs, read-only git. Everything else waits for you. |

## The worker tools

<details>
<summary>The 11 tools the coordinator gets (an MCP server inside the daemon)</summary>

| Tool | Does |
| --- | --- |
| `worker_start` | Start a worker in a folder or in a new git worktree, with a first prompt |
| `worker_send` | Send a message to a worker (steers a running turn) |
| `worker_wait` | Wait for a worker event: question, permission, denied, turn end, error |
| `worker_read` | Read a worker's recent timeline |
| `worker_list` | List workers and their state |
| `worker_answer` | Answer a worker's simple factual question |
| `worker_permission` | Allow once or deny a worker's low-tier permission request |
| `worker_escalate` | Hand a worker's question or request to you |
| `worker_stop` | Interrupt a worker's running turn |
| `worker_close` | Close a worker's Claude process (the session stays) |
| `worker_remove` | Delete a finished worker's session for good |

</details>

## Good to know

- A worker is a normal session. You can open it, type in it and answer its requests yourself. The first answer wins.
- A worker in a more permissive mode than its coordinator needs your OK on the `worker_start` card.
- High-tier requests are always yours. The coordinator can still stop or close the worker.
- Workers count toward your plan usage like any session.
