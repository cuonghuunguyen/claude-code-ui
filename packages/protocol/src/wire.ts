// WebSocket wire protocol (docs/spec.md "Wire protocol"). JSON, one message per frame.
import type { Effort, EffortLevel, Part, PermissionMode, PlanUsage, SessionState, SlashCommand } from "./parts.ts";
import type { HistSummary } from "./histogram.ts";

/** A model an Engine offers (models.list). `value` goes to session.setModel; "default" = the Engine's default. */
export type ModelInfo = {
  value: string;
  /** The model id an alias `value` resolves to. */
  resolvedModel?: string;
  displayName: string;
  description: string;
  /** Picker group label (OpenCode: the provider name). */
  group?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: EffortLevel[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
};

/** All permission modes, in picker order. Shift+Tab cycles them without dontAsk (Claude Code's order). */
export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"];
/** The agent runtimes a session can run on (ADR 0012); the engine of a session follows its id (UUID = claude, `ses_` = opencode). */
export const ENGINES = ["claude", "opencode"] as const;
export type Engine = (typeof ENGINES)[number];
/** Oldest OpenCode this daemon works with: its API was checked against 1.18.34. Raise when a later feature needs newer endpoints. */
export const OPENCODE_MIN = "1.18.0";
/** What an Engine supports for its sessions (ADR 0012); web hides or disables a control by these, never by engine name. */
export type EngineCapabilities = {
  /** Every permission mode the Engine has; SessionInfo.permissionModes is the subset offered now. */
  permissionModes: PermissionMode[];
  effort: boolean;
  rewind: boolean;
  fork: boolean;
  steering: boolean;
  slashCommands: boolean;
  planMeter: boolean;
  account: boolean;
  contextUsage: boolean;
  /** Bash mode (`!`): shell commands run in the session cwd. */
  shell: boolean;
};
export const ALL_CAPABILITIES: EngineCapabilities = { permissionModes: PERMISSION_MODES, effort: true, rewind: true, fork: true, steering: true, slashCommands: true, planMeter: true, account: true, contextUsage: true, shell: true };
/** The session's flags; absent (a daemon before Engines) = ALL_CAPABILITIES. */
export const capabilitiesOf = (s: { capabilities?: EngineCapabilities }) => s.capabilities ?? ALL_CAPABILITIES;
/** The modes offered now, of `modes` (the Engine's own): auto only when the model has `supportsAutoMode`, bypass only when the daemon config enables it. */
export const permissionModesFor = ({ allowBypass, supportsAuto, modes = PERMISSION_MODES }: { allowBypass?: boolean; supportsAuto?: boolean; modes?: PermissionMode[] }) =>
  modes.filter((m) => (m === "bypassPermissions" ? allowBypass : m === "auto" ? supportsAuto : true));
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
  /** What the session's Engine supports; absent (an older daemon) = everything (capabilitiesOf). */
  capabilities?: EngineCapabilities;
  /** The Engine the session runs on; absent (an older daemon) = claude. */
  engine?: Engine;
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
  | { type: "session.create"; cwd: string; model?: string; draft?: string; engine?: Engine }
  /** Binary and version of OpenCode, never starts its server. Reply OpenCodeStatus. */
  | { type: "opencode.status" }
  /** Providers of the OpenCode server with their login methods (starts the server). Reply OpenCodeProvidersResult. */
  | { type: "opencode.providers" }
  /** `api` method: stores `key` (`inputs` = the method's prompt values), reply OpenCodeProvidersResult. `oauth` method: reply OpenCodeLoginStart. `method` = index in the provider's `methods`. The daemon never logs or keeps `key`. */
  | { type: "opencode.login"; provider: string; method: number; key?: string; inputs?: Record<string, string> }
  /** Ends an OAuth login: waits for the browser (`auto`) or sends `code`. Reply OpenCodeProvidersResult; error `cancelled` after opencode.loginCancel. */
  | { type: "opencode.loginFinish"; provider: string; method: number; code?: string }
  /** Stops the daemon's wait of a pending OAuth login; reply `{}`. */
  | { type: "opencode.loginCancel"; provider: string }
  /** Removes the saved login of a provider; reply OpenCodeProvidersResult. */
  | { type: "opencode.logout"; provider: string }
  /** The mode a new session in `cwd` starts in: Claude settings `permissions.defaultMode` (local > project > user), when offered; else "default". */
  | { type: "session.defaultMode"; cwd: string }
  /** Commands and skills of a project, for the new-session tab's `/` menu (no session yet); the daemon caches the list per cwd for a minute. */
  | { type: "session.commands"; cwd: string; engine?: Engine }
  /** `addProject`: an explicit open (link, notification) of a session of a project that is not added adds the project; a resubscribe must not. */
  /** `background`: follow only (unread markers); it does not keep the session's CLI from the idle close (docs/spec.md "Idle close"). */
  | { type: "session.subscribe"; sessionId: string; sinceSeq: number; logEpoch?: string; addProject?: boolean; background?: boolean; paged?: boolean; from?: string }
  /** Stops this connection's events of the session; reply `{}`. Never restores a session. */
  | { type: "session.unsubscribe"; sessionId: string }
  /** The page of whole turns before `before` (a cursor's id); `until` (part id, or API message id) extends it back to the turn holding that part. Reply `PageResult`. */
  | { type: "session.page"; sessionId: string; logEpoch: string; before: string; until?: string }
  /** Edit/Write calls (and their results) older than the cursor `before`, for the changes tab. Reply `EditsResult`. */
  | { type: "session.edits"; sessionId: string; logEpoch: string; before: string }
  /** Done Artifact publishes (and their results) older than the cursor `before`, for the Artifacts pane (GH-176). Reply `ArtifactsResult`. */
  | { type: "session.artifacts"; sessionId: string; logEpoch: string; before: string }
  /** A base64 payload a snapshot or page left out (images.ts omitMedia): `index` into the tool_result output or the user_text images. Reply `MediaResult`; error `unknown_media`. */
  | { type: "session.media"; sessionId: string; partId: string; index: number }
  /** URL of the local page an Artifact publish part of the session names (GH-175, GH-335); reply ArtifactPreviewResult. */
  | { type: "artifact.preview"; sessionId: string; partId: string }
  // images: data URLs (`data:image/png;base64,...`); png, jpeg, gif, webp.
  | { type: "session.prompt"; sessionId: string; text: string; images?: string[] }
  /** Bash mode: runs `command` with the user's shell in the session cwd; output streams as a `bash` part; Claude sees it with the next prompt. `session.interrupt` kills it. Idle: runs, reply `{}`. Busy (turn, pending input, rewind, shell command, terminal CLI turn): queued as a bash item (`prompt_queue`), reply `{ itemId }`; error `queue_full`. */
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
  /** Removes a queued message (Delete, Edit); reply `{ text, images, bash? }`; error unknown_item. */
  | { type: "session.dequeue"; sessionId: string; itemId: string }
  /** Send now: removes the item and sends it like session.prompt (steers a running turn); reply `{}`; errors unknown_item and the session.prompt codes (the item stays queued on failure). A bash item while busy: error `session_busy`. */
  | { type: "session.sendQueued"; sessionId: string; itemId: string }
  /** Stop agent: stops one running subagent run (`subagentId` = its subagent part id); the turn goes on. `unknown_subagent` when none runs. */
  | { type: "session.stopSubagent"; sessionId: string; subagentId: string }
  /** Run in background (GH-440): moves the running foreground Bash call `toolUseId` to the background (`backgroundTasks()`, Ctrl+B in Claude Code); the turn goes on. Also the running bash mode command whose `bash` part id is `toolUseId` (GH-485): the session is free, the command runs on as a background shell. Errors `unknown_shell` (no foreground task of that call runs), `background_failed`. */
  | { type: "session.backgroundShell"; sessionId: string; toolUseId: string }
  /** Shells list (GH-442): the tail of background Bash call `toolUseId`'s output file (stdout and stderr merged, at most MAX_BASH_OUTPUT_CHARS chars); reply ShellOutputResult. Error `no_output` (no file known, it lies outside the CLI's task folder, or it is gone). */
  | { type: "session.shellOutput"; sessionId: string; toolUseId: string }
  /** Kill (GH-442): stops the running background shell `toolUseId` (`stopTask()`); its task_notification ends it. Also a bash mode command moved to the background (kills its process group). Errors `unknown_shell` (no task of that call runs), `stop_failed`. */
  | { type: "session.stopShell"; sessionId: string; toolUseId: string }
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
  /** `answers`: question text -> answer. First answer wins, like permission.respond. `choices`: question text -> the chosen option labels, then the Other text; optional, an Engine that needs the structure of a multi-select answer (OpenCode) uses it, Claude ignores it. */
  | { type: "question.respond"; requestId: string; answers: Record<string, string>; choices?: Record<string, string[]> }
  | { type: "models.list"; engine?: Engine; cwd?: string }
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
  /** Saves a named Claude token (from `claude setup-token`) in secrets.json; write-only, at most 20. Reply SettingsResult; broadcasts `settings_changed`. Error `bad_settings`. Hub only. */
  | { type: "claude.account.add"; name: string; token: string }
  /** Removes a token account; when it was the active one the account falls back to Default. Reply SettingsResult; broadcasts `settings_changed`. Hub only. */
  | { type: "claude.account.remove"; id: string }
  /** Checks a token account with one minimal CLI turn (Haiku, no tools) in a throwaway CLI config; never changes the active account or any session. Reply {} on success; errors claude_auth (token refused: invalid, expired, revoked), claude_test_failed (network, timeout, other; message = the CLI's one-line reason), bad_settings (unknown id, cloud provider env). Hub only. */
  | { type: "claude.account.test"; id: string }
  /** Test connection with the saved Jira settings and token. Reply `{user}` (display name); errors jira_not_configured, jira_auth, jira_unreachable, jira_failed. */
  | { type: "jira.test" }
  /** Ticket tab: no `text` = the Ticket filter's tickets (`settings.jira.jql`, default my open ones; 20); a key or ticket URL = that ticket; other text = summary search (inside the Ticket filter when set). Reply JiraSearchResult; errors as `jira.test`. */
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
  /** Web app Close worker (docs/spec.md "Orchestration"): as `worker_close` for the worker's own coordinator. Reply `{}`; errors not_worker, unknown_worker, unknown_session, held_elsewhere, stop_timeout, has_workers. */
  | { type: "worker.close"; sessionId: string }
  /** /btw (docs/spec.md "Aside"): forks the session into an Aside and sends `text` there. Reply AsideOpenResult; errors bad_prompt, unknown_session, aside_unavailable, aside_failed. */
  | { type: "aside.open"; sessionId: string; text: string }
  /** Closes the Aside popup: stops its CLI, deletes its transcript and link. Reply `{}`; errors not_an_aside. */
  | { type: "aside.close"; sessionId: string }
  /** Keep as session: the Aside becomes a listed Session (link to its owner dropped). Reply `{}`; errors unknown_session, not_an_aside. */
  | { type: "aside.keep"; sessionId: string }
  /** Web app Remove worker: as `worker_remove` (session and transcript deleted, link dropped, worktree kept). Reply `{}`; errors not_worker, unknown_worker, held_elsewhere, session_running, has_workers, delete_failed. Broadcasts `sessions.changed`. */
  | { type: "worker.remove"; sessionId: string }
  /** Without `path`: the allowlisted roots (of `side`). */
  | { type: "fs.list"; path?: string }
  /**
   * Starts a side (WSL distro, Docker container); replies when it is ready, `side_failed` with the next step for the user otherwise.
   * `setup`: `never` runs only a build that is installed (none: `side_failed`, the side stays `off`), `needed` (default) installs it
   * first when this build is not installed, `force` installs it again.
   */
  | { type: "side.start"; side: string; setup?: SideSetup }
  /** `error` row with a `mismatch` (remote older), or a ready Side whose Hub an attach started: runs `claude-ui update` there; this Hub attaches again afterwards. */
  | { type: "side.updateRemote"; side: string }
  /** Read-only look at a side (nothing is installed or started; the hub answers it, a side never sees it): reply `SideCheck`, error `unknown_side`. */
  | { type: "side.check"; side: string }
  /** Add SSH host: writes a `Host` block for `ssh user@host -p N [-i key] [-J jump]` to the ssh config (alias defaults to the host name). Reply `SshAddResult`; error `bad_request` with the reason (bad command, alias exists, no ssh). Broadcasts nothing: the list is read again. */
  | { type: "ssh.add"; command: string; alias?: string }
  /** "Start with Claude UI" (`start`: the hub starts the side with itself) and "Update automatically" (`update`) of a side; reply `{}`; error `unknown_side`, `bad_request`. */
  | { type: "side.prefs"; side: string; start?: boolean; update?: boolean; /** The Grace period of the Hub an attach started there, in minutes. */ graceMinutes?: number }
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
  /** Opens a file or folder (absolute, inside the roots; `cwd` is the session folder, also inside) in the OS file manager (`reveal`), the default app (`default`, files only) or a detected editor. Only for a browser on the daemon machine (`not_local` otherwise); a side's path: `side_unsupported`. Reply `{}`. Other errors: `bad_request`, `cwd_not_allowed`, `path_not_allowed`, `not_found`, `editor_missing`, `open_failed`. */
  | { type: "fs.openExternal"; path: string; cwd: string; with: "reveal" | "default" | EditorId }
  /** Text files only; `mtime` (ms) identifies the disk version. */
  | { type: "fs.read"; path: string }
  /** Image, SVG, video or audio file (extension allowlist): a URL that serves its bytes to this connection (docs/spec.md "Security"). */
  /** Image, SVG, video or audio file (extension allowlist): a URL that serves its bytes to this connection (docs/spec.md "Security"). With `hash` (and `cwd`): the file at that commit, `path` relative to the repository top as in git.fileAt, at most 32 MiB (a gitlink path: `bad_request` "Submodule: open its repository"; `exact` applies with `hash` only). A side's file or commit is served by the hub (bytes read with media.read). */
  | { type: "fs.media"; path: string; cwd?: string; hash?: string; exact?: true }
  /** Bytes of a media file, or of the file at a commit (`cwd` + `hash`, as fs.media): `length` at most 1 MiB, 0 for only size, mtime and type. The hub reads a side's media with it for GET /media. Reply MediaReadResult. */
  | { type: "media.read"; path: string; cwd?: string; hash?: string; offset: number; length: number; exact?: true }
  /** Overwrites an existing file. Fails with `conflict` when `baseMtime` is given and the disk version differs. */
  | { type: "fs.write"; path: string; content: string; baseMtime?: number }
  /** Local history of a file (docs/spec.md "Local history"; `path` must be inside the roots, else `path_not_allowed`). Reply HistoryListResult, newest first. */
  | { type: "history.list"; path: string }
  /** Content of one entry (`not_found` for an unknown id). Reply `{ content }`. */
  | { type: "history.read"; path: string; id: string }
  /** Snapshots the current content (reason `restore`), then writes the entry's content like fs.write (`conflict` when `baseMtime` differs). Reply `{ mtime }`. */
  | { type: "history.restore"; path: string; id: string; baseMtime?: number }
  /** `label`: 1..100 characters, no control characters. Reply `{}`. */
  | { type: "history.rename"; path: string; id: string; label: string }
  | { type: "history.delete"; path: string; id: string }
  /** A named entry of the file on disk (no merge, no dedupe; `too_large` over 256 KB). Reply `{ entry }`. */
  | { type: "history.create"; path: string; label: string }
  /** New empty file, or folder with `dir` (one level: the parent must exist). Fails `exists`, `bad_name`, `path_not_allowed`. Reply FsPathResult. */
  | { type: "fs.create"; path: string; dir?: boolean }
  /**
   * New name in the same folder (`name`: one path segment). A link is renamed, never followed. Fails `exists`, `bad_name`, `not_found`, `root_protected`, `in_use`. Reply FsPathResult.
   * GH-555: `dir` moves it into that folder (an existing folder in the roots; `into_itself` when `dir` is `path` or below it). `replace`: an existing target is replaced (a file: Local history entry `paste`; a folder: the whole folder).
   */
  | { type: "fs.rename"; path: string; name: string; dir?: string; replace?: boolean }
  /** GH-555: every file, folder and link below `path` (`path` itself first, `rel` ""); links are never followed. Fails `not_found`, `path_not_allowed`, `too_many` (> TRANSFER_MAX_ENTRIES), `too_large` (> TRANSFER_MAX_BYTES). Reply FsWalkResult. */
  | { type: "fs.walk"; path: string }
  /** GH-555: copies one file or link to `to` (same Daemon; `to` must not exist: `exists`; a folder: `not_a_file`). Reply FsPathResult. */
  | { type: "fs.copy"; from: string; to: string }
  /** GH-555: `length` bytes (at most CHUNK_BYTES, else `bad_request`) of a file from `offset`. Fails `not_a_file`. Reply FsChunkResult. */
  | { type: "fs.readChunk"; path: string; offset: number; length: number }
  /** GH-555: `data` (base64) at `offset`. Offset 0 creates the file exclusively (`exists`); later pieces need the file to have exactly `offset` bytes (`conflict`). `mode`: permission bits. Reply `{ size }`. */
  | { type: "fs.writeChunk"; path: string; offset: number; data: string; mode?: number }
  /** Deletes for good (no trash): a file, a link (never its target) or a folder with everything in it. `dryRun`: only counts. Fails `not_found`, `root_protected`, `in_use`. Reply FsDeleteResult. */
  | { type: "fs.delete"; path: string; dryRun?: boolean }
  /** Copy of a file next to it, named "<name> copy<.ext>", "<name> copy 2<.ext>", ... Files only (`not_a_file`), at most 512 MiB (`too_large`). Reply FsPathResult. */
  | { type: "fs.duplicate"; path: string }
  /** Replaces this connection's watched files; each change on disk sends `fs.changed`. */
  | { type: "fs.watch"; paths: string[] }
  /** Starts the user's shell in a PTY in `cwd` (inside the roots). It runs until closed or its shell exits, across reconnects. */
  | { type: "terminal.create"; cwd: string; cols: number; rows: number; login?: true }
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
  /**
   * Status bar: branch and diff size of `cwd` (a session's cwd, inside the roots).
   * `exact` (every git.* message below and `fs.media` / `media.read` with `hash`): refused with `not_git` "Not a repository top" unless `cwd` is its repository's top (an uninitialised submodule folder would answer for the superproject).
   */
  | { type: "git.status"; cwd: string; exact?: true }
  /** The refs stamp of `cwd`'s repository (as `GitStatus.refs`), from file stats only (no git process, never waits for a graph read). Reply GitRefsResult. */
  | { type: "git.refs"; cwd: string; exact?: true }
  /** Repository list of `cwd` (docs/spec.md "git.repos"): own repository, nested repositories and submodules found as VS Code finds them (Settings › Git), file system only (no git process). `openFiles`: absolute paths of open editor tabs (at most 50). `fresh`: skip the 10 s cache. Reply GitReposResult. */
  | { type: "git.repos"; cwd: string; openFiles?: string[]; fresh?: true }
  /** Commit graph page (docs/spec.md "Layout"): `skip` commits already loaded; `ref` a full ref name (refs/heads/… or refs/remotes/…) or `HEAD`, else all refs; `author`/`text` case-insensitive substrings; `fresh`: skip the daemon's page and branch caches (the Refresh button). Reply GitLogResult. */
  | { type: "git.log"; cwd: string; skip?: number; limit?: number; ref?: string; author?: string; text?: string; fresh?: boolean; exact?: true; /** Timeline (GH-565): `path` relative to the top; only the commits touching that file (`HEAD --follow`, no `ref`, no `branches` in the reply). */ path?: string }
  /** Reply GitCommitResult. */
  | { type: "git.commit"; cwd: string; hash: string; exact?: true }
  /** File text at a commit (`path` relative to the repository top). Same limits and error codes as fs.read (too_large, binary, not_utf8), not_found when absent, `bad_request` "Submodule: open its repository" for a gitlink (submodule) path. Reply `{ content }`. */
  | { type: "git.fileAt"; cwd: string; hash: string; path: string; exact?: true }
  /** Annotate (GH-564): `git blame` of the working-tree file (`path` relative to the repository top), so uncommitted lines come back `null`. Reply GitBlameResult. `too_large` (with `size`) over the editor read limit (2 MiB), `not_found`, `not_a_file`, `cwd_not_allowed`, `bad_request` bad path. */
  | { type: "git.blame"; cwd: string; path: string; exact?: true }
  /** Changes tab git modes (docs/spec.md "Layout"): the working tree (staged, unstaged, untracked) against HEAD (`base: "head"`) or against the merge base of HEAD and `ref` (`base: "branch"`; full ref under refs/heads or refs/remotes; omitted: the default branch). Reply GitDiffResult. */
  | { type: "git.diff"; cwd: string; base: "head" | "branch"; ref?: string; exact?: true }
  /** Graph tab Fetch: `git fetch --all` in `cwd`'s repository (docs/spec.md "Layout", Graph tab). Reply GitRemoteResult; `remote` null outside a git work tree. */
  | { type: "git.fetch"; cwd: string; exact?: true; /** Fetch only the default branch's remote with `--prune` (Clean up). */ defaultRemote?: boolean }
  /** Branch menu data (docs/spec.md "Layout", Graph tab): where push/pull go and the exact git argv of each; `ref` a full refs/heads/ name. Reply GitBranchResult. */
  | { type: "git.branch"; cwd: string; ref: string; exact?: true }
  /** Push `ref` as `git.branch` showed it; `local`: the sha shown; `argv`: the git command shown in the dialog (the daemon runs it only when it computes the same, else `stale`); `lease`: force push with --force-with-lease=<remoteRef>:<lease>. Reply GitRemoteResult. */
  | { type: "git.push"; cwd: string; ref: string; local: string; argv: string[]; lease?: string; /** The remote-tracking hash the dialog showed (`trackingHash`), absent when none; a different one now is `stale`. */ tracking?: string; exact?: true }
  /** Changes tab Commit: commits exactly `paths` (relative to the repository top, as `git.diff` names them; a rename: both sides) with their working-tree content; other index and work-tree entries stay; hooks run. `amend`: rewrites HEAD (no path: its message only). `push`: the reply also carries the push dialog data of HEAD's branch. Reply GitCommitFilesResult. */
  | { type: "git.commitFiles"; cwd: string; paths: string[]; message: string; amend?: boolean; push?: boolean; exact?: true }
  /** Changes tab Rollback, step 1 (GH-558): what a rollback of `paths` (as `git.commitFiles`) would do and the token it needs. Reply GitRollbackPreviewResult. */
  | { type: "git.rollbackPreview"; cwd: string; paths: string[]; exact?: true }
  /** Changes tab Rollback, step 2: `paths` back to HEAD in the work tree and the index; `token` from the preview (changed since: `stale`); `deleteAdded`: also delete added (new) files, else they stay untracked. Reply GitRollbackResult. */
  | { type: "git.rollback"; cwd: string; paths: string[]; token: string; deleteAdded?: boolean; exact?: true }
  /** Changes tab hunk Rollback: undoes one hunk of the diff of `path` in the work tree only. `hunk.lines`: unified-diff lines (" x", "-x", "+x", "\\ No newline at end of file"); `newStart`: unified convention. The text no longer matching: `stale`. Reply GitRollbackResult. */
  | { type: "git.rollbackHunk"; cwd: string; path: string; hunk: { newStart: number; lines: string[] }; exact?: true }
  /** Branch menu Merge: `git merge --no-edit <ref>` into HEAD, as `git.branch` showed it (`local`, `headRef`, `headHash` and `argv` are the shown values; a change is `stale`). A conflict is a success whose reply carries `operation`. Reply GitWriteResult. */
  | { type: "git.merge"; cwd: string; ref: string; local: string; headRef: string; headHash: string; argv: string[]; exact?: true }
  /** Branch menu Rebase: `git rebase <ref>` of HEAD, same fields as `git.merge`. Reply GitWriteResult. */
  | { type: "git.rebase"; cwd: string; ref: string; local: string; headRef: string; headHash: string; argv: string[]; exact?: true }
  /** Conflict banner Continue: marks the conflicted files resolved (refused while conflict markers remain), then `<kind> --continue`; kind `conflict` only clears the unmerged entries. `kind` is the operation the banner showed (a different one now is `stale`). Reply GitWriteResult. */
  | { type: "git.continue"; cwd: string; kind: GitOperationKind; exact?: true }
  /** Conflict banner Abort: `<kind> --abort`; kind `conflict`: `git reset --merge`. Reply GitWriteResult. */
  | { type: "git.abort"; cwd: string; kind: GitOperationKind; exact?: true }
  /** Branch menu New branch: `git branch <name> <at|HEAD>`, or with `checkout` `git switch -c <name> [<at>]`. `at`: a full commit hash (absent = HEAD). Tracked local changes that would be overwritten: error code `local_changes`; `smart` stashes them, switches and applies them again (a conflict is a success whose reply carries `operation`). Refused while a merge, rebase or conflict is unfinished. Reply GitWriteResult. */
  | { type: "git.branchCreate"; cwd: string; name: string; at?: string; checkout?: boolean; smart?: boolean; exact?: true }
  /** Branch menu Checkout: `git switch --no-guess <branch>` for `refs/heads/x`, `git switch --track <ref>` for `refs/remotes/r/b` (a new local branch). Errors, `smart` and the reply as `git.branchCreate`. */
  | { type: "git.checkout"; cwd: string; ref: string; smart?: boolean; exact?: true }
  /** Graph commit menu data (GH-562): what Undo Commit, Revert Commit, Cherry-Pick and Reset Current Branch to Here can do for `hash`, with the exact git argv of each. `hard`: also the files a hard reset would lose (`lose`, `loseCount`, `dirty`). Reply GitCommitMenuResult. */
  | { type: "git.commitMenu"; cwd: string; hash: string; hard?: true; exact?: true }
  /** Commit menu Undo Commit, Revert Commit, Cherry-Pick: run the `argv` `git.commitMenu` showed against the shown HEAD (`headRef`, `headHash`); a change is `stale`. A conflict is a success whose reply carries `operation`. Reply GitWriteResult. */
  | { type: "git.undoCommit" | "git.revert" | "git.cherryPick"; cwd: string; hash: string; headRef: string; headHash: string; argv: string[]; exact?: true }
  /** Commit menu Reset Current Branch to Here: `mode` and `argv` as shown; `dirty` (required for `hard`): the `git.commitMenu` fingerprint of the files the reset would lose. Reply GitWriteResult. */
  | { type: "git.reset"; cwd: string; hash: string; mode: "soft" | "mixed" | "hard"; headRef: string; headHash: string; argv: string[]; dirty?: string; exact?: true }
  /** The unfinished git operation of `cwd`'s repository (the Changes tab banner in Session mode, which has no `git.diff`). Reply GitOperationResult. */
  | { type: "git.operation"; cwd: string; exact?: true }
  /** Graph tab stash list of `cwd`'s repository, newest first (at most 500). Reply GitStashListResult. */
  | { type: "git.stashList"; cwd: string; exact?: true }
  /** Stash the local changes (`git stash push`); `includeUntracked`: also untracked files. Nothing to save: `bad_request`. Reply GitWriteResult. */
  | { type: "git.stashPush"; cwd: string; message?: string; includeUntracked?: boolean; exact?: true }
  /** Apply, pop or drop `stash@{index}`; `hash`: the entry's commit as the list showed it (another one there now: `stale`). Apply/pop conflict: a success whose reply carries `operation`. Reply GitWriteResult. */
  | { type: "git.stashApply" | "git.stashPop" | "git.stashDrop"; cwd: string; index: number; hash: string; exact?: true }
  /** Claude writes a commit message for `paths` (GH-559). `project`: the project cwd, the key of `git.commitMessageInstructions`. */
  | { type: "git.commitMessage"; cwd: string; paths: string[]; project?: string; exact?: true }
  /** Stops this connection's running `git.commitMessage` (it replies `cancelled`). */
  | { type: "git.commitMessageCancel" }
  /** Pull `ref` (fast-forward only) as `git.branch` showed it; `local`: the sha shown; `argv`: the command shown. Reply GitRemoteResult. */
  | { type: "git.pull"; cwd: string; ref: string; local: string; argv: string[]; /** The remote-tracking hash the dialog showed (`upstreamHash`), absent when none; a different one now is `stale`. */ tracking?: string; exact?: true }
  /**
   * Creates a worktree in `<repo>/.claude/worktrees/` (docs/spec.md "Worktrees"). `name` only: folder `<name>` on branch `worktree-<name>`; nothing: a generated
   * name. `branch` (GH-447, may contain `/`): a new Created branch, folder = `branch` with `/` → `-`; `base`: its start point (a commit-ish, the Base picker
   * sends a full ref), default the "Worktrees" base rule. `checkout`: an existing branch (`refs/heads/x`, or `refs/remotes/<remote>/x` as a new local
   * `x` tracking it), not marked; no name, branch or base with it. Reply WorktreeCreateResult. Broadcasts `sessions.changed`.
   */
  | { type: "worktree.create"; cwd: string; name?: string; branch?: string; base?: string; checkout?: string }
  /** Local and remote branches for the Create worktree modal (GH-447); `fetch`: `git fetch --prune origin` first. Reply WorktreeBranchesResult. */
  | { type: "worktree.branches"; cwd: string; fetch?: boolean }
  /** A pasted pull request link (GitHub, GitLab, Bitbucket Server) of `cwd`'s origin: the origin branches at its head commit. Reply PullRequestBranchesResult; errors pr_other_repo, pr_not_found, pr_unsupported, git_failed. */
  | { type: "worktree.pr"; cwd: string; url: string }
  /** What removing `path` loses and whether it may be removed (docs/spec.md "Worktrees"); reply WorktreeStatusResult. */
  | { type: "worktree.status"; cwd: string; path: string; /** A Clean up scan or warming read: low git priority, cancelled by `worktree.cancel`. */ scan?: string }
  /** The last preview status of each path, without git (GH-463); `stale: true` when it would be recomputed. Reply WorktreeCachedResult. */
  | { type: "worktree.cached"; cwd: string; paths: string[] }
  /** Cancels the queued and running `worktree.status` requests of `scan` (replied `cancelled`). Reply {}. */
  | { type: "worktree.cancel"; scan: string }
  /**
   * `git worktree remove --force` of a linked worktree inside the roots (not main, not locked, not a symlink), then `git branch -D` for a Created branch (git config `branch.<name>.claudeUiCreated`, or legacy `worktree-*`; ADR 0005),
   * `git branch -d` for another one only with `deleteBranch`; `expectSafe`: refused with `stale` unless status is still safe; `expect`: refused with `stale` when the current status has more uncommitted files, commits ahead or ignored files than listed (checked before and after the sessions and terminals close). Transcripts stay.
   * Reply WorktreeRemoveResult. Broadcasts `sessions.changed`.
   */
  | { type: "worktree.remove"; cwd: string; path: string; expectSafe?: boolean; expect?: { uncommitted: number; ahead: number; ignored?: number }; deleteBranch?: boolean }
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
  // Addons (docs/spec.md "Addons"): Hub only, never routed to a Side. Each write broadcasts `config.changed` (kind addons, cwd "").
  /** Reply AddonsListResult. Re-reads local-folder addons. */
  | { type: "addons.list" }
  /** Clones (git) or reads (local) and validates; stored with approved [] (state needs_approval). Reply AddonInfo. */
  | { type: "addons.install"; source: AddonSource }
  /** git fetch; reply AddonUpdateCheck. */
  | { type: "addons.checkUpdate"; name: string }
  /** Checks out `sha` (the last checkUpdate's latest). Reply AddonInfo. */
  | { type: "addons.update"; name: string; sha: string }
  /** Approves `capabilities` (must equal the declared set) and enables. Reply AddonInfo. */
  | { type: "addons.approve"; name: string; capabilities: string[] }
  | { type: "addons.setEnabled"; name: string; enabled: boolean }
  /** Removes the record and, for git, `<config>/addons/<name>/`. Reply `{}`. */
  | { type: "addons.uninstall"; name: string }
  /** `target`: `fence:<lang>` or `tool:<name>`. Reply `{}`. */
  | { type: "addons.pickRenderer"; target: string; name: string }
  // Updates (docs/spec.md "Updates").
  /** Asks the registry now (Settings > About, the palette); reply UpdateCheckResult. A newer version also goes out as update_available. */
  | { type: "update.check" }
  /** Installs the available version into the daemon's versions dir; reply UpdateInstallResult. The daemon keeps running. */
  | { type: "update.install" }
  /** Restarts into the installed version once every session is idle (`now`: at once); reply UpdateRestartResult. */
  | { type: "update.restart"; now?: boolean }
  /** Creates (on) or removes the OS launcher shortcut on the Hub's machine (docs/spec.md "Launcher shortcut"). Reply `{installed}`; errors shortcut_unavailable, shortcut_failed. */
  | { type: "launcher.shortcut"; on: boolean }
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
 * Paged subscribe reply: `heads` = the latest session_state, commands, context_usage, external_turn, auto_continue, limit_stop, prompt_queue, todo_update events; `aux` = parts of the
 * unloaded region that whole-session features need (subagent, turn_result, running background Bash calls).
 */
export type Snapshot = { heads: Event[]; attentionSeq: number; page: TimelinePage; aux: PosPart[] };
export type PageResult = { page: TimelinePage };
export type MediaResult = { dataUrl: string };
export type EditsResult = { parts: PosPart[] };
export type ArtifactsResult = { parts: PosPart[] };

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
  /** To every connection when OpenCode read a changed provider set (after a login or logout): its model list is stale. */
  | { type: "opencode.providersChanged" }
  /** To every connection of this daemon after `settings.set`. */
  | { type: "settings_changed"; settings: Settings; jiraToken?: boolean; claudeAccounts?: ClaudeAccountInfo[] }
  /** On connect: this daemon runs older code than is on disk (a source checkout changed after the start, or a newer install waits for a restart). `note` says which. */
  | { type: "daemon_stale"; note: string }
  /** GH-518: the Hub's machine slept while a session ran; to every connection when found, the last one again to each new connection. */
  | { type: "daemon_slept"; at: number; gapMs: number }
  /** To every connection after a config write (e.g. `mcp.add`) in `cwd`: an open dialog of that project refreshes (`cwd` "" for addons: Hub-wide). `reloadFailed`: set when plugins were reloaded: the sessions whose reload failed (empty: none; restart banners then clear). */
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
/** `latest`: the newer version the daemon offers, none when this one is the latest. */
export type UpdateCheckResult = { current: string; latest?: string };
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
/** `from`: the Aside question's user_text part id: the popup subscribes from it (only the Aside's own messages). */
export type AsideOpenResult = { session: SessionInfo; title: string; from: string };
/**
 * `logEpoch` differs from the one the client sent: its store belongs to an earlier daemon run and the events are a full replay.
 * `seq`: the last event seq when `session` was read; the replayed events up to it are older than `session`.
 */
/** `title`: as `session.list` titles the session, for a tab opened before (or without) the list. */
/** `planDirs`: the folders the session's CLI keeps plan files in (absolute), to find the plan of an ExitPlanMode call written there. */
export type SubscribeResult = { logEpoch: string; seq: number; session: SessionInfo; title: string; snapshot?: Snapshot; planDirs?: string[] };
/** session.setModel, session.setPermissionMode, session.setEffort. */
export type SetModelResult = { session: SessionInfo };
/** opencode.status: `missing` no binary, `old` below OPENCODE_MIN, `failed` the last start failed, `stopped` found and not started, `running`. */
export type OpenCodeStatus = { state: "running" | "stopped" | "missing" | "old" | "failed"; version?: string; path?: string; message?: string };
export type OpenCodeAuthPrompt = { type: "text"; key: string; message: string; placeholder?: string; when?: { key: string; op: "eq" | "neq"; value: string } } | { type: "select"; key: string; message: string; options: { label: string; value: string; hint?: string }[]; when?: { key: string; op: "eq" | "neq"; value: string } };
export type OpenCodeAuthMethod = { type: "api" | "oauth"; label: string; prompts?: OpenCodeAuthPrompt[] };
/** `source`: where the connection comes from; only `api` and `custom` (OAuth, plugin) can be logged out. */
export type OpenCodeProvider = { id: string; name: string; connected: boolean; source?: "env" | "config" | "custom" | "api"; methods: OpenCodeAuthMethod[] };
/** opencode.providers, and the login and logout requests that end with a changed list. */
export type OpenCodeProvidersResult = { providers: OpenCodeProvider[] };
/** opencode.login with an OAuth method: open `url`; `auto` = OpenCode finishes by itself, `code` = the user pastes a code. */
export type OpenCodeLoginStart = { url: string; mode: "auto" | "code"; instructions: string };
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
  /** Every Engine of this daemon with its flags and the modes a new session starts with; the new-session tab reads the selected one. Absent (an older daemon): claude only. */
  engines?: { engine: Engine; capabilities: EngineCapabilities; permissionModes: PermissionMode[] }[];
  /** A daemon with sides (WSL distros, Docker containers): every side, this daemon's own ("local": Windows, Linux or macOS) first. Absent: no sides. */
  sides?: SideInfo[];
  /**
   * A hub with the docker command: `ok` (a running Linux container exists), `empty` (the engine runs none) or `down` (the engine does not answer).
   * Absent: no docker command, or a daemon without this field (the Docker kind then shows only when a Docker side is listed).
   */
  docker?: DockerState;
  /** A hub with the ssh command: the SSH kind shows (and Add SSH host works) even with no host in the ssh config. */
  ssh?: true;
  /** Side of each listed project, recent project and session cwd that is not local. */
  cwdSides?: Record<string, string>;
  /** Git worktrees of each listed project that is in a git repository (docs/spec.md "Projects"), the main worktree first. */
  worktrees?: Record<string, Worktree[]>;
};
/**
 * A git worktree of a project's repository, identified by its directory (canonical path). `main`: the repository's own checkout.
 * `branch`: the short hash on a detached HEAD. `outsideRoots`: listed, but no session can start there. `locked`: `git worktree lock`; never removable. `detached`: HEAD is detached (`branch` is then a short hash, not a branch).
 */
export type Worktree = { path: string; branch?: string; main: boolean; outsideRoots?: boolean; locked?: true; detached?: true; /** A removal is running (`worktree.remove` holds its mark). */ removing?: true };
export type WorktreeCreateResult = { path: string; branch: string };
/** One branch name of `worktree.branches`: `local` (refs/heads), `remote` (full ref, `origin` preferred), `worktree`: the path it is checked out in. */
export type BranchRow = { name: string; local: boolean; remote?: string; worktree?: string };
/**
 * `defaultBase`: the start point a new branch gets without a base, as text (`origin/main`, `HEAD`). `fetched`: the fetch ran;
 * `fetchError`: it failed (offline), the list holds the local refs.
 */
/** `worktree.pr`: the pull request number and the origin branch names at its head (empty: merged and deleted, or pushed over). */
export type PullRequestBranchesResult = { number: number; branches: string[] };
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
 * `ignored`: ignored files that removal deletes (ignored directories git reports as a whole are not counted); absent in the preview (counted at removal only); `headTime`: ms of HEAD's last reflog write; `running`: its sessions that run or need input. `safety`: "blocked" when `blocked` is set, else
 * "has_work" when `uncommitted` or `ahead` (unless `mergedInto`), else "safe".
 */
export type WorktreeCachedResult = { statuses: Record<string, WorktreeStatusResult & { stale?: true }> };
export type WorktreeStatusResult = { /** ms since epoch of the git read behind this result. */ checkedAt: number; uncommitted: number; untracked: number; commits: number; ahead: number; ignored?: number; branch: string; branchMerged: boolean; headTime?: number; running: number; safety: "safe" | "has_work" | "blocked"; blocked?: WorktreeBlock; /** The changes are already in this base ref (squash or rebase merged). */ mergedInto?: string; /** The upstream branch was deleted on the remote (`[gone]`). */ upstreamGone?: true; /** GH-447: the branch is a Created branch (ADR 0005); removal deletes it. */ createdBranch?: true };
/** `branchKept`: why a kept branch the caller asked to delete stays (git's message). */
/** `ignoredDeleted`: ignored files removal deleted (counted at removal; the preview does not count them). */
export type WorktreeRemoveResult = { branchKept?: string; ignoredDeleted?: number };
/** Claude Code's worktree name rule; undefined when `name` is valid. */
export function worktreeNameError(name: string): string | undefined {
  if (!name || name.length > 64) return "Name must be 1 to 64 characters";
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return "Only letters, numbers, dots, hyphens, and underscores";
  if (name === "." || name.includes("..") || name.toLowerCase() === ".git") return "Name cannot be ., .git or contain ..";
}
/**
 * One Claude Code install the daemon reaches: its own (`local`), a WSL distro (`wsl:<distro>`), a running Docker container (`docker:<name>`) or an SSH host (`ssh:<alias>`), each with its own login,
 * transcripts, settings, MCP servers and plugins. `off`: not started yet (side.start sets it up); `error`: `message` says what to do.
 */
export type SideInfo = {
  id: string;
  label: string;
  /** `reconnecting`: the pipe to the Hub of the Side dropped; that Hub keeps running and this hub attaches again. */
  state: "off" | "starting" | "ready" | "reconnecting" | "error";
  message?: string;
  phase?: SidePhase;
  /** Docker, while starting: the install uses the host-assembled bundle (no npm in the container). */
  bundle?: boolean;
  /** Docker, while starting or after a failed start: why the install uses npm in the container instead of the bundle. */
  fallback?: string;
  /** While starting: why the Node.js found in the container or distro was not used (it did not start claude-ui), so claude-ui brings its own. */
  nodeNote?: string;
  /** Saved: the hub starts this side with itself ("Start with Claude UI"). */
  autoStart?: true;
  /** Only `false`: the hub does not update this side's claude-ui by itself. */
  autoUpdate?: false;
  /** Minutes the Hub that an attach started there keeps running with no hub attached, no browser and no turn (Grace period; default 30). */
  graceMinutes?: number;
  /** Ready: the Hub there was started by an attach and runs another build; it is replaced by this build once nothing runs there. */
  updatePending?: true;
  /** `error`: the Hub there speaks no frame schema of ours (ADR 0009). `remoteOlder`: Update (side.updateRemote) can fix it; else this claude-ui must be updated. `remoteSchema` absent: a Hub without an attach socket. */
  mismatch?: { local: string; remote: string; localSchema: [number, number]; remoteSchema?: [number, number]; remoteOlder: boolean };
  /** `off` and the installed claude-ui is not this build: an update is needed (Update). */
  update?: true;
  /** A saved side the hub does not list now (a Docker container that is not running); named for Settings and the sidebar. */
  missing?: true;
};
/** What a starting side is doing (`SideInfo.phase`, only while `state` is `starting`). `downloading`: the hub fetches bundle parts. */
export type SidePhase = "downloading" | "packing" | "copying" | "installing" | "starting";
/** The Docker engine as the hub sees it (`ListResult.docker`). */
export type DockerState = "ok" | "down" | "empty";
/** `side.start` setup mode: run only what is installed, install when needed (default), install again. */
export type SideSetup = "never" | "needed" | "force";
/** `running`/`starting`: the side is up (nothing was run); `installed`: this build is installed, or a schema-compatible Hub runs there (can start); `install`/`update`: setup is needed; `blocked`: see `reason`. */
export type SideCheckVerdict = "running" | "starting" | "installed" | "install" | "update" | "blocked";
/** Why a check is blocked. */
export type SideCheckReason = "gone" | "not_running" | "unreachable" | "no_build" | "package_unreadable" | "node_missing" | "node_old" | "build_tools_missing" | "unpack_tools_missing" | "no_writable_path" | "npm_missing" | "windows_host" | "check_failed";
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
  /** Docker, WSL or SSH: the CPU (`uname -m`), C library and glibc version; `os`: an SSH host's `uname -s` (absent: Linux). */
  target?: { arch: string; libc: "glibc" | "musl" | "unknown"; glibc?: string; os?: string };
  /** Docker, WSL or SSH: how an install gets claude-ui in: the host-assembled bundle, or npm in the container, distro or host (`reason`: why not the bundle). */
  install?: { method: "bundle" | "npm"; reason?: string; /** Bundle only, when the hub looked at its cache: every part file is there (`cached`), or the start must download them (`download`). */ parts?: "cached" | "download" };
  /** Docker, WSL or SSH: tools and libraries found (each item of "What this container needs"). */
  tools?: { tar: boolean; gzip: boolean; npm: boolean; git: boolean; cxxRuntime: boolean };
  /** Docker: false when the container has no network (`--network none`). */
  network?: boolean;
  /** Docker or WSL: the installed build carries its own Node.js (a bundle install). */
  bundled?: boolean;
  /** A live Hub there whose frame schema overlaps ours (GH-619): a start bridges through it, nothing is installed. */
  hub?: { version: string };
};
/** Reply of `ssh.add`: the new SSH Side (`ssh:<alias>`), already in the list. */
export type SshAddResult = { side: string };
/** Reply of `side.check`. `message`: the user's next step in plain words (blocked, install, update). `key`: this claude-ui build. */
export type SideCheck = { verdict: SideCheckVerdict; reason?: SideCheckReason; message?: string; key: string; facts: SideCheckFacts; phase?: SidePhase };
export const LOCAL_SIDE = "local";
/** `lastActivity`: ms of its newest session. */
export type RecentProject = { cwd: string; sessionCount: number; lastActivity: number };
/** `cwd`: the canonical path of the opened project. */
export type ProjectOpenResult = { cwd: string };
export type FsListResult = { entries: FsEntry[] };
/** Dry run of a code rewind: files it would restore (empty = no code options); `conversation` false for the first prompt. */
export type RewindPreview = { filesChanged: string[]; insertions: number; deletions: number; conversation: boolean; /** The modes the engine offers; absent = all the preview allows. */ modes?: RewindMode[] };
/** Paths relative to the searched cwd, best first; folders end with `/`. */
export type FsSearchResult = { paths: string[] };
export type FsReadResult = { content: string; mtime: number };
/** `url`: same-origin path, valid while this connection is open and used within 10 min. */
/** `unavailable`: published paths of supporting files named in the call that this preview does not serve (absent when none; GH-335). */
/** `title`: the publish's title (GH-400), else the file's base name: names an artifact tab whose part a paged snapshot did not load. */
export type ArtifactPreviewResult = { url: string; size: number; mtime: number; unavailable?: string[]; title?: string };
export type FsMediaResult = { url: string; mime: string; size: number; mtime: number };
/** `data`: base64 of the bytes at the offset (shorter at the end of the file); `size` of the whole file; `mtime` 0 for a file at a commit. */
export type MediaReadResult = { data: string; size: number; mtime: number; mime: string };
export type FsWriteResult = { mtime: number };
/** The path an fs.create / fs.rename / fs.duplicate made (parent as fs.list gives it, plus the name). */
export type FsPathResult = { path: string };
/** `rel`: path below the walked path with `/` ("" = the path itself); folders come before their content. `target`: the text of a link. */
export type FsWalkEntry = { rel: string; kind: "file" | "dir" | "link"; size: number; mode: number; target?: string };
export type FsWalkResult = { entries: FsWalkEntry[]; bytes: number };
/** `data`: base64; `size`: of the whole file. */
export type FsChunkResult = { data: string; size: number };
/** Limits of one paste or drop (GH-555), checked before anything is written. */
export const TRANSFER_MAX_BYTES = 512 * 1024 * 1024;
export const TRANSFER_MAX_ENTRIES = 10_000;
/** Largest piece of fs.readChunk / fs.writeChunk. */
export const CHUNK_BYTES = 1024 * 1024;
/** Entries below the folder (none for a file or link); `more`: the count stopped at 10 000 entries or 2 s. */
export type FsDeleteResult = { files: number; folders: number; more?: boolean };
/** `title`: "Terminal N", the smallest N free in its cwd. */
/** `login`: runs the Claude CLI login (`claude auth login`), not a shell. */
export type TerminalInfo = { id: string; title: string; login?: true };
export type TerminalCreateResult = { terminal: TerminalInfo };
export type TerminalListResult = { terminals: TerminalInfo[] };
/** `buffer`: the last output (capped), to replay into a fresh view. */
export type TerminalAttachResult = { buffer: string };

/** Larger `terminal.input` data (UTF-8 bytes) is refused (`too_large`); the panel sends a big paste in parts. */
export const MAX_TERMINAL_INPUT_BYTES = 64 * 1024;
/**
 * `branch`: short commit hash on a detached HEAD. `added`/`removed`: lines changed in tracked files against HEAD.
 * `refs`: opaque stamp of the repository's refs (file stats of HEAD, packed-refs, refs folders, worktree HEADs); changes when a branch, tag, HEAD or packed refs change. Compare for equality only.
 * `files`: tracked files changed against HEAD (binary and moved submodules included; a submodule with only uncommitted changes is not counted). `added`/`removed` leave submodules out.
 */
export type GitStatus = { branch: string; added: number; removed: number; files?: number; refs?: string };
/** `refs` null outside a git work tree. */
/** A repository of `git.repos`. */
export type GitRepo = {
  /** Canonical top. */
  path: string;
  /** `path` relative to the request's canonical cwd, `/` separated; "" = the cwd itself, ".." segments above it. */
  rel: string;
  /** main: the cwd's own repository; submodule: listed in its parent's `.gitmodules` and checked out; nested: any other repository found by the scan, `scanRepositories` or an open file. */
  kind: "main" | "submodule" | "nested";
  /** The listed repository that contains it (the superproject for a submodule). */
  parent?: string;
  /** Branch name, or 7 hex characters of a detached HEAD; read from files. */
  branch?: string;
  /** Its git dir, alternates or top lie outside the allowed roots: listed, never read or used. */
  outsideRoots?: true;
};
export type GitReposResult = { repos: GitRepo[]; truncated?: { scan?: "entries" | "time" | "count"; submodules?: { repo: string; count: number }[] } };
export type GitRefsResult = { refs: string | null };
/** `status` null outside a git work tree. */
export type GitStatusResult = { status: GitStatus | null };
/** Why an entry exists: a write is about to replace the stored content. `save`: editor save; `agent`: Edit/Write of the agent; `rollback`, `checkout`, `reset`, `stash-drop`: a git write; `restore`: a restore from the Timeline; `named`: made by the user. `paste`: a paste replaced the file (GH-555). */
export const HISTORY_REASONS = ["save", "agent", "rollback", "checkout", "reset", "stash-drop", "abort", "restore", "named", "paste"] as const;
export type HistoryReason = (typeof HISTORY_REASONS)[number];
/** `time`: ms since epoch; `label`: set by `named` entries and renames; `size`: bytes. */
export type HistoryEntry = { id: string; time: number; reason: HistoryReason; label?: string; size: number };
export type HistoryListResult = { entries: HistoryEntry[] };
/** `refs`: full ref names pointing here ("HEAD" first when HEAD points here). `time`: author time, unix seconds. */
export type GitCommit = { hash: string; parents: string[]; author: string; email: string; time: number; subject: string; refs: string[] };
/**
 * First page only (skip 0): `branches`: full ref names of local and remote branches. `refs`: the refs stamp (as `GitStatus.refs`).
 * `head`: the full ref HEAD points to (`refs/heads/main`); absent when detached or unknown.
 */
export type GitLog = { commits: GitCommit[]; more: boolean; branches?: string[]; refs?: string; head?: string };
/** `log` null outside a git work tree. */
export type GitLogResult = { log: GitLog | null };
/** `author` / `time` (author time, unix s) / `summary` of one blamed commit. */
export type GitBlameCommit = { author: string; time: number; summary: string };
/** `lines[i]`: full hash of the commit of line i+1, `null` = not committed. `untracked`: the file is not in HEAD (or no commit yet): `lines` empty, every line not committed. */
export type GitBlame = { commits: Record<string, GitBlameCommit>; lines: (string | null)[]; untracked?: true };
/** `blame` null outside a git work tree. */
export type GitBlameResult = { blame: GitBlame | null };
/** `added`/`removed` undefined for a binary file. `oldPath`: renamed from. `untracked`: not in the index (status A; git.diff only). `submodule`: a gitlink (mode 160000) row; `from`/`to`: full commit recorded on the before/after side (absent: not a gitlink there, or unknown: the working-tree side). Such rows have no `added`/`removed`. */
export type GitFileChange = { status: "A" | "D" | "M" | "R"; path: string; oldPath?: string; added?: number; removed?: number; untracked?: boolean; submodule?: { from?: string; to?: string } };
/** `message`: full message. `refs`: always `[]` from `git.commit` (no decoration: slow with thousands of refs); the client shows the refs of the commit from `git.log`. `truncated`: more than 3000 files changed, list cut. */
export type GitCommitDetail = GitCommit & { message: string; committer: string; committerTime: number; files: GitFileChange[]; truncated?: boolean };
export type GitCommitResult = { commit: GitCommitDetail };
/**
 * `prefix`: the request cwd relative to the repository top ("/"-separated, "" or ending with "/"); `files[].path` are relative to the top.
 * `base`: the full hash of the before side; absent before the first commit (every file A, before side empty). `ref`: the branch compared (branch mode).
 * `branches`: local and remote branches for the picker (branch mode only). `truncated`: list cut at 3000 files.
 */
export type GitDiff = { prefix: string; base?: string; ref?: string; files: GitFileChange[]; branches?: string[]; truncated?: boolean; /** The unfinished merge, rebase, cherry-pick, revert, am or unmerged state of the repository (the conflict banner). */ operation?: GitOperation };
/** `conflict`: unmerged entries and no state file (stash pop, `checkout -m`). */
export type GitOperationKind = "merge" | "rebase" | "cherry-pick" | "revert" | "am" | "conflict";
/** `conflicted`: unmerged paths relative to the repository top, at most 3000. */
export type GitOperation = { kind: GitOperationKind; conflicted: string[] };
/** `operation` null: nothing unfinished, or outside a work tree. */
export type GitOperationResult = { operation: GitOperation | null };
/** A merge, rebase, continue or abort: git's output and the refs stamp; `operation` is set when it stopped on conflicts. `written` null outside a work tree. */
export type GitWriteResult = { written: { output: string; refs: string | null; operation?: GitOperation } | null };
/** One stash entry: `message` is the reflog subject ("On main: wip"), `time` seconds like \`GitCommit.time\`. */
export type GitStash = { index: number; hash: string; message: string; time: number };
/** `stashes` null outside a git work tree. */
export type GitStashListResult = { stashes: GitStash[] | null };
/** `diff` null outside a git work tree. */
export type GitDiffResult = { diff: GitDiff | null };
/** A remote operation's git output (redacted, at most 8000 chars) and the refs stamp after it. */
export type GitRemote = { output: string; refs: string | null };
/** `remote` null outside a git work tree. */
export type GitCommitted = { hash: string; output: string; refs: string | null; /** `push` was asked: `git.branch` data of HEAD's branch (the push dialog). */ push?: GitBranchInfo };
/** `committed` is null outside a git work tree. */
/** `truncated`: the diff in the prompt was cut (the file list was complete). */
export type GitCommitMessageResult = { message: string; truncated?: true };
export type GitCommitFilesResult = { committed: GitCommitted | null };
/** A file a rollback acts on: `A` added or untracked, `D` deleted, `R` renamed (`path` the new name), `M` the rest. */
export type GitRollbackFile = { path: string; kind: "M" | "D" | "R" | "A"; oldPath?: string };
export type GitRollbackPreview = { files: GitRollbackFile[]; token: string };
/** `preview` is null outside a git work tree. */
export type GitRollbackPreviewResult = { preview: GitRollbackPreview | null };
/** `rolledBack` is null outside a git work tree. */
export type GitRollbackResult = { rolledBack: { output: string } | null };
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
  /** Hash of the upstream's remote-tracking ref (pull's stale check). */
  upstreamHash?: string;
  ahead?: number;
  behind?: number;
  isDefault?: boolean;
  push?: string[];
  forcePush?: string[];
  pull?: string[];
  /** HEAD's branch (`refs/heads/x`) and commit: what Merge and Rebase were computed against. Absent when HEAD is detached or unborn. */
  headRef?: string;
  headHash?: string;
  merge?: string[];
  rebase?: string[];
  why?: { push?: string; forcePush?: string; pull?: string; merge?: string; rebase?: string };
};
/** `branch` null outside a git work tree. */
export type GitBranchResult = { branch: GitBranchInfo | null };
/** What the commit menu shows for one commit and the exact git argv (without "git") of each action; an absent argv is unavailable and `why` says why. */
export type GitCommitMenu = {
  hash: string;
  parents: number;
  headRef?: string;
  headHash?: string;
  undo?: string[];
  revert?: string[];
  cherryPick?: string[];
  reset?: { soft: string[]; mixed: string[]; hard: string[] };
  /** Only with `hard`: the files a hard reset overwrites or deletes (at most 50), their count, and the fingerprint `git.reset` must send back. */
  lose?: string[];
  loseCount?: number;
  dirty?: string;
  why?: { undo?: string; revert?: string; cherryPick?: string; reset?: string };
};
/** `commitMenu` null outside a git work tree. */
export type GitCommitMenuResult = { commitMenu: GitCommitMenu | null };
export const GIT_LOG_MAX_LIMIT = 500;

/** Where an MCP server (or plugin setting) is saved; Claude Code's term. local: this project, private; user: all projects; project: `.mcp.json`. */
export type ConfigScope = "local" | "user" | "project";
/** App-wide settings (settings.json in the daemon config dir). A later setting is one more field here, in the daemon's `DEFAULTS` and `CHECKS`. */
/** `orchestration.workerMode`: the permission mode of a new worker when the coordinator names none; `coordinator` = the coordinator's own mode. */
export const WORKER_MODES = ["coordinator", "default", "acceptEdits", "plan", "auto"] as const;
export type WorkerModeSetting = (typeof WORKER_MODES)[number];
/** `sessions.defaultMode` values: the mode of a new session when Claude settings set no `permissions.defaultMode`. */
export const SESSION_MODES = ["default", "acceptEdits", "plan", "auto"] as const;
/** `git.autoRepositoryDetection` values (VS Code's git extension). */
export const AUTO_REPOSITORY_DETECTION = [true, false, "subFolders", "openEditors"] as const;
/** `git.openRepositoryInParentFolders` values (VS Code's git extension). */
export const PARENT_FOLDER_MODES = ["always", "never", "prompt"] as const;
/** Custom name and icon of a project or a side (GH-515). `icon`: emoji text, or a png/webp/jpeg data URL (no svg). */
export type Label = { name?: string; icon?: string };
export const LABEL_NAME_MAX = 60;
/** UTF-16 units. */
export const LABEL_EMOJI_MAX = 16;
/** Data URL characters. */
export const LABEL_ICON_MAX = 32_000;
/** Entries per map. */
export const LABEL_ENTRIES_MAX = 200;
/** Longest commit message instruction, global or per project (GH-559). */
export const COMMIT_INSTRUCTION_MAX = 4000;
/** What Claude is asked when no instruction is set (the Settings › Git placeholder shows it). */
export const DEFAULT_COMMIT_INSTRUCTION = "Write a conventional commit message: a subject line of at most 72 characters in the imperative mood (type(scope): summary), a blank line, then a short body that explains what changed and why. Plain text.";
/** Side of the saved square image icon, in pixels. */
export const LABEL_ICON_PX = 64;
/** Side of the saved square app icon, in pixels (the PWA icon size). */
export const APP_ICON_PX = 512;
/** Data URL characters of the app icon. */
export const APP_ICON_MAX = 300_000;
/** The app name when `Settings.app.name` is "". */
export const APP_NAME_DEFAULT = "Claude UI";
export type Settings = { orchestration: { enabled: boolean; /** Live workers of one root coordinator's tree, every depth, plus its worker_start calls in flight. */ workerCap: number; /** Live workers of this daemon, all trees; 0 = no limit. */ workerCapTotal: number; /** Depth = coordinatorId hops from the root coordinator; a worker at this depth may not start workers. */ maxDepth: number; /** Live direct workers one coordinator may run. */ maxChildren: number; /** A running worker whose CLI sends no message for this long raises a `stalled` event to its coordinator; 0 = off. */ stallMinutes: number; coordinatorPermissions: boolean; workerMode: WorkerModeSetting; /** Off: a worker's finished, needs-input and error notify nobody but its coordinator; an escalated request still does (GH-387). */ workerNotifications: boolean; /** GH-574: a worker whose turn ends settled loses its CLI (worker_send resumes it). */ closeFinished: boolean }; /** New session mode when Claude settings set none; `auto` on a model without auto support runs in `default`. */ sessions: { defaultMode: (typeof SESSION_MODES)[number]; /** The Engine of the last session created: the new-session tab starts with it. */ engine: Engine }; /** OpenCode engine (docs/spec.md "OpenCode engine"): `path` of its binary, "" = look it up on PATH. */ opencode: { path: string }; usageLimit: { autoContinue: boolean }; focus: { /** Claude predicts the next prompt after a turn (SDK promptSuggestions); applies to sessions started or resumed after the change. */ nextForYou: boolean }; notifications: { desktop: boolean };
  /** Keep computer awake (GH-523): the Hub holds an OS sleep inhibitor while a session runs. */
  power: { keepAwake: boolean };
  /** Performance monitor (GH-272): measures the daemon; off stops every observer and the sampling. */
  performance: { monitor: boolean };
  /** Claude in Chrome (GH-514): new non-worker sessions run the CLI with --chrome; applies when a session's query (re)starts. */
  chrome: { enabled: boolean };
  /** Claude account (GH-615): `""` = Default (the Daemon's environment), `"cli"` = the CLI login (no CLAUDE_CODE_OAUTH_TOKEN), else the id of a token account. Hub-local. */
  claude: { account: string };
  /** Local history (GH-565): `exclude` globs (matched on the absolute path with / separators) are never stored. */
  history: { enabled: boolean; exclude: string[] };
  /** Ticket tab of the Create worktree modal (GH-447): one Jira connection; `email` for Cloud only; the token is in secrets.json, never here. */
  jira: { url: string; email: string; template: string; /** Ticket filter: the JQL of the Ticket tab's list and text search; "" = my open tickets. */ jql: string };
  /** Settings › Git (VS Code's git extension settings, same names and values; openRepositoryInParentFolders defaults to always and prompt behaves as always). */
  git: {
    autoRepositoryDetection: boolean | "subFolders" | "openEditors";
    /** -1..10, -1 = no limit. */
    repositoryScanMaxDepth: number;
    repositoryScanIgnoredFolders: string[];
    /** Relative to the project cwd. */
    scanRepositories: string[];
    /** Absolute, or relative to the project cwd. */
    ignoredRepositories: string[];
    detectSubmodules: boolean;
    /** 0..100. */
    detectSubmodulesLimit: number;
    ignoreSubmodules: boolean;
    openRepositoryInParentFolders: (typeof PARENT_FOLDER_MODES)[number];
    /** GH-559: what Claude is asked for when it writes a commit message; "" = the built-in instruction. At most COMMIT_INSTRUCTION_MAX chars. */
    commitMessageInstruction: string;
    /** Per project (key: project cwd) instruction; wins over `commitMessageInstruction`. Value 1..COMMIT_INSTRUCTION_MAX chars. A patch replaces the whole map. */
    commitMessageInstructions: Record<string, string>;
  };
  /** Custom names and icons (GH-515), shared by every browser. Key: project cwd, or side id (`local`, `wsl:<distro>`, `docker:<name>`). A patch replaces the whole map. */
  labels: { projects: Record<string, Label>; sides: Record<string, Label> };
  /** Settings › Launcher (GH-553): start options of claude-ui on the Hub's machine; apply on the next start, a flag or env var wins. */
  launcher: {
    /** Web UI port. */
    port: number;
    /** [] = home directory. */
    roots: string[];
    tailscale: boolean;
    lan: boolean;
    allowBypass: boolean;
    updateCheck: boolean;
    osNotify: boolean;
    /** Open the browser at start. */
    open: boolean;
  };
  /** The app icon and name shared by every browser (tab and installed app); served at /app-icon and in /manifest.webmanifest. */
  app: { /** "" = the built-in icon; else an emoji (≤ LABEL_EMOJI_MAX) or a data:image/(png|webp|jpeg);base64 URL of a square APP_ICON_PX image (≤ APP_ICON_MAX). */ icon: string; /** "" = "Claude UI"; else 1..LABEL_NAME_MAX chars, no control characters, not only whitespace. */ name: string };
};
export type SettingsPatch = { [S in keyof Settings]?: Partial<Settings[S]> };
/** `daemon`: where the daemon runs (the desktop notification row names it) and whether it was started without desktop notifications (`--no-os-notify`). Absent from an older daemon. */
export type ClaudeAccountInfo = { id: string; name: string };
/** An editor the hub can open a path in. */
export type EditorId = "code" | "cursor" | "idea";
export type SettingsResult = { settings: Settings; daemon?: { host: string; version?: string; desktopForcedOff?: true; /** The daemon's own environment has CLAUDE_CODE_OAUTH_TOKEN: the Default Claude account is that token. */ claudeEnvToken?: true; /** This daemon can hold a sleep inhibitor (`supported`) and the last failure (`error`, kept until the setting is turned off); absent from a side or an older daemon. */ keepAwake?: { supported: boolean; error?: string }; /** The OS launcher shortcut exists; absent: this daemon cannot make one (side, older daemon, other OS). */ shortcut?: { installed: boolean }; /** Editors found on the hub (fs.openExternal `with`); absent from a side or an older daemon. */ editors?: { id: EditorId; label: string }[] }; /** A Jira token is saved (the token itself is write-only). */ jiraToken?: boolean; /** The saved Claude token accounts, without tokens. */ claudeAccounts?: ClaudeAccountInfo[]; /** An old-format token was cleared by a security update and none is saved since (GH-487). */ jiraTokenReset?: true };
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
export type ConfigKind = "mcp" | "plugins" | "skills" | "addons" | "models";
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
/** session.shellOutput: `truncated` when the file holds more than `output`. */
export type ShellOutputResult = { output: string; truncated: boolean };
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

// Addons (docs/spec.md "Addons", ADR 0006).
export type AddonSource = { kind: "git"; url: string; ref?: string } | { kind: "local"; path: string };
export type AddonView = { id: string; title: string; entry: string; kind: "pane" | "band"; phone?: boolean };
export type AddonCommand = { name: string; description: string; argumentHint?: string };
export type AddonRenderer = ({ fence: string } | { tool: string }) & { entry: string };
/** Colours per palette key (themes.ts KEYS); a mode may be partial: the web drops incomplete modes. */
export type AddonTheme = { id: string; name: string; light?: Record<string, string>; dark?: Record<string, string> };
export type AddonManifest = {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  themes: AddonTheme[];
  css?: string;
  views: AddonView[];
  commands: AddonCommand[];
  commandsEntry?: string;
  renderers: AddonRenderer[];
};
/** needs_approval: declared capabilities not all approved (never enabled). error: the manifest does not load. */
export type AddonState = "enabled" | "disabled" | "needs_approval" | "error";
export type AddonInfo = { name: string; source: AddonSource; sha?: string; manifest?: AddonManifest; approved: string[]; state: AddonState; error?: string; /** `/addon/<nonce>/<name>/`: only when enabled. */ base?: string };
export type AddonsListResult = { addons: AddonInfo[]; picks: Record<string, string> };
export type AddonUpdateCheck = { name: string; current: string; latest: string; added: string[]; removed: string[]; error?: string };
