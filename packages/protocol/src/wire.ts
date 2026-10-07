// WebSocket wire protocol (docs/spec.md "Wire protocol"). JSON, one message per frame.
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, Part, PermissionMode, PlanUsage, SessionState, SlashCommand } from "./parts.ts";

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
 */
export type SessionListItem = SessionInfo & { title: string; lastActivity: number; archived: boolean; transcript: boolean; coordinator?: true; coordinatorId?: string; workerName?: string };
export type FsEntry = { name: string; path: string; isDir: boolean };

/**
 * Every client message carries a `reqId`; the daemon answers with a `reply` or an `error` with the same `reqId`.
 * `side`: the side (SideInfo.id) that handles it, on a daemon with sides; without it the daemon routes by session, terminal or path.
 */
export type ClientMessage = { reqId: string; side?: string } & (
  /** `coordinator`: the session gets the orchestration tools (docs/spec.md "Orchestration"); refused while orchestration is off. */
  | { type: "session.create"; cwd: string; model?: string }
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
   * Attach button, non-image file: the daemon stores it in a temp folder (a browser cannot tell a file's path)
   * and replies its absolute path, which the prompt gets as an `@path` mention. `data`: base64 content.
   */
  | { type: "fs.upload"; name: string; data: string; cwd?: string }
  /** Stops the running turn; a no-op while idle. */
  | { type: "session.interrupt"; sessionId: string }
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
  /** Adds a directory inside the roots to the known projects (kept across daemon restarts). */
  | { type: "project.open"; cwd: string }
  /** Removes a project from the list; files and transcripts stay. */
  | { type: "project.remove"; cwd: string }
  /** Reply `{settings}` (docs/spec.md "Settings"). */
  | { type: "settings.get" }
  /** Sets only the fields in `patch`; reply `{settings}`, error `bad_settings` for an invalid value. Broadcasts `settings_changed`. */
  | { type: "settings.set"; patch: SettingsPatch }
  /** Sets the SDK custom title (the terminal CLI shows it too). Needs a transcript: a session with no prompt yet has none. */
  | { type: "session.rename"; sessionId: string; title: string }
  | { type: "session.archive"; sessionId: string; archived: boolean }
  /** Removes the transcript. Refused while a turn runs or input is pending: stop it first. */
  | { type: "session.delete"; sessionId: string }
  /** Without `path`: the allowlisted roots (of `side`). */
  | { type: "fs.list"; path?: string }
  /** Sets up and starts a side (WSL distro, Docker container); replies when it is ready, `side_failed` with the next step for the user otherwise. */
  | { type: "side.start"; side: string }
  | { type: "session.rewindPreview"; sessionId: string; userMessageId: string }
  | { type: "session.rewind"; sessionId: string; userMessageId: string; mode: RewindMode }
  /** @-mention autocomplete: fuzzy matches under `cwd` (a session's cwd, inside the roots). */
  | { type: "fs.search"; cwd: string; query: string }
  /** Content search (docs/spec.md "Wire protocol"): streams `sessions.search.result`, then the reply SessionsSearchResult. A new search on the connection cancels the running one; a query under MIN_SEARCH_CHARS only cancels. */
  | { type: "sessions.search"; query: string; cwd?: string }
  /** The daemon's VAPID public key, for `PushManager.subscribe()`. */
  | { type: "push.key" }
  | { type: "push.subscribe"; subscription: WebPushSubscription }
  /** The session this tab shows while focused and visible (none otherwise); pushes for it are suppressed. */
  | { type: "push.focus"; sessionId?: string }
  /** Text files only; `mtime` (ms) identifies the disk version. */
  | { type: "fs.read"; path: string }
  /** Image, SVG, video or audio file (extension allowlist): a URL that serves its bytes to this connection (docs/spec.md "Security"). */
  | { type: "fs.media"; path: string }
  /** Overwrites an existing file. Fails with `conflict` when `baseMtime` is given and the disk version differs. */
  | { type: "fs.write"; path: string; content: string; baseMtime?: number }
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
  /** Commit graph page (docs/spec.md "Layout"): `skip` commits already loaded; `ref` a full ref name (refs/heads/… or refs/remotes/…) or `HEAD`, else all refs; `author`/`text` case-insensitive substrings. Reply GitLogResult. */
  | { type: "git.log"; cwd: string; skip?: number; limit?: number; ref?: string; author?: string; text?: string }
  /** Reply GitCommitResult. */
  | { type: "git.commit"; cwd: string; hash: string }
  /** File text at a commit (`path` relative to the repository top). Same limits and error codes as fs.read (too_large, binary, not_utf8), not_found when absent. Reply `{ content }`. */
  | { type: "git.fileAt"; cwd: string; hash: string; path: string }
  /** Creates `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>` (docs/spec.md "Worktrees"); no `name`: a generated one. Reply WorktreeCreateResult. Broadcasts `sessions.changed`. */
  | { type: "worktree.create"; cwd: string; name?: string }
  /** What removing `path` loses; reply WorktreeStatusResult. */
  | { type: "worktree.status"; cwd: string; path: string }
  /** `git worktree remove --force` of a worktree under `<repo>/.claude/worktrees`, then `git branch -D` for a `worktree-*` branch; transcripts stay. Reply `{}`. Broadcasts `sessions.changed`. */
  | { type: "worktree.remove"; cwd: string; path: string }
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
/** Whole turns, oldest part first; `older` absent = the start of the session. */
export type TimelinePage = { parts: Part[]; older?: Cursor };
/**
 * Paged subscribe reply: `heads` = the latest session_state, commands, context_usage, external_turn, todo_update events; `aux` = parts of the
 * unloaded region that whole-session features need (subagent, turn_result, running background Bash calls).
 */
export type Snapshot = { heads: Event[]; attentionSeq: number; page: TimelinePage; aux: PosPart[] };
export type PageResult = { page: TimelinePage };
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
  | { type: "settings_changed"; settings: Settings }
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
  /** Side of each listed project, recent project and session cwd that is not local. */
  cwdSides?: Record<string, string>;
  /** Git worktrees of each listed project that is in a git repository (docs/spec.md "Projects"), the main worktree first. */
  worktrees?: Record<string, Worktree[]>;
};
/**
 * A git worktree of a project's repository, identified by its directory (canonical path). `main`: the repository's own checkout.
 * `branch`: the short hash on a detached HEAD. `outsideRoots`: listed, but no session can start there.
 */
export type Worktree = { path: string; branch?: string; main: boolean; outsideRoots?: boolean };
export type WorktreeCreateResult = { path: string; branch: string };
/** `uncommitted`: changed and untracked files; `commits`: commits only this worktree's branch (or detached HEAD) holds, 0 when the branch is kept (not `worktree-*`). */
export type WorktreeStatusResult = { uncommitted: number; commits: number; branch: string };
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
export type SideInfo = { id: string; label: string; state: "off" | "starting" | "ready" | "error"; message?: string };
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
export type FsMediaResult = { url: string; mime: string; size: number; mtime: number };
export type FsWriteResult = { mtime: number };
/** `title`: "Terminal N", the smallest N free in its cwd. */
export type TerminalInfo = { id: string; title: string };
export type TerminalCreateResult = { terminal: TerminalInfo };
export type TerminalListResult = { terminals: TerminalInfo[] };
/** `buffer`: the last output (capped), to replay into a fresh view. */
export type TerminalAttachResult = { buffer: string };

/** Larger `terminal.input` data (UTF-8 bytes) is refused (`too_large`); the panel sends a big paste in parts. */
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
/** `branch`: short commit hash on a detached HEAD. `added`/`removed`: lines changed in tracked files against HEAD. */
export type GitStatus = { branch: string; added: number; removed: number };
/** `status` null outside a git work tree. */
export type GitStatusResult = { status: GitStatus | null };
/** `refs`: full ref names pointing here ("HEAD" first when HEAD points here). `time`: author time, unix seconds. */
export type GitCommit = { hash: string; parents: string[]; author: string; email: string; time: number; subject: string; refs: string[] };
/** `branches`: on the first page only (skip 0), full ref names of local and remote branches. */
export type GitLog = { commits: GitCommit[]; more: boolean; branches?: string[] };
/** `log` null outside a git work tree. */
export type GitLogResult = { log: GitLog | null };
/** `added`/`removed` undefined for a binary file. `oldPath`: renamed from. */
export type GitFileChange = { status: "A" | "D" | "M" | "R"; path: string; oldPath?: string; added?: number; removed?: number };
/** `message`: full message. `truncated`: more than 3000 files changed, list cut. */
export type GitCommitDetail = GitCommit & { message: string; committer: string; committerTime: number; files: GitFileChange[]; truncated?: boolean };
export type GitCommitResult = { commit: GitCommitDetail };
export const GIT_LOG_MAX_LIMIT = 500;

/** Where an MCP server (or plugin setting) is saved; Claude Code's term. local: this project, private; user: all projects; project: `.mcp.json`. */
export type ConfigScope = "local" | "user" | "project";
/** App-wide settings (settings.json in the daemon config dir). A later setting is one more field here, in the daemon's `DEFAULTS` and `CHECKS`. */
/** `orchestration.workerMode`: the permission mode of a new worker when the coordinator names none; `coordinator` = the coordinator's own mode. */
export const WORKER_MODES = ["coordinator", "default", "acceptEdits", "plan", "auto"] as const;
export type WorkerModeSetting = (typeof WORKER_MODES)[number];
export type Settings = { orchestration: { enabled: boolean; workerCap: number; coordinatorPermissions: boolean; workerMode: WorkerModeSetting } };
export type SettingsPatch = { [S in keyof Settings]?: Partial<Settings[S]> };
export type SettingsResult = { settings: Settings };
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
