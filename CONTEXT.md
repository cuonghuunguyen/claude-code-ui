# Claude Code Web UI

A browser UI that drives Claude Agent SDK sessions running in a local daemon. Full spec: `docs/spec.md`.

## Language

**Daemon**:
The local process that owns all sessions, runs the SDK, and serves browsers over WebSocket. Single source of truth.
_Avoid_: server, backend

**Hub**:
The Daemon the browser connects to. It routes each request to itself or to the Side that owns the session, terminal or path.
_Avoid_: main daemon, host daemon

**Side**:
A Daemon run with `--side` inside a WSL distro or a Docker container, reached by the Hub over stdio. Never the side panel.
_Avoid_: remote, node, side panel (different thing)

**Relay**:
A self-hosted server that forwards traffic between browsers and the Hubs of its users, one hostname per Hub. Session content crosses it end-to-end encrypted only.
_Avoid_: proxy, tunnel service, gateway

**Client command**:
A `claude-ui <command>` (status, open, sessions, projects, workers) that asks the running Daemon from a terminal and exits. It never starts a Daemon and never creates the token. It finds the Daemon through `daemon.json` in the config dir.
_Avoid_: CLI session, remote control

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

**Nested repository**:
A git repository below a project's folder that is not the project's own repository: a submodule (listed in its parent's `.gitmodules` and checked out) or an independent repository with its own `.git`. Found as VS Code finds them (Settings › Git); shown in the repository selector and the file tree marks. Not a Project, not a Worktree.
_Avoid_: subrepo, child repo, workspace repo

**Selected repository**:
The one repository of a project that the Changes and Git graph panes show, picked in the repository selector (a tree: own repository > submodules > nested repositories); remembered per project in the browser. Default: the project's own repository.
_Avoid_: active repository, current repo

**Branch source**:
Where a new worktree's branch comes from: a Ticket (new branch named from it), an existing Branch (local or remote, checked out as is) or a free Name (new branch). The three tabs of the Create worktree modal.
_Avoid_: worktree type, origin

**Ticket**:
A Jira work item a new worktree's branch is named from.
_Avoid_: issue, work item, story

**Created branch**:
A branch claude-ui created for a new worktree, marked `branch.<name>.claudeUiCreated = true` in git config (ADR 0005). Deleting the worktree deletes it; any other branch stays unless the user asks.
_Avoid_: owned branch, temp branch

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

**Queued message**:
A message or bash mode command held by the daemon and sent (run) when the session is next idle.
_Avoid_: followup, pending prompt

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
A session that started a worker; a worker that starts a worker is also a coordinator. While orchestration is on in Settings, every session gets the daemon's `worker_*` tools to start and drive worker sessions. **Root coordinator**: a coordinator that is not a worker.
_Avoid_: orchestrator, manager, parent session

**Worker**:
A session a coordinator started with `worker_start`, linked to it by name in `sessions.json`. A normal session in every other way. May start workers of its own (**Worker tree**).
_Avoid_: child session, subagent (different thing: a subagent run lives inside one session)

**Agent type**:
A named role (system prompt, model, tool limits) a session runs as: a project, user or plugin agent; plugin agents are `plugin:agent`. `worker_start {agent}` starts a worker as one.
_Avoid_: persona, role session. Not a Subagent run.

**Worker tree**:
A root coordinator, its workers, their workers, linked by `coordinatorId`; depth = hops to the root coordinator. Limited by Settings Maximum tree depth and Maximum workers per coordinator.
_Avoid_: hierarchy, manager chain

**Aside**:
A Session forked from an owner session with `/btw` (or palette Ask aside), shown in a floating popup over the owner. Read-only by default (no Edit, Write, NotebookEdit until the user changes its permission mode) and without the orchestration tools. Linked to its owner by `ownerId` in `sessions.json`; never listed; thrown away when the popup closes, unless kept with Keep as session (then an ordinary Session). Forked at the owner's last complete main-thread message, so it works while the owner's turn runs.
_Avoid_: side question (Claude Code's tool-less `/btw`), side chat, branch, fork session. Not a Subagent run, not a Worker.

**Escalation**:
A coordinator hands a worker's pending question or permission request to the user (`worker_escalate`); only the user answers it then. The coordinator can still stop or close the worker, which cancels it.

**Focus**:
The app-level page (sidebar row, pinned tab, `#focus`) that lists every pending permission request and question, and every session that needs a look (error, usage limit, quiet, finished unread), across all projects; answers requests in place.
_Avoid_: inbox, queue page

**Side panel**:
The dock area on the right or left of the session view; its tabs are panes (Changes, Files, Git graph, Plan, Terminal).
_Avoid_: sidebar (the project and session list), side (a Side is a Daemon)

**Pane**:
Something of one session that the user can show and place: a kind, an owner session. Plan, Files and Git graph can also be main-area tabs (`plan:<session>`, `files:<session>`, `graph:<session>`).
_Avoid_: view, panel (a panel is a dock area), widget, document

**Owner session**:
The session a pane belongs to; a session pane owns itself. It is fixed. Closing the owner's tab does not close its other panes.

**Kind home**:
Where a pane kind shows in this browser: side panel, bottom panel or main area (`claude-ui.layout`). Files, Git graph and Plan can be main; Changes never.

**Pane identity**:
What "already open" compares: the owner's folder for Files and Git graph (one tab per project folder), the owner session for Plan.
_Avoid_: instance

**Main area**:
The tab strip and the area under it (one tab, or two splits).

**Current session**:
The owner of the active main tab. The dock areas, Changes, Files, Terminal and the commands follow it; the New session tab and Focus keep the rule they had.

**Item**:
A single file or artifact shown as its own tab ("Open in tab"). Not in this slice.

**Files tab**:
The pane with the file tree and the editor tabs (side panel by default, or a main-area tab "Files · <project>").
_Avoid_: explorer

**Changes tab**:
The side-panel pane that reviews the session's file changes as diffs.
_Avoid_: review panel

**File dialog**:
The large modal that shows the Files tab (tree, tabs, editor) over the same editor state. Pop out opens it; Read cards and file references in the timeline open it at a line. Not the popup viewer (the dialog for a diff, a plan or the Changes view).
_Avoid_: popup viewer, file popup

**Split view**:
The session area showing a session and one more pane (another session, or one of its panes) at once, side by side or stacked; each region is a **split**. One split is active and shows the active tab (the current session for the side panel, terminal and commands). Not a tab group (the project chip). A plan tab is never in a split yet.
_Avoid_: group, editor group

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
