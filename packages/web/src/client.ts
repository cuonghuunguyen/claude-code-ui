// One WebSocket per tab, reconnected with backoff. Requests resolve on the reply with the same reqId; events go to onEvent.
// onOpen runs after every (re)connect, so the caller resubscribes there with its last seq and logEpoch.
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ClientMessage, type Event, type PlanUsage, type ServerMessage } from "@claude-ui/protocol";
import { takeToken } from "./pairing.ts";

export type Request = ClientMessage extends infer M ? (M extends ClientMessage ? Omit<M, "reqId"> : never) : never;

type FsChanged = Extract<ServerMessage, { type: "fs.changed" }>;

/** "unauthorized": the daemon rejected this browser's token (or it has none); no redial until it is paired. */
/** A daemon `error` reply; `code` as the daemon sent it (e.g. unknown_session). */
export type RequestError = Error & { code?: string };

export type ConnectionStatus = "connected" | "reconnecting" | "offline" | "unauthorized";

/** Failed attempts in a row after which the header shows offline; retries continue at the capped delay. */
const OFFLINE_AFTER = 5;

export const backoffMs = (attempt: number) => Math.min(10_000, 500 * 2 ** attempt);

export function connect(opts: {
  url?: string;
  /** Pairing token; defaults to the one this browser stored (pairing.ts). */
  token?: string;
  onEvent: (e: Event) => void;
  /** Another tab (or this one) renamed, archived or deleted a session. */
  onSessionsChanged?: (m: Extract<ServerMessage, { type: "sessions.changed" }>) => void;
  /** Account plan usage, on connect and on each change; null = no plan limits. */
  onPlanUsage?: (u: PlanUsage | null) => void;
  onOpen?: () => void;
  onStatus?: (s: ConnectionStatus) => void;
}) {
  const url = opts.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  const fsListeners = new Set<(m: FsChanged) => void>();
  const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  let ws: WebSocket;
  let isOpen = false;
  let closed = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let markOpen!: () => void;
  let ready = new Promise<void>((r) => (markOpen = r));

  const token = "token" in opts ? opts.token : takeToken();
  const protocols = token ? [WS_PROTOCOL, TOKEN_PROTOCOL_PREFIX + token] : [WS_PROTOCOL];

  // A rejected upgrade closes before open like a down daemon (the browser hides the HTTP status), so ask the daemon over HTTP.
  // Unreachable daemon = not an auth failure.
  const rejectsToken = () =>
    fetch(new URL("/auth", url.replace(/^ws/, "http")), { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(
      (r) => r.status === 401,
      () => false,
    );

  function dial() {
    ws = new WebSocket(url, protocols);
    ws.addEventListener("open", () => {
      isOpen = true;
      failures = 0;
      markOpen();
      opts.onStatus?.("connected");
      opts.onOpen?.();
    });
    ws.addEventListener("message", (ev) => {
      const m: ServerMessage = JSON.parse(ev.data);
      if (m.type === "event") return opts.onEvent(m);
      if (m.type === "fs.changed") return fsListeners.forEach((l) => l(m));
      if (m.type === "sessions.changed") return opts.onSessionsChanged?.(m);
      if (m.type === "plan_usage") return opts.onPlanUsage?.(m.usage);
      const p = m.reqId ? pending.get(m.reqId) : undefined;
      if (!p) return console.error("daemon error", m);
      pending.delete(m.reqId!);
      m.type === "reply" ? p.resolve(m.result) : p.reject(Object.assign(new Error(m.message), { code: m.code }));
    });
    // Node's WebSocket fires only error on a rejected upgrade, a browser error then close: handle the first, once.
    let down = false;
    const onDown = async () => {
      if (down) return;
      down = true;
      const wasOpen = isOpen;
      if (isOpen) ready = new Promise<void>((r) => (markOpen = r));
      isOpen = false;
      for (const p of pending.values()) p.reject(new Error("disconnected"));
      pending.clear();
      if (closed) return;
      if (!wasOpen && (await rejectsToken())) return opts.onStatus?.("unauthorized");
      if (closed) return;
      opts.onStatus?.(failures >= OFFLINE_AFTER ? "offline" : "reconnecting");
      timer = setTimeout(dial, backoffMs(failures++));
    };
    ws.addEventListener("error", onDown);
    ws.addEventListener("close", onDown);
  }
  dial();

  async function send<T>(msg: Request, reqId: string, expired = () => false): Promise<T> {
    await ready;
    if (expired()) throw new Error("timed out");
    if (ws.readyState !== WebSocket.OPEN) throw new Error("disconnected");
    ws.send(JSON.stringify({ ...msg, reqId }));
    return new Promise<T>((resolve, reject) => pending.set(reqId, { resolve: resolve as (r: unknown) => void, reject }));
  }

  /** Waits for a connection; rejects if it drops before the reply, or with "timed out" after `timeoutMs` (waiting for the connection included). */
  function request<T>(msg: Request, { timeoutMs }: { timeoutMs?: number } = {}): Promise<T> {
    const reqId = crypto.randomUUID();
    if (!timeoutMs) return send<T>(msg, reqId);
    let t: ReturnType<typeof setTimeout>;
    let expired = false;
    const timeout = new Promise<never>((_, reject) => (t = setTimeout(() => (expired = true, pending.delete(reqId), reject(new Error("timed out"))), timeoutMs)));
    // A request that timed out waiting for the connection is not sent on reconnect.
    return Promise.race([send<T>(msg, reqId, () => expired), timeout]).finally(() => clearTimeout(t));
  }

  return {
    request,
    /** Listens for `fs.changed` of the files this connection watches (`fs.watch`); returns the unsubscribe. */
    onFsChanged(l: (m: FsChanged) => void) {
      fsListeners.add(l);
      return () => void fsListeners.delete(l);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      ws.close();
    },
  };
}
