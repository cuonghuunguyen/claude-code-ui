// WebSocket wire protocol (docs/spec.md "Wire protocol"). JSON, one message per frame.
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, Part, PermissionMode, PlanUsage, SessionState, SlashCommand } from "./parts.ts";
import type { HistSummary } from "./histogram.ts";

export type { ModelInfo };

/** All permission modes, in picker order. Shift+Tab cycles them without dontAsk (Claude Code's order). */
export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
/** The modes offered now: auto only when the model has `supportsAutoMode`, bypass only when the daemon config enables it. */
export const permissionModesFor = ({ allowBypass, supportsAuto }: { allowBypass?: boolean; supportsAuto?: boolean }) =>
  PERMISSION_MODES.filter((m) => (m === "bypassPermissions" ? allowBypass : m === "auto" ? supportsAuto : true));
export const EFFORTS: Effort[] = ["default", "low", "medium", "high", "xhigh", "max"];
/** Prefix of the user message the daemon sends a coordinator on worker events; the web app shows it as a chip. */
export const ORCHESTRATION_NOTICE = "[claude-ui orchestration notice]";

/**
 * `model` is a `ModelInfo.value` from models.list; "default" = the SDK default model. `effort`: "default" = the model's default.
 * `permissionModes`: the modes this session can switch to (permissionModesFor: auto follows the session's model).
 */
export type SessionInfo = {
  id: string;
  cwd: string;
  state: SessionState;
  model: string;
  permissionMode: PermissionMode;
  effort: Effort;
  permissionModes: PermissionMode[];
};
/**
 * A `session.list` entry: a transcript from `listSessions()` (terminal CLI sessions too) or a session of this daemon run.
 * `archived`: hidden from the list unless the archived filter is on (SDK session tag "archived").
 * `transcript`: false until the first prompt; such a session cannot be renamed or archived (the SDK has no file to write to).
 * `coordinator`: started as coordinator; `coordinatorId` + `workerName`: a worker's link (sessions.json, survives restarts).
 * `live`: false when the session has no CLI process in this daemon (never prompted, `worker_close`, idle close, CLI ended, not loaded); absent while one runs (and from older daemons).
 */
export type SessionListItem = SessionInfo & { title: string; lastActivity: number; archived: boolean; transcript: boolean; coordinator?: true; coordinatorId?: string; workerName?: string; live?: false };
export type FsEntry = { name: string; path: string; isDir: boolean };

/**
 * Every client message carries a `reqId`; the daemon answers with a `reply` or an `error` with the same `reqId`.
 * `side`: the side (SideInfo.id) that handles it, on a daemon with sides; without it the daemon routes by session, terminal or path.
 */
export type ClientMessage = { reqId: string; side?: string } & (
  /** `coordinator`: the session gets the orchestration tools (docs/spec.md "Orchestration"); refused while orchestration is off. */
  /** `draft`: the new-session tab's upload token (fs.upload `draft`); the session gets the id, and with it the folder, of those uploads; one claim per token. */
  | { type: "session.create"; cwd: string; model?: string; draft?: string }
  /** The mode a new session in `cwd` starts in: Claude settings `permissions.defaultMode` (local > project > user), when offered; else "default". */
  | { type: "session.defaultMode"; cwd: string }
  /** Commands and skills of a project, for the new-session tab's `/` menu (no session yet); the daemon caches the list per cwd for a minute. */
  | { type: "session.commands"; cwd: string }
  /** `addProject`: an explicit open (link, notification) of a session of a project that is not added adds the project; a resubscribe must not. */
  /** `background`: follow only (unread markers); it does not keep the session's CLI from the idle close (docs/spec.md "Idle close"). */
  | { type: "session.subscribe"; sessionId: string; sinceSeq: number; logEpoch?: string; addProject?: boolean; background?: boolean; paged?: boolean; from?: string }
  /** Stops this connection's events of the session; reply `{}`. Never restores a session. */
  | { type: "session.unsubscribe"; sessionId: string }
  /** The page of whole turns before `before` (a cursor's id); `until` (part id, or API message id) extends it back to the turn holding that part. Reply `PageResult`. */
  | { type: "session.page"; sessionId: string; logEpoch: string; before: string; until?: string }
  /** Edit/Write calls (and their results) older than the cursor `before`, for the changes tab. Reply `EditsResult`. */
  | { type: "session.edits"; sessionId: string; logEpoch: string; before: string }
  /** A base64 payload a snapshot or page left out (images.ts omitMedia): `index` into the tool_result output or the user_text images. Reply `MediaResult`; error `unknown_media`. */
  | { type: "session.media"; sessionId: string; partId: string; index: number }
  /** URL of the local page an Artifact publish part of the session names (GH-175, GH-335); reply ArtifactPreviewResult. */
  | { type: "artifact.preview"; sessionId: string; partId: string }
  // images: data URLs (`data:image/png;base64,...`); png, jpeg, gif, webp.
  | { type: "session.prompt"; sessionId: string; text: string; images?: string[] }
  /** Bash mode: runs `command` with the user's shell in the session cwd (idle only); output streams as a `bash` part; Claude sees it with the next prompt. `session.interrupt` kills it. */
  | { type: "session.bash"; sessionId: string; command: string }
  | { type: "session.setModel"; sessionId: string; model: string }
  /** Applies from the next turn on (`setPermissionMode()`); the session's start option before its query runs. */
  | { type: "session.setPermissionMode"; sessionId: string; mode: PermissionMode }
  /** Applies from the next turn on (`applyFlagSettings({effortLevel})`); the `effort` start option before the query runs. */
  | { type: "session.setEffort"; sessionId: string; effort: Effort }
  /**
   * Attach button, non-image file: the daemon stores it in a folder of its own (a browser cannot tell a file's path)
   * and replies its absolute path, which the prompt gets as an `@path` mention. `data`: base64 content.
   * Stored in the folder of `sessionId`, or of the draft `draft` (64 hex chars, made by the client, secret) before the
   * session exists; one of them is required.
   */
  | { type: "fs.upload"; name: string; data: string; cwd?: string; sessionId?: string; draft?: string }
  /** Stops the running turn; a no-op while idle. */
  | { type: "session.interrupt"; sessionId: string }
  /** Drops the session's scheduled continue (auto_continue); reply `{}`, also when none was scheduled. */
  | { type: "session.cancelContinue"; sessionId: string }
  /** Queues a message: sent as a prompt when the session is next idle (docs/spec.md "Queued messages"). Reply `{ itemId }`; errors bad_prompt, bad_images, queue_full, session_not_live. */
  | { type: "session.enqueue"; sessionId: string; text: string; images?: string[] }
  /** Removes a queued message (Delete, Edit); reply `{ text, images }`; error unknown_item. */
  | { type: "session.dequeue"; sessionId: string; itemId: string }
  /** Send now: removes the item and sends it like session.prompt (steers a running turn); reply `{}`; errors unknown_item and the session.prompt codes (the item stays queued on failure). */
  | { type: "session.sendQueued"; sessionId: string; itemId: string }
  /** Stop agent: stops one running subagent run (`subagentId` = its subagent part id); the turn goes on. `unknown_subagent` when none runs. */
  | { type: "session.stopSubagent"; sessionId: string; subagentId: string }
  /**
   * First answer wins; a later one gets `{ settled: false }`. "allow_always" applies `suggestions[ruleIndex]`
   * (all suggestions when ruleIndex is omitted). `message`: feedback for Claude with "deny".
   * `updatedInput`: the full tool input to run instead (edit before accept), with "allow"/"allow_always".
   */
  | {
      type: "permission.respond";
      requestId: string;
      decision: "allow" | "allow_always" | "deny";
      ruleIndex?: number;
      message?: string;
      updatedInput?: Record<string, unknown>;
    }
  /** `answers`: question text -> answer. First answer wins, like permission.respond. */
  | { type: "question.respond"; requestId: string; answers: Record<string, string> }
  | { type: "models.list" }
  | { type: "session.list" }
  /** Every session ID this daemon has (live, or a transcript inside its roots), added project or not; the hub's lookup of an unlisted ID (GH-328), which names no ID. Reply SessionIdsResult. */
  | { type: "session.ids" }
  /** Adds a directory inside the roots to the known projects (kept across daemon restarts). */
  | { type: "project.open"; cwd: string }
  /** Removes a project from the list; files and transcripts stay. */
  | { type: "project.remove"; cwd: string }
  /** Reply `{settings}` (docs/spec.md "Settings"). */
  | { type: "settings.get" }
  /** Sets only the fields in `patch`; reply `{settings}`, error `bad_settings` for an invalid value. Broadcasts `settings_changed`. */
  | { type: "settings.set"; patch: SettingsPatch }
  /** Saves (string) or clears (null) the Jira token in secrets.json; write-only. Reply SettingsResult; broadcasts `settings_changed`. Error `bad_settings`. */
  | { type: "jira.token"; token: string | null }
  /** Test connection with the saved Jira settings and token. Reply `{user}` (display name); errors jira_not_configured, jira_auth, jira_unreachable, jira_failed. */
  | { type: "jira.test" }
  /** Ticket tab: no `text` = my open tickets (20); a key or ticket URL = that ticket; other text = summary search. Reply JiraSearchResult; errors as `jira.test`. */
  | { type: "jira.search"; text?: string }
  /** Performance data of this daemon (docs/spec.md "Performance monitor"); reply PerfReport. */
  | { type: "perf.report" }
  /** Empties the performance store; reply {}. */
  | { type: "perf.clear" }
  /** Sets the SDK custom title (the terminal CLI shows it too). Needs a transcript: a session with no prompt yet has none. */
  | { type: "session.rename"; sessionId: string; title: string }
  | { type: "session.archive"; sessionId: string; archived: boolean }
  /** Removes the transcript. Refused while a turn runs or input is pending: stop it first. */
  | { type: "session.delete"; sessionId: string }
  /** Web app Close worker (docs/spec.md "Orchestration"): as `worker_close` for the worker's own coordinator. Reply `{}`; errors not_worker, unknown_worker, unknown_session, held_elsewhere, stop_timeout. */
  | { type: "worker.close"; sessionId: string }
  /** Web app Remove worker: as `worker_remove` (session and transcript deleted, link dropped, worktree kept). Reply `{}`; errors not_worker, unknown_worker, held_elsewhere, session_running, delete_failed. Broadcasts `sessions.changed`. */
  | { type: "worker.remove"; sessionId: string }
  /** Without `path`: the allowlisted roots (of `side`). */
  | { type: "fs.list"; path?: string }
  /**
   * Starts a side (WSL distro, Docker container); replies when it is ready, `side_failed` with the next step for the user otherwise.
   * `setup`: `never` runs only a build that is installed (none: `side_failed`, the side stays `off`), `needed` (default) installs it
   * first when this build is not installed, `force` installs it again.
   */
  | { type: "side.start"; side: string; setup?: SideSetup }
  /** Read-only look at a side (nothing is installed or started; the hub answers it, a side never sees it): reply `SideCheck`, error `unknown_side`. */
  | { type: "side.check"; side: string }
  | { type: "session.rewindPreview"; sessionId: string; userMessageId: string }
  | { type: "session.rewind"; sessionId: string; userMessageId: string; mode: RewindMode }
  /** @-mention autocomplete: fuzzy matches under `cwd` (a session's cwd, inside the roots). */
  | { type: "fs.search"; cwd: string; query: string }
  /** Content search (docs/spec.md "Wire protocol"): streams `sessions.search.result`, then the reply SessionsSearchResult. A new search on the connection cancels the running one; a query under MIN_SEARCH_CHARS only cancels. */
  | { type: "sessions.search"; query: string; cwd?: string }
  /** Liveness probe: answered with `{}` by the daemon itself (never routed to a side). The page sends it after waking to find a zombie socket. */
  | { type: "ping" }
  /** The daemon's VAPID public key, for `PushManager.subscribe()`. */
  | { type: "push.key" }
  | { type: "push.subscribe"; subscription: WebPushSubscription }
  /**
   * The session this tab shows while focused and visible (none otherwise); pushes for it are suppressed.
   * `covered` (GH-158): the sessions this page shows in-app notification cards for (in-app on, page focused and visible); no push or desktop notification for them either. Absent otherwise; an empty array is a page with in-app on and no listed session.
   */
  | { type: "push.focus"; sessionId?: string; covered?: string[] }
  /** Text files only; `mtime` (ms) identifies the disk version. */
  | { type: "fs.read"; path: string }
  /** Image, SVG, video or audio file (extension allowlist): a URL that serves its bytes to this connection (docs/spec.md "Security"). */
  /** Image, SVG, video or audio file (extension allowlist): a URL that serves its bytes to this connection (docs/spec.md "Security"). With `hash` (and `cwd`): the file at that commit, `path` relative to the repository top as in git.fileAt, at most 32 MiB. A side's file or commit is served by the hub (bytes read with media.read). */
  | { type: "fs.media"; path: string; cwd?: string; hash?: string }
  /** Bytes of a media file, or of the file at a commit (`cwd` + `hash`, as fs.media): `length` at most 1 MiB, 0 for only size, mtime and type. The hub reads a side's media with it for GET /media. Reply MediaReadResult. */
  | { type: "media.read"; path: string; cwd?: string; hash?: string; offset: number; length: number }
  /** Overwrites an existing file. Fails with `conflict` when `baseMtime` is given and the disk version differs. */
  | { type: "fs.write"; path: string; content: string; baseMtime?: number }
  /** New empty file, or folder with `dir` (one level: the parent must exist). Fails `exists`, `bad_name`, `path_not_allowed`. Reply FsPathResult. */
  | { type: "fs.create"; path: string; dir?: boolean }
  /** New name in the same folder (`name`: one path segment). A link is renamed, never followed. Fails `exists`, `bad_name`, `not_found`, `root_protected`, `in_use`. Reply FsPathResult. */
  | { type: "fs.rename"; path: string; name: string }
  /** Deletes for good (no trash): a file, a link (never its target) or a folder with everything in it. `dryRun`: only counts. Fails `not_found`, `root_protected`, `in_use`. Reply FsDeleteResult. */
  | { type: "fs.delete"; path: string; dryRun?: boolean }
  /** Copy of a file next to it, named "<name> copy<.ext>", "<name> copy 2<.ext>", ... Files only (`not_a_file`), at most 512 MiB (`too_large`). Reply FsPathResult. */
  | { type: "fs.duplicate"; path: string }
  /** Replaces this connection's watched files; each change on disk sends `fs.changed`. */
  | { type: "fs.watch"; paths: string[] }
  /** Starts the user's shell in a PTY in `cwd` (inside the roots). It runs until closed or its shell exits, across reconnects. */
  | { type: "terminal.create"; cwd: string; cols: number; rows: number }
  /** The terminals running in `cwd`, oldest first. */
  | { type: "terminal.list"; cwd: string }
  /** Replies the scrollback, then streams `terminal.output` to this connection. Attaching again is a no-op for the stream. */
  | { type: "terminal.attach"; terminalId: string }
  /** Stops streaming that terminal to this connection; it keeps running. */
  | { type: "terminal.detach"; terminalId: string }
  | { type: "terminal.input"; terminalId: string; data: string }
  | { type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  /** Kills the shell. */
  | { type: "terminal.close"; terminalId: string }
  /** Status bar: branch and diff size of `cwd` (a session's cwd, inside the roots). */
  | { type: "git.status"; cwd: string }
  /** The refs stamp of `cwd`'s repository (as `GitStatus.refs`), from file stats only (no git process, never waits for a graph read). Reply GitRefsResult. */
  | { type: "git.refs"; cwd: string }
  /** Commit graph page (docs/spec.md "Layout"): `skip` commits already loaded; `ref` a full ref name (refs/heads/… or refs/remotes/…) or `HEAD`, else all refs; `author`/`text` case-insensitive substrings; `fresh`: skip the daemon's page and branch caches (the Refresh button). Reply GitLogResult. */
  | { type: "git.log"; cwd: string; skip?: number; limit?: number; ref?: string; author?: string; text?: string; fresh?: boolean }
  /** Reply GitCommitResult. */
  | { type: "git.commit"; cwd: string; hash: string }
  /** File text at a commit (`path` relative to the repository top). Same limits and error codes as fs.read (too_large, binary, not_utf8), not_found when absent. Reply `{ content }`. */
  | { type: "git.fileAt"; cwd: string; hash: string; path: string }
  /** Changes tab git modes (docs/spec.md "Layout"): the working tree (staged, unstaged, untracked) against HEAD (`base: "head"`) or against the merge base of HEAD and `ref` (`base: "branch"`; full ref under refs/heads or refs/remotes; omitted: the default branch). Reply GitDiffResult. */
  | { type: "git.diff"; cwd: string; base: "head" | "branch"; ref?: string }
  /** Graph tab Fetch: `git fetch --all` in `cwd`'s repository (docs/spec.md "Layout", Graph tab). Reply GitRemoteResult; `remote` null outside a git work tree. */
  | { type: "git.fetch"; cwd: string }
  /** Branch menu data (docs/spec.md "Layout", Graph tab): where push/pull go and the exact git argv of each; `ref` a full refs/heads/ name. Reply GitBranchResult. */
  | { type: "git.branch"; cwd: string; ref: string }
  /** Push `ref` as `git.branch` showed it; `local`: the sha shown; `argv`: the git command shown in the dialog (the daemon runs it only when it computes the same, else `stale`); `lease`: force push with --force-with-lease=<remoteRef>:<lease>. Reply GitRemoteResult. */
  | { type: "git.push"; cwd: string; ref: string; local: string; argv: string[]; lease?: string }
  /** Pull `ref` (fast-forward only) as `git.branch` showed it; `local`: the sha shown; `argv`: the command shown. Reply GitRemoteResult. */
  | { type: "git.pull"; cwd: string; ref: string; local: string; argv: string[] }
  /**
   * Creates a worktree in `<repo>/.claude/worktrees/` (docs/spec.md "Worktrees"). `name` only: folder `<name>` on branch `worktree-<name>`; nothing: a generated
   * name. `branch` (GH-447, may contain `/`): a new Created branch, folder = `branch` with `/` → `-`; `base`: its start point (a commit-ish, the Base picker
   * sends a full ref), default the "Worktrees" base rule. `checkout`: an existing branch (`refs/heads/x`, or `refs/remotes/<remote>/x` as a new local
   * `x` tracking it), not marked; no name, branch or base with it. Reply WorktreeCreateResult. Broadcasts `sessions.changed`.
   */
  | { type: "worktree.create"; cwd: string; name?: string; branch?: string; base?: string; checkout?: string }
  /** Local and remote branches for the Create worktree modal (GH-447); `fetch`: `git fetch --prune origin` first. Reply WorktreeBranchesResult. */
  | { type: "worktree.branches"; cwd: string; fetch?: boolean }
  /** What removing `path` loses and whether it may be removed (docs/spec.md "Worktrees"); reply WorktreeStatusResult. */
  | { type: "worktree.status"; cwd: string; path: string }
  /**
   * `git worktree remove --force` of a linked worktree inside the roots (not main, not locked, not a symlink), then `git branch -D` for a Created branch (git config `branch.<name>.claudeUiCreated`, or legacy `worktree-*`; ADR 0005),
   * `git branch -d` for another one only with `deleteBranch`; `expectSafe`: refused with `stale` unless status is still safe; `expect`: refused with `stale` when the current status has more uncommitted files, commits ahead or ignored files than listed (checked before and after the sessions and terminals close). Transcripts stay.
   * Reply WorktreeRemoveResult. Broadcasts `sessions.changed`.
   */
  | { type: "worktree.remove"; cwd: string; path: string; expectSafe?: boolean; expect?: { uncommitted: number; ahead: number; ignored: number }; deleteBranch?: boolean }
  // MCP servers dialog (docs/spec.md "Config dialogs"): the live query of `sessionId` when it has one, else the config query of `cwd`.
  /** Reply McpListResult. */
  | { type: "mcp.list"; cwd: string; sessionId?: string }
  /** `toggleMcpServer()`: persists for new sessions of the project; reply McpListResult. */
  | { type: "mcp.toggle"; cwd: string; sessionId?: string; name: string; enabled: boolean }
  /** Reply McpListResult. */
  | { type: "mcp.reconnect"; cwd: string; sessionId?: string; name: string }
  /** Reply McpAuthResult; the CLI then waits for the OAuth redirect on its callback port. */
  | { type: "mcp.authenticate"; cwd: string; sessionId?: string; name: string }
  /** The redirect URL pasted from a browser that could not reach the CLI's callback port. */
  | { type: "mcp.oauthCallback"; cwd: string; sessionId?: string; name: string; callbackUrl: string }
  /** HTTP/SSE servers only. */
  | { type: "mcp.clearAuth"; cwd: string; sessionId?: string; name: string }
  /** `claude mcp add --scope <scope>`; running sessions do not get it. Broadcasts `config.changed`. */
  | { type: "mcp.add"; cwd: string; name: string; scope: ConfigScope; config: McpAddConfig }
  /** `claude mcp remove --scope <scope>`; running sessions keep it until restarted. Broadcasts `config.changed`. */
  | { type: "mcp.remove"; cwd: string; name: string; scope: ConfigScope }
  // "Slash commands" dialog (docs/spec.md "Config dialogs"): the live query of `sessionId` when it has one, else the config query of `cwd`.
  /** `getSkillsDialog()`; reply SkillsResult (empty when the CLI does not support it). */
  | { type: "skills.list"; cwd: string; sessionId?: string }
  /** `claude edit-skill-overrides --json`, then `reloadSkills()` and a poll until the row shows `state`; reply SkillsSetStateResult. Broadcasts `config.changed`. */
  | { type: "skills.setState"; cwd: string; sessionId?: string; name: string; state: SkillState; handles?: SkillHandles }
  // Manage Plugins dialog (docs/spec.md "Config dialogs: plugins"): `claude plugin …` in `cwd`; each write then reloads plugins in
  // every live query and broadcasts `config.changed` (kind plugins).
  /** Reply PluginsListResult. */
  | { type: "plugins.list"; cwd: string }
  /** Reply PluginWriteResult. */
  | { type: "plugins.install"; cwd: string; pluginId: string; scope: ConfigScope }
  /** `scope`: the installed row's (the CLI uninstalls from user scope otherwise). */
  | { type: "plugins.uninstall"; cwd: string; pluginId: string; scope?: PluginScope }
  | { type: "plugins.setEnabled"; cwd: string; pluginId: string; enabled: boolean }
  /** Reply PluginUpdateResult. */
  | { type: "plugins.update"; cwd: string; pluginId: string; scope: PluginScope }
  /** `reloadPlugins()` in every live query; reply ReloadResult. */
  | { type: "plugins.reload"; cwd: string }
  /** Closes the session's live query; its next prompt resumes the transcript in a new CLI. */
  | { type: "plugins.restart"; cwd: string; sessionId: string }
  /** Reply MarketplacesResult. */
  | { type: "marketplace.list"; cwd: string }
  /** `source`: GitHub repo, URL or path. Reply `{}`. */
  | { type: "marketplace.add"; cwd: string; source: string }
  /** Uninstalls its plugins too. Reply PluginWriteResult. */
  | { type: "marketplace.remove"; cwd: string; name: string }
  /** Refreshes its catalog. Reply `{}`. */
  | { type: "marketplace.update"; cwd: string; name: string }
  // Updates (docs/spec.md "Updates").
  /** Installs the available version into the daemon's versions dir; reply UpdateInstallResult. The daemon keeps running. */
  | { type: "update.install" }
  /** Restarts into the installed version once every session is idle (`now`: at once); reply UpdateRestartResult. */
  | { type: "update.restart"; now?: boolean }
);

/** `PushSubscription.toJSON()`. */
export type WebPushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushKeyResult = { publicKey: string };
/** Decrypted Web Push payload the service worker shows as a notification. */
export type PushPayload = {
  sessionId: string;
  title: string;
  body: string;
  /** Notification tag; absent: the session ID. A newer notification with the same tag replaces the older one. */
  tag?: string;
  /** No sound or vibration. */
  silent?: boolean;
  /** Only replaces an earlier notification (a request that settled); the desktop fallback shows nothing for it. */
  replace?: boolean;
};

/** Claude Code `/rewind` modes: `both` restores code, then conversation. */
export type RewindMode = "code" | "conversation" | "both";

/**
 * `pos`: set when the event updates a timeline part that already exists; the seq of that part's first event (its position in the
 * session's order). A paged client uses it to tell updates of parts in a page it has not loaded from the ones it holds.
 */
export type Event = { type: "event"; sessionId: string; seq: number; pos?: number; part: Part };

/** Paging constants (docs/spec.md "Event log and sequence numbers"): a page holds whole turns, at least PAGE_TURNS of them or PAGE_PARTS parts. */
export const PAGE_TURNS = 10;
export const PAGE_PARTS = 400;
/** A snapshot `from` a turn (after a daemon restart) is capped at this many parts; over it the last page is sent. */
export const MAX_FROM_PARTS = 3000;

/** Where a page ends: `before` = id of the oldest loaded turn start (a top-level user_text), `pos` = its first seq in this daemon run. */
export type Cursor = { before: string; pos: number };
export type PosPart = { part: Part; pos: number };
/** Whole turns, oldest part first (parts as `omitMedia` leaves them); `older` absent = the start of the session. */
export type TimelinePage = { parts: Part[]; older?: Cursor };
/**
 * Paged subscribe reply: `heads` = the latest session_state, commands, context_usage, external_turn, auto_continue, prompt_queue, todo_update events; `aux` = parts of the
 * unloaded region that whole-session features need (subagent, turn_result, running background Bash calls).
 */
export type Snapshot = { heads: Event[]; attentionSeq: number; page: TimelinePage; aux: PosPart[] };
export type PageResult = { page: TimelinePage };
export type MediaResult = { dataUrl: string };
export type EditsResult = { parts: PosPart[] };

export type ServerMessage =
  | Event
  | { type: "reply"; reqId: string; result: unknown }
  /** A watched file changed on disk; `path` as given in `fs.watch`, `mtime` 0 when it was deleted. */
  | { type: "fs.changed"; path: string; mtime: number }
  /** Sent to every connection after a rename, archive, delete, project open or project remove, worktree create or remove: refetch `session.list`. `deleted`: drop that session. */
  | { type: "sessions.changed"; deleted?: string }
  /** One session's hits of a running `sessions.search`; `reqId` is the search request's. */
  | ({ type: "sessions.search.result"; reqId: string } & SessionSearchHits)
  /** Plan usage, not a session event: on connect and on each change. `usage` null: no plan limits (API key, Bedrock, Vertex). */
  | { type: "plan_usage"; usage: PlanUsage | null }
  /** Output of an attached terminal. */
  | { type: "terminal.output"; terminalId: string; data: string }
  /** The terminal's shell exited (or it was closed); sent to every attached connection. The terminal is gone. */
  | { type: "terminal.exit"; terminalId: string; exitCode: number }
  /** To every connection of this daemon after `settings.set`. */
  | { type: "settings_changed"; settings: Settings; jiraToken?: boolean }
  /** On connect: this daemon runs older code than is on disk (a source checkout changed after the start, or a newer install waits for a restart). `note` says which. */
  | { type: "daemon_stale"; note: string }
  /** To every connection after a config write (e.g. `mcp.add`) in `cwd`: an open dialog of that project refreshes. `reloadFailed`: set when plugins were reloaded: the sessions whose reload failed (empty: none; restart banners then clear). */
  | { type: "config.changed"; kind: ConfigKind; cwd: string; reloadFailed?: string[] }
  /** A newer claude-ui is on npm: on connect and when a check finds it. */
  | { type: "update_available"; version: string; current: string }
  /** The update under way, to every connection; after an install failure `update_available` is sent again. */
  | ({ type: "update_state" } & UpdateState)
  /** `size`: bytes of the file, on an fs.read refusal (binary, not_utf8, too_large). */
  | { type: "error"; reqId?: string; code: string; message: string; size?: number };

/**
 * `installing`: npm runs. `waiting`: the restart waits for `waitingFor` busy sessions (running turn, pending input or running
 * subagent run); "Restart now" would also end `terminals` terminals. `restarting`: the daemon exits; the browser reconnects.
 */
export type UpdateState = { phase: "installing" | "restarting" } | { phase: "waiting"; waitingFor: number; terminals: number };
export type UpdateInstallResult = { installed: string };
/** `waitingFor`: 0 when the daemon restarts at once. */
export type UpdateRestartResult = { waitingFor: number };

/** `messageId`: a prompt's transcript uuid, an answer's API message id. `snippet`: at most ~120 chars around the first match, redacted. */
export type SearchHit = { messageId: string; role: "user" | "assistant"; snippet: string };
export type SessionSearchHits = { sessionId: string; cwd: string; title: string; hits: SearchHit[] };
/** `stopped`: why the scan ended before the last transcript: cap of sessions, time or byte budget, or a newer search. */
export type SessionsSearchResult = { scannedFiles: number; scannedBytes: number; ms: number; firstMs?: number; stopped?: "sessions" | "time" | "bytes" | "canceled" };
export const MIN_SEARCH_CHARS = 2;
export const MAX_SEARCH_CHARS = 200;

export type CreateResult = { session: SessionInfo };
/**
 * `logEpoch` differs from the one the client sent: its store belongs to an earlier daemon run and the events are a full replay.
 * `seq`: the last event seq when `session` was read; the replayed events up to it are older than `session`.
 */
/** `title`: as `session.list` titles the session, for a tab opened before (or without) the list. */
export type SubscribeResult = { logEpoch: string; seq: number; session: SessionInfo; title: string; snapshot?: Snapshot };
/** session.setModel, session.setPermissionMode, session.setEffort. */
export type SetModelResult = { session: SessionInfo };
/** session.defaultMode. */
export type DefaultModeResult = { mode: PermissionMode };
/** session.commands. */
export type CommandsResult = { commands: SlashCommand[] };
export type UploadResult = { path: string };
/** fs.upload / session.create `draft`: a secret token, 32 random bytes as lowercase hex. */
export const DRAFT_TOKEN = /^[0-9a-f]{64}$/;
/** fs.upload size cap; the client checks it before reading the file. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** permission.respond and question.respond. `settled`: false when the request was already settled (or unknown) and this answer was ignored. */
export type RespondResult = { settled: boolean };
export type ModelsResult = { models: ModelInfo[] };

/**
 * WebSocket subprotocols (browsers cannot set headers on a WebSocket): the client offers
 * `[WS_PROTOCOL, TOKEN_PROTOCOL_PREFIX + token]`; the daemon answers with `WS_PROTOCOL`.
 */
export const WS_PROTOCOL = "claude-ui";
export const TOKEN_PROTOCOL_PREFIX = "token.";

/** Reply to `session.ids`. */
export type SessionIdsResult = { ids: string[] };

/**
 * `projects`: added project cwds only (project.open, a created session, a deep link), newest activity first.
 * `sessions`: only sessions of those projects and of their worktrees inside the roots.
 * `recentProjects`: cwds with sessions that are not added, newest activity first: suggestions for the Open project dialog.
 * `permissionModes`: the modes a new session can start in (permissionModesFor, for the default model).
 */
export type ListResult = {
  sessions: SessionListItem[];
  projects: string[];
  recentProjects: RecentProject[];
  permissionModes: PermissionMode[];
  /** A daemon with sides (WSL distros, Docker containers): every side, this daemon's own ("local": Windows, Linux or macOS) first. Absent: no sides. */
  sides?: SideInfo[];
  /**
   * A hub with the docker command: `ok` (a running Linux container exists), `empty` (the engine runs none) or `down` (the engine does not answer).
   * Absent: no docker command, or a daemon without this field (the Docker kind then shows only when a Docker side is listed).
   */
  docker?: DockerState;
  /** Side of each listed project, recent project and session cwd that is not local. */
  cwdSides?: Record<string, string>;
  /** Git worktrees of each listed project that is in a git repository (docs/spec.md "Projects"), the main worktree first. */
  worktrees?: Record<string, Worktree[]>;
};
/**
 * A git worktree of a project's repository, identified by its directory (canonical path). `main`: the repository's own checkout.
 * `branch`: the short hash on a detached HEAD. `outsideRoots`: listed, but no session can start there. `locked`: `git worktree lock`; never removable.
 */
export type Worktree = { path: string; branch?: string; main: boolean; outsideRoots?: boolean; locked?: true };
export type WorktreeCreateResult = { path: string; branch: string };
/** One branch name of `worktree.branches`: `local` (refs/heads), `remote` (full ref, `origin` preferred), `worktree`: the path it is checked out in. */
export type BranchRow = { name: string; local: boolean; remote?: string; worktree?: string };
/**
 * `defaultBase`: the start point a new branch gets without a base, as text (`origin/main`, `HEAD`). `fetched`: the fetch ran;
 * `fetchError`: it failed (offline), the list holds the local refs.
 */
export type WorktreeBranchesResult = { branches: BranchRow[]; defaultBase: string; fetched?: boolean; fetchError?: string };
/** A Jira ticket row of the Ticket tab. */
export type JiraTicket = { key: string; type: string; summary: string; status: string };
export type JiraSearchResult = { tickets: JiraTicket[] };
/** Why a worktree cannot be removed now. */
export type WorktreeBlock = "locked" | "symlink" | "outside_roots" | "sessions_running" | "removing" | "contains_worktree";
/**
 * `uncommitted`: changed and untracked files (ignored not); `untracked`: the untracked part of it; `commits`: commits only this worktree's branch
 * (or detached HEAD) holds, 0 when the branch is kept (not a Created branch); `ahead`: commits of HEAD in neither the base branch nor the upstream
 * (nor a same-name remote branch); `branchMerged`: a kept branch (not a Created branch, not detached) has no commit outside base or upstream (`git branch -d` may delete it);
 * `ignored`: ignored files that removal deletes (ignored directories git reports as a whole are not counted); `headTime`: ms of HEAD's committer date; `running`: its sessions that run or need input. `safety`: "blocked" when `blocked` is set, else
 * "has_work" when `uncommitted` or `ahead`, else "safe".
 */
export type WorktreeStatusResult = { uncommitted: number; untracked: number; commits: number; ahead: number; ignored: number; branch: string; branchMerged: boolean; headTime?: number; running: number; safety: "safe" | "has_work" | "blocked"; blocked?: WorktreeBlock; /** GH-447: the branch is a Created branch (ADR 0005); removal deletes it. */ createdBranch?: true };
/** `branchKept`: why a kept branch the caller asked to delete stays (git's message). */
export type WorktreeRemoveResult = { branchKept?: string };
/** Claude Code's worktree name rule; undefined when `name` is valid. */
export function worktreeNameError(name: string): string | undefined {
  if (!name || name.length > 64) return "Name must be 1 to 64 characters";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "Only letters, numbers, dots, hyphens, and underscores";
  if (name === "." || name.includes("..") || name.toLowerCase() === ".git") return "Name cannot be ., .git or contain ..";
}
/**
 * One Claude Code install the daemon reaches: its own (`local`), a WSL distro (`wsl:<distro>`) or a running Docker container (`docker:<name>`), each with its own login,
 * transcripts, settings, MCP servers and plugins. `off`: not started yet (side.start sets it up); `error`: `message` says what to do.
 */
export type SideInfo = {
  id: string;
  label: string;
  state: "off" | "starting" | "ready" | "error";
  message?: string;
  phase?: SidePhase;
  /** Docker, while starting: the install uses the host-assembled bundle (no npm in the container). */
  bundle?: boolean;
  /** Docker, while starting or after a failed start: why the install uses npm in the container instead of the bundle. */
  fallback?: string;
};
/** What a starting side is doing (`SideInfo.phase`, only while `state` is `starting`). `downloading`: the hub fetches bundle parts. */
export type SidePhase = "downloading" | "packing" | "copying" | "installing" | "starting";
/** The Docker engine as the hub sees it (`ListResult.docker`). */
export type DockerState = "ok" | "down" | "empty";
/** `side.start` setup mode: run only what is installed, install when needed (default), install again. */
export type SideSetup = "never" | "needed" | "force";
/** `running`/`starting`: the side is up (nothing was run); `installed`: this build is installed (can start); `install`/`update`: setup is needed; `blocked`: see `reason`. */
export type SideCheckVerdict = "running" | "starting" | "installed" | "install" | "update" | "blocked";
/** Why a check is blocked. */
export type SideCheckReason = "gone" | "not_running" | "unreachable" | "no_build" | "package_unreadable" | "node_missing" | "node_old" | "build_tools_missing" | "unpack_tools_missing" | "no_writable_path" | "check_failed";
export type SideCheckFacts = {
  reachable: boolean;
  running?: boolean;
  /** Node.js version, e.g. "22.4.0"; absent when there is none. */
  node?: string;
  nodeOk?: boolean;
  buildTools?: { make: boolean; python3: boolean; cxx: boolean };
  /** This build (`current`), another build (`other`, named by `installedKey`) or nothing. */
  installed: "current" | "other" | "none";
  installedKey?: string;
  /** Docker: the writable folders among /tmp, /dev/shm and the home folder. */
  writable?: string[];
  /** Docker or WSL: the container's or distro's CPU (`uname -m`), C library and glibc version. */
  target?: { arch: string; libc: "glibc" | "musl" | "unknown"; glibc?: string };
  /** Docker or WSL: how an install gets claude-ui in: the host-assembled bundle, or npm in the container or distro (`reason`: why not the bundle). */
  install?: { method: "bundle" | "npm"; reason?: string };
  /** Docker or WSL: tools and libraries found (each item of "What this container needs"). */
  tools?: { tar: boolean; gzip: boolean; npm: boolean; git: boolean; cxxRuntime: boolean };
  /** Docker: false when the container has no network (`--network none`). */
  network?: boolean;
  /** Docker or WSL: the installed build carries its own Node.js (a bundle install). */
  bundled?: boolean;
};
/** Reply of `side.check`. `message`: the user's next step in plain words (blocked, install, update). `key`: this claude-ui build. */
export type SideCheck = { verdict: SideCheckVerdict; reason?: SideCheckReason; message?: string; key: string; facts: SideCheckFacts; phase?: SidePhase };
export const LOCAL_SIDE = "local";
/** `lastActivity`: ms of its newest session. */
export type RecentProject = { cwd: string; sessionCount: number; lastActivity: number };
/** `cwd`: the canonical path of the opened project. */
export type ProjectOpenResult = { cwd: string };
export type FsListResult = { entries: FsEntry[] };
/** Dry run of a code rewind: files it would restore (empty = no code options); `conversation` false for the first prompt. */
export type RewindPreview = { filesChanged: string[]; insertions: number; deletions: number; conversation: boolean };
/** Paths relative to the searched cwd, best first; folders end with `/`. */
export type FsSearchResult = { paths: string[] };
export type FsReadResult = { content: string; mtime: number };
/** `url`: same-origin path, valid while this connection is open and used within 10 min. */
/** `unavailable`: published paths of supporting files named in the call that this preview does not serve (absent when none; GH-335). */
export type ArtifactPreviewResult = { url: string; size: number; mtime: number; unavailable?: string[] };
export type FsMediaResult = { url: string; mime: string; size: number; mtime: number };
/** `data`: base64 of the bytes at the offset (shorter at the end of the file); `size` of the whole file; `mtime` 0 for a file at a commit. */
export type MediaReadResult = { data: string; size: number; mtime: number; mime: string };
export type FsWriteResult = { mtime: number };
/** The path an fs.create / fs.rename / fs.duplicate made (parent as fs.list gives it, plus the name). */
export type FsPathResult = { path: string };
/** Entries below the folder (none for a file or link); `more`: the count stopped at 10 000 entries or 2 s. */
export type FsDeleteResult = { files: number; folders: number; more?: boolean };
/** `title`: "Terminal N", the smallest N free in its cwd. */
export type TerminalInfo = { id: string; title: string };
export type TerminalCreateResult = { terminal: TerminalInfo };
export type TerminalListResult = { terminals: TerminalInfo[] };
/** `buffer`: the last output (capped), to replay into a fresh view. */
export type TerminalAttachResult = { buffer: string };

/** Larger `terminal.input` data (UTF-8 bytes) is refused (`too_large`); the panel sends a big paste in parts. */
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
/**
 * `branch`: short commit hash on a detached HEAD. `added`/`removed`: lines changed in tracked files against HEAD.
 * `refs`: opaque stamp of the repository's refs (file stats of HEAD, packed-refs, refs folders, worktree HEADs); changes when a branch, tag, HEAD or packed refs change. Compare for equality only.
 */
export type GitStatus = { branch: string; added: number; removed: number; refs?: string };
/** `refs` null outside a git work tree. */
export type GitRefsResult = { refs: string | null };
/** `status` null outside a git work tree. */
export type GitStatusResult = { status: GitStatus | null };
/** `refs`: full ref names pointing here ("HEAD" first when HEAD points here). `time`: author time, unix seconds. */
export type GitCommit = { hash: string; parents: string[]; author: string; email: string; time: number; subject: string; refs: string[] };
/**
 * First page only (skip 0): `branches`: full ref names of local and remote branches. `refs`: the refs stamp (as `GitStatus.refs`).
 * `head`: the full ref HEAD points to (`refs/heads/main`); absent when detached or unknown.
 */
export type GitLog = { commits: GitCommit[]; more: boolean; branches?: string[]; refs?: string; head?: string };
/** `log` null outside a git work tree. */
export type GitLogResult = { log: GitLog | null };
/** `added`/`removed` undefined for a binary file. `oldPath`: renamed from. `untracked`: not in the index (status A; git.diff only). */
export type GitFileChange = { status: "A" | "D" | "M" | "R"; path: string; oldPath?: string; added?: number; removed?: number; untracked?: boolean };
/** `message`: full message. `refs`: always `[]` from `git.commit` (no decoration: slow with thousands of refs); the client shows the refs of the commit from `git.log`. `truncated`: more than 3000 files changed, list cut. */
export type GitCommitDetail = GitCommit & { message: string; committer: string; committerTime: number; files: GitFileChange[]; truncated?: boolean };
export type GitCommitResult = { commit: GitCommitDetail };
/**
 * `prefix`: the request cwd relative to the repository top ("/"-separated, "" or ending with "/"); `files[].path` are relative to the top.
 * `base`: the full hash of the before side; absent before the first commit (every file A, before side empty). `ref`: the branch compared (branch mode).
 * `branches`: local and remote branches for the picker (branch mode only). `truncated`: list cut at 3000 files.
 */
export type GitDiff = { prefix: string; base?: string; ref?: string; files: GitFileChange[]; branches?: string[]; truncated?: boolean };
/** `diff` null outside a git work tree. */
export type GitDiffResult = { diff: GitDiff | null };
/** A remote operation's git output (redacted, at most 8000 chars) and the refs stamp after it. */
export type GitRemote = { output: string; refs: string | null };
/** `remote` null outside a git work tree. */
export type GitRemoteResult = { remote: GitRemote | null };
/** What the branch menu shows for a local branch and the exact git argv (without "git") of each action; an absent argv is unavailable and `why` says why. */
export type GitBranchInfo = {
  ref: string;
  local: string;
  /** "here": HEAD of the session's worktree; a path: checked out in that other worktree; absent: nowhere. */
  checkedOut?: string;
  remote?: string;
  remoteRef?: string;
  tracking?: string;
  trackingHash?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  isDefault?: boolean;
  push?: string[];
  forcePush?: string[];
  pull?: string[];
  why?: { push?: string; forcePush?: string; pull?: string };
};
/** `branch` null outside a git work tree. */
export type GitBranchResult = { branch: GitBranchInfo | null };
export const GIT_LOG_MAX_LIMIT = 500;

/** Where an MCP server (or plugin setting) is saved; Claude Code's term. local: this project, private; user: all projects; project: `.mcp.json`. */
export type ConfigScope = "local" | "user" | "project";
/** App-wide settings (settings.json in the daemon config dir). A later setting is one more field here, in the daemon's `DEFAULTS` and `CHECKS`. */
/** `orchestration.workerMode`: the permission mode of a new worker when the coordinator names none; `coordinator` = the coordinator's own mode. */
export const WORKER_MODES = ["coordinator", "default", "acceptEdits", "plan", "auto"] as const;
export type WorkerModeSetting = (typeof WORKER_MODES)[number];
export type Settings = { orchestration: { enabled: boolean; workerCap: number; coordinatorPermissions: boolean; workerMode: WorkerModeSetting; /** Off: a worker's finished, needs-input and error notify nobody but its coordinator; an escalated request still does (GH-387). */ workerNotifications: boolean }; usageLimit: { autoContinue: boolean }; notifications: { desktop: boolean };
  /** Performance monitor (GH-272): measures the daemon; off stops every observer and the sampling. */
  performance: { monitor: boolean };
  /** Ticket tab of the Create worktree modal (GH-447): one Jira connection; `email` for Cloud only; the token is in secrets.json, never here. */
  jira: { url: string; email: string; template: string };
};
export type SettingsPatch = { [S in keyof Settings]?: Partial<Settings[S]> };
/** `daemon`: where the daemon runs (the desktop notification row names it) and whether it was started without desktop notifications (`--no-os-notify`). Absent from an older daemon. */
export type SettingsResult = { settings: Settings; daemon?: { host: string; version?: string; desktopForcedOff?: true }; /** A Jira token is saved (the token itself is write-only). */ jiraToken?: boolean };
/** Spans of the daemon the monitor times (code constants; never a user value). */
export type PerfSpanName = "session.open" | "session.start" | "session.start.timeout" | "side.start" | "side.install" | "side.spawn" | "side.firstFrame" | "worktree.list";
/** An event-loop block of at least 50 ms while spans were open; `spans` = the ones open then. */
export type PerfStall = { kind: "stall"; at: number; ms: number; spans: { name: PerfSpanName; id: number }[] };
/** A child process: `cmd` and `sub` come from closed lists; `request` = the request type it served ("background" = none in flight). */
export type PerfChild = { kind: "child"; at: number; cmd: string; sub?: string; ms: number; heldMs?: number; thread: "main" | "worker"; request: string; exit: number | "error" | "signal" };
export type PerfSpan = { kind: "span"; at: number; name: PerfSpanName; id: number; parent?: number; ms: number; elu?: number };
export type PerfHandler = { kind: "handler"; at: number; request: string; ms: number };
export type PerfWorst = PerfStall | PerfChild | PerfSpan | PerfHandler;
export type PerfDaemon = {
  pid: number;
  version?: string;
  /** Epoch ms of the last Clear or the start. */
  since: number;
  monitor: boolean;
  /** Event-loop delay over the idle floor (ms) per 10 s window; resolution of the timer in ms. */
  eld: { excessP95?: number; excessMax?: number; idleP50?: number; resolutionMs: number };
  /** Event-loop utilization (0-1) of the last 10 s window. */
  elu: number;
  handlers: Record<string, HistSummary>;
  spans: Partial<Record<PerfSpanName, HistSummary>>;
  /** Key "git log", "git status", "claude", ... */
  children: Record<string, HistSummary>;
  /** Last 60 samples, one per 10 s. */
  memory: { at: number; rss: number; heapUsed: number }[];
  /** The 50 slowest events, slowest first. */
  worst: PerfWorst[];
  /** The monitor's own JS time since `since` (ms) and the time it was on. */
  cost: { ownMs: number; wallMs: number };
};
export type PerfReport = { daemon: PerfDaemon };
export type ConfigKind = "mcp" | "plugins" | "skills";
/** `McpServerStatus.status` of the SDK. */
export type McpStatus = "connected" | "failed" | "needs-auth" | "pending" | "disabled";
/**
 * `McpServerStatus` without secrets: `config` has no headers or env, `tools` only names and annotations.
 * `scope`: project, local, user, claudeai, managed, enterprise, dynamic, ... (open set). `error`: the CLI's text.
 */
export type McpServerInfo = {
  name: string;
  status: McpStatus | (string & {});
  scope?: string;
  source?: string;
  error?: string;
  serverInfo?: { name: string; version: string };
  config?: { type: string; command?: string; url?: string };
  tools?: { name: string; readOnly?: boolean; destructive?: boolean }[];
};
export type McpListResult = { servers: McpServerInfo[] };
/** `requiresUserAction`: the user signs in at `authUrl`; the server connects once the CLI got the redirect. */
export type McpAuthResult = { authUrl?: string; requiresUserAction: boolean };
/** Add form values as `claude mcp add` takes them: `env` "KEY=value", `headers` "Header-Name: value". */
export type McpAddConfig =
  | { transport: "stdio"; command: string; args: string[]; env: string[] }
  | { transport: "http" | "sse"; url: string; headers: string[] };

/** Claude Code's `skillOverrides` values; the dialog labels them On / Name only / User only / Off. */
export type SkillState = "on" | "name-only" | "user-invocable-only" | "off";
/** `get_skills_dialog` `handles` as the CLI sends it (snake_case), passed back unchanged to `edit-skill-overrides`. */
export type SkillHandles = { unqualified_name?: string; aliases?: string[]; bare_name_reserved?: boolean };
/**
 * One skill of the "Slash commands" dialog (`get_skills_dialog`). `source`: user, project, plugin, built-in, claude.ai sync, ... (open set).
 * `lockedBy`: why the state cannot be changed: plugin, author, policy, flag, reserved-name (open set). `advertised`: listed as a command.
 */
export type SkillRow = {
  name: string;
  displayName: string;
  description: string;
  source: string;
  tokens: number;
  state: SkillState | (string & {});
  lockedBy?: string;
  advertised: boolean;
  handles?: SkillHandles;
};
export type SkillsResult = { skills: SkillRow[] };
/** `confirmed` false: saved, but the session's dialog still shows the previous state after 5 reads. */
export type SkillsSetStateResult = SkillsResult & { confirmed: boolean };
/** Scope of an installed plugin as `claude plugin list --json` reports it; `managed` and `synced` are not install targets. */
export type PluginScope = ConfigScope | "managed" | "synced" | (string & {});
/**
 * An installed plugin of this project (user, managed, synced, or project/local scope of `cwd`). `id`: `name@marketplace`.
 * `description`, `mcpServers`: from its `.claude-plugin/plugin.json` and `.mcp.json`. `updatable`: the VS Code extension's rule.
 */
export type InstalledPlugin = { id: string; version?: string; scope: PluginScope; enabled: boolean; projectPath?: string; description?: string; mcpServers?: string[]; updatable: boolean };
/** A marketplace plugin not installed in this project. `official`: from `anthropics/claude-plugins-official`. */
export type AvailablePlugin = { pluginId: string; name: string; description?: string; marketplaceName: string; official: boolean; sourceUrl?: string; installCount: number };
/** `claude plugin marketplace list --json` row. `source`: github (repo), git / url (url), directory / file (path), npm (package). */
export type MarketplaceInfo = { name: string; source: string; repo?: string; url?: string; path?: string; package?: string; official: boolean };
export type PluginsListResult = { installed: InstalledPlugin[]; available: AvailablePlugin[]; marketplaces: MarketplaceInfo[] };
export type MarketplacesResult = { marketplaces: MarketplaceInfo[] };
/** `failed`: sessions whose `reloadPlugins()` threw (restart them); `errorCount`: plugin load errors summed. */
export type ReloadResult = { reloaded: number; failed: string[]; errorCount: number };
export type PluginWriteResult = { reload: ReloadResult };
export type PluginUpdateFailure = "timeout" | "policy" | "disabled" | "needs_consent" | "not_installed" | "not_found" | "network" | "other";
/** ok: `message` = the CLI's result line (e.g. already at the latest version); `reload` when the update needs one. */
export type PluginUpdateResult = { outcome: "ok"; message?: string; reload?: ReloadResult } | { outcome: "failed"; kind: PluginUpdateFailure; message: string };
