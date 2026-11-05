// Local history (docs/spec.md "Local history", ADR 0010): the content a write is about to replace, kept per file in the config dir.
// One entry point: `before(path, reason, content?)`. It only enqueues; one drain loop does the disk work.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import type { HistoryEntry, HistoryReason } from "@claude-ui/protocol";
import { createJsonFile } from "./json-file.ts";
import { openChecked, OPEN_READ, readAll } from "./fd-check.ts";

export const MAX_ENTRIES = 50;
export const MAX_BYTES = 256 * 1024;
export const MERGE_MS = 10_000;
const MAX_PENDING = 100;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MERGING: readonly HistoryReason[] = ["save", "agent"];

export class HistoryError extends Error {
  constructor(
    readonly code: "path_not_allowed" | "not_found" | "bad_request" | "too_large" | "fs_error",
    message: string,
  ) {
    super(message);
  }
}

type Stored = HistoryEntry & { hash: string };
type Store = { path: string; entries: Stored[] };
type Item = { path: string; reason: HistoryReason; content: string; time: number; label?: string };

const parse = (raw: unknown): Store => {
  const r = raw as Partial<Store> | undefined;
  return r && typeof r.path === "string" && Array.isArray(r.entries) ? { path: r.path, entries: r.entries } : { path: "", entries: [] };
};
const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");
const labelOk = (l: unknown): l is string => typeof l === "string" && l.length >= 1 && l.length <= 100 && !/[\0-\x1f\x7f]/.test(l);

export function createLocalHistory(opts: { dir: string; settings: () => { enabled: boolean; exclude: string[] }; allowed: (path: string) => string | undefined; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const queue: Item[] = [];
  let pendingBytes = 0;
  let dropped = 0;
  let loggedAt = 0;
  let draining: Promise<void> | undefined;

  const storeOf = (path: string) => {
    const dir = join(opts.dir, createHash("sha256").update(path).digest("hex").slice(0, 16));
    mkdirSync(dir, { recursive: true });
    return { dir, json: createJsonFile<Store>(join(dir, "entries.json"), parse, "local history") };
  };
  const excluded = (path: string) => {
    const p = path.replaceAll("\\", "/");
    return opts.settings().exclude.some((g) => matchesGlob(p, g));
  };
  const known = (path: string) => {
    const p = opts.allowed(path);
    if (!p) throw new HistoryError("path_not_allowed", `outside the allowlisted roots: ${path}`);
    return p;
  };
  /** The file's text, read once through an fd that is proven to be the file; undefined: too large or unreadable. */
  const readDisk = (path: string) => {
    let fd: number | undefined;
    try {
      fd = openChecked(path, OPEN_READ);
      const st = fstatSync(fd);
      return st.isFile() && st.size <= MAX_BYTES ? readAll(fd, st.size).toString("utf8") : undefined;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  /** Writes one entry; the caller has checked size and settings. `force`: named entries skip dedupe and merge. */
  async function store(it: Item, force: boolean): Promise<Stored | undefined> {
    const { dir, json } = storeOf(it.path);
    const hash = hashOf(it.content);
    const last = json.get().entries.at(-1);
    if (!force && last) {
      if (last.hash === hash) return;
      if (it.time - last.time < MERGE_MS && MERGING.includes(it.reason) && MERGING.includes(last.reason)) return;
    }
    const entry: Stored = { id: randomUUID(), time: it.time, reason: it.reason, size: Buffer.byteLength(it.content), hash, ...(it.label ? { label: it.label } : {}) };
    await writeFile(join(dir, entry.id), it.content, { mode: 0o600 });
    let old: Stored[] = [];
    json.change((d) => {
      d.path = it.path;
      d.entries.push(entry);
      old = d.entries.splice(0, Math.max(0, d.entries.length - MAX_ENTRIES));
    });
    await Promise.all(old.map((e) => rm(join(dir, e.id), { force: true })));
    return entry;
  }

  const drain = () =>
    (draining ??= (async () => {
      try {
        for (;;) {
          // Yield first: the caller's synchronous burst fills the queue before the first item leaves it.
          await new Promise((r) => setImmediate(r));
          const it = queue.shift();
          if (!it) break;
          pendingBytes -= it.content.length;
          try {
            await store(it, false);
          } catch (e) {
            console.error("local history write failed:", e);
          }
        }
      } finally {
        draining = undefined;
      }
    })());

  return {
    /**
     * The one entry point: `content` (the agent case) is stored as is; without it the file on disk is read now, before the write that follows.
     * Never throws and never waits for the disk.
     */
    before(path: string, reason: HistoryReason, content?: string) {
      try {
        const s = opts.settings();
        const p = s.enabled ? opts.allowed(path) : undefined;
        if (!p || excluded(p)) return;
        const text = content ?? readDisk(p);
        if (text === undefined || text.length > MAX_BYTES) return;
        if (queue.length >= MAX_PENDING || pendingBytes + text.length > MAX_PENDING_BYTES) {
          dropped++;
          if (now() - loggedAt > 60_000) {
            loggedAt = now();
            console.error(`local history queue full: ${dropped} entries dropped so far`);
          }
          return;
        }
        queue.push({ path: p, reason, content: text, time: now() });
        pendingBytes += text.length;
        void drain();
      } catch (e) {
        console.error("local history before failed:", e);
      }
    },
    /** Entries dropped because the queue was full (tests, diagnostics). */
    dropped: () => dropped,
    /** Newest first, after every queued entry is written. */
    async list(path: string): Promise<HistoryEntry[]> {
      const p = known(path);
      await draining;
      return storeOf(p)
        .json.get()
        .entries.map(({ hash: _h, ...e }) => e)
        .reverse();
    },
    async read(path: string, id: string): Promise<string> {
      const p = known(path);
      await draining;
      const { dir, json } = storeOf(p);
      if (!json.get().entries.some((e) => e.id === id)) throw new HistoryError("not_found", `no such entry: ${id}`);
      return readFile(join(dir, id), "utf8").catch(() => {
        throw new HistoryError("not_found", `no such entry: ${id}`);
      });
    },
    async rename(path: string, id: string, label: string): Promise<void> {
      const p = known(path);
      if (!labelOk(label)) throw new HistoryError("bad_request", "label must be 1 to 100 characters without control characters");
      await draining;
      let found = false;
      storeOf(p).json.change((d) => {
        const e = d.entries.find((x) => x.id === id);
        if (e) ((found = true), (e.label = label));
      });
      if (!found) throw new HistoryError("not_found", `no such entry: ${id}`);
    },
    async remove(path: string, id: string): Promise<void> {
      const p = known(path);
      await draining;
      const { dir, json } = storeOf(p);
      let found = false;
      json.change((d) => {
        const n = d.entries.length;
        d.entries = d.entries.filter((e) => e.id !== id);
        found = d.entries.length < n;
      });
      if (!found) throw new HistoryError("not_found", `no such entry: ${id}`);
      await rm(join(dir, id), { force: true });
    },
    /** A named entry of the file on disk: no merge, no dedupe. */
    async create(path: string, label: string): Promise<HistoryEntry> {
      const p = known(path);
      if (!labelOk(label)) throw new HistoryError("bad_request", "label must be 1 to 100 characters without control characters");
      const content = readDisk(p);
      if (content === undefined) throw new HistoryError("too_large", `unreadable or larger than ${MAX_BYTES} bytes: ${path}`);
      await draining;
      const e = await store({ path: p, reason: "named", content, time: now(), label }, true);
      const { hash: _h, ...entry } = e!;
      return entry;
    },
  };
}

export type LocalHistory = ReturnType<typeof createLocalHistory>;
