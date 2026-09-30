// WebSocket wire protocol (docs/spec.md "Wire protocol"). JSON, one message per frame.
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { Part, SessionState } from "./parts.ts";

export type { ModelInfo };

/** `model` is a `ModelInfo.value` from models.list; "default" = the SDK default model. */
export type SessionInfo = { id: string; cwd: string; state: SessionState; model: string };
/** A `session.list` entry: a transcript from `listSessions()` (terminal CLI sessions too) or a session of this daemon run. */
export type SessionListItem = SessionInfo & { title: string; lastActivity: number };
export type FsEntry = { name: string; path: string; isDir: boolean };

/** Every client message carries a `reqId`; the daemon answers with a `reply` or an `error` with the same `reqId`. */
export type ClientMessage = { reqId: string } & (
  | { type: "session.create"; cwd: string; model?: string }
  | { type: "session.subscribe"; sessionId: string; sinceSeq: number; logEpoch?: string }
  // images: data URLs (`data:image/png;base64,...`); png, jpeg, gif, webp.
  | { type: "session.prompt"; sessionId: string; text: string; images?: string[] }
  | { type: "session.setModel"; sessionId: string; model: string }
  /** Stops the running turn; a no-op while idle. */
  | { type: "session.interrupt"; sessionId: string }
  /**
   * First answer wins; a later one gets `{ settled: false }`. "allow_always" applies `suggestions[ruleIndex]`
   * (all suggestions when ruleIndex is omitted). `message`: feedback for Claude with "deny".
   */
  | { type: "permission.respond"; requestId: string; decision: "allow" | "allow_always" | "deny"; ruleIndex?: number; message?: string }
  /** `answers`: question text -> answer. First answer wins, like permission.respond. */
  | { type: "question.respond"; requestId: string; answers: Record<string, string> }
  | { type: "models.list" }
  | { type: "session.list" }
  /** Without `path`: the allowlisted roots. */
  | { type: "fs.list"; path?: string }
  | { type: "session.rewindPreview"; sessionId: string; userMessageId: string }
  | { type: "session.rewind"; sessionId: string; userMessageId: string; mode: RewindMode }
  /** @-mention autocomplete: fuzzy matches under `cwd` (a session's cwd, inside the roots). */
  | { type: "fs.search"; cwd: string; query: string }
);

/** Claude Code `/rewind` modes: `both` restores code, then conversation. */
export type RewindMode = "code" | "conversation" | "both";

export type Event = { type: "event"; sessionId: string; seq: number; part: Part };

export type ServerMessage =
  | Event
  | { type: "reply"; reqId: string; result: unknown }
  | { type: "error"; reqId?: string; code: string; message: string };

export type CreateResult = { session: SessionInfo };
/** `logEpoch` differs from the one the client sent: its store belongs to an earlier daemon run and the events are a full replay. */
export type SubscribeResult = { logEpoch: string; session: SessionInfo };
export type SetModelResult = { session: SessionInfo };
/** permission.respond and question.respond. `settled`: false when the request was already settled (or unknown) and this answer was ignored. */
export type RespondResult = { settled: boolean };
export type ModelsResult = { models: ModelInfo[] };

/**
 * WebSocket subprotocols (browsers cannot set headers on a WebSocket): the client offers
 * `[WS_PROTOCOL, TOKEN_PROTOCOL_PREFIX + token]`; the daemon answers with `WS_PROTOCOL`.
 */
export const WS_PROTOCOL = "claude-ui";
export const TOKEN_PROTOCOL_PREFIX = "token.";

export type ListResult = { sessions: SessionListItem[] };
export type FsListResult = { entries: FsEntry[] };
/** Dry run of a code rewind: files it would restore (empty = no code options); `conversation` false for the first prompt. */
export type RewindPreview = { filesChanged: string[]; insertions: number; deletions: number; conversation: boolean };
/** Paths relative to the searched cwd, best first; folders end with `/`. */
export type FsSearchResult = { paths: string[] };
