// The daemon's message dispatch (CONTEXT.md "Area"): every client message type has exactly one handler, owned by one area module.
// `areas.ts` builds the areas of one connection; `createDispatch` merges their handlers into one lookup table.
import type { ClientMessage, ServerMessage } from "@claude-ui/protocol";
import type { Conn } from "./server.ts";

export type ClientType = ClientMessage["type"];
/** The message of one type. */
export type Msg<K extends ClientType> = Extract<ClientMessage, { type: K }>;

/** How a handler answers its request: a `reply` or an `error` with the request's `reqId`. */
export type Respond = {
  reply(result: unknown): void;
  fail(code: string, message: string, size?: number): void;
};
export type Handler<K extends ClientType> = (msg: Msg<K>, r: Respond) => unknown;
export type Handlers<K extends ClientType> = { readonly [P in K]: Handler<P> };

/** The handlers of one connection's share of the types `K`; `close` releases what the connection holds (aborts, watches, attachments, subscriptions). */
export type Area<K extends ClientType> = { handlers: Handlers<K>; close?(): void };

/** What a handler knows of the connection that sent the message. `ws` is the identity key of the connection. */
export type Connection = {
  ws: Conn;
  send(m: ServerMessage): void;
  /** The browser runs on the daemon's machine (ADR 0011). */
  sameHost: boolean;
  sameBrowser: boolean;
  /** The nonce this connection got for a media key (issued once per key). */
  nonceFor(key: string): string;
};

/**
 * Types no area handles: `ping` is answered by the connection's `onMessage`, the others by the router's `hubOwn`.
 * Without a router they answer `unknown_type`.
 */
export const ANSWERED_BEFORE_DISPATCH = ["ping", "side.start", "side.updateRemote", "side.check", "side.prefs", "ssh.add"] as const;
export type DispatchedType = Exclude<ClientType, (typeof ANSWERED_BEFORE_DISPATCH)[number]>;

/** One lookup table over the handlers of all areas of a connection. A type two areas handle throws. */
/** Any area: its handlers, whatever types it owns (the exhaustive check is `connectAreas`). */
export type AnyArea = { handlers: { readonly [type: string]: (msg: never, r: Respond) => unknown }; close?(): void };

export function createDispatch(areas: readonly AnyArea[], fallback?: (msg: ClientMessage, out: (m: ServerMessage) => void) => Promise<void>) {
  const table = new Map<string, Handler<ClientType>>();
  for (const a of areas)
    for (const [type, h] of Object.entries(a.handlers) as [string, Handler<ClientType>][]) {
      if (table.has(type)) throw new Error(`message type ${type} is handled by two areas`);
      table.set(type, h);
    }
  return {
    /** Runs the handler of `msg.type`; its reply or error goes to `out`. A Map lookup: `constructor` or `__proto__` is an unknown type. */
    async dispatch(msg: ClientMessage, out: (m: ServerMessage) => void): Promise<void> {
      const h = table.get(msg.type) as Handler<ClientType> | undefined;
      if (!h && fallback) return fallback(msg, out);
      const r: Respond = {
        reply: (result) => out({ type: "reply", reqId: msg.reqId, result }),
        fail: (code, message, size) => out({ type: "error", reqId: msg.reqId, code, message, size }),
      };
      if (!h) return r.fail("unknown_type", `unknown message type ${(msg as { type?: string }).type}`);
      await h(msg as never, r);
    },
    close() {
      for (const a of areas) a.close?.();
    },
  };
}
