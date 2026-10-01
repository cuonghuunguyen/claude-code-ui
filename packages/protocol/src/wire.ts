// WebSocket wire protocol (docs/spec.md "Wire protocol"). JSON, one message per frame.
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Effort, Part, PermissionMode, PlanUsage, SessionState } from "./parts.ts";

export type { ModelInfo };

/** Modes the permission mode chooser offers, in Claude Code's Shift+Tab order; bypass only when the daemon config enables it. */
export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];
export const EFFORTS: Effort[] = ["default", "low", "medium", "high", "xhigh", "max"];

/**
 * `model` is a `ModelInfo.value` from models.list; "default" = the SDK default model. `effort`: "default" = the model's default.
 * `permissionModes`: the modes this session can switch to (PERMISSION_MODES, without bypassPermissions unless enabled).
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
 */
export type SessionListItem = SessionInfo & { title: string; lastActivity: number; archived: boolean; transcript: boolean };
export type FsEntry = { name: string; path: string; isDir: boolean };

/** Every client message carries a `reqId`; the daemon answers with a `reply` or an `error` with the same `reqId`. */
export type ClientMessage = { reqId: string } & (
  | { type: "session.create"; cwd: string; model?: string }
  | { type: "session.subscribe"; sessionId: string; sinceSeq: number; logEpoch?: string }
  // images: data URLs (`data:image/png;base64,...`); png, jpeg, gif, webp.
  | { type: "session.prompt"; sessionId: string; text: string; images?: string[] }
  | { type: "session.setModel"; sessionId: string; model: string }
  /** Applies from the next turn on (`setPermissionMode()`); the session's start option before its query runs. */
  | { type: "session.setPermissionMode"; sessionId: string; mode: PermissionMode }
  /** Applies from the next turn on (`applyFlagSettings({effortLevel})`); the `effort` start option before the query runs. */
  | { type: "session.setEffort"; sessionId: string; effort: Effort }
  /**
   * Attach button, non-image file: the daemon stores it in a temp folder (a browser cannot tell a file's path)
   * and replies its absolute path, which the prompt gets as an `@path` mention. `data`: base64 content.
   */
  | { type: "fs.upload"; name: string; data: string }
  /** Stops the running turn; a no-op while idle. */
  | { type: "session.interrupt"; sessionId: string }
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
  /** Sets the SDK custom title (the terminal CLI shows it too). Needs a transcript: a session with no prompt yet has none. */
  | { type: "session.rename"; sessionId: string; title: string }
  | { type: "session.archive"; sessionId: string; archived: boolean }
  /** Removes the transcript. Refused while a turn runs or input is pending: stop it first. */
  | { type: "session.delete"; sessionId: string }
  /** Without `path`: the allowlisted roots. */
  | { type: "fs.list"; path?: string }
  | { type: "session.rewindPreview"; sessionId: string; userMessageId: string }
  | { type: "session.rewind"; sessionId: string; userMessageId: string; mode: RewindMode }
  /** @-mention autocomplete: fuzzy matches under `cwd` (a session's cwd, inside the roots). */
  | { type: "fs.search"; cwd: string; query: string }
  /** The daemon's VAPID public key, for `PushManager.subscribe()`. */
  | { type: "push.key" }
  | { type: "push.subscribe"; subscription: WebPushSubscription }
  /** The session this tab shows while focused and visible (none otherwise); pushes for it are suppressed. */
  | { type: "push.focus"; sessionId?: string }
  /** Text files only; `mtime` (ms) identifies the disk version. */
  | { type: "fs.read"; path: string }
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
);

/** `PushSubscription.toJSON()`. */
export type WebPushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushKeyResult = { publicKey: string };
/** Decrypted Web Push payload the service worker shows as a notification. */
export type PushPayload = { sessionId: string; title: string; body: string };

/** Claude Code `/rewind` modes: `both` restores code, then conversation. */
export type RewindMode = "code" | "conversation" | "both";

export type Event = { type: "event"; sessionId: string; seq: number; part: Part };

export type ServerMessage =
  | Event
  | { type: "reply"; reqId: string; result: unknown }
  /** A watched file changed on disk; `path` as given in `fs.watch`, `mtime` 0 when it was deleted. */
  | { type: "fs.changed"; path: string; mtime: number }
  /** Sent to every connection after a rename, archive or delete: refetch `session.list`. `deleted`: drop that session. */
  | { type: "sessions.changed"; deleted?: string }
  /** Plan usage, not a session event: on connect and on each change. `usage` null: no plan limits (API key, Bedrock, Vertex). */
  | { type: "plan_usage"; usage: PlanUsage | null }
  /** Output of an attached terminal. */
  | { type: "terminal.output"; terminalId: string; data: string }
  /** The terminal's shell exited (or it was closed); sent to every attached connection. The terminal is gone. */
  | { type: "terminal.exit"; terminalId: string; exitCode: number }
  | { type: "error"; reqId?: string; code: string; message: string };

export type CreateResult = { session: SessionInfo };
/**
 * `logEpoch` differs from the one the client sent: its store belongs to an earlier daemon run and the events are a full replay.
 * `seq`: the last event seq when `session` was read; the replayed events up to it are older than `session`.
 */
export type SubscribeResult = { logEpoch: string; seq: number; session: SessionInfo };
/** session.setModel, session.setPermissionMode, session.setEffort. */
export type SetModelResult = { session: SessionInfo };
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
 * `projects`: known project cwds, newest activity first: session cwds plus opened projects, minus removed ones.
 * `sessions`: only sessions of those projects.
 */
export type ListResult = { sessions: SessionListItem[]; projects: string[] };
/** `cwd`: the canonical path of the opened project. */
export type ProjectOpenResult = { cwd: string };
export type FsListResult = { entries: FsEntry[] };
/** Dry run of a code rewind: files it would restore (empty = no code options); `conversation` false for the first prompt. */
export type RewindPreview = { filesChanged: string[]; insertions: number; deletions: number; conversation: boolean };
/** Paths relative to the searched cwd, best first; folders end with `/`. */
export type FsSearchResult = { paths: string[] };
export type FsReadResult = { content: string; mtime: number };
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
