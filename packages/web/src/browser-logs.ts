// Browser logs (docs/spec.md "Client state" > "Browser logs"): console.error/warn/info/log, window `error` and `unhandledrejection` of this
// browser are kept in IndexedDB (newest 5000 entries, 7 days) so a bug report can include them. Nothing leaves the device unless the user
// exports the file. The logger must never break the app and never log about itself: every storage failure is swallowed silently.
import { useSyncExternalStore } from "react";
import { storedToken } from "./pairing.ts";
import { WEB_VERSION } from "./version.ts";

export type LogLevel = "error" | "warn" | "info" | "log";
export type LogEntry = { time: number; level: LogLevel; message: string; path: string; version: string };

export const KEY = "claude-ui.browserLogs";
export const MAX_ENTRIES = 5000;
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** Characters (UTF-16 units), not bytes. */
export const MAX_MESSAGE = 8192;
const TRUNCATED = "…[truncated]";
const BUFFER_MAX = 1000;
const FLUSH_AT = 100;
const FLUSH_MS = 1000;
const BLOCKED_MS = 3000;
const DB_NAME = "claude-ui-logs";
const STORE = "entries";

// ---- Serialization and redaction ----

const cap = (s: string) => (s.length > MAX_MESSAGE ? s.slice(0, MAX_MESSAGE - TRUNCATED.length) + TRUNCATED : s);

function serializeOne(x: unknown): string {
  if (typeof x === "string") return x;
  if (x instanceof Error) {
    const stack = x.stack;
    if (!stack) return `${x.name}: ${x.message}`;
    return stack.includes(x.message) ? stack : `${x.name}: ${x.message}\n${stack}`;
  }
  if (x === null || typeof x !== "object") return String(x);
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(x, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    try {
      return String(x);
    } catch {
      return "[unserializable]";
    }
  }
}

const joinArgs = (args: unknown[]) => args.map(serializeOne).join(" ");

/** The console arguments as one message: strings as is, Errors with stack, objects as JSON; at most 8192 characters. */
export const serializeArgs = (args: unknown[]): string => cap(joinArgs(args));

const RULES: [RegExp, string][] = [
  [/(\btoken=)[^&\s"'#<>]+/gi, "$1[redacted]"],
  [/(\btoken\.)[A-Za-z0-9_-]{16,}/g, "$1[redacted]"],
  [/(\bauthorization["']?\s*[:=]\s*["']?)[^"',}\r\n]+/gi, "$1[redacted]"],
  [/(\bbearer\s+)[^\s"',}]+/gi, "$1[redacted]"],
];

/** Pairing token (`#token=`, `token=`, WebSocket subprotocol `token.<t>`), Authorization and bearer values, and the stored token itself. */
export function redact(text: string, token?: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  if (token && token.length >= 16) out = out.split(token).join("[redacted]");
  return out;
}

/** One JSON object per line, in the given order (oldest first), with a trailing newline. */
export const toNdjson = (entries: LogEntry[]): string =>
  entries.map((e) => JSON.stringify({ time: new Date(e.time).toISOString(), level: e.level, message: e.message, path: e.path, version: e.version }) + "\n").join("");

const two = (n: number) => String(n).padStart(2, "0");
/** `claude-ui-browser-logs-YYYY-MM-DD.log`, local date. */
export const logFileName = (d: Date) => `claude-ui-browser-logs-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.log`;

// ---- IndexedDB ----

const done = (r: IDBRequest) =>
  new Promise<void>((resolve, reject) => {
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });

export function openLogDb(factory?: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const f = factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
      if (!f) throw new Error("indexedDB unavailable");
      const req = f.open(DB_NAME, 1);
      let blocked: ReturnType<typeof setTimeout> | undefined;
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      req.onsuccess = () => {
        clearTimeout(blocked);
        resolve(req.result);
      };
      req.onerror = () => {
        clearTimeout(blocked);
        reject(req.error);
      };
      req.onblocked = () => {
        blocked = setTimeout(() => reject(new Error("blocked")), BLOCKED_MS);
      };
    } catch (e) {
      reject(e);
    }
  });
}

/** One readwrite transaction: add the entries, then drop the oldest while over the count cap or older than 7 days. */
export function appendAndPrune(db: IDBDatabase, entries: LogEntry[], now: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      for (const e of entries) store.add(e);
      const count = store.count();
      count.onsuccess = () => {
        let remaining = count.result;
        const cutoff = now - MAX_AGE_MS;
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (!c) return;
          if (remaining > MAX_ENTRIES || (c.value as LogEntry).time < cutoff) {
            c.delete();
            remaining--;
            c.continue();
          }
        };
      };
    } catch (e) {
      reject(e);
    }
  });
}

export function readAll(db: IDBDatabase): Promise<LogEntry[]> {
  return new Promise((resolve, reject) => {
    try {
      const r = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      r.onsuccess = () =>
        resolve((r.result as (LogEntry & { id?: number })[]).map(({ time, level, message, path, version }) => ({ time, level, message, path, version })));
      r.onerror = () => reject(r.error);
    } catch (e) {
      reject(e);
    }
  });
}

export function stats(db: IDBDatabase): Promise<{ count: number; oldest?: number }> {
  return new Promise((resolve, reject) => {
    try {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      let count = 0;
      const c = store.count();
      c.onsuccess = () => (count = c.result);
      const first = store.openCursor();
      first.onsuccess = () => resolve({ count, oldest: (first.result?.value as LogEntry | undefined)?.time });
      first.onerror = () => reject(first.error);
    } catch (e) {
      reject(e);
    }
  });
}

export const clearAll = (db: IDBDatabase): Promise<void> => {
  try {
    return done(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
  } catch (e) {
    return Promise.reject(e);
  }
};

// ---- Logger ----

export type LoggerDeps = {
  factory?: IDBFactory;
  now?: () => number;
  path?: () => string;
  version?: string;
  token?: () => string | undefined;
  /** Returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Where the setting lives; read at every capture so another tab's change applies. */
  enabled?: () => boolean;
};

export type ErrorLike = { error?: unknown; message?: string; filename?: string; lineno?: number; colno?: number };
export type BrowserLogger = ReturnType<typeof createBrowserLogger>;

export function createBrowserLogger(deps: LoggerDeps = {}) {
  const now = deps.now ?? Date.now;
  const version = deps.version ?? WEB_VERSION;
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  });
  let on = deps.enabled?.() ?? true;
  let state: "pending" | "ready" | "unavailable" = "pending";
  let buffer: LogEntry[] = [];
  let dropped = 0;
  // Taken from the buffer, not written yet: counts against the cap while the database is slow or opening.
  let inflight = 0;
  let busy = false;
  let cancelTimer: (() => void) | undefined;
  let dbp: Promise<IDBDatabase | undefined> | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const getDb = () =>
    (dbp ??= openLogDb(deps.factory).then(
      (db) => {
        state = "ready";
        db.onversionchange = () => {
          db.close();
          state = "unavailable";
          buffer = [];
        };
        // Once on open: a long-closed browser still holds old entries.
        appendAndPrune(db, [], now()).catch(() => undefined);
        return db;
      },
      () => {
        state = "unavailable";
        buffer = [];
        return undefined;
      },
    ));
  // Serialised so a flush, a clear and a read never interleave.
  const queue = <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job);
    chain = next.catch(() => undefined);
    return next;
  };

  const flush = (): Promise<void> => {
    cancelTimer?.();
    cancelTimer = undefined;
    const batch = buffer;
    const lost = dropped;
    buffer = [];
    dropped = 0;
    if (lost) batch.unshift({ time: now(), level: "warn", message: `browser logs: ${lost} entries dropped`, path: pathNow(), version });
    inflight += batch.length;
    return queue(async () => {
      try {
        if (!batch.length || state === "unavailable") return;
        const db = await getDb();
        if (!db) return;
        // A failed transaction (quota, private mode) loses this batch; the logger stays usable.
        await appendAndPrune(db, batch, now()).catch(() => undefined);
      } finally {
        inflight -= batch.length;
      }
    });
  };

  const pathNow = () => {
    try {
      return redact((deps.path ?? (() => location.pathname))());
    } catch {
      return "";
    }
  };
  const tokenNow = () => {
    try {
      return (deps.token ?? storedToken)();
    } catch {
      return undefined;
    }
  };

  const enabledNow = () => on && deps.enabled?.() !== false;
  const push = (level: LogLevel, text: string) => {
    if (busy || !enabledNow() || state === "unavailable") return;
    busy = true;
    try {
      const message = cap(redact(text, tokenNow()));
      if (buffer.length + inflight >= BUFFER_MAX) {
        dropped++;
        return;
      }
      buffer.push({ time: now(), level, message, path: pathNow(), version });
      if (buffer.length >= FLUSH_AT) void flush();
      else cancelTimer ??= setTimer(() => void flush(), FLUSH_MS);
    } catch {
      // Never a failure of the app.
    } finally {
      busy = false;
    }
  };

  return {
    capture(level: LogLevel, args: unknown[]) {
      if (busy) return;
      let text: string;
      try {
        text = joinArgs(args);
      } catch {
        return;
      }
      push(level, text);
    },
    captureError(ev: ErrorLike) {
      // A resource that failed to load fires `error` on its element without either field.
      if (!ev.error && !ev.message) return;
      const stack = ev.error instanceof Error ? ev.error.stack : undefined;
      push("error", `Uncaught ${stack ?? `${ev.message} (${ev.filename}:${ev.lineno}:${ev.colno})`}`);
    },
    captureRejection(ev: { reason?: unknown }) {
      if (busy) return;
      try {
        push("error", `Unhandled rejection: ${joinArgs([ev.reason])}`);
      } catch {
        // See push.
      }
    },
    flush,
    state: () => state,
    async stats(): Promise<{ count: number; oldest?: number }> {
      await flush();
      return queue(async () => {
        const db = await getDb();
        return db ? await stats(db).catch(() => ({ count: 0 })) : { count: 0 };
      });
    },
    async exportText(): Promise<string> {
      await flush();
      return queue(async () => {
        const db = await getDb();
        return db ? toNdjson(await readAll(db).catch(() => [])) : "";
      });
    },
    clear(): Promise<void> {
      buffer = [];
      dropped = 0;
      return queue(async () => {
        const db = await getDb();
        if (db) await clearAll(db).catch(() => undefined);
      });
    },
    setEnabled(next: boolean) {
      on = next;
      if (!next) void this.clear();
    },
  };
}

// ---- Install ----

type ConsoleLike = Record<LogLevel, (...a: unknown[]) => void>;
type Target = {
  console: ConsoleLike;
  window: Pick<EventTarget, "addEventListener">;
  document?: Pick<EventTarget, "addEventListener"> & { visibilityState?: string };
};
const installed = new WeakSet<object>();

/** Patches console (the original is called first) and listens to window errors; once per console object. */
export function installBrowserLogs(logger: BrowserLogger, target: Target = { console: console as unknown as ConsoleLike, window, document }) {
  if (installed.has(target.console)) return;
  installed.add(target.console);
  for (const level of ["log", "info", "warn", "error"] as const) {
    const orig = target.console[level];
    target.console[level] = function (this: unknown, ...args: unknown[]) {
      orig.apply(target.console, args);
      try {
        logger.capture(level, args);
      } catch {
        // See createBrowserLogger.
      }
    };
  }
  const guard = (fn: () => void) => () => {
    try {
      fn();
    } catch {
      // See createBrowserLogger.
    }
  };
  target.window.addEventListener("error", (e) => guard(() => logger.captureError(e as unknown as ErrorLike))());
  target.window.addEventListener("unhandledrejection", (e) => guard(() => logger.captureRejection(e as unknown as { reason?: unknown }))());
  const out = () => void logger.flush();
  target.window.addEventListener("pagehide", out);
  target.document?.addEventListener("visibilitychange", () => target.document?.visibilityState === "hidden" && out());
}

// ---- Setting and singleton ----

const listeners = new Set<() => void>();
// Storage blocked: the choice lasts while the page is open.
let memory = true;

/** Whether this browser keeps logs; on unless set off. */
export function loadKeepLogs(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return memory;
  }
}

export const browserLogs = createBrowserLogger({ enabled: loadKeepLogs });

export function saveKeepLogs(on: boolean, logger: BrowserLogger = browserLogs) {
  memory = on;
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    // See `memory`.
  }
  logger.setEnabled(on);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => (e.key === KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
export const useKeepLogs = (): boolean => useSyncExternalStore(subscribe, loadKeepLogs, () => true);

/** First thing in main.tsx. Still installs where IndexedDB is blocked: the section then says so. */
export const startBrowserLogs = () => installBrowserLogs(browserLogs);
