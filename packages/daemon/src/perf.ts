// Performance monitor of the daemon (docs/spec.md "Performance monitor"): event-loop delay and use, request handler times, spans
// (session open, side start, worktree list), child processes and memory, in one in-memory store. Off = no timer, no observer, no allocation.
// Privacy: only numbers and labels from closed lists are stored; cwd, args, paths, ids and titles never are.
import type { ChildProcess } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { newHistogram, percentile, record, summarize, type Histogram, type PerfDaemon, type PerfSpanName, type PerfWorst } from "@claude-ui/protocol";

/** Every ClientMessage type (perf.test.ts checks it against wire.ts); any other request type is counted as "other". */
export const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "artifact.preview", "event", "fs.create", "fs.delete", "fs.duplicate", "fs.list", "fs.media", "fs.read", "fs.rename", "fs.search", "fs.upload", "fs.watch", "fs.write", "git.branch", "git.commit", "git.diff", "git.fetch", "git.fileAt", "git.log", "git.pull", "git.push", "git.refs", "git.repos", "git.status", "jira.search", "jira.test", "jira.token",
  "marketplace.add", "marketplace.list", "marketplace.remove", "marketplace.update", "mcp.add", "mcp.authenticate", "mcp.clearAuth", "mcp.list", "mcp.oauthCallback",
  "mcp.reconnect", "mcp.remove", "mcp.toggle", "media.read", "models.list", "perf.clear", "perf.report", "permission.respond", "ping", "plugins.install", "plugins.list", "plugins.reload",
  "plugins.restart", "plugins.setEnabled", "plugins.uninstall", "plugins.update", "project.open", "project.remove", "push.focus", "push.key", "push.subscribe",
  "question.respond", "session.archive", "session.backgroundShell", "session.bash", "session.cancelContinue", "session.commands", "session.create", "session.defaultMode", "session.delete", "session.dequeue", "session.enqueue", "session.sendQueued",
  "session.edits", "session.ids", "session.interrupt", "session.list", "session.media", "session.page", "session.prompt", "session.rename", "session.rewind", "session.rewindPreview", "session.setEffort",
  "session.setModel", "session.setPermissionMode", "session.shellOutput", "session.stopShell", "session.stopSubagent", "session.subscribe", "session.unsubscribe", "sessions.search", "settings.get", "settings.set",
  "side.check", "side.start", "skills.list", "skills.setState", "terminal.attach", "terminal.close", "terminal.create", "terminal.detach", "terminal.input", "terminal.list",
  "terminal.resize", "update.install", "update.restart", "aside.open", "aside.close", "aside.keep", "worker.close", "worker.remove", "worktree.branches", "worktree.cached", "worktree.cancel", "worktree.create", "worktree.pr", "worktree.remove", "worktree.status",
]);
const CMDS = new Set(["git", "claude", "node", "docker", "wsl", "powershell", "tailscale", "npm", "sh", "bash", "cmd", "taskkill", "osascript", "notify-send"]);
export const GIT_SUBS = ["status", "log", "show", "diff", "diff-tree", "rev-parse", "worktree", "for-each-ref", "branch", "cat-file", "ls-files", "symbolic-ref", "merge-base", "rev-list", "config", "check-ignore", "grep", "merge-tree", "fetch"] as const;

/** The git subcommand of an argument list (skips `-c x=y`, `-C dir` and `--flags`), from the allowlist, else "other". */
export function gitSub(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-c" || a === "-C") i++;
    else if (!a.startsWith("-")) return (GIT_SUBS as readonly string[]).includes(a) ? a : "other";
  }
  return "other";
}
/** Basename without .exe/.cmd/.bat, from the allowlist, else "other". */
export function cmdLabel(file: string | undefined): string {
  const base = (file ?? "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
  return CMDS.has(base) ? base : "other";
}

export type EldLike = { enable(): unknown; disable(): unknown; reset(): void; /** ms */ percentile(p: number): number; /** ms */ readonly max: number };
type EluValue = { idle?: number; active?: number; utilization: number };
type EluFn = (a?: EluValue, b?: EluValue) => EluValue;
export type PerfSpanHandle = { readonly id: number; end(): void };
export type PerfMonitor = {
  /** Times a request handler and lists it as in flight (a child process started meanwhile is attributed to it). Returns the end function. */
  request(type: string, cwd?: string): () => void;
  span(name: PerfSpanName, parent?: PerfSpanHandle): PerfSpanHandle;
  /** A child process of a seam that the diagnostics channel cannot see (worker thread). Returns the exit function. */
  child(o: { cmd: string; args?: readonly string[]; cwd?: string; thread: "main" | "worker" }): (exit: number | "error" | "signal") => void;
  /** A synchronous child process: its whole time blocks the event loop. */
  syncChild<T>(cmd: string, args: readonly string[], fn: () => T): T;
  report(): PerfDaemon;
  clear(): void;
  setEnabled(on: boolean): void;
  readonly enabled: boolean;
  close(): void;
};
export type PerfOptions = {
  now?: () => number;
  eld?: () => EldLike;
  memory?: () => { rss: number; heapUsed: number };
  elu?: EluFn;
  version?: string;
  /** Called on each 10 s tick: false turns the monitor off (the setting changed in another daemon). */
  poll?: () => boolean | undefined;
  /** Test seam: the minimum ms of an entry in the worst list (default 100 for requests and spans, 200 for processes). */
  worstMs?: number;
};

type ChildHook = { spawned(): void; ended(exit: number | "error" | "signal"): void };
// One subscription and one set of listeners per process for all monitors (a test may hold dozens of daemons; a ChildProcess warns above 10 listeners).
const watchers = new Set<(cp: ChildProcess) => ChildHook>();
const onChannel = (msg: unknown) => {
  const cp = (msg as { process?: ChildProcess }).process;
  if (!cp || watchers.size === 0) return;
  const hooks = [...watchers].map((w) => w(cp));
  cp.once("spawn", () => hooks.forEach((h) => h.spawned()));
  cp.once("exit", (code, signal) => hooks.forEach((h) => h.ended(signal ? "signal" : (code ?? 0))));
  cp.once("error", () => hooks.forEach((h) => h.ended("error")));
};
function watchChildren(w: (cp: ChildProcess) => ChildHook) {
  if (watchers.size === 0) subscribe("child_process", onChannel);
  watchers.add(w);
}
function unwatchChildren(w: (cp: ChildProcess) => ChildHook) {
  if (watchers.delete(w) && watchers.size === 0) unsubscribe("child_process", onChannel);
}

const RESOLUTION = 50;
const TICK_MS = 10_000;
const WATCH_MS = 20;
const STALL_MS = 50;
const WORST_MAX = 50;
const MEMORY_MAX = 60;
const LONG_LIVED = 600_000;
/** Longest a span may stay open; then it closes as `<name>.timeout`. */
const SPAN_MAX: Partial<Record<PerfSpanName, number>> = { "session.start": 60_000 };

const NOOP_END = () => {};
const NOOP_SPAN: PerfSpanHandle = { id: 0, end: NOOP_END };

export function createPerf(o: PerfOptions = {}): PerfMonitor {
  const now = o.now ?? (() => performance.now());
  const elu = o.elu ?? (performance.eventLoopUtilization as EluFn);
  const memoryOf = o.memory ?? (() => ({ rss: process.memoryUsage.rss(), heapUsed: process.memoryUsage().heapUsed }));
  const makeEld = o.eld ?? (() => {
    const h = monitorEventLoopDelay({ resolution: RESOLUTION });
    return { enable: () => h.enable(), disable: () => h.disable(), reset: () => h.reset(), percentile: (p) => h.percentile(p) / 1e6, get max() { return h.max / 1e6; } } satisfies EldLike;
  });

  let on = false;
  let eld: EldLike | undefined;
  let tickTimer: NodeJS.Timeout | undefined;
  let watch: NodeJS.Timeout | undefined;
  let expected = 0;
  let nextId = 0;
  let enabledAt = 0;
  let wallAcc = 0;
  let ownMs = 0;
  let since = Date.now();
  let prevElu: EluValue | undefined;
  let lastElu = 0;
  let idleP50: number | undefined;

  type Store = {
    handlers: Map<string, Histogram>;
    spans: Map<PerfSpanName, Histogram>;
    children: Map<string, Histogram>;
    excess: Histogram;
    excessMax: number | undefined;
    memory: { at: number; rss: number; heapUsed: number }[];
    worst: PerfWorst[];
  };
  const fresh = (): Store => ({ handlers: new Map(), spans: new Map(), children: new Map(), excess: newHistogram(), excessMax: undefined, memory: [], worst: [] });
  let st = fresh();
  const flight: { id: number; type: string; cwd?: string }[] = [];
  const open = new Map<number, { name: PerfSpanName; parent?: number; t0: number; elu0: EluValue }>();

  const own = (fn: () => void) => {
    const t = now();
    try {
      fn();
    } finally {
      ownMs += now() - t;
    }
  };
  const hist = <K>(m: Map<K, Histogram>, k: K) => {
    let h = m.get(k);
    if (!h) m.set(k, (h = newHistogram()));
    return h;
  };
  const addWorst = (w: PerfWorst) => {
    const ms = w.ms;
    const list = st.worst;
    if (list.length >= WORST_MAX && ms <= list[list.length - 1]!.ms) return;
    let i = list.findIndex((x) => x.ms < ms);
    if (i < 0) i = list.length;
    list.splice(i, 0, w);
    if (list.length > WORST_MAX) list.pop();
  };

  // The request a process started now is attributed to: same cwd (newest), else the newest in flight, else background.
  const attribute = (cwd?: string) => {
    for (let i = flight.length - 1; i >= 0 && cwd; i--) if (flight[i]!.cwd === cwd) return flight[i]!.type;
    return flight[flight.length - 1]?.type ?? "background";
  };
  const recordChild = (c: { cmd: string; sub?: string; ms: number; heldMs?: number; thread: "main" | "worker"; request: string; exit: number | "error" | "signal" }) => {
    record(hist(st.children, c.sub ? `${c.cmd} ${c.sub}` : c.cmd), c.ms);
    if (c.ms >= (o.worstMs ?? 200) || (c.heldMs ?? 0) >= (o.worstMs ?? 20)) addWorst({ kind: "child", at: Date.now(), ...c });
  };

  // A span that never ends (the CLI sends nothing until a prompt) must not keep the watchdog running or label every later stall.
  const endSpan = (id: number, timeout = false) => {
    const s = open.get(id);
    if (!s) return;
    open.delete(id);
    if (open.size === 0) (clearTimeout(watch), (watch = undefined));
    const ms = now() - s.t0;
    const name = timeout ? (`${s.name}.timeout` as PerfSpanName) : s.name;
    record(hist(st.spans, name), ms);
    if (ms >= (o.worstMs ?? 100)) addWorst({ kind: "span", at: Date.now(), name, id, parent: s.parent, ms, elu: elu(s.elu0).utilization });
  };
  const check = () => {
    const t = now();
    for (const [id, s] of open) if (SPAN_MAX[s.name] !== undefined && t - s.t0 >= SPAN_MAX[s.name]!) endSpan(id, true);
    const late = t - expected;
    expected = t + WATCH_MS;
    if (late >= STALL_MS && open.size > 0) addWorst({ kind: "stall", at: Date.now(), ms: late, spans: [...open].map(([id, s]) => ({ name: s.name, id })) });
  };
  const startWatch = () => {
    expected = now() + WATCH_MS;
    const fire = () => {
      own(() => {
        check();
        watch = open.size > 0 ? setTimeout(fire, WATCH_MS) : undefined;
        watch?.unref();
      });
    };
    watch = setTimeout(fire, WATCH_MS);
    watch.unref();
  };

  const tick = () =>
    own(() => {
      if (o.poll?.() === false) return void setEnabled(false);
      if (eld && eld.max > 0) {
        const p50 = eld.percentile(50);
        idleP50 = idleP50 === undefined ? p50 : Math.min(idleP50, p50);
        record(st.excess, Math.max(0, eld.percentile(95) - idleP50));
        const ex = Math.max(0, eld.max - idleP50);
        st.excessMax = Math.max(st.excessMax ?? 0, ex);
      }
      eld?.reset();
      const cur = elu();
      lastElu = (prevElu ? elu(cur, prevElu) : cur).utilization;
      prevElu = cur;
      const m = memoryOf();
      st.memory.push({ at: Date.now(), rss: m.rss, heapUsed: m.heapUsed });
      if (st.memory.length > MEMORY_MAX) st.memory.shift();
    });

  // One process seen by the diagnostics channel (see `watchChildren`): `spawned` at its spawn event, `ended` at exit or error.
  const onChild = (cp: ChildProcess): ChildHook => {
    const t0 = now();
    const request = attribute();
    let cmd = "other";
    let sub: string | undefined;
    let heldMs: number | undefined;
    let done = false;
    const finish = (exit: number | "error" | "signal") =>
      own(() => {
        if (done) return;
        done = true;
        const ms = now() - t0;
        recordChild({ cmd, sub, ms: ms > LONG_LIVED ? (heldMs ?? 0) : ms, heldMs, thread: "main", request, exit });
      });
    return {
      spawned: () =>
        own(() => {
          heldMs = now() - t0;
          cmd = cmdLabel(cp.spawnfile);
          sub = cmd === "git" ? gitSub(cp.spawnargs.slice(1)) : undefined;
          // A session's CLI lives for hours: only its start counts.
          if (cmd === "claude") (done = true, recordChild({ cmd, ms: heldMs, heldMs, thread: "main", request, exit: 0 }));
        }),
      ended: (exit) => {
        if (exit === "error" && cmd === "other") cmd = cmdLabel(cp.spawnfile);
        finish(exit);
      },
    };
  };

  function setEnabled(next: boolean) {
    if (next === on) return;
    on = next;
    if (on) {
      eld = makeEld();
      eld.enable();
      enabledAt = now();
      prevElu = undefined;
      idleP50 = undefined;
      tickTimer = setInterval(tick, TICK_MS);
      tickTimer.unref();
      watchChildren(onChild);
    } else {
      wallAcc += now() - enabledAt;
      eld?.disable();
      eld = undefined;
      clearInterval(tickTimer);
      tickTimer = undefined;
      clearTimeout(watch);
      watch = undefined;
      unwatchChildren(onChild);
      open.clear();
      flight.length = 0;
    }
  }

  return {
    get enabled() {
      return on;
    },
    setEnabled,
    request(type, cwd) {
      if (!on) return NOOP_END;
      const e = { id: ++nextId, type: KNOWN_TYPES.has(type) ? type : "other", cwd };
      const t0 = now();
      flight.push(e);
      return () =>
        own(() => {
          const i = flight.indexOf(e);
          if (i < 0) return;
          flight.splice(i, 1);
          const ms = now() - t0;
          record(hist(st.handlers, e.type), ms);
          if (ms >= (o.worstMs ?? 100)) addWorst({ kind: "handler", at: Date.now(), request: e.type, ms });
        });
    },
    span(name, parent) {
      if (!on) return NOOP_SPAN;
      const id = ++nextId;
      open.set(id, { name, parent: parent && parent.id > 0 ? parent.id : undefined, t0: now(), elu0: elu() });
      if (!watch) startWatch();
      return {
        id,
        end: () =>
          own(() => {
            if (!open.has(id)) return;
            check();
            endSpan(id);
          }),
      };
    },
    child(c) {
      if (!on) return NOOP_END;
      const t0 = now();
      const request = attribute(c.cwd);
      const cmd = cmdLabel(c.cmd);
      const sub = cmd === "git" ? gitSub(c.args ?? []) : undefined;
      return (exit) => own(() => recordChild({ cmd, sub, ms: now() - t0, thread: c.thread, request, exit }));
    },
    syncChild(cmd, args, fn) {
      if (!on) return fn();
      const t0 = now();
      const request = attribute();
      let exit: number | "error" = 0;
      try {
        return fn();
      } catch (e) {
        exit = "error";
        throw e;
      } finally {
        own(() => {
          const ms = now() - t0;
          const label = cmdLabel(cmd);
          recordChild({ cmd: label, sub: label === "git" ? gitSub(args) : undefined, ms, heldMs: ms, thread: "main", request, exit });
        });
      }
    },
    report() {
      const sum = <K extends string>(m: Map<K, Histogram>) => Object.fromEntries([...m].map(([k, h]) => [k, summarize(h)])) as Record<K, ReturnType<typeof summarize>>;
      return {
        pid: process.pid,
        version: o.version,
        since,
        monitor: on,
        eld: { excessP95: percentile(st.excess, 95), excessMax: st.excessMax, idleP50, resolutionMs: RESOLUTION },
        elu: lastElu,
        handlers: sum(st.handlers),
        spans: sum(st.spans),
        children: sum(st.children),
        memory: st.memory.slice(),
        worst: st.worst.slice(),
        cost: { ownMs, wallMs: wallAcc + (on ? now() - enabledAt : 0) },
      };
    },
    clear() {
      st = fresh();
      ownMs = 0;
      wallAcc = 0;
      enabledAt = now();
      since = Date.now();
      idleP50 = undefined;
      lastElu = 0;
    },
    close() {
      setEnabled(false);
    },
  };
}

/** The monitor of this process, for seams without access to the daemon object (git runner, sides, session). Off until `createDaemon` sets its own. */
export let perf: PerfMonitor = createPerf();
export function setPerf(p: PerfMonitor): void {
  perf = p;
}
