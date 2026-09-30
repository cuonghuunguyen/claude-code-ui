// WebSocket wire protocol (docs/spec.md "Wire protocol"). JSON, one message per frame.
import type { Part, SessionState } from "./parts.ts";

export type SessionInfo = { id: string; cwd: string; state: SessionState };

/** Every client message carries a `reqId`; the daemon answers with a `reply` or an `error` with the same `reqId`. */
export type ClientMessage = { reqId: string } & (
  | { type: "session.create"; cwd: string; model?: string }
  | { type: "session.subscribe"; sessionId: string; sinceSeq: number; logEpoch?: string }
  | { type: "session.prompt"; sessionId: string; text: string }
);

export type Event = { type: "event"; sessionId: string; seq: number; part: Part };

export type ServerMessage =
  | Event
  | { type: "reply"; reqId: string; result: unknown }
  | { type: "error"; reqId?: string; code: string; message: string };

export type CreateResult = { session: SessionInfo };
export type SubscribeResult = { logEpoch: string };
