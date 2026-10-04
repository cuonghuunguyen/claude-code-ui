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

- The daemon generates a UUID at `session.create` and passes it as `Options.sessionId`, so the ID is known before the first prompt. The session's CLI starts on its first prompt; before that a throwaway query lists its commands and skills.
- A live session is one long-lived `query()` in streaming input mode (required for `canUseTool`, `interrupt()`, images, `setModel()`). After a daemon restart, a session is resumed by a new `query({resume})` with the same ID.
- `settingSources: ['user', 'project']`, so CLAUDE.md, commands, skills and permission rules load like in Claude Code.
- States: `idle`, `running`, `needs_input` (permission request or question pending), `error`, `closed`.
- Session list = `listSessions()` filtered to cwds inside the allowlisted roots. Includes sessions started in the terminal CLI; they can be resumed. One scan at a time; the last result is reused while no transcript file changed (each `listSessions()` call grows the daemon RSS by ~3-4 MB natively, SDK 0.3.285). The web app re-lists on a live `session_state` change, not on replayed ones.
- No protection when the terminal CLI and the daemon drive the same session at once (same as OpenCode).

### Projects

- The project list = only the projects the user added: "Open project" (`project.open`), a session created in the web app (`session.create`), or a link or notification click to a session of a project that is not added (`session.subscribe {addProject: true}` adds its project; a plain resubscribe after a reconnect never does, so a removed project stays removed). Transcript-only cwds (projects used only with the terminal CLI) are not listed. Newest activity first. `session.list` returns them (`projects`) with the sessions of those projects only, so the sidebar, search and the palette's "switch session" cover added projects only. A fresh install lists none: the sidebar shows an empty state with an "Add project" action.
- `session.list` also returns `recentProjects` (`{cwd, sessionCount, lastActivity}`, newest first): cwds inside the roots with transcripts that are not added. The Open project dialog shows the first 5 above the folder browser ("Recent projects", a click or ArrowDown + Enter adds one). They are hidden while a path segment is typed, so the folder type-ahead (Tab, Enter) works on folders only.
- Added projects are kept in `projects.json` in the daemon config dir, so an added project with no sessions survives a restart. Session data stays in the transcripts (ADR 0001). Upgrade: the first `session.list` with no `seeded` mark in `projects.json` adds the cwds of sessions that have saved claude-ui settings (`sessions.json`), besides the projects already opened; transcript-only cwds stay recent. Known gap: `sessions.json` gets an entry only when a session's model, mode or effort changes, so a project known only through web-created sessions that always kept the defaults (and was never opened with "Open project") is not seeded and shows as a recent project after the upgrade; the transcript has no claude-ui marker to widen the rule with. A project removed under the old rule stays removed.
- Removing a project hides it and its sessions from the list; files and transcripts stay. It is a recent project again, and a session newer than the removal does not bring it back.

### Event log and sequence numbers

- Every event has a per-session, monotonically increasing `seq`. The log is in memory only.
- History before the daemon started is rebuilt from `getSessionMessages()` through the adapter, followed by every subagent run transcript (`listSubagents()` / `getSubagentMessages()`, `<session>/subagents/agent-<agentId>.jsonl`; each message names the Agent call that started its run in `parent_tool_use_id`), so restored and terminal CLI sessions have full subagent timelines. A run's prompt is no checkpoint. The live query resumes on the same adapter, so a later task notification finds a restored run. A run or call still running at the end of the restore (no `<task-notification>` or `tool_result`: its CLI exited mid-run) ends `stopped`, a run at its last transcript message: no query runs it.
- Each daemon start has a `logEpoch`. `session.subscribe {sessionId, sinceSeq, logEpoch}`: same epoch → replay after `sinceSeq`; different epoch → client clears its store and gets a full replay. The reply carries the current `SessionInfo` and its `seq`: replayed model/mode/effort changes up to that `seq` are older and do not override it.
- Clients drop events with `seq` ≤ the last applied one.
- State changes, permission requests, questions and their settlement are all logged events, so replay alone restores the full view.

### Wire protocol (WebSocket, JSON)

| Direction | Message | Purpose |
| --- | --- | --- |
| client → daemon | `session.create {cwd, model?}` | Start a new session |
| client → daemon | `session.subscribe {sessionId, sinceSeq, logEpoch, addProject?}` | Replay and follow; `addProject: true` (link, notification) also adds the session's project |
| client → daemon | `session.prompt {sessionId, text, images?}` | Send a user message; while a turn runs it steers the turn |
| client → daemon | `session.interrupt {sessionId}` | Stop the running turn |
| client → daemon | `session.stopSubagent {sessionId, subagentId}` | Stop agent: stop one running subagent run (`subagentId` = its subagent part id); the turn goes on. `unknown_subagent` when that run is not running in the live query |
| client → daemon | `session.setModel {sessionId, model}` | Switch model (`setModel()`) |
| client → daemon | `session.setPermissionMode {sessionId, mode}` | `default`, `acceptEdits`, `plan`, `bypassPermissions` (`setPermissionMode()`) |
| client → daemon | `session.setEffort {sessionId, effort}` | Thinking effort or `default` (`applyFlagSettings({effortLevel})`) |
| client → daemon | `fs.upload {name, data}` | Attach a file that is not a png, jpeg, gif or webp image (svg, bmp, heic, text, ...): stored in a temp folder (one per daemon, an additional directory of every session, so Claude reads it without a permission request), reply `{path}` for an `@path` mention |
| client → daemon | `session.rewind {sessionId, userMessageId, mode}` | `mode`: `code`, `conversation`, `both` |
| client → daemon | `session.rewindPreview {sessionId, userMessageId}` | `rewindFiles` dry run: `filesChanged[]`, `insertions`, `deletions`, `conversation` |
| client → daemon | `permission.respond {requestId, decision, ruleIndex?, updatedInput?, message?}` | Answer a permission request |
| client → daemon | `question.respond {requestId, answers}` | Answer a question |
| client → daemon | `session.list` / `session.close` / `models.list` | Lists and management; `session.list` also returns the added projects, `recentProjects` and `permissionModes` (the modes a new session may start in: `auto` only when the default model has `supportsAutoMode`; bypass only when enabled) |
| client → daemon | `project.open {cwd}` / `project.remove {cwd}` | Add a directory inside the roots to the added projects / remove one from the list |
| client → daemon | `session.rename {sessionId, title}` | SDK custom title (`renameSession()`); the terminal CLI shows it too |
| client → daemon | `session.archive {sessionId, archived}` | SDK session tag `archived` (`tagSession()`); hidden from the list unless the archived filter is on; the SDK keeps one tag per session, so archive replaces a CLI `/tag` and unarchive clears it |
| client → daemon | `session.delete {sessionId}` | Removes the transcript (`deleteSession()`) after the CLI exited; refused while `running` or `needs_input` |
| client → daemon | `fs.list` / `fs.read` / `fs.write` / `fs.search` | File tree, editor, @-mention autocomplete |
| client → daemon | `git.status {cwd}` | Status bar: branch (short hash when detached) and lines added/removed in tracked files against HEAD; `status` null outside a git work tree |
| client → daemon | `fs.watch {paths}` | Replace this connection's watched files (stat polling, 1 s) |
| client → daemon | `terminal.create {cwd, cols, rows}` / `terminal.list {cwd}` | Start `$SHELL` in a PTY (node-pty) in a cwd inside the roots ("Terminal N", smallest free N per cwd); at most 8 running per creating connection and 32 per daemon (`too_many_terminals`); cols/rows 1–1000 / the terminals running in a cwd |
| client → daemon | `terminal.attach` / `terminal.detach` / `terminal.input {data}` / `terminal.resize {cols, rows}` / `terminal.close` `{terminalId}` | Attach replies the scrollback (last 256K chars, cut at a line break or before an ESC so no escape sequence is split), then streams output to this connection; while a connection has more than 1 MiB unsent the shell is paused (resumed below 128 KiB); `data` at most 64 KiB UTF-8 (`too_large`; the panel sends a bigger paste in parts); at most 1 MiB of input waits for the shell to read it (`input_backlog`, shown in the panel until input is taken again); input still waiting when the terminal closes is dropped; a terminal whose PTY master closed (also while its shell process lives on) is `unknown_terminal` and gets no write or resize: the daemon writes input itself with `writeSync` and checks first that node-pty's read stream on the master is not destroyed (it is the only closer of the fd, and `destroyed` is set in the same synchronous call that closes it, so no later fd can take the number between check and write; an fstat inode check cannot tell PTY masters apart, all are /dev/ptmx); close kills the shell |
| client → daemon | `push.key` | The daemon's VAPID public key, for `PushManager.subscribe()` |
| client → daemon | `push.subscribe {subscription}` | Register a Web Push subscription |
| client → daemon | `push.focus {sessionId?}` | The session this tab shows while focused and visible; none otherwise |
| daemon → client | `event {sessionId, seq, part}` | One normalized part |
| daemon → client | `error {code, message}` | Protocol or session error |
| daemon → client | `fs.changed {path, mtime}` | A watched file changed on disk; not a session event |
| daemon → client | `sessions.changed {deleted?}` | To every connection after a rename, archive, delete, project open or project remove: refetch the list |
| daemon → client | `plan_usage {usage}` | Plan usage (account-wide, not a session event): on connect and on each change; `usage` null without plan limits |
| daemon → client | `terminal.output {terminalId, data}` / `terminal.exit {terminalId, exitCode}` | Output of an attached terminal / its shell ended (the terminal is gone) |

### Permission bridge (same behavior as Claude Code)

1. The SDK calls `canUseTool(tool, input, {suggestions})`. Rules already saved (Claude Code rules in `.claude/settings*.json`) never reach the callback.
2. The daemon logs a `permission_request` part with the SDK's suggested rules and sets state `needs_input`.
3. Options shown (OpenCode dock): **Allow once** / **Allow always** (only with SDK suggestions; the dock lists the rule patterns) / **Deny**, with a feedback field that tells Claude what to do differently. Rules are chosen by the SDK, not the user. Bash rules are saved to `.claude/settings.local.json` (via `updatedPermissions`), Edit rules last for the session, as in Claude Code.
4. Edit/Write requests show a diff; the user may change the proposed content before accepting (`updatedInput`).
5. The first answer settles the request; a settlement event tells every client. Later answers are ignored.
6. No timeout: a request waits until someone answers.
7. Interrupt denies pending requests.

### Questions

`AskUserQuestion` arrives through `canUseTool`. The daemon logs a `question` part; the UI shows a question panel in place of the prompt box, with an "Other" free-text choice. The answer returns through `updatedInput`. Counts as `needs_input`.

### Steering and interrupt

- A message sent while a turn runs is pushed into the query immediately (steering); Claude Code injects it after the current tool calls. The SDK does the same (verified, see "Open items"). Its `isReplay` echo marks when the CLI took it; a message taken after the turn ended runs as its own turn, so the echo sets `running` again.
- `session.stopSubagent`: `stopTask()` with the `task_id` of the run's `system/task_started` (matched by `tool_use_id`, dropped at its `task_notification`); the CLI then sends `task_notification` `stopped` and the Agent call's error result.
- `session.interrupt` denies pending requests (like No without feedback), then calls `interrupt()`; a no-op while `idle`. Stop button and Esc in the web app. The CLI then sends the user text `[Request interrupted by user]` (or `... for tool use]`), logged as `turn_interrupted`, and a `result` with `terminal_reason` `aborted_streaming` / `aborted_tools`, which logs no `turn_result` and returns the session to `idle`. The query stays live.

### Commands, skills, models

- Commands and skills come from `supportedCommands()` and are refreshed on `system/commands_changed`. The daemon logs them as a `commands` part (fixed id, replaced on each change), so every tab gets the push and replay restores it; there is no `commands.list` request. Terminal-only commands (`terminal_slash_commands`) are hidden. That list arrives only with `system/init`, after the first prompt; until then a built-in fallback set is hidden. Rows sharing a name collapse to the builtin one.
- A restored session has no query before its first prompt, so its picker is empty until then.
- Invoked by sending `/name args` as prompt text.
- Models from `supportedModels()`; switch with `setModel()` mid-session.
- Permission modes (SDK `PermissionMode`): `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. `SessionInfo.permissionModes` lists those a session can switch to: `auto` only when the session's model has `supportsAutoMode` (the daemon reads the cached `supportedModels()` list), bypass only when enabled. When `setModel()` gives a session in `auto` a model without auto support, the daemon sets mode `default` (`session_permission_mode` part); a saved `auto` on such a model restores as `default`. `session.list` waits at most 2 s for the model list; without it, new sessions are offered no `auto`. `dontAsk` denies every tool call not allowed by a rule: the CLI sends `permission_denied`, shown as a denied tool card, and no `permission_request` exists, so no needs-input push. `auto` escalations arrive as normal permission requests.
- Permission mode and effort: start options of the query; while it runs `setPermissionMode()` / `applyFlagSettings({effortLevel})`, applied from the next turn. The CLI changes the mode itself too (plan approved, "all edits this session"); `system/init` and `system/status` carry it, and the daemon logs every change as a `session_permission_mode` part. Effort changes log `session_effort`. The daemon saves each session's model, mode and effort in `sessions.json` in its config dir (written to a temp file, then renamed; at most 1000 entries, least recently changed dropped first; `session.delete` and a list that finds no transcript for a non-live session remove the entry); a session restored after a restart shows and resumes with them (a mode not enabled now falls back to `default`). Without an entry, mode and effort come from the raw transcript: `permissionMode` of the last prompt, `effort` of the last main-thread reply.
- Context usage: `getContextUsage({detail: "summary"})` (no token-count requests) after each `result`, each `system/compact_boundary`, each model switch and each conversation rewind (a throwaway resumed at the fork point), logged as a `context_usage` part (fixed id). A restored session asks a throwaway query resumed on its transcript without a prompt and with `persistSession: false` (the transcript file, mtime included, stays unchanged), closed after the answer. Throwaway queries run one at a time daemon-wide; a queued one is dropped when the session starts its real query first. A throwaway runs with `settings: {disableAllHooks: true}` (viewing a session fires no SessionStart hook) and is closed after 30 s without an answer (failure logged, meter keeps its last value).
- Plan usage (Claude Code `/usage`): `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors: true})`, called only in `plan-usage.ts`, on the session's query after each `result` and each `rate_limit_event` (its `status` shows at once: `allowed_warning` near a limit, `rejected` = limit hit; it ends at its reset time, one without a reset time on the next read). At the earliest reset time (status or window) the daemon reads again, also while idle (a reset beyond the 24.8-day timer limit waits in clamped steps). A `rejected` status names its window from `rateLimitType` (`statusLimit`). Windows are the server's usage rows (kind, percent, reset time, severity). A connection gets the last value; a read older than 5 min is refreshed by a throwaway query in the same one-at-a-time queue as the context usage ones (one pending read shared by a connect burst). Percent rounded. `rate_limits_available` false (API key, Bedrock, Vertex): `usage` null, meter hidden. `rate_limits` null while available (fetch failed): last value kept. Titlebar meter: headline window ring + percent (in a warning or limit state the worst window, named in the label); warning icon at 80% or a non-normal server severity, limit at 100% or `rejected`; click lists every window with percent and reset time.
- `ExitPlanMode` arrives through `canUseTool` without suggestions; the daemon adds `setMode acceptEdits` so the panel offers Claude Code's "Yes, and auto-accept edits" next to "Yes, manually approve edits" and "No, keep planning". Each "Yes" sends its mode as `setMode` (auto-accept → `acceptEdits`, manually approve → `default`); without it the CLI restores the mode active before plan mode.

### Checkpoints and rewind (same modes as Claude Code `/rewind`)

- `enableFileCheckpointing: true` and `extraArgs: {'replay-user-messages': null}`; each user message UUID is a checkpoint.
- Code: `rewindFiles(userMessageId)` (Edit/Write/NotebookEdit only, not Bash; a `dryRun` preview shows changed files).
- Conversation: the next prompt resumes with `resumeSessionAt` = UUID of the last main-thread assistant message before the rewound prompt; the original prompt is put back in the prompt box. The first prompt has no such message, so it has no conversation rewind. `resumeDropsTurn` is not passed: it refuses any discarded range longer than one turn. The fork point is in daemon memory only: a daemon restart before the next prompt restores the untruncated transcript (ADR 0001).
- A prompt or another rewind during `rewindFiles()` is rejected (`session is rewinding`).
- Both: code, then conversation. Code options appear only when the checkpoint has tracked file changes.

### Push notifications (rules copied from Orca)

- Web Push with VAPID keys generated by the daemon; payload end-to-end encrypted, full text (session title + tool/command, or last line of the answer; ~4 KB max).
- Events: `needs input` and `finished` (an error counts as finished).
- `finished` waits 1.5 s and is cancelled if work resumes. At most one push per session per 5 s.
- Suppressed when a focused, visible tab shows that session (reported by `push.focus`). A suppressed or throttled push is dropped, not deferred.
- VAPID keys (`vapid.json`) and subscriptions (`push-subscriptions.json`) live in the daemon config dir next to the token, owner-only. A subscription the push service answers 404/410 for (toggle off, expired) is dropped.
- Click opens the session and scrolls to the bottom.
- One on/off toggle in v1, per browser.
- Unread: a session is unread after it needs input or finishes until a focused, visible tab shows it. The tab follows every live session in the list for this.
- Needs HTTPS (see Security) and, on iOS, 16.4+ with the app added to the Home Screen.

## Message model

The daemon converts raw SDK messages into one normalized model; the UI renders only this model.

| Part type | Key fields | Rendered as |
| --- | --- | --- |
| `user_text` | `id`, `text`, `images[]` | User bubble, with copy and rewind actions (shown on hover or focus) |
| `assistant_text` | `id`, `text`, `streaming` | Markdown, streamed at a steady pace |
| `thinking` | `id`, `text` | Not shown; a "Thinking" row shows while the turn runs |
| `tool_call` | `toolUseId`, `tool`, `input`, `status` (pending / running / done / error / denied / stopped; stopped: a stopped background task or subagent run, or a call whose query ended without its result) | Tool card, by tool type |
| `tool_result` | `toolUseId`, `output`, `isError`, `original?` (file before the first Edit/Write of a path, live only) | Merged into its tool card; `original` feeds the changes tab |
| `permission_request` | `requestId`, `toolUseId`, `tool`, `input`, `suggestions[]`, `settled`, `decision?` | Permission panel; in the timeline its tool card is held expanded with status "Awaiting approval" |
| `question` | `requestId`, `toolUseId`, `questions[]`, `settled`, `answers?` (absent = cancelled) | Question panel |
| `todo_update` | `items[]` (content, status, activeForm) | Pinned todo list (todo dock: each item by its content, as OpenCode; collapsed state kept per browser) |
| `subagent` | `id`, `description`, `status`, `startedAt`, `endedAt?`; child parts carry `parentId` = `id`; its own `parentId` = the run that started it (none = the session) | Nested, collapsible group with an Open icon; agent map node; subagent view |
| `session_state` | `state` | Header badge, list badge |
| `commands` | `commands[]` (name, description, argumentHint, aliases?) | Slash command picker; not in the timeline |
| `context_usage` | `usage` (`totalTokens`, `maxTokens`, `percentage`, `categories[]` name + tokens + SDK `kind` used/free/buffer, deferred left out) | Context meter in the prompt box toolbar, breakdown popover; not in the timeline |
| `turn_result` | `durationMs`, `costUsd` (this turn; the SDK total is cumulative, absent for the first turn after a daemon restart), `usage`, `isError` | Turn footer (live turns only) |
| `turn_interrupted` | — | Status line; replaces the turn footer |
| `raw` | original message | Generic JSON |
| `compaction` | `trigger?`, `summary?` | Divider "Conversation compacted" (OpenCode); the summary collapsed below it. Live from `system/compact_boundary`, filled by the synthetic summary message after it; a restored transcript starts at its `isCompactSummary` message |
| `rewind` | `userMessageId` | Not rendered; the client drops that user message and every part after it |

**Adapter rules**

- Streaming deltas accumulate under a stable part `id`; the UI replaces rather than appends.
- A `tool_result` updates its `tool_call` status; grouped by `toolUseId`.
- Tool rendering keyed on `tool`: `Bash`, `Edit`/`Write` (diff), `Read`, `Grep`/`Glob`, `TodoWrite`, `Task` (subagent), anything else (JSON).
- The daemon enables TodoWrite (`CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, `CLAUDE_CODE_ENABLE_TASKS=0`; off by default on current models) and `forwardSubagentText`.
- A background subagent ends with `task_notification`, not with its placeholder `tool_result`; `stopped` ends it as `stopped` (the error `tool_result` after a stop keeps it so), `failed` as `error`. When the live query ends (CLI exited), its runs and calls still running end `stopped` and the stop map is cleared. A restored one ends with the transcript's `<task-notification>` user text; a later notice of a run that resumed (task ID only) moves its `endedAt`.
- A subagent run's `startedAt` / `endedAt` (ms) are the transcript timestamps of its Agent call and of the message that ends it, live the daemon clock; the first part of a call fixes `startedAt`. Nested runs (spawn depth up to 3, SDK default) nest by the same `parentId` rule.
- The same adapter converts live SDK messages and `getSessionMessages()` history.
- Fixture tests recorded from real SDK sessions.

## Frontend

React + AI Elements (shadcn look), layout and UX from OpenCode's new web UI.

### Layout

- Theme: OpenCode oc-2 tokens, light and dark (follows the OS, or forced from the titlebar toggle); text/background token pairs reach WCAG 4.5:1.

- Titlebar tabs: each open session is a tab (project avatar, title, close; running / needs-input / unread indicator), plus one "New session" tab opened by `+`: the session prompt box (same toolbar: attach, permission mode, model, effort) and a project chip (added projects, "Open project…"), starting in the active tab's project; the first prompt creates the session. Closing a tab does not stop the session. Middle click closes, drag reorders, overflow scrolls; open tabs, their order and the active tab (also "New session", URL hash `#new`) persist per browser. Arrow keys, Home and End move between tabs (one Tab stop), Delete closes and focuses the tab that becomes active. Reorder without drag: Alt+Shift+Left/Right or Ctrl+Shift+PageUp/PageDown on a focused tab, or Move left / Move right in the tab context menu (also Close tab). A Home button left of the tabs shows or hides the sidebar on wide screens. Each tab keeps its scroll position, draft prompt and side panel pane. Narrow screens: one switcher instead of the strip.
- Sidebar: one group per added project (also with no sessions; with none: "No projects yet" and an "Add project" button that opens the same dialog), with state badge and unread marker; inside a project, sessions sit under day headers as in OpenCode Home: "Today", "Yesterday", "Older" (only "Recent sessions" when nothing is from today or yesterday). Project avatar colors differ between added projects (up to 9). Clicking a session opens or focuses its tab. Each project group has "New session" (the new-session tab in that project, no picker, focus in its prompt) and "Remove" (after a "Remove project?" confirmation; files and sessions stay; its session tabs close in every client; focus moves to the next project row, else the previous one, else the prompt box or "Open project"); the "Projects" header has "Open project": a modal dialog with "Recent projects" above a folder browser inside the allowlisted roots with type-ahead (Tab and Shift+Tab stay inside it; Esc or Close gives the focus back to the opener, a pick moves it to the new-session prompt).
- Session view: timeline, prompt box at the bottom, header with project avatar, name and cwd, state, stop button. The model chooser is in the prompt box toolbar.
- Side panel (resizable): file tree + editor tabs, and a changes/diff tab: files changed by the session's Edit/Write calls with an A/D/M badge and `+N -N` (a file created and deleted again in the session is not listed; a deleted file with an unknown before has no `+N -N`), a "Filter files" field, previous/next file buttons with the position `i/N` (also ←/→ outside text fields), the list beside the diff (240px) once the panel is at least 672px wide, above it otherwise, the selected file's diff (file before the session vs disk; one header per file: badge, path relative to cwd, `+N -N`, the library's file header off; "Loading diff…" until drawn), unified/split toggle (split by default, the choice kept per browser; narrow screens always unified), "Open in editor"; the tab shows the changed file count; outside or Bash changes to a listed file show live (fs.watch). Without `original` (restored transcript) the before is the calls undone from the disk; if that is ambiguous (a replace_all Edit, an Edit's new text not found exactly once, a Write other than the first call creating the file), each call's diff is shown.
- Terminal panel (OpenCode terminal panel): below the side panel on wide screens (280px by default, resizable by dragging the handle above it or with ArrowUp/ArrowDown on it, 100px to 60% of the window high, the height kept per browser; toggled by Ctrl+` or the terminal button in the side panel header), the "terminal" pane on narrow screens. Tabs "Terminal N" with close, `+` for another; xterm.js. Terminals belong to the project (cwd), run in the daemon and survive reconnects and page reloads while the daemon runs (a daemon restart ends them); opening the panel (Ctrl+`, the terminal button, the "terminal" pane) with none running starts one; switching to another project with the panel open, or a reconnect after a daemon restart, starts none (`+` does); closing the last one hides the panel; the open state and the selected terminal are kept per browser across reloads; after a reload every terminal streams live (a terminal not selected opens its xterm when first shown); a click on a tab, the selected one too, focuses its shell; xterm.js loads with the first opened panel (code split). Copy: Ctrl+Shift+C, Cmd+C, or Ctrl+C over a selection (without one Ctrl+C goes to the shell, Ctrl+Shift+C and Cmd+C leave the clipboard as it is); paste: Ctrl+V / Cmd+V / Ctrl+Shift+V (browser paste). Input typed while disconnected is dropped.
- Narrow screens: sidebar becomes a drawer; a tab switch replaces the side panel ("session" / "changes" / "files").

### Session view UX (from OpenCode)

- A pending permission request or question replaces the prompt box (panel), and is also marked in the timeline (permission: its tool card; no separate approval row).
- Consecutive read/search tool calls merge into one "context" group: one row "Explored" ("Exploring" while running) with "N reads, N searches".
- A tool card is a borderless 32px row (44px on touch screens): tool name, muted summary, `+N -N` for edits, a status icon (label only for awaiting approval, error, denied), chevron shown on hover, keyboard focus, while open and on touch screens. For a file tool (Read, Edit, Write) the summary is the file name, then its directory relative to the session cwd; a narrow row cuts the directory from the left, then the name, the Read line range stays; the full path is the tooltip of the row. Expanded Bash: `$ command` and output as plain text in one bordered box; expanded Edit/Write: the diff with a file header (icon, path relative to cwd, `+N -N`), result text only on error. Timeline rhythm (OpenCode): 12px between rows, assistant text 24px more, 24px between turns.
- CLI text that is no user input (synthetic or meta user messages, e.g. the "no visible output" nudge) is not shown.
- Subagent runs (OpenCode child sessions): an Agents button in the prompt toolbar after the choosers, shown when the session has a subagent run, with the number of running runs. It opens the agent map popover: a tree (`role="tree"`, status and duration in each node's name) with the session as root and each run under the run that started it, live status and duration; ↑/↓/Home/End move, ←/→ go to the parent / first child, Enter or click opens (the session node: the session view) and closes the map, Esc closes it (the turn keeps running). The subagent view (URL `#<session id>/agent/<subagent part id>`, a history entry per navigation so browser Back returns; an unknown run shows the session view) shows the run's timeline, live; a top bar with Back (to the parent run, or the session), parent / description (OpenCode breadcrumb), status and duration, a Children menu when the run started runs of its own, and the Agents button; instead of the prompt box "Subagent runs cannot be prompted. Back to main session." (OpenCode) with Stop agent while the run runs (disabled "Stopping…" until the run ends; a failed stop shows its error below the button). Esc in a subagent view stops only that run, like Stop agent; Esc in the session view stops the turn. Run status labels: Running, Done, Failed, Denied, Stopped. Tree nodes carry `aria-expanded` (nodes with runs), `aria-posinset` / `aria-setsize`; truncated run names have a tooltip. A permission request or question from inside a run shows in that run's view (and those of the runs above it) and in the session view; the first answer settles it.
- Every tool card, context group and subagent group renders collapsed, live and in a restored transcript; the collapsed header still tells what happened: tool name, summary (command, path, pattern), status, and `+N -N` line counts for edits. A card whose call waits for a permission answer is held expanded. Expand state is per card and survives re-renders and regrouping.
- Streamed text is revealed at a steady pace; incomplete markdown is repaired while streaming.
- Auto-scroll only while at the bottom: on new items and while the last item grows (streaming text, a running tool card); any scroll up leaves the bottom, scrolling down to within 80px of the end returns to it; scrolled up, a scroll-to-bottom button (fades in, OpenCode "Jump to latest") returns to the newest item (instant with reduced motion). A session opens at the bottom.
- The session timeline is windowed: only the items in or near the viewport are in the DOM, whatever the session length; per-item state (expanded cards, open summaries, an open rewind panel) survives leaving the window. Palette Rewind scrolls to the message first. Accepted loss: browser find (Ctrl+F) and text selection do not reach items outside the window. The subagent view's timeline is not windowed.
- Unread count in the tab title.

### Prompt box

- Enter sends, Shift+Enter newline; while a turn runs, sending steers.
- `/` opens a command and skill picker.
- `@` opens file autocomplete (`fs.search`); the SDK expands `@path`.
- Image paste and drop.
- Selection from the editor can be sent as context.
- Toolbar inside the box (OpenCode): attach (`+`, native file picker), permission mode, model, effort (only for a model with `supportsEffort`), send / stop. Shift+Tab cycles the permission mode like Claude Code: Ask, Edit automatically, Plan mode, Auto mode (only when offered), Bypass (only when enabled); Don't ask is only chosen in the picker ("Don't ask (deny unapproved)"). The picker, status bar (`auto mode on`, `don't ask on`) and command palette list the modes the session offers; the web derives them from the session's current model, so a client that only gets the `session_model` part of another client's change follows it. After a model change that drops auto mode, a toast reads "Auto mode not available for <model>; switched to Ask" (5 s; only in the client that changed the model, other clients just show the new mode; bottom right 32px/48px, 320px wide; full width with 16px offsets at 600px and below; slides and fades in and out, no motion under reduced motion); the new-session tab does the same for its draft.
- Attached non-image files are uploaded (`fs.upload`) and sent as `@<upload path>` mentions; the user message shows each one as a file card (name, type) instead of the path (path shape `…/u-XXXXXX/<name>`).
- Plan mode with Haiku: Claude Code runs plan-mode turns of a `haiku` session on the default Sonnet ("haiku plan upgrade", like `opusplan`); the toolbar keeps showing the chosen model, the turn's transcript records the model that ran.
- Status bar under the prompt box (Claude Code status line), fields hidden without data: `Model`, `Ctx` (context tokens), git branch and `(+added,-removed)` (`git.status` on mount, at each session state change and every 5 s while visible), `In` (uncached input + cache writes) / `Out` / `Cached` (cache reads), summed over the session's `turn_result` parts, `Ctx Used` %, plan `Session` % + `Reset`, `Weekly` % + `Weekly Reset` (countdown, from `plan_usage` windows `session` / `weekly_all`), permission mode as "… on" (not in default mode), `N shell(s)` (running `Bash` calls with `run_in_background`). Tokens as k/M, percents one decimal. Ctx fields open the context breakdown, plan fields the plan usage popover, the mode its chooser, shells the list. Below `sm` only model, ctx used, session and shells stay.

### Editor

- CodeMirror 6 (touch-friendly), editable, saved through `fs.write`, restricted to allowlisted roots.
- A file changed by Claude reloads when clean; with unsaved edits the editor shows a conflict.
- "Send selection to Claude" inserts path + line range into the prompt box.
- Diffs in chat and the changes tab: `@pierre/diffs`.

### Components

| Component | Source |
| --- | --- |
| Session timeline windowing, scroll-to-bottom | `@tanstack/react-virtual`, own "Jump to latest" button; subagent view: AI Elements `conversation` |
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
- Token auth on every WebSocket connection; pairing by a printed URL or QR code containing the token. A browser cannot read the status of a rejected upgrade, so after a failed dial the web app asks `GET /auth` (`Authorization: Bearer <token>`, 204 or 401); on 401 it stops redialing and tells the user to open the pairing URL.
- Origin check on WebSocket upgrade.
- Working directory allowlist for sessions, file tree, editor writes, session list and terminals (a terminal is a remote shell: only over the authenticated, origin-checked WebSocket, cwd inside the roots). The shell gets the user's environment like a VS Code terminal (an `ANTHROPIC_API_KEY` or credentials file the user has are visible to it) minus the daemon's own settings (`PORT`, `CLAUDE_UI_*`). WebSocket frames above 64 MiB close the socket (ws `maxPayload`).
- Default permission mode asks; bypass modes off unless enabled in daemon config (`CLAUDE_UI_ALLOW_BYPASS=1`).
- Credentials: the owner's subscription login stays in the daemon's environment, never sent to the browser.
- No secrets in logs.

## Scope and build

Work is split into GitHub issues along a dependency graph, so independent pieces run in parallel worktrees (Orca).

**Core (first)**: shared package → daemon session + streaming + adapter + seq/replay → web app session view with generic tool cards → permission bridge and panel → interrupt, steering, multiple sessions, session list, directory picker → tool-specific cards → auth token, origin check, allowlist.

**Then, in parallel where possible**: model switch; commands and skills; @-mentions; images; questions; edit-before-accept; file tree and editor with send-selection; checkpoints and rewind; push notifications (needs HTTPS).

**v1 is done when**: a session keeps running with the tab closed, the phone reconnects and shows every message once, a permission request can be answered from either of two open tabs, and the phone gets a push when a session needs input.

**Deferred**: multi-user.

### Open questions

- [ ] Remote access and HTTPS without external hosting (ADR 0003).
- [x] Verify: SDK uses `claude login` credentials when no API key is set. Verified 2026-10-01 with SDK 0.3.285: with `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset, `system/init` reports `apiKeySource: "none"` (claude.ai OAuth login) and turns succeed.
- [x] Verify: mid-turn `streamInput` steers like Claude Code. Verified 2026-10-01 with SDK 0.3.285: a message pushed during a Bash call is echoed (`isReplay`) right after that call's `tool_result` and the same turn continues with it (one `result`). `interrupt()` while streaming text, while a tool runs, or while `canUseTool` waits (its signal aborts) ends the turn as described in "Steering and interrupt"; the next prompt runs normally on the same query.
- [x] Verify: which UUID `resumeSessionAt` needs for a conversation rewind. Verified 2026-10-01 with SDK 0.3.285: the UUID of the last main-thread assistant message before the rewound prompt (the prompt's own UUID keeps it; a non-chain UUID fails with `No message found`). Resume without `forkSession` keeps the session ID; `getSessionMessages()` then returns the truncated branch. `rewindFiles()` takes the prompt's own UUID (the one sent in `SDKUserMessage.uuid`, echoed with `isReplay`); an assistant UUID has no checkpoint.
