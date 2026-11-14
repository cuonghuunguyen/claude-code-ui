// Main-thread stall log (docs/spec.md "Browser logs"): a page that stops reading its socket cannot take the daemon's ping off the wire,
// so a drop on a phone shows whether the page was busy. A timer lag sampler works everywhere (Safari has no "longtask" entries);
// long tasks are added where the browser reports them. One console.warn per 10 s window, only when the window lost ≥ 500 ms,
// and the last 30 s ride on the reconnect note to the daemon log (client.ts).

const TICK_MS = 250;
const WINDOW_MS = 10_000;
const WARN_AT_MS = 500;
/** Closed windows kept for the 30 s summary. */
const KEEP_WINDOWS = 3;

interface Window {
  start: number;
  lagMax: number;
  lagTotal: number;
  longTasks: number;
  longMax: number;
  msgs: number;
  bytes: number;
  parseMs: number;
}

type EntryList = { getEntries: () => { duration: number }[] };
interface ObserverLike {
  observe(o: { type: string; buffered: boolean }): void;
  disconnect(): void;
}

export interface StallSeams {
  now: () => number;
  setInterval: (f: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  visible: () => boolean;
  PerformanceObserver?: { new (cb: (list: EntryList) => void): ObserverLike; supportedEntryTypes?: readonly string[] };
  warn: (line: string) => void;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function createStallLog(seams: StallSeams) {
  const fresh = (start: number): Window => ({ start, lagMax: 0, lagTotal: 0, longTasks: 0, longMax: 0, msgs: 0, bytes: 0, parseMs: 0 });
  let current = fresh(seams.now());
  const closed: Window[] = [];
  let last = seams.now();
  let timer: unknown;
  let observer: ObserverLike | undefined;
  let longTasks = false;

  const roll = (now: number) => {
    if (now - current.start < WINDOW_MS) return;
    const w = current;
    current = fresh(now);
    closed.push(w);
    if (closed.length > KEEP_WINDOWS) closed.shift();
    if (w.lagTotal < WARN_AT_MS) return;
    const tasks = longTasks ? `, long tasks ${w.longTasks} (max ${seconds(w.longMax)})` : "";
    seams.warn(`claude-ui: main thread busy ${Math.round((now - w.start) / 1000)}s: lag max ${seconds(w.lagMax)} total ${seconds(w.lagTotal)}${tasks}, msgs ${w.msgs} (${(w.bytes / 2 ** 20).toFixed(1)}MB) parse ${Math.round(w.parseMs)}ms`);
  };

  const tick = () => {
    const now = seams.now();
    // A hidden page's timers are throttled: the wait is not lag, and the sampler restarts from here.
    if (seams.visible()) {
      const late = now - last - TICK_MS;
      if (late > 0) {
        current.lagTotal += late;
        current.lagMax = Math.max(current.lagMax, late);
      }
    }
    last = now;
    roll(now);
  };

  return {
    start() {
      if (timer !== undefined) return;
      last = seams.now();
      current = fresh(last);
      timer = seams.setInterval(tick, TICK_MS);
      const PO = seams.PerformanceObserver;
      if (PO?.supportedEntryTypes?.includes("longtask")) {
        try {
          observer = new PO((list) =>
            list.getEntries().forEach((e) => {
              current.longTasks++;
              current.longMax = Math.max(current.longMax, e.duration);
            }),
          );
          observer.observe({ type: "longtask", buffered: false });
          longTasks = true;
        } catch {
          longTasks = false;
        }
      }
    },
    stop() {
      if (timer !== undefined) seams.clearInterval(timer);
      timer = undefined;
      observer?.disconnect();
      observer = undefined;
    },
    /** One received WebSocket message: its size and the time `JSON.parse` took. */
    message(bytes: number, parseMs: number) {
      current.msgs++;
      current.bytes += bytes;
      current.parseMs += parseMs;
    },
    /** Lag of the current and the last closed windows (about the last 30 s). */
    lag30() {
      const all = [...closed, current];
      return { max: Math.max(...all.map((w) => w.lagMax)), total: all.reduce((n, w) => n + w.lagTotal, 0) };
    },
  };
}

/** The page's one stall log; main.tsx starts it, client.ts reports to it. */
export const stallLog = createStallLog({
  now: () => Date.now(),
  setInterval: (f, ms) => setInterval(f, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  visible: () => typeof document === "undefined" || document.visibilityState === "visible",
  PerformanceObserver: typeof PerformanceObserver === "undefined" ? undefined : (PerformanceObserver as never),
  warn: (line) => console.warn(line),
});
