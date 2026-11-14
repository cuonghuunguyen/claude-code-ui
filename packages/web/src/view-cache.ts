// View cache (GH-771, plan section 2.C): session views, infos, titles and the last session list are kept in IndexedDB so a page reload shows
// them before the socket opens. Pure helpers (serialize, trim, eviction choice, save scheduler) are separate from the IDB wrapper.
// Failure rule (same as browser-logs.ts): no indexedDB, open error, quota error, blocked open > 3 s -> the cache turns unavailable, every call
// resolves empty, nothing is thrown, and nothing is ever written to the console (it would feed the browser logs).
import type { Part, SessionInfo } from "@claude-ui/protocol";
import { emptySession, type SessionView } from "./store.ts";

export const DB_NAME = "claude-ui-cache";
export const SCHEMA = 1;
/** Characters (UTF-16 units) of one record JSON. */
export const MAX_SESSION_CHARS = 4_000_000;
export const MAX_TOTAL_CHARS = 40_000_000;
export const MAX_SESSIONS = 60;
export const MAX_AGE_MS = 14 * 24 * 3600 * 1000;
export const HYDRATE_MS = 300;
export const BLOCKED_MS = 3000;
export const SAVE_QUIET_MS = 2000;
export const SAVE_GAP_MS = 5000;
export const LIST_QUIET_MS = 1000;

const META = "meta";
const LIST = "list";
const VIEW_META = "viewMeta";
const VIEW_DATA = "viewData";

export type CachedView = { view: SessionView; info: SessionInfo; title: string; trimmed?: true };
export type ViewMeta = { id: string; savedAt: number; chars: number; trimmed: boolean };
export type CacheMeta = { schema: number; daemonId: string; tokenHash: string };
/** `version`: the list's `version` as the daemon named it (a string, GH-767). */
export type CachedList = { json: string; version: string | number };
export type Hydrated = { meta?: CacheMeta; list?: CachedList; views: Map<string, CachedView> };
export type SaveEntry = { id: string; view: SessionView; info: SessionInfo; title: string };

// ---- Pure helpers ----

/** Equality check only (the stored token is compared with the one the cache was written under); two FNV-1a 32 bit passes, base36. */
export function tokenHash(token: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ i, 0x85ebca6b) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

type Record1 = { v: 1; view: Record<string, unknown> & { parts: Part[] }; info: SessionInfo; title: string; trimmed?: true };

function toRecord(view: SessionView, info: SessionInfo, title: string, parts: Part[], aux = view.aux): Record1 {
  const { parts: _p, order: _o, stale: _s, auxEdits: _e, auxArtifacts: _a, ...scalars } = view;
  return { v: 1, view: { ...scalars, aux, parts }, info, title };
}

const orderedParts = (view: SessionView): Part[] => view.order.flatMap((id) => {
  const p = view.parts.get(id);
  return p ? [p] : [];
});

/**
 * The record JSON of a view, or undefined when it is not cacheable: a `stale` view, or one whose record exceeds the per session cap even after
 * `trimToCap` (aux alone over the cap, or not even the newest turn fits). Not stored: stale views, `auxEdits` / `auxArtifacts` flags (re-asked),
 * optimistic prompts (they are not part of the view).
 */
export function serializeView(view: SessionView, info: SessionInfo, title: string, cap = MAX_SESSION_CHARS): string | undefined {
  if (view.stale) return undefined;
  const full = JSON.stringify(toRecord(view, info, title, orderedParts(view)));
  return full.length <= cap ? full : trimToCap(view, info, title, cap);
}

/**
 * Keeps the newest whole turns (a turn starts at a `user_text` part; parts before the first one are the oldest segment) whose record JSON fits
 * `cap`. The cut result has `trimmed: true`, no `logEpoch` and no `older` (the cursor no longer matches; the resume reply brings it).
 * Undefined when aux alone is over the cap or not even the newest turn fits.
 */
export function trimToCap(view: SessionView, info: SessionInfo, title: string, cap = MAX_SESSION_CHARS): string | undefined {
  if (view.stale) return undefined;
  const parts = orderedParts(view);
  const starts: number[] = [];
  parts.forEach((p, i) => {
    if (p.type === "user_text") starts.push(i);
  });
  if (starts[0] !== 0) starts.unshift(0);
  const build = (k: number): string => {
    const rec = toRecord(view, info, title, parts.slice(starts[starts.length - k]));
    const { logEpoch: _l, older: _o, ...rest } = rec.view as Record<string, unknown>;
    return JSON.stringify({ ...rec, view: rest, trimmed: true });
  };
  if (parts.length === 0 || build(1).length > cap) return undefined;
  let lo = 1;
  let hi = starts.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(mid).length <= cap) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

/** Inverse of `serializeView`; undefined for malformed JSON or another record version. */
export function reviveView(json: string): CachedView | undefined {
  try {
    const rec = JSON.parse(json) as Partial<Record1> | null;
    if (!rec || rec.v !== 1 || !rec.view || !Array.isArray(rec.view.parts) || !rec.info) return undefined;
    const { parts, ...scalars } = rec.view;
    const view: SessionView = { ...emptySession(), ...(scalars as Partial<SessionView>), order: parts.map((p) => p.id), parts: new Map(parts.map((p) => [p.id, p])) };
    if (!Array.isArray(view.aux)) view.aux = [];
    return { view, info: rec.info, title: rec.title ?? "", ...(rec.trimmed ? { trimmed: true as const } : {}) };
  } catch {
    return undefined;
  }
}

export type EvictOptions = { maxTotalChars?: number; maxSessions?: number; maxAgeMs?: number };

/**
 * Ids to remove. Always: older than 14 days (by `savedAt`), and, when `listedIds` is given, sessions missing from the last applied list.
 * Then by priority while over 40 M chars or 60 sessions: open tabs (`openTabsByUsed`, most recently shown first) are kept before the others
 * (newest `savedAt` first).
 */
export function chooseEvictions(metas: ViewMeta[], listedIds: ReadonlySet<string> | undefined, openTabsByUsed: readonly string[], now: number, opt: EvictOptions = {}): string[] {
  const maxTotal = opt.maxTotalChars ?? MAX_TOTAL_CHARS;
  const maxSessions = opt.maxSessions ?? MAX_SESSIONS;
  const maxAge = opt.maxAgeMs ?? MAX_AGE_MS;
  const out: string[] = [];
  const alive: ViewMeta[] = [];
  for (const m of metas) {
    if (now - m.savedAt > maxAge || (listedIds && !listedIds.has(m.id))) out.push(m.id);
    else alive.push(m);
  }
  const tabRank = new Map(openTabsByUsed.map((id, i) => [id, i]));
  alive.sort((a, b) => {
    const ra = tabRank.get(a.id);
    const rb = tabRank.get(b.id);
    if (ra !== undefined || rb !== undefined) return ra === undefined ? 1 : rb === undefined ? -1 : ra - rb;
    return b.savedAt - a.savedAt;
  });
  let chars = 0;
  alive.forEach((m, i) => {
    chars += m.chars;
    if (i >= maxSessions || chars > maxTotal) {
      chars -= m.chars;
      out.push(m.id);
    }
  });
  return out;
}

export type Timer = (fn: () => void, ms: number) => () => void;
const realTimer: Timer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export type SaveScheduler = {
  /** The view of this session changed (lastSeq moved): save 2 s after the last change, at most every 5 s per session. */
  markView(id: string): void;
  /** A list was applied: save 1 s after the last one. */
  markList(): void;
  /** pagehide / visibilitychange hidden: save everything dirty now. */
  flushAll(): void;
  dispose(): void;
};

/** Debounce for views and the list; `saveViews` gets the ids due together (one transaction), `saveList` runs once. Timers and clock are injectable. */
export function createSaveScheduler(o: { saveViews: (ids: string[]) => void; saveList: () => void; setTimer?: Timer; now?: () => number; quietMs?: number; gapMs?: number; listMs?: number }): SaveScheduler {
  const setTimer = o.setTimer ?? realTimer;
  const now = o.now ?? Date.now;
  const quiet = o.quietMs ?? SAVE_QUIET_MS;
  const gap = o.gapMs ?? SAVE_GAP_MS;
  const listMs = o.listMs ?? LIST_QUIET_MS;
  const due = new Map<string, number>();
  const lastSaved = new Map<string, number>();
  let listDue: number | undefined;
  let cancel: (() => void) | undefined;
  let disposed = false;

  const run = (all: boolean) => {
    const t = now();
    const ids = [...due].filter(([, d]) => all || d <= t).map(([id]) => id);
    for (const id of ids) {
      due.delete(id);
      lastSaved.set(id, t);
    }
    const doList = listDue !== undefined && (all || listDue <= t);
    if (doList) listDue = undefined;
    if (ids.length) o.saveViews(ids);
    if (doList) o.saveList();
    arm();
  };
  const arm = () => {
    cancel?.();
    cancel = undefined;
    if (disposed) return;
    const next = Math.min(listDue ?? Infinity, ...due.values());
    if (next === Infinity) return;
    cancel = setTimer(() => {
      cancel = undefined;
      run(false);
    }, Math.max(0, next - now()));
  };
  return {
    markView(id) {
      if (disposed) return;
      due.set(id, Math.max(now() + quiet, (lastSaved.get(id) ?? -Infinity) + gap));
      arm();
    },
    markList() {
      if (disposed) return;
      listDue = now() + listMs;
      arm();
    },
    flushAll() {
      if (!disposed) run(true);
    },
    dispose() {
      disposed = true;
      cancel?.();
      due.clear();
      listDue = undefined;
    },
  };
}

// ---- IndexedDB wrapper ----

export type ViewCacheOptions = { factory?: IDBFactory; now?: () => number; setTimer?: Timer; blockedMs?: number };
export type SaveOptions = { openTabsByUsed?: string[]; listedIds?: string[] };

export type ViewCache = {
  /** One read of meta, list, viewMeta, then viewData of `tabIds`; empty on any failure, on timeout (late result dropped), on token or schema mismatch (cache cleared). */
  hydrate(o: { tokenHash: string; tabIds: string[]; timeoutMs?: number }): Promise<Hydrated>;
  readView(id: string): Promise<CachedView | undefined>;
  /** One readwrite transaction: put every cacheable entry, then evict (age, caps; the not listed rule only when `listedIds` is given). */
  saveViews(entries: SaveEntry[], o?: SaveOptions): Promise<void>;
  /** Put the list, then evict like `saveViews`; pass the ids of the list so unlisted sessions are removed. */
  saveList(json: string, version: string | number, o?: SaveOptions): Promise<void>;
  writeMeta(m: { daemonId: string; tokenHash: string }): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  /** Unpair: deletes the database; the cache is unavailable afterwards. */
  destroy(): Promise<void>;
  readonly available: boolean;
};

const reqP = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const txDone = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("aborted"));
  });

export function createViewCache(opt: ViewCacheOptions = {}): ViewCache {
  const now = opt.now ?? Date.now;
  const setTimer = opt.setTimer ?? realTimer;
  const blockedMs = opt.blockedMs ?? BLOCKED_MS;
  let unavailable = false;
  let dbp: Promise<IDBDatabase> | undefined;

  const open = (): Promise<IDBDatabase> => {
    dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      try {
        const f = opt.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
        if (!f) throw new Error("indexedDB unavailable");
        const req = f.open(DB_NAME, 1);
        let cancelBlocked: (() => void) | undefined;
        req.onupgradeneeded = () => {
          for (const name of [META, LIST, VIEW_META, VIEW_DATA]) req.result.createObjectStore(name);
        };
        req.onsuccess = () => {
          cancelBlocked?.();
          // Another page (or this one, on unpair) deletes the database: let go, so the delete is not blocked by this connection.
          req.result.onversionchange = () => {
            req.result.close();
            unavailable = true;
          };
          resolve(req.result);
        };
        req.onerror = () => {
          cancelBlocked?.();
          reject(req.error);
        };
        req.onblocked = () => {
          cancelBlocked = setTimer(() => reject(new Error("blocked")), blockedMs);
        };
      } catch (e) {
        reject(e);
      }
    });
    return dbp;
  };

  /** Runs `fn` against an open database; any failure turns the cache unavailable and resolves `fallback`. */
  const guard = async <T>(fallback: T, fn: (db: IDBDatabase) => Promise<T>): Promise<T> => {
    if (unavailable) return fallback;
    try {
      return await fn(await open());
    } catch {
      unavailable = true;
      return fallback;
    }
  };

  const clearAll = (db: IDBDatabase) => {
    const tx = db.transaction([META, LIST, VIEW_META, VIEW_DATA], "readwrite");
    for (const n of [META, LIST, VIEW_META, VIEW_DATA]) tx.objectStore(n).clear();
    return txDone(tx);
  };

  /** Inside a readwrite transaction on viewMeta/viewData: evict by the rules; resolves once the delete requests are queued. */
  const evict = async (tx: IDBTransaction, o: SaveOptions | undefined, extra: ViewMeta[] = []): Promise<void> => {
    const metaStore = tx.objectStore(VIEW_META);
    const stored = (await reqP(metaStore.getAll())) as ViewMeta[];
    const byId = new Map(stored.map((m) => [m.id, m]));
    for (const m of extra) byId.set(m.id, m);
    const doomed = chooseEvictions([...byId.values()], o?.listedIds ? new Set(o.listedIds) : undefined, o?.openTabsByUsed ?? [], now());
    for (const id of doomed) {
      metaStore.delete(id);
      tx.objectStore(VIEW_DATA).delete(id);
    }
  };

  return {
    get available() {
      return !unavailable;
    },
    async hydrate({ tokenHash: hash, tabIds, timeoutMs = HYDRATE_MS }) {
      const empty: Hydrated = { views: new Map() };
      let late = false;
      const work = guard<Hydrated>(empty, async (db) => {
        const tx = db.transaction([META, LIST, VIEW_META, VIEW_DATA], "readonly");
        const [meta, list, metas] = await Promise.all([
          reqP(tx.objectStore(META).get("meta")) as Promise<CacheMeta | undefined>,
          reqP(tx.objectStore(LIST).get("list")) as Promise<CachedList | undefined>,
          reqP(tx.objectStore(VIEW_META).getAll()) as Promise<ViewMeta[]>,
        ]);
        if (late) return empty;
        if (!meta) return empty;
        if (meta.schema !== SCHEMA || meta.tokenHash !== hash) {
          await clearAll(db);
          return empty;
        }
        const have = new Set(metas.map((m) => m.id));
        const views = new Map<string, CachedView>();
        const rows = await Promise.all(tabIds.filter((id) => have.has(id)).map(async (id) => [id, (await reqP(tx.objectStore(VIEW_DATA).get(id))) as { json: string } | undefined] as const));
        if (late) return empty;
        for (const [id, row] of rows) {
          const v = row && reviveView(row.json);
          if (v) views.set(id, v);
        }
        return { meta, list, views };
      });
      let cancel: (() => void) | undefined;
      const timeout = new Promise<Hydrated>((resolve) => {
        cancel = setTimer(() => {
          late = true;
          resolve(empty);
        }, timeoutMs);
      });
      const result = await Promise.race([work, timeout]);
      cancel?.();
      return result;
    },
    readView: (id) =>
      guard<CachedView | undefined>(undefined, async (db) => {
        const row = (await reqP(db.transaction(VIEW_DATA, "readonly").objectStore(VIEW_DATA).get(id))) as { json: string } | undefined;
        return row && reviveView(row.json);
      }),
    saveViews: (entries, o) =>
      guard<void>(undefined, async (db) => {
        const t = now();
        const rows = entries.flatMap((e) => {
          const json = serializeView(e.view, e.info, e.title);
          return json === undefined ? [] : [{ id: e.id, json, meta: { id: e.id, savedAt: t, chars: json.length, trimmed: json.includes('"trimmed":true') } satisfies ViewMeta }];
        });
        const tx = db.transaction([VIEW_META, VIEW_DATA], "readwrite");
        const done = txDone(tx);
        for (const r of rows) {
          tx.objectStore(VIEW_META).put(r.meta, r.id);
          tx.objectStore(VIEW_DATA).put({ json: r.json }, r.id);
        }
        await evict(tx, o, rows.map((r) => r.meta));
        await done;
      }),
    saveList: (json, version, o) =>
      guard<void>(undefined, async (db) => {
        const tx = db.transaction([LIST, VIEW_META, VIEW_DATA], "readwrite");
        const done = txDone(tx);
        tx.objectStore(LIST).put({ json, version } satisfies CachedList, "list");
        await evict(tx, o);
        await done;
      }),
    writeMeta: (m) =>
      guard<void>(undefined, async (db) => {
        const tx = db.transaction(META, "readwrite");
        tx.objectStore(META).put({ schema: SCHEMA, ...m } satisfies CacheMeta, "meta");
        await txDone(tx);
      }),
    remove: (id) =>
      guard<void>(undefined, async (db) => {
        const tx = db.transaction([VIEW_META, VIEW_DATA], "readwrite");
        tx.objectStore(VIEW_META).delete(id);
        tx.objectStore(VIEW_DATA).delete(id);
        await txDone(tx);
      }),
    clear: () => guard<void>(undefined, clearAll),
    async destroy() {
      const prior = dbp;
      unavailable = true;
      try {
        (await prior?.catch(() => undefined))?.close();
        const f = opt.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
        if (!f) return;
        await new Promise<void>((resolve) => {
          const r = f.deleteDatabase(DB_NAME);
          r.onsuccess = () => resolve();
          r.onerror = () => resolve();
          r.onblocked = () => setTimer(resolve, blockedMs);
        });
      } catch {
        // silent
      }
    },
  };
}
