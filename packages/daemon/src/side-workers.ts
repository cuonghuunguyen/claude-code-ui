// A Hub's coordinator drives workers that run on a Side (docs/spec.md "Orchestration", ADR 0010). This module is the Hub's own client of each
// ready Side: one virtual connection per Side (like a browser's, but independent of any browser), request/reply calls, and one background
// subscription per worker. A RemoteWorker holds the worker's parts so orchestration.ts derives its events, state and reads from them
// exactly as it does for a local Session. The Side keeps running the worker's CLI lifecycle; the Hub never holds the Side's CLI (background subscribe).
import type { ClientMessage, Event, Part, ServerMessage, SessionListItem, SessionState } from "@claude-ui/protocol";
import type { Sides } from "./sides.ts";

/** The Side's error or a transport failure of a call (`side_not_ready`, `side_timeout`, or the Side's own code). */
export class RemoteError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Longest wait for one reply of a Side. */
const CALL_MS = 30_000;
/** Parts a RemoteWorker holds; the oldest go first (worker_read and the pending requests need the recent ones). */
const MAX_PARTS = 2000;
/** A `sessions.changed` burst of a Side refreshes the `live` flags once after this quiet time. */
const LIVE_REFRESH_MS = 400;

type Listener = (e: Event) => void;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A client message without its reqId (the call adds one). */
export type SideRequest = DistributiveOmit<ClientMessage, "reqId" | "side">;

/** Parts that are not a message of the worker's CLI: they do not count as progress. */
const NOT_PROGRESS = new Set<Part["type"]>(["user_text", "session_state"]);

/** The Hub's view of one worker session on a Side, built from its part stream. */
export class RemoteWorker {
  readonly parts = new Map<string, Part>();
  state: SessionState = "idle";
  /** Whether the Side runs a CLI process for the worker (its `session.list` `live`); updated by the Side's `sessions.changed` and by the first running state. */
  liveFlag = false;
  /** Whether the Side answers: false from a pipe drop until the subscription is back (see Side link of docs/spec.md). */
  reachable = false;
  /** Whether `unreachable` was reported for the current drop (the matching `back` / `ended` follows once). */
  reportedDown = false;
  /** `logEpoch` of the Side runtime this subscription belongs to, and the seq of the last event received. */
  epoch?: string;
  seq = 0;
  /** Events with seq up to this are the replay of a subscribe: they fire worker events only when `fireReplay`. */
  replayUntil = 0;
  fireReplay = false;
  /** Counts for activity(): every event, and those that are a CLI message. */
  received = 0;
  progress = 0;
  at = Date.now();
  private readonly listeners = new Set<Listener>();

  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly side: string,
    private readonly io: { interrupt: (w: RemoteWorker) => Promise<void> },
  ) {}

  info() {
    return { state: this.state };
  }
  live() {
    return this.state === "running" || this.state === "needs_input" || (this.liveFlag && this.state !== "closed" && this.state !== "error");
  }
  working() {
    return this.state === "running" || this.state === "needs_input";
  }
  isLive() {
    return this.state !== "error" && this.state !== "closed";
  }
  activity() {
    return { received: this.received, at: this.at, progress: this.progress };
  }
  /** Held parts as events (seq 0) while `sinceSeq` is behind the held stream, then the live ones. Infinity: live only. */
  subscribe(sinceSeq: number, listener: Listener): () => void {
    if (sinceSeq < this.seq) for (const part of [...this.parts.values()]) listener({ type: "event", sessionId: this.id, seq: 0, part });
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  interrupt() {
    return this.io.interrupt(this);
  }
  /** Not used for a remote worker: worker.close does the Side's own restart (orchestration.ts closeWorker). */
  restartQuery() {}

  /** One event of the Side's stream. Returns whether it is news (a worker event may follow from it). */
  receive(e: Event, news: boolean) {
    const p = e.part;
    this.seq = Math.max(this.seq, e.seq);
    this.received++;
    if (!NOT_PROGRESS.has(p.type)) this.progress++;
    this.at = Date.now();
    this.parts.delete(p.id);
    this.parts.set(p.id, p);
    if (this.parts.size > MAX_PARTS) this.parts.delete(this.parts.keys().next().value!);
    if (p.type === "session_state") {
      this.state = p.state;
      if (p.state === "running" || p.state === "needs_input") this.liveFlag = true;
      if (p.state === "closed" || p.state === "error") this.liveFlag = false;
    }
    for (const l of [...this.listeners]) l(e);
    return news;
  }
}

export type RemoteSideInfo = { id: string; label: string; ready: boolean; remoteWorkers: boolean };

export type SideWorkersDeps = {
  sides: Sides;
  /** A session ID this daemon has itself (never claimed for a Side). */
  isLocal?: (sessionId: string) => boolean;
  /** A worker event source: every event of a subscribed worker that is news (live, or replayed after a pipe drop). */
  onEvent: (w: RemoteWorker, e: Event) => void;
  /** The Side deleted a worker's session (the web app's Remove worker routed to the Side). */
  onGone?: (id: string, side: string) => void;
  /** A Side's pipe came back or dropped: its subscribed workers' reachability changed (orchestration.ts remoteState). */
  onReach?: (w: RemoteWorker, change: "unreachable" | "back" | "restarted") => void;
  /** The hub links to workers on Sides: `{ id, cwd, side }`; their subscriptions start when the Side attaches. */
  links: () => { id: string; cwd: string; side: string }[];
  callMs?: number;
};

type Call = { settle: (m: ServerMessage) => void; sync?: (m: ServerMessage) => void };
type SideConn = {
  conn: NonNullable<ReturnType<Sides["open"]>>;
  logEpoch?: string;
  caps?: string[];
  pending: Map<string, Call>;
  refresh?: ReturnType<typeof setTimeout>;
  /** Settles once the Side's `daemon_hello` arrived (or after HELLO_MS: an older daemon sends one without caps, a stuck one none). */
  hello: Promise<void>;
  gotHello: () => void;
};
/** Longest wait for a Side's hello. */
const HELLO_MS = 5000;

export function createSideWorkers(deps: SideWorkersDeps) {
  const { sides } = deps;
  const conns = new Map<string, SideConn>();
  const workers = new Map<string, RemoteWorker>();
  let nextReq = 1;
  // Links of an earlier run: known to orchestration (list, errors) before their Side is up; subscribed when it attaches.
  for (const l of deps.links()) workers.set(l.id, new RemoteWorker(l.id, l.cwd, l.side, { interrupt: (w) => interrupt(w) }));

  const label = (id: string) => sides.list().find((s) => s.id === id)?.label ?? id;
  const notReady = (id: string) => new RemoteError(`${label(id)} is not running. Open it in the project picker to start it.`, "side_not_ready");

  /** The Side's answer to `msg`: the reply's result; throws RemoteError for an error answer, a missing connection or a timeout. `sync` sees the answer before any later message of the Side is handled. */
  function call<T = unknown>(side: string, msg: SideRequest, o: { timeoutMs?: number; sync?: (result: T) => void } = {}): Promise<T> {
    const c = conns.get(side);
    if (!c) return Promise.reject(notReady(side));
    return new Promise<T>((resolve, reject) => {
      const reqId = `wk:${nextReq++}`;
      const ms = o.timeoutMs ?? deps.callMs ?? CALL_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => (clearTimeout(timer), c.pending.delete(reqId));
      const answer = (m: ServerMessage) => {
        if (m.type === "error") reject(new RemoteError(m.message, m.code));
        else if (m.type === "reply") resolve(m.result as T);
      };
      c.pending.set(reqId, {
        settle: (m) => (done(), answer(m)),
        ...(o.sync && { sync: (m: ServerMessage) => m.type === "reply" && o.sync!(m.result as T) }),
      });
      timer = setTimeout(() => (done(), reject(new RemoteError(`${label(side)} did not answer in ${ms / 1000} s`, "side_timeout"))), ms);
      c.conn.send({ ...msg, reqId } as ClientMessage);
    });
  }

  const sideOfWorker = (id: string) => workers.get(id)?.side;

  function onMessage(side: string, m: ServerMessage) {
    const c = conns.get(side);
    if (!c) return;
    if (m.type === "daemon_hello") {
      c.logEpoch = m.logEpoch;
      c.caps = m.caps;
      c.gotHello();
      return;
    }
    if (m.type === "reply" || m.type === "error") {
      const pend = m.reqId === undefined ? undefined : c.pending.get(m.reqId);
      if (!pend) return;
      pend.sync?.(m);
      pend.settle(m);
      return;
    }
    if (m.type === "event") {
      const w = workers.get(m.sessionId);
      if (!w || w.side !== side) return;
      // A browser answers the worker's request through the Hub: it needs to know which Side holds it (the router learns it from the events it forwards, and none is connected).
      if (sides.sessionSide.get(m.sessionId) === side) sides.noteRequest(side, m.part as never);
      const news = m.seq > w.replayUntil || w.fireReplay;
      w.receive(m, news);
      if (news) deps.onEvent(w, m);
      return;
    }
    if (m.type === "sessions.changed") {
      if (m.deleted !== undefined) {
        const w = workers.get(m.deleted);
        if (w?.side === side) deps.onGone?.(w.id, side);
      }
      scheduleRefresh(side);
    }
  }

  /** One session.list per quiet burst of `sessions.changed`: the Side's `live` of each tracked worker (a CLI closed by Close finished workers emits no part). */
  function scheduleRefresh(side: string) {
    const c = conns.get(side);
    if (!c || ![...workers.values()].some((w) => w.side === side)) return;
    clearTimeout(c.refresh);
    c.refresh = setTimeout(() => void refreshLive(side), LIVE_REFRESH_MS);
    c.refresh.unref?.();
  }
  async function refreshLive(side: string) {
    try {
      const list = await call<{ sessions: SessionListItem[] }>(side, { type: "session.list" });
      for (const s of list.sessions) {
        const w = workers.get(s.id);
        if (w?.side === side) w.liveFlag = s.live !== false && s.state !== "closed" && s.state !== "error";
      }
    } catch {
      // The next change tries again.
    }
  }

  /** Subscribes `w` in the background (the Side's closeFinished and idle close stay in charge of its CLI). `news`: events of the replay count as news. */
  async function subscribe(w: RemoteWorker, sinceSeq: number, news: boolean) {
    const c = conns.get(w.side);
    if (!c) throw notReady(w.side);
    await call<{ logEpoch?: string; seq: number; session?: { state?: SessionState } }>(
      w.side,
      { type: "session.subscribe", sessionId: w.id, sinceSeq, ...(c.logEpoch && { logEpoch: c.logEpoch }), background: true },
      {
        // Before the replayed events are handled: they have seq up to the reply's.
        sync: (r) => {
          w.replayUntil = r.seq;
          w.fireReplay = news;
          w.epoch = r.logEpoch ?? c.logEpoch;
          if (r.session?.state) w.state = r.session.state;
          // The Side restored the session: seqs of an earlier run mean nothing here.
          if (sinceSeq === 0) w.seq = 0;
        },
      },
    );
    w.reachable = true;
    scheduleRefresh(w.side);
  }

  /** Claims a session ID for its Side: the Side's push for it is forwarded and browsers route its permission and question answers there. */
  function claim(side: string, id: string) {
    if (sides.sessionSide.get(id) === side) return;
    if (sides.sessionSide.has(id) || sides.contested.has(id) || deps.isLocal?.(id)) return;
    sides.sessionSide.set(id, side);
  }

  const interrupt = async (w: RemoteWorker) => void (await call(w.side, { type: "session.interrupt", sessionId: w.id }));

  /** A worker the Hub just created on `side`: tracked and subscribed before its first prompt, so every event is news. */
  async function start(side: string, id: string, cwd: string): Promise<RemoteWorker> {
    claim(side, id);
    const w = new RemoteWorker(id, cwd, side, { interrupt });
    workers.set(id, w);
    try {
      await subscribe(w, 0, true);
    } catch (e) {
      workers.delete(id);
      throw e;
    }
    return w;
  }

  /** The Side's subscriptions after an attach: every hub link to a worker on it. First time (Hub start): history, no events. Same Side runtime as before: the parts missed while down replay as news. */
  async function adopt(side: string) {
    const c = conns.get(side);
    if (!c) return;
    for (const l of deps.links().filter((x) => x.side === side)) {
      let w = workers.get(l.id);
      const again = !!w && w.epoch !== undefined && w.epoch === c.logEpoch;
      if (!w) workers.set(l.id, (w = new RemoteWorker(l.id, l.cwd, side, { interrupt })));
      claim(side, l.id);
      try {
        await subscribe(w, again ? w.seq : 0, again);
        if (w.reportedDown) {
          w.reportedDown = false;
          deps.onReach?.(w, again ? "back" : "restarted");
        }
      } catch {
        // The worker's session is gone on the Side, or the pipe dropped again: the next attach tries again.
      }
    }
  }

  const router = {
    attach(id: string) {
      if (conns.has(id)) return;
      let gotHello = () => {};
      const hello = new Promise<void>((r) => (gotHello = r));
      setTimeout(() => gotHello(), HELLO_MS).unref?.();
      // Registered before `open`: the Side's hello can arrive while it runs.
      const c: SideConn = { conn: undefined as never, pending: new Map(), hello, gotHello };
      conns.set(id, c);
      const conn = sides.open(id, (m) => onMessage(id, m));
      if (!conn) return void conns.delete(id);
      c.conn = conn;
      void hello.then(() => adopt(id));
    },
    detach(id: string) {
      const c = conns.get(id);
      if (!c) return;
      conns.delete(id);
      clearTimeout(c.refresh);
      for (const [reqId, p] of c.pending) p.settle({ type: "error", reqId, code: "side_not_ready", message: `${label(id)} stopped` });
      for (const w of workers.values())
        if (w.side === id && !w.reportedDown) {
          w.reachable = false;
          w.reportedDown = true;
          deps.onReach?.(w, "unreachable");
        }
    },
  };
  sides.addRouter(router);
  sides.ready().forEach((id) => router.attach(id));

  return {
    call,
    start,
    claim,
    /** The folders a Side lists as its projects and worktrees count as its paths (the router learns them from project.open; sides.claimCwd refuses a local folder), so a path argument routes to it. */
    learnPaths: (side: string, paths: string[]) => paths.forEach((p) => sides.claimCwd(side, p)),
    /** Resolves once the Side's hello (its caps and runtime identity) is known. */
    hello: (side: string) => conns.get(side)?.hello ?? Promise.resolve(),
    get: (id: string) => workers.get(id),
    sideOfWorker,
    forget: (id: string) => void workers.delete(id),
    /** Every Side the Hub knows, ready or not, with whether it can run workers for this Hub (`daemon_hello.caps`). */
    sides: (): RemoteSideInfo[] =>
      sides.list().map((s) => ({ id: s.id, label: s.label, ready: conns.has(s.id), remoteWorkers: !!conns.get(s.id)?.caps?.includes("remoteWorkers") })),
    close() {
      sides.removeRouter(router);
      for (const c of conns.values()) clearTimeout(c.refresh);
    },
  };
}

export type SideWorkers = ReturnType<typeof createSideWorkers>;
