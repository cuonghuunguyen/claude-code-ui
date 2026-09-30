# Claude Code Web UI — General Spec

Rev 9, 2026-09-30. Based on the Claude Doc spec rev 8 (https://claude.ai/artifact/QGJWx4mN966peZmokWTN1h), revised by the 2026-09-30 grilling session. This file is now ahead of the doc. Glossary: `CONTEXT.md`. Decisions: `docs/adr/`.

## Overview

A browser UI for running Claude coding agents on a machine you control. A local daemon runs sessions through the Claude Agent SDK and streams them to a web app, so you can drive and approve agent work from any browser, including a phone. It should feel like the Claude Code VS Code extension or OpenCode web: smooth, same behavior as Claude Code.

**Goals**

- Start, watch and steer agent sessions in a chosen working directory from the browser.
- Approve or deny tool use and answer Claude's questions, with the same options as Claude Code.
- Keep sessions running when the browser disconnects; catch up on reconnect with nothing lost or duplicated.
- Show tool activity readably: bash output, file-edit diffs, todo lists, subagent activity.
- Browse and edit files, rewind to checkpoints, get push notifications when input is needed.
- Private by default: no external hosting (ADR 0003), authenticated always.

**Non-goals for v1**

- Plan mode toggle.
- Multi-user or team hosting.
- Replacing the agent loop; the SDK owns tools, context and model calls.

## Architecture

```
Browser (web app)  --WebSocket-->  Daemon  -->  Claude Agent SDK  -->  Anthropic API
                                                     |
                                     ~/.claude (transcripts, checkpoints, settings)
```

- The browser only talks to the daemon. Daemon and SDK run on the machine that holds the code.
- No database: the SDK transcript is the only store (ADR 0001).
- Auth: Claude subscription login only (ADR 0002).

**Stack**

- Daemon: Node.js + TypeScript, `@anthropic-ai/claude-agent-sdk`, `ws`.
- Web app: React + Vite, Tailwind, shadcn/ui, Vercel AI Elements (shadcn look). Layout and UX copied from OpenCode's new web UI (not its visual design).
- One shared TypeScript package for the wire protocol and message model.

## Daemon

### Sessions

- The daemon generates a UUID at `session.create` and passes it as `Options.sessionId`, so the ID is known before the first prompt.
- A live session is one long-lived `query()` in streaming input mode (required for `canUseTool`, `interrupt()`, images, `setModel()`). After a daemon restart, a session is resumed by a new `query({resume})` with the same ID.
- `settingSources: ['user', 'project']`, so CLAUDE.md, commands, skills and permission rules load like in Claude Code.
- States: `idle`, `running`, `needs_input` (permission request or question pending), `error`, `closed`.
- Session list = `listSessions()` filtered to cwds inside the allowlisted roots. Includes sessions started in the terminal CLI; they can be resumed.
- No protection when the terminal CLI and the daemon drive the same session at once (same as OpenCode).

### Event log and sequence numbers

- Every event has a per-session, monotonically increasing `seq`. The log is in memory only.
- History before the daemon started is rebuilt from `getSessionMessages()` through the adapter.
- Each daemon start has a `logEpoch`. `session.subscribe {sessionId, sinceSeq, logEpoch}`: same epoch → replay after `sinceSeq`; different epoch → client clears its store and gets a full replay.
- Clients drop events with `seq` ≤ the last applied one.
- State changes, permission requests, questions and their settlement are all logged events, so replay alone restores the full view.

### Wire protocol (WebSocket, JSON)

| Direction | Message | Purpose |
| --- | --- | --- |
| client → daemon | `session.create {cwd, model?}` | Start a new session |
| client → daemon | `session.subscribe {sessionId, sinceSeq, logEpoch}` | Replay and follow |
| client → daemon | `session.prompt {sessionId, text, images?}` | Send a user message; while a turn runs it steers the turn |
| client → daemon | `session.interrupt {sessionId}` | Stop the running turn |
| client → daemon | `session.setModel {sessionId, model}` | Switch model (`setModel()`) |
| client → daemon | `session.rewind {sessionId, userMessageId, mode}` | `mode`: `code`, `conversation`, `both` |
| client → daemon | `session.rewindPreview {sessionId, userMessageId}` | `rewindFiles` dry run: `filesChanged[]`, `insertions`, `deletions`, `conversation` |
| client → daemon | `permission.respond {requestId, decision, ruleIndex?, updatedInput?, message?}` | Answer a permission request |
| client → daemon | `question.respond {requestId, answers}` | Answer a question |
| client → daemon | `session.list` / `session.close` / `models.list` | Lists and management |
| client → daemon | `fs.list` / `fs.read` / `fs.write` / `fs.search` | File tree, editor, @-mention autocomplete |
| client → daemon | `push.subscribe {subscription}` | Register a Web Push subscription |
| daemon → client | `event {sessionId, seq, part}` | One normalized part |
| daemon → client | `error {code, message}` | Protocol or session error |

### Permission bridge (same behavior as Claude Code)

1. The SDK calls `canUseTool(tool, input, {suggestions})`. Rules already saved (Claude Code rules in `.claude/settings*.json`) never reach the callback.
2. The daemon logs a `permission_request` part with the SDK's suggested rules and sets state `needs_input`.
3. Options shown: **Yes** / **Yes, and don't ask again for `<suggested rule>`** / **No, and tell Claude what to do differently**. Rules are chosen by the SDK, not the user. Bash rules are saved to `.claude/settings.local.json` (via `updatedPermissions`), Edit rules last for the session, as in Claude Code.
4. Edit/Write requests show a diff; the user may change the proposed content before accepting (`updatedInput`).
5. The first answer settles the request; a settlement event tells every client. Later answers are ignored.
6. No timeout: a request waits until someone answers.
7. Interrupt denies pending requests.

### Questions

`AskUserQuestion` arrives through `canUseTool`. The daemon logs a `question` part; the UI shows a question panel in place of the prompt box, with an "Other" free-text choice. The answer returns through `updatedInput`. Counts as `needs_input`.

### Steering and interrupt

- A message sent while a turn runs is pushed into the query immediately (steering); Claude Code injects it after the current tool calls. To verify at build time: SDK mid-turn `streamInput` behaves the same.
- `session.interrupt` calls `interrupt()`, denies pending requests, logs `turn_interrupted`; the session returns to `idle` and stays live.

### Commands, skills, models

- Commands and skills come from `supportedCommands()` and are refreshed on `system/commands_changed`. The daemon logs them as a `commands` part (fixed id, replaced on each change), so every tab gets the push and replay restores it; there is no `commands.list` request. Terminal-only commands (`terminal_slash_commands`) are hidden. That list arrives only with `system/init`, after the first prompt; until then a built-in fallback set is hidden. Rows sharing a name collapse to the builtin one.
- A restored session has no query before its first prompt, so its picker is empty until then.
- Invoked by sending `/name args` as prompt text.
- Models from `supportedModels()`; switch with `setModel()` mid-session.

### Checkpoints and rewind (same modes as Claude Code `/rewind`)

- `enableFileCheckpointing: true` and `extraArgs: {'replay-user-messages': null}`; each user message UUID is a checkpoint.
- Code: `rewindFiles(userMessageId)` (Edit/Write/NotebookEdit only, not Bash; a `dryRun` preview shows changed files).
- Conversation: the next prompt resumes with `resumeSessionAt` = UUID of the last main-thread assistant message before the rewound prompt; the original prompt is put back in the prompt box. The first prompt has no such message, so it has no conversation rewind. `resumeDropsTurn` is not passed: it refuses any discarded range longer than one turn.
- Both: code, then conversation. Code options appear only when the checkpoint has tracked file changes.

### Push notifications (rules copied from Orca)

- Web Push with VAPID keys generated by the daemon; payload end-to-end encrypted, full text (session title + tool/command, or last line of the answer; ~4 KB max).
- Events: `needs input` and `finished` (an error counts as finished).
- `finished` waits 1.5 s and is cancelled if work resumes. At most one push per session per 5 s.
- Suppressed when a focused, visible tab shows that session.
- Click opens the session and scrolls to the bottom.
- One on/off toggle in v1.
- Needs HTTPS (see Security) and, on iOS, 16.4+ with the app added to the Home Screen.

## Message model

The daemon converts raw SDK messages into one normalized model; the UI renders only this model.

| Part type | Key fields | Rendered as |
| --- | --- | --- |
| `user_text` | `id`, `text`, `images[]` | User bubble, with rewind action |
| `assistant_text` | `id`, `text`, `streaming` | Markdown, streamed at a steady pace |
| `thinking` | `id`, `text` | Collapsed reasoning block |
| `tool_call` | `toolUseId`, `tool`, `input`, `status` (pending / running / done / error / denied) | Tool card, by tool type |
| `tool_result` | `toolUseId`, `output`, `isError` | Merged into its tool card |
| `permission_request` | `requestId`, `toolUseId`, `tool`, `input`, `suggestions[]`, `settled`, `decision?` | Permission panel |
| `question` | `requestId`, `questions[]`, `settled`, `answers?` | Question panel |
| `todo_update` | `items[]` (content, status) | Pinned todo list |
| `subagent` | `id`, `description`, `status`, child parts | Nested, collapsible group |
| `session_state` | `state` | Header badge, list badge |
| `commands` | `commands[]` (name, description, argumentHint, aliases?) | Slash command picker; not in the timeline |
| `turn_result` | `durationMs`, `costUsd`, `usage`, `isError` | Turn footer (live turns only) |
| `turn_interrupted` | — | Status line |
| `raw` | original message | Generic JSON |
| `rewind` | `userMessageId` | Not rendered; the client drops that user message and every part after it |

**Adapter rules**

- Streaming deltas accumulate under a stable part `id`; the UI replaces rather than appends.
- A `tool_result` updates its `tool_call` status; grouped by `toolUseId`.
- Tool rendering keyed on `tool`: `Bash`, `Edit`/`Write` (diff), `Read`, `Grep`/`Glob`, `TodoWrite`, `Task` (subagent), anything else (JSON).
- The same adapter converts live SDK messages and `getSessionMessages()` history.
- Fixture tests recorded from real SDK sessions.

## Frontend

React + AI Elements (shadcn look), layout and UX from OpenCode's new web UI.

### Layout

- Sidebar: session list grouped by working directory, with state badge and unread marker. "New session" opens a directory picker (allowlisted roots) and model choice.
- Session view: timeline, prompt box at the bottom, header with cwd, model switcher, state, stop button.
- Side panel (resizable): file tree + editor tabs, and a changes/diff tab.
- Narrow screens: sidebar becomes a drawer; a tab switch replaces the side panel ("session" / "changes" / "files").

### Session view UX (from OpenCode)

- A pending permission request or question replaces the prompt box (panel), and is also marked in the timeline.
- Consecutive read/search tool calls merge into one "context" group with a count.
- Tool cards collapse by default; Bash and edits expanded per tool type.
- Streamed text is revealed at a steady pace; incomplete markdown is repaired while streaming.
- Auto-scroll only while at the bottom.
- Unread count in the tab title.

### Prompt box

- Enter sends, Shift+Enter newline; while a turn runs, sending steers.
- `/` opens a command and skill picker.
- `@` opens file autocomplete (`fs.search`); the SDK expands `@path`.
- Image paste and drop.
- Selection from the editor can be sent as context.

### Editor

- CodeMirror 6 (touch-friendly), editable, saved through `fs.write`, restricted to allowlisted roots.
- A file changed by Claude reloads when clean; with unsaved edits the editor shows a conflict.
- "Send selection to Claude" inserts path + line range into the prompt box.
- Diffs in chat and the changes tab: `@pierre/diffs`.

### Components

| Component | Source |
| --- | --- |
| Conversation, scroll-to-bottom | AI Elements `conversation` |
| Message, markdown response | AI Elements `message`, `response` |
| Reasoning | AI Elements `reasoning` |
| Tool card | AI Elements `tool`, customized |
| Bash output | Custom: monospace, ANSI colors, collapse after ~20 lines |
| Edit diff | `@pierre/diffs` |
| Todo list | AI Elements `task`, customized |
| Permission panel, question panel | Custom |
| Prompt input | AI Elements `prompt-input`, extended with `/` and `@` pickers |
| Editor | CodeMirror 6 |
| Turn footer | AI Elements `context`, customized |

### Client state

- One WebSocket per tab, auto-reconnect with backoff; resubscribe with last `seq` and `logEpoch`.
- Per-session store keyed by part id; events applied idempotently.
- Connection status in the header.
- Service worker for Web Push; PWA manifest with `display: "standalone"`.

## Security

The daemon can run arbitrary shell commands; treat it as a remote shell.

- Bind to 127.0.0.1 only.
- Remote access and HTTPS: to be decided; no external hosting services (ADR 0003).
- Token auth on every WebSocket connection; pairing by a printed URL or QR code containing the token.
- Origin check on WebSocket upgrade.
- Working directory allowlist for sessions, file tree, editor writes and session list.
- Default permission mode asks; bypass modes off unless enabled in daemon config.
- Credentials: the owner's subscription login stays in the daemon's environment, never sent to the browser.
- No secrets in logs.

## Scope and build

Work is split into GitHub issues along a dependency graph, so independent pieces run in parallel worktrees (Orca).

**Core (first)**: shared package → daemon session + streaming + adapter + seq/replay → web app session view with generic tool cards → permission bridge and panel → interrupt, steering, multiple sessions, session list, directory picker → tool-specific cards → auth token, origin check, allowlist.

**Then, in parallel where possible**: model switch; commands and skills; @-mentions; images; questions; edit-before-accept; file tree and editor with send-selection; checkpoints and rewind; push notifications (needs HTTPS).

**v1 is done when**: a session keeps running with the tab closed, the phone reconnects and shows every message once, a permission request can be answered from either of two open tabs, and the phone gets a push when a session needs input.

**Deferred**: plan mode toggle; multi-user.

### Open questions

- [ ] Remote access and HTTPS without external hosting (ADR 0003).
- [x] Verify: SDK uses `claude login` credentials when no API key is set. Verified 2026-10-01 with SDK 0.3.285: with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset, `system/init` reports `apiKeySource: "none"` (claude.ai OAuth login) and turns succeed.
- [ ] Verify: mid-turn `streamInput` steers like Claude Code.
- [x] Verify: which UUID `resumeSessionAt` needs for a conversation rewind. Verified 2026-10-01 with SDK 0.3.285: the UUID of the last main-thread assistant message before the rewound prompt (the prompt's own UUID keeps it; a non-chain UUID fails with `No message found`). Resume without `forkSession` keeps the session ID; `getSessionMessages()` then returns the truncated branch. `rewindFiles()` takes the prompt's own UUID (the one sent in `SDKUserMessage.uuid`, echoed with `isReplay`); an assistant UUID has no checkpoint.
