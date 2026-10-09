# Claude Code Web UI

A browser UI that drives Claude Agent SDK sessions running in a local daemon. Full spec: `docs/spec.md`.

## Language

**Daemon**:
The local process that owns all sessions, runs the SDK, and serves browsers over WebSocket. Single source of truth.
_Avoid_: server, backend

**Session**:
One SDK session in one working directory, identified by its session ID. The SDK transcript is its durable history. It may be driven by several `query()` runs over time (e.g. resumed after a daemon restart).
_Avoid_: chat, conversation, thread

**Idle close**:
The daemon ends the CLI process of an idle session no tab holds after a set time; the Session and its history stay and the next prompt resumes it.

**Project**:
A working directory the user added in claude-ui: opened with "Open project" (also by picking a recent project), the cwd of a session created in the web app, or a project reached by a link or notification click to one of its sessions (not by a reconnect or a page load). Cwds that only have terminal CLI transcripts are recent projects, not projects, until added. New sessions start in a project. Removing one hides it from the list; files and transcripts stay.
_Avoid_: workspace, folder (folder = any directory in the folder browser)

**Worktree**:
A linked git worktree of a project's repository, identified by its directory. The repository's own checkout is the main worktree. Its sessions show under the project without adding it.
_Avoid_: workspace, sandbox

**Turn**:
One user prompt and everything it causes, ending with a turn result or an interrupt. Waiting for a permission request is part of the running turn.
_Avoid_: exchange, round

**Page**:
Whole turns of a session's timeline, newest first. A session opens with its latest page; the client loads older ones on scroll up.

**Cursor**:
Where a page ends: the id of the oldest loaded turn start and its first seq. The next older page is requested with it.

**Event**:
One entry in a session's event log, carrying a `seq` and one part.
_Avoid_: message (on the wire)

**Seq**:
Per-session, monotonically increasing event number used for replay and de-duplication.

**Part**:
One unit of the normalized message model (`assistant_text`, `tool_call`, `permission_request`, ...). The UI renders only parts.
_Avoid_: block, chunk

**Adapter**:
Shared-package code that converts raw SDK messages into parts.

**Permission request**:
A pending `canUseTool` decision waiting for a browser answer; settled by the first `permission.respond`.
_Avoid_: approval, prompt (prompt = user turn text)

**Question**:
A multiple-choice question Claude asks the user mid-turn (`AskUserQuestion`); pending until answered, like a permission request.
_Avoid_: prompt, dialog

**Needs input**:
Session condition where a permission request or question is pending. Triggers a push notification.

**Permission rule**:
A saved "don't ask again" decision (e.g. `Bash(npm run test *)`), suggested by the SDK and chosen by the user in a permission request. Same rules as Claude Code, shared with it.
_Avoid_: scope, allow-list entry

**Steering**:
Sending a user message while a turn runs; it is injected into the running turn instead of waiting for the turn to end.
_Avoid_: queueing (different behavior)

**Checkpoint**:
The file state saved before a user prompt's turn edits files; one per user prompt. Covers Edit/Write changes only, not Bash.

**Rewind**:
Returning a session to a checkpoint: code only, conversation only, or both. Same modes as Claude Code's `/rewind`.
_Avoid_: undo, revert

**Tool card**:
The UI rendering of a `tool_call` merged with its `tool_result`, grouped by `toolUseId`.

**Quote**:
A `> `-prefixed passage of an earlier message, inserted into the prompt as markdown blockquote text.
_Avoid_: reply, thread

**Guided tour**:
The first-use walkthrough: a dimmed page, a spotlight on one real control and a popover with Back, Next and Skip, in two chapters (Basics, Your session). Per browser; restarted from Settings › Guide or the palette ("Show guide").
_Avoid_: onboarding, walkthrough, wizard

**Subagent run**:
One Agent/Task call: a child agent with its own timeline, inside one turn of the parent session. Stored in the parent's transcript, not as a separate session.
_Avoid_: child session, subtask

**External turn**:
A transcript entry on a session's main chain that the daemon's own `query()` did not produce in this daemon run, e.g. a terminal CLI turn. Identified by message UUID; synced into the event log as normal events.
_Avoid_: CLI turn, foreign message

**Permission mode**:
The session setting that decides what happens before a tool runs: ask (default), accept edits, plan, auto (a classifier decides), don't ask (deny anything not pre-approved by a permission rule), bypass (allow everything). Same modes as Claude Code.
_Avoid_: approval mode, auto-approve

**Coordinator**:
A session that started a worker. While orchestration is on in Settings, every session but a worker gets the daemon's `worker_*` tools to start and drive worker sessions.
_Avoid_: orchestrator, manager, parent session

**Worker**:
A session a coordinator started with `worker_start`, linked to it by name in `sessions.json`. A normal session in every other way.
_Avoid_: child session, subagent (different thing: a subagent run lives inside one session)

**Escalation**:
A coordinator hands a worker's pending question or permission request to the user (`worker_escalate`); only the user answers it then. The coordinator can still stop or close the worker, which cancels it.

**Focus**:
The app-level page (sidebar row, pinned tab, `#focus`) that lists every pending permission request and question across all projects, oldest first, and answers them in place.
_Avoid_: inbox, queue page

**In-app notification**:
A notice card in the open page about another session that needs input or finished; one per session, acted on in place (Allow once or Deny for a low-tier read) or in Focus. Per browser, on by default (Settings › Notifications).
_Avoid_: toast (the component), alert, banner

**Signal only**:
A browser-wide timeline setting (Settings > Timeline, palette, Ctrl+Alt+S; one value for every session) that folds each run of tool cards into one line ("4 tool calls · Read 3 · Grep 1"); prompts, text, errors and pending requests stay expanded.
_Avoid_: compact mode

**Permission tier**:
`low` or `high`, assigned by the daemon to a permission request (`risk-tier.ts`): a worker's for its coordinator, any session's for the Focus page (the tier at arrival, taken back if a later read says otherwise). A coordinator may settle a `low` one with `worker_permission` (allow once or deny); a `high` one is the user's. Unknown = `high`. Low covers reads in the worker folder and its repository's agent docs and main checkout, and, in a **plain repository** (nothing a worker can write decides what git runs: no hooks or programs in the cwd, no includes into it, no submodules or nested repositories), file edits in the worker folder and read-only git there.
_Avoid_: risk level, trust level

**Config scope**:
Where an MCP server (or plugin setting) is saved: local = this project, private to you (`~/.claude.json` project entry); user = all your projects; project = shared in the repo (`.mcp.json`). Claude Code's own term.
_Avoid_: permission rule scope (different thing)

**Config query**:
A query with no prompt, started in a project cwd for a config dialog when the session has no live query; held open while the dialog uses it, closed 30 s after its last request.
_Avoid_: throwaway (that one closes after one answer)

**Skill state**:
How much of a skill Claude sees: On (listed with its description, and yours to invoke), Name only (listed by name), User only (yours to invoke, Claude does not see it), Off (hidden from both). Claude Code's `skillOverrides` values `on`, `name-only`, `user-invocable-only`, `off`; set in the "Slash commands" dialog.

**Plugin**:
A Claude Code plugin, `name@marketplace`: commands, skills, agents, hooks and MCP servers in one package; installed from a marketplace and enabled per config scope (`enabledPlugins` in the user, project or local settings file).
_Avoid_: extension, add-on

**Marketplace**:
A plugin catalog known to the Claude Code CLI (a GitHub repo, git or URL source, a local directory or file, an npm package).
_Avoid_: plugin store, registry
