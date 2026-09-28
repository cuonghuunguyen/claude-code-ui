# Claude Code Web UI — General Spec

Source: [Claude Docs](https://claude.ai/artifact/QGJWx4mN966peZmokWTN1h), rev 8, 2026-09-28. The doc is the live version; this file is a snapshot.

## Overview

A browser UI for running Claude coding agents on a machine you control. A local daemon runs sessions through the Claude Agent SDK and streams them to a web app, so you can drive and approve agent work from any browser, including a phone.

**Goals**

- Start, watch and steer agent sessions in a chosen working directory from the browser.
- Approve or deny tool use (bash, file edits) with a clear prompt, per request or for the whole session.
- Keep sessions running when the browser disconnects; catch up on reconnect with nothing lost or duplicated.
- Show tool activity readably: bash output, file-edit diffs, todo lists, subagent activity.
- Safe by default: reachable only on localhost or a private network until real auth is added.

**Non-goals for v1**

- A code editor or file tree (v2).
- Multi-user or team hosting.
- Replacing the agent loop; the SDK owns tools, context and model calls.
- Parity with every Claude Code CLI feature (slash commands, checkpoints).

## Architecture

Three layers: a web app, a daemon you write, and the Claude Agent SDK, which owns the agent loop.

```
Browser (web app)  --WebSocket-->  Daemon  -->  Claude Agent SDK  -->  Anthropic API
                                     |
                                   SQLite (session metadata)
```

The browser only ever talks to the daemon. The daemon and SDK run on the machine that holds the code; the browser reaches the daemon over localhost, Tailscale or an SSH tunnel.

**Stack (proposed)**

- Daemon: Node.js + TypeScript, `@anthropic-ai/claude-agent-sdk`, a WebSocket server (`ws`), SQLite for session metadata.
- Web app: React + Vite, Tailwind, shadcn/ui and Vercel AI Elements for chat components.
- One shared TypeScript package for the wire protocol and message model, used by both sides.

## Daemon

The daemon owns every session's lifecycle and is the single source of truth; browsers are disposable views onto it.

### Sessions

- A session = one SDK `query()` run in one working directory, keyed by the SDK session ID.
- States: `idle` (waiting for a prompt), `running`, `awaiting_permission`, `error`, `closed`.
- Sessions keep running when no browser is connected.
- Several sessions may run at once; each has its own event log.
- Metadata (id, title, cwd, model, created/updated, state) is stored in SQLite so the list survives a daemon restart. v1 may resume a stored session with the SDK's resume option rather than keeping it live.

### Event log and sequence numbers

- Every event sent to clients gets a per-session, monotonically increasing `seq`.
- The daemon keeps the full event log per session (in memory for v1, appended to disk later).
- A client subscribes with `{sessionId, sinceSeq}`; the daemon replays everything after `sinceSeq`, then streams live.
- Clients drop any event with `seq` ≤ the last one they applied, so replays never duplicate.

### Wire protocol (WebSocket, JSON)

| Direction | Message | Purpose |
| --- | --- | --- |
| client → daemon | `session.create {cwd, model?, permissionMode?}` | Start a new session |
| client → daemon | `session.subscribe {sessionId, sinceSeq}` | Replay and follow a session |
| client → daemon | `session.prompt {sessionId, text, attachments?}` | Send a user turn |
| client → daemon | `session.interrupt {sessionId}` | Stop the running turn |
| client → daemon | `permission.respond {requestId, decision, scope}` | Answer a permission request |
| client → daemon | `session.list` / `session.close` | Manage sessions |
| daemon → client | `event {sessionId, seq, part}` | One normalized message part (see message model) |
| daemon → client | `session.state {sessionId, state}` | State change |
| daemon → client | `permission.request {requestId, sessionId, tool, input}` | Ask the user to approve a tool call |
| daemon → client | `error {code, message}` | Protocol or session error |

### Permission bridge

1. The SDK calls `canUseTool(tool, input)` in the daemon.
2. The daemon checks session rules ("allow for this session"); if one matches, it resolves immediately.
3. Otherwise it creates a request with an id, stores the pending promise, sets state `awaiting_permission`, and emits `permission.request` as a logged event.
4. The first `permission.respond` for that id resolves the promise; later answers are ignored, and every client is told the request is settled.
5. With no client connected, the request waits. An optional timeout (default: none) resolves as deny.
6. Interrupting the session denies any pending request.

Scopes: `once`, `session` (same tool, and for bash the same command prefix). Persistent project-level rules are v2.

### Interrupt

- `session.interrupt` calls the SDK's interrupt/abort for the running query, denies pending permissions, and emits a `turn.interrupted` event.
- The session returns to `idle` and accepts a new prompt, resuming the same SDK session.

## Message model

The daemon converts raw SDK messages into one normalized model; the UI renders only this model, so the component library can be swapped without touching the daemon.

| Part type | Key fields | Rendered as |
| --- | --- | --- |
| `user_text` | `text`, `attachments[]` | User bubble |
| `assistant_text` | `id`, `text`, `streaming` | Markdown, streamed |
| `thinking` | `id`, `text` | Collapsed reasoning block |
| `tool_call` | `toolUseId`, `tool`, `input`, `status` (pending / running / done / error / denied) | Tool card, by tool type |
| `tool_result` | `toolUseId`, `output`, `isError` | Merged into its tool card |
| `permission_request` | `requestId`, `toolUseId`, `tool`, `input`, `settled` | Inline approve / deny prompt |
| `todo_update` | `items[]` (content, status) | Pinned todo list |
| `subagent` | `id`, `description`, `status`, child parts | Nested, collapsible group |
| `turn_result` | `durationMs`, `costUsd`, `usage`, `isError` | Turn footer |
| `turn_interrupted` | — | Status line |

**Adapter rules**

- Streaming text arrives as deltas; the adapter accumulates them under a stable part `id` and sends updates for that id, so the UI replaces rather than appends.
- A `tool_result` updates its `tool_call` status; the UI groups them by `toolUseId`.
- Tool-specific rendering is keyed on `tool`: `Bash` (command + output), `Edit`/`Write` (diff from input), `Read` (path + line range), `Grep`/`Glob` (pattern + matches), `TodoWrite` (todo list), anything else (JSON input/output).
- Unknown SDK message types pass through as a generic `raw` part so nothing is silently lost.
- The model and adapter live in the shared package and are covered by fixture tests recorded from real SDK sessions.

## Frontend

One responsive single-page app with two main views, built from AI Elements components restyled toward OpenCode's look.

### Screens

- **Session list**: sessions with title, working directory, state badge (running, needs approval, idle), last activity. "New session" opens a directory picker (paths from the daemon) and optional model choice.
- **Session view**: the conversation, a prompt box, and a header with cwd, model, state, and a stop button. A pending permission request is shown inline and also as a sticky banner so it can't be missed.
- On narrow screens the list becomes a drawer; the session view is full width.

### Components

| Component | Source | Notes |
| --- | --- | --- |
| Conversation container, scroll-to-bottom | AI Elements `conversation` | Auto-scroll only when already at bottom |
| Message, markdown response | AI Elements `message`, `response` | Streaming updates by part id |
| Reasoning | AI Elements `reasoning` | Collapsed by default |
| Tool card | AI Elements `tool`, customized | Header: icon, tool name, one-line summary, status |
| Bash output | Custom | Monospace, ANSI colors, collapse after ~20 lines |
| Edit diff | Custom, `@pierre/diffs` or `diff2html` | Unified diff built from Edit/Write input |
| Todo list | AI Elements `task`, customized | Pinned above the prompt while a turn runs |
| Permission prompt | Custom | Tool, full input, Allow once / Allow for session / Deny |
| Prompt input | AI Elements `prompt-input` | Enter to send, Shift+Enter newline, image paste (v1.1) |
| Turn footer | AI Elements `context`, customized | Duration, tokens, cost |

### Client state

- One WebSocket per tab, auto-reconnect with backoff; on reconnect, resubscribe with the last applied `seq`.
- A per-session store keyed by part id; events are applied idempotently.
- Connection status shown in the header (connected / reconnecting / offline).

## Security

The daemon can run arbitrary shell commands, so it is treated as a remote shell: private by default, authenticated always.

- **Bind to 127.0.0.1 only** by default. Remote access goes through Tailscale or an SSH tunnel; binding to other interfaces requires an explicit flag.
- **Token auth on every connection**: the daemon generates a random token on first run; the browser sends it on WebSocket connect. Pairing via a printed URL or QR code containing the token.
- **Origin check** on WebSocket upgrade to block cross-site connections from other pages in the same browser.
- **Working directory allowlist**: sessions may only start inside configured root folders.
- **Default permission mode asks** for every write and bash command; "bypass" modes are off unless enabled in daemon config.
- **Anthropic credentials** live only in the daemon's environment (API key), never sent to the browser. Check current SDK terms before using subscription login.
- **No secrets in logs**: redact env vars and tokens from event logs and error messages.

## Scope and roadmap

v1 is chat, tool cards and permissions over a reliable stream; the editor and power features follow in v2.

### v1 build order

1. Shared package: wire protocol types and message model.
2. Daemon: one session, `query()` streaming, adapter, WebSocket with seq numbers and replay.
3. Web app: session view with streaming text and generic tool cards.
4. Permission bridge and prompt UI (once / session / deny).
5. Interrupt, multiple sessions, session list, directory picker.
6. Tool-specific cards: Bash, Edit/Write diffs, Read, Grep/Glob, todos.
7. Auth token, origin check, cwd allowlist; test over Tailscale on a phone.

**v1 is done when**: a session keeps running with the tab closed, the phone reconnects and shows every message once, and a permission request can be answered from either of two open tabs.

### v2 candidates

- File tree and Monaco editor; edits reviewed as a Monaco diff tied to the permission prompt.
- @-mention files with fuzzy search; send editor selection to Claude.
- Checkpoints and rewind (per-turn snapshots via a shadow git repo).
- Slash commands, plan mode toggle, model switching mid-session.
- Persistent permission rules per project; event logs on disk.
- Push notifications when a session needs approval or finishes.

### Open questions

- [ ] React + AI Elements, or fork OpenCode's SolidJS UI?
- [ ] API key only, or also support subscription login (check SDK terms)?
- [ ] Should a permission request with nobody connected time out, and after how long?
- [ ] Where do event logs live long-term: SQLite, JSONL files, or both?
