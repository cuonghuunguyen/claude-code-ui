// One WebSocket per tab, reconnected with backoff. Requests resolve on the reply with the same reqId; events go to onEvent.
// onOpen runs after every (re)connect, so the caller resubscribes there with its last seq and logEpoch.
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ClientMessage, type Event, type PlanUsage, type ServerMessage, type SessionsSearchResult } from "@claude-ui/protocol";
import { takeToken } from "./pairing.ts";
import { browserWakeEvents, type WakeEvents } from "./wake.ts";

export type Request = ClientMessage extends infer M ? (M extends ClientMessage ? Omit<M, "reqId"> : never) : never;

type FsChanged = Extract<ServerMessage, { type: "fs.changed" }>;
type SearchResultMessage = Extract<ServerMessage, { type: "sessions.search.result" }>;
export type TerminalMessage = Extract<ServerMessage, { type: "terminal.output" | "terminal.exit" }>;

/** "unauthorized": the daemon rejected this browser's token (or it has none); no redial until it is paired. */
/** A daemon `error` reply; `code` as the daemon sent it (e.g. unknown_session). */
export type RequestError = Error & { code?: string; size?: number };

export type ConnectionStatus = "connected" | "reconnecting" | "offline" | "unauthorized";

/** Failed attempts in a row after which the header shows offline; retries continue at the capped delay. */
const OFFLINE_AFTER = 5;

/** A socket open after the page was hidden at least this long is probed with a ping on wake: the OS may have dropped the connection without telling the page. */
const PROBE_AFTER_MS = 10_000;
const PROBE_TIMEOUT_MS = 1_000;

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
  /** A config write (e.g. an MCP server added) in a project: an open config dialog of it refreshes. */
  onConfigChanged?: (m: Extract<ServerMessage, { type: "config.changed" }>) => void;
  /** Another client changed the app settings. */
  onSettingsChanged?: (m: Extract<ServerMessage, { type: "settings_changed" }>) => void;
  /** A newer claude-ui and the update under way (update.tsx). */
  onUpdate?: (m: Extract<ServerMessage, { type: "update_available" | "update_state" }>) => void;
  /** The daemon runs older code than is on disk (stale-toast.tsx). */
  onStale?: (note: string) => void;
  onOpen?: () => void;
  onStatus?: (s: ConnectionStatus) => void;
  /** Test seam: replaces the browser's visibilitychange / pageshow / online (wake.ts). Returns the unsubscribe. */
  wakeEvents?: WakeEvents;
  /** Test seams of the wake probe (docs/spec.md "Reconnect"). */
  probeAfterMs?: number;
  probeTimeoutMs?: number;
}) {
  const url = opts.url ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  const fsListeners = new Set<(m: FsChanged) => void>();
  const terminalListeners = new Set<(m: TerminalMessage) => void>();
  const streams = new Map<string, (m: SearchResultMessage) => void>();
  const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>();
  let ws: WebSocket | undefined;
  let isOpen = false;
  let closed = false;
  let unauthorized = false;
  let hiddenAt: number | undefined;
  let probing = false;
  /** The current socket reported error or close; its readyState can lag behind (a browser fires error first). */
  let sockDown = false;
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

  /** The socket stops being current (down, or abandoned by a probe): reject what waits on it and make requests wait for the next one. */
  function markDown() {
    if (isOpen) ready = new Promise<void>((r) => (markOpen = r));
    isOpen = false;
    for (const p of pending.values()) p.reject(new Error("disconnected"));
    pending.clear();
  }

  function dial() {
    if (closed || unauthorized) return;
    // One socket at a time: a timer, a wake and a close handler may all ask.
    if (ws && !sockDown && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    clearTimeout(timer);
    timer = undefined;
    const sock = new WebSocket(url, protocols);
    ws = sock;
    sockDown = false;
    // A socket that is no longer the current one (replaced after a wake) must not touch the state.
    const current = () => sock === ws;
    sock.addEventListener("open", () => {
      if (!current()) return;
      isOpen = true;
      failures = 0;
      markOpen();
      opts.onStatus?.("connected");
      opts.onOpen?.();
    });
    sock.addEventListener("message", (ev) => {
      if (!current()) return;
      const m: ServerMessage = JSON.parse(ev.data);
      if (m.type === "event") return opts.onEvent(m);
      if (m.type === "fs.changed") return fsListeners.forEach((l) => l(m));
      if (m.type === "terminal.output" || m.type === "terminal.exit") return terminalListeners.forEach((l) => l(m));
      if (m.type === "sessions.changed") return opts.onSessionsChanged?.(m);
      if (m.type === "plan_usage") return opts.onPlanUsage?.(m.usage);
      if (m.type === "config.changed") return opts.onConfigChanged?.(m);
      if (m.type === "settings_changed") return opts.onSettingsChanged?.(m);
      if (m.type === "update_available" || m.type === "update_state") return opts.onUpdate?.(m);
      if (m.type === "daemon_stale") return opts.onStale?.(m.note);
      if (m.type === "sessions.search.result") return streams.get(m.reqId)?.(m);
      const p = m.reqId ? pending.get(m.reqId) : undefined;
      if (!p) return console.error("daemon error", m);
      pending.delete(m.reqId!);
      m.type === "reply" ? p.resolve(m.result) : p.reject(Object.assign(new Error(m.message), { code: m.code, size: m.size }));
    });
    // Node's WebSocket fires only error on a rejected upgrade, a browser error then close: handle the first, once.
    let down = false;
    const onDown = async () => {
      if (down || !current()) return;
      down = true;
      sockDown = true;
      const wasOpen = isOpen;
      markDown();
      if (closed) return;
      if (!wasOpen && (await rejectsToken())) {
        if (!current()) return;
        unauthorized = true;
        return opts.onStatus?.("unauthorized");
      }
      // A wake may have dialed again while the probe above was in flight.
      if (closed || !current()) return;
      opts.onStatus?.(failures >= OFFLINE_AFTER ? "offline" : "reconnecting");
      timer = setTimeout(dial, backoffMs(failures++));
    };
    sock.addEventListener("error", onDown);
    sock.addEventListener("close", onDown);
  }
  dial();

  /** The phone woke, the tab came back or the network returned (wake.ts): do not sit out the backoff, and check an open socket that may be dead. */
  function wake(force = false) {
    if (closed || unauthorized) return;
    const hidFor = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
    hiddenAt = undefined;
    const sock = ws;
    if (!sock || sockDown || sock.readyState === WebSocket.CLOSED || sock.readyState === WebSocket.CLOSING) {
      failures = 0;
      return dial();
    }
    if (sock.readyState !== WebSocket.OPEN || probing || !(force || hidFor >= (opts.probeAfterMs ?? PROBE_AFTER_MS))) return;
    probing = true;
    request({ type: "ping" }, { timeoutMs: opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS })
      .catch((e: Error) => {
        // Only silence is a zombie; "disconnected" is the normal down path already running.
        if (closed || sock !== ws || e.message !== "timed out") return;
        ws = undefined;
        sock.close();
        markDown();
        opts.onStatus?.("reconnecting");
        failures = 0;
        dial();
      })
      .finally(() => (probing = false));
  }
  const stopWakeEvents = (opts.wakeEvents ?? browserWakeEvents)((force) => wake(force), () => (hiddenAt = Date.now()));

  async function send<T>(msg: Request, reqId: string, expired = () => false): Promise<T> {
    await ready;
    if (expired()) throw new Error("timed out");
    if (ws?.readyState !== WebSocket.OPEN) throw new Error("disconnected");
    ws.send(JSON.stringify({ ...msg, reqId }));
    return new Promise<T>((resolve, reject) => pending.set(reqId, { resolve: resolve as (r: unknown) => void, reject }));
  }

  let lastReqId = 0;
  /** Waits for a connection; rejects if it drops before the reply, or with "timed out" after `timeoutMs` (waiting for the connection included). */
  function request<T>(msg: Request, { timeoutMs }: { timeoutMs?: number } = {}): Promise<T> {
    // A counter, not crypto.randomUUID(): that needs a secure context, and --lan serves plain http://<LAN IP>.
    const reqId = String(++lastReqId);
    if (!timeoutMs) return send<T>(msg, reqId);
    let t: ReturnType<typeof setTimeout>;
    let expired = false;
    const timeout = new Promise<never>((_, reject) => (t = setTimeout(() => (expired = true, pending.delete(reqId), reject(new Error("timed out"))), timeoutMs)));
    // A request that timed out waiting for the connection is not sent on reconnect.
    return Promise.race([send<T>(msg, reqId, () => expired), timeout]).finally(() => clearTimeout(t));
  }

  return {
    request,
    /** `request` whose stream messages (sessions.search.result with its reqId) go to `onResult` until the reply. */
    search(msg: Extract<Request, { type: "sessions.search" }>, onResult: (m: SearchResultMessage) => void) {
      const reqId = String(++lastReqId);
      streams.set(reqId, onResult);
      return send<SessionsSearchResult>(msg, reqId).finally(() => streams.delete(reqId));
    },
    /** Listens for `fs.changed` of the files this connection watches (`fs.watch`); returns the unsubscribe. */
    onFsChanged(l: (m: FsChanged) => void) {
      fsListeners.add(l);
      return () => void fsListeners.delete(l);
    },
    /** Listens for output and exits of the terminals this connection attached; returns the unsubscribe. */
    onTerminal(l: (m: TerminalMessage) => void) {
      terminalListeners.add(l);
      return () => void terminalListeners.delete(l);
    },
    close() {
      closed = true;
      clearTimeout(timer);
      stopWakeEvents();
      ws?.close();
    },
  };
}
