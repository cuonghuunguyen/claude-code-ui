// One WebSocket per tab, reconnected with backoff. Requests resolve on the reply with the same reqId; events go to onEvent.
// onOpen runs after every (re)connect, so the caller resubscribes there with its last seq and logEpoch.
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ClientMessage, type Event, type ServerMessage } from "@claude-ui/protocol";
import { takeToken } from "./pairing.ts";

type Request = ClientMessage extends infer M ? (M extends ClientMessage ? Omit<M, "reqId"> : never) : never;

type FsChanged = Extract<ServerMessage, { type: "fs.changed" }>;

/** "unauthorized": the daemon rejected this browser's token (or it has none); no redial until it is paired. */
export type ConnectionStatus = "connected" | "reconnecting" | "offline" | "unauthorized";

/** Failed attempts in a row after which the header shows offline; retries continue at the capped delay. */
const OFFLINE_AFTER = 5;

export const backoffMs = (attempt: number) => Math.min(10_000, 500 * 2 ** attempt);

export function connect(opts: {
  url?: string;
  /** Pairing token; defaults to the one this browser stored (pairing.ts). */
  token?: string;
  onEvent: (e: Event) => void;
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
      const p = m.reqId ? pending.get(m.reqId) : undefined;
      if (!p) return console.error("daemon error", m);
      pending.delete(m.reqId!);
      m.type === "reply" ? p.resolve(m.result) : p.reject(new Error(m.message));
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

  /** Waits for a connection; rejects if it drops before the reply. */
  async function request<T>(msg: Request): Promise<T> {
    await ready;
    if (ws.readyState !== WebSocket.OPEN) throw new Error("disconnected");
    const reqId = crypto.randomUUID();
    ws.send(JSON.stringify({ ...msg, reqId }));
    return new Promise<T>((resolve, reject) => pending.set(reqId, { resolve: resolve as (r: unknown) => void, reject }));
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
