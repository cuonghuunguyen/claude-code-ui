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
  | { type: "models.list" }
  | { type: "session.list" }
  /** Without `path`: the allowlisted roots. */
  | { type: "fs.list"; path?: string }
);

export type Event = { type: "event"; sessionId: string; seq: number; part: Part };

export type ServerMessage =
  | Event
  | { type: "reply"; reqId: string; result: unknown }
  | { type: "error"; reqId?: string; code: string; message: string };

export type CreateResult = { session: SessionInfo };
/** `logEpoch` differs from the one the client sent: its store belongs to an earlier daemon run and the events are a full replay. */
export type SubscribeResult = { logEpoch: string; session: SessionInfo };
export type SetModelResult = { session: SessionInfo };
export type ModelsResult = { models: ModelInfo[] };

/**
 * WebSocket subprotocols (browsers cannot set headers on a WebSocket): the client offers
 * `[WS_PROTOCOL, TOKEN_PROTOCOL_PREFIX + token]`; the daemon answers with `WS_PROTOCOL`.
 */
export const WS_PROTOCOL = "claude-ui";
export const TOKEN_PROTOCOL_PREFIX = "token.";

export type ListResult = { sessions: SessionListItem[] };
export type FsListResult = { entries: FsEntry[] };
