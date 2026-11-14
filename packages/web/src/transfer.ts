// Copy, cut, paste and drop of file tree entries (GH-555). Pure async, no React: `send` is injected.
// The browser streams a copy between two Daemons (readChunk then writeChunk, 1 MiB at a time) and uploads OS files the same way.
// shortcut: bytes of a cross-Daemon copy pass Side -> Hub -> browser -> Hub -> Side as base64, one chunk pair at a time. Fine on one machine; upgrade to
// 2-4 chunks in flight, or a Hub-side job, when users copy big trees between Sides over a slow link.
// shortcut: closing the tab mid-copy leaves the hidden staging name `.<name>.partial-<hex>` in the target folder; delete it by hand (docs/spec.md).
import { CHUNK_BYTES, copyName, TRANSFER_MAX_BYTES, TRANSFER_MAX_ENTRIES, type FsChunkResult, type FsPathResult, type FsWalkEntry, type FsWalkResult } from "@claude-ui/protocol";
import { isWinPath, joinPath, sepOf } from "./paths.ts";

/** One request to the Daemon named by `msg.side`. */
export type Send = <T = unknown>(msg: { type: string; side: string; [k: string]: unknown }) => Promise<T>;
export type BrowserItem = { rel: string; kind: "file" | "dir"; size: number; file?: File };
/** One top-level thing to paste: an entry of a Daemon, or files and folders of this computer. */
export type Item = { kind: "daemon"; name: string; isDir: boolean; side: string; path: string } | { kind: "browser"; name: string; isDir: boolean; items: BrowserItem[] };
export type Clash = "replace" | "skip" | "keep";
export type Progress = { files: number; totalFiles: number; bytes: number; totalBytes: number };
/** `moved`: source and new path of each finished item that came from a Daemon. */
export type TransferResult = { done: string[]; moved: { from: string; to: string }[]; skipped: string[]; linksSkipped: number; /** Cut items whose source stays because a link inside was not copied. */ kept: string[]; /** GH-757: items that failed one by one; the others still ran. */ failed: { name: string; code: string; message: string }[]; cancelled?: boolean; error?: { code: string; message: string; name: string } };
export type Refusal = { name: string; code: "into_itself" | "too_many" | "too_large" };

export const parentOf = (p: string) => {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return isWinPath(p) && i === 2 ? p.slice(0, 3) : i <= 0 ? p.slice(0, i + 1) || p : p.slice(0, i);
};
const norm = (p: string) => (isWinPath(p) ? p.toLowerCase() : p);
/** `dir` is `path` or below it. */
const inside = (dir: string, path: string) => norm(dir) === norm(path) || norm(dir).startsWith(norm(path) + sepOf(path)) || norm(dir).startsWith(norm(path) + "/");
const below = (base: string, rel: string) => (rel === "" ? base : joinPath(base, rel));

/** What can be pasted into `target`: a folder into itself or below is refused, a cut into its own folder does nothing, OS files over the limits are refused. */
export function planPaste(items: Item[], target: { side: string; dir: string }, op: "copy" | "cut"): { items: Item[]; refused: Refusal[] } {
  const refused: Refusal[] = [];
  const ok: Item[] = [];
  let entries = 0;
  let bytes = 0;
  for (const it of items) {
    // GH-757: a row inside another carried folder travels with that folder.
    if (it.kind === "daemon" && items.some((o) => o !== it && o.kind === "daemon" && o.isDir && o.side === it.side && norm(o.path) !== norm(it.path) && inside(it.path, o.path))) continue;
    if (it.kind === "daemon" && it.side === target.side) {
      if (it.isDir && inside(target.dir, it.path)) {
        refused.push({ name: it.name, code: "into_itself" });
        continue;
      }
      if (op === "cut" && norm(parentOf(it.path)) === norm(target.dir)) continue;
    }
    if (it.kind === "browser") {
      entries += it.items.length;
      bytes += it.items.reduce((n, x) => n + x.size, 0);
    }
    ok.push(it);
  }
  if (entries > TRANSFER_MAX_ENTRIES) return { items: [], refused: [{ name: "", code: "too_many" }] };
  if (bytes > TRANSFER_MAX_BYTES) return { items: [], refused: [{ name: "", code: "too_large" }] };
  return { items: ok, refused };
}

class Cancelled extends Error {}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const byteLength = (b64: string) => (b64.length * 3) / 4 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);

/** Pastes `items` into `target.dir`. Nothing appears under its final name before it is complete; a failure or cancel removes the staging copy and leaves the source alone. */
export async function runTransfer(o: {
  send: Send;
  items: Item[];
  target: { side: string; dir: string; /** Names in the folder now. */ names: string[] };
  op: "copy" | "cut";
  /** Asked once per clash (not again after `all`); `remaining`: later items that clash too. */
  resolve: (name: string, remaining: number) => Promise<{ choice: Clash; all: boolean }>;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}): Promise<TransferResult> {
  const { send, target, op, signal } = o;
  const call = <T>(side: string, msg: { type: string; [k: string]: unknown }) => send<T>({ ...msg, side });
  const key = (n: string) => (isWinPath(target.dir) ? n.toLowerCase() : n);
  const taken = new Set(target.names.map(key));
  const res: TransferResult = { done: [], moved: [], skipped: [], linksSkipped: 0, kept: [], failed: [] };
  const fail = (name: string, e: unknown) => res.failed.push({ name, code: (e as { code?: string }).code ?? "", message: (e as Error).message });
  const bad = new Set<number>();
  const stop = () => {
    if (signal?.aborted) throw new Cancelled();
  };
  let current = "";
  try {
    // Walk everything first: the limits are checked before the first write.
    const walks: (FsWalkEntry[] | undefined)[] = [];
    let totalFiles = 0;
    let totalBytes = 0;
    let count = 0;
    for (const [wi, it] of o.items.entries()) {
      stop();
      current = it.name;
      let entries: FsWalkEntry[] | undefined;
      if (it.kind === "browser") entries = it.items.map((x) => ({ rel: x.rel, kind: x.kind, size: x.size, mode: 0o644 }));
      else if (!(it.side === target.side && op === "cut")) {
        try {
          entries = (await call<FsWalkResult>(it.side, { type: "fs.walk", path: it.path })).entries;
        } catch (e) {
          // A limit hit by the Daemon (too_many, too_large) stops the whole batch.
          if (e instanceof Cancelled || /^too_(many|large)$/.test((e as { code?: string }).code ?? "")) throw e;
          fail(it.name, e);
          bad.add(wi);
        }
      }
      walks.push(entries);
      for (const e of entries ?? []) {
        count++;
        if (e.kind === "file") (totalFiles++, (totalBytes += e.size));
      }
    }
    if (count > TRANSFER_MAX_ENTRIES) throw Object.assign(new Error("too many"), { code: "too_many" });
    if (totalBytes > TRANSFER_MAX_BYTES) throw Object.assign(new Error("too large"), { code: "too_large" });
    const prog = { files: 0, totalFiles, bytes: 0, totalBytes };
    const report = () => o.onProgress?.({ ...prog });
    let all: Clash | undefined;

    for (const [i, it] of o.items.entries()) {
      stop();
      if (bad.has(i)) continue;
      current = it.name;
      try {
        let name = it.name;
        let replace = false;
        if (taken.has(key(name))) {
          if (it.kind === "daemon" && it.side === target.side && norm(parentOf(it.path)) === norm(target.dir)) name = free(taken, key, name);
          else {
            let choice = all;
            if (!choice) {
              const remaining = o.items.slice(i + 1).filter((x) => taken.has(key(x.name))).length;
              const r = await o.resolve(name, remaining);
              choice = r.choice;
              if (r.all) all = choice;
            }
            if (choice === "skip") {
              res.skipped.push(name);
              continue;
            }
            if (choice === "keep") name = free(taken, key, name);
            else replace = true;
          }
        }
        let entries = walks[i];
        if (it.kind === "daemon" && it.side === target.side && op === "cut") {
          let renamed: FsPathResult | undefined;
          try {
            renamed = await call<FsPathResult>(target.side, { type: "fs.rename", path: it.path, name, dir: target.dir, ...(replace && { replace: true }) });
          } catch (e) {
            // Another volume or mount: a rename cannot cross it, so copy and delete like a move between Daemons.
            if (!/EXDEV|cross-device/i.test((e as Error).message)) throw e;
          }
          if (renamed) {
            res.done.push(renamed.path);
            res.moved.push({ from: it.path, to: renamed.path });
            taken.add(key(name));
            continue;
          }
          entries = (await call<FsWalkResult>(it.side, { type: "fs.walk", path: it.path })).entries;
        }
        const same = it.kind === "daemon" && it.side === target.side;
        if (it.kind === "daemon" && !same && entries![0]?.kind === "link") {
          res.linksSkipped++;
          continue;
        }
        const linksBefore = res.linksSkipped;
        let moved: { from: string; to: string } | undefined;
        const staging = joinPath(target.dir, `.${name}.partial-${Math.random().toString(16).slice(2, 8).padEnd(6, "0")}`);
        try {
          for (const e of entries!) {
            stop();
            const dest = below(staging, e.rel);
            if (e.kind === "dir") await call(target.side, { type: "fs.create", path: dest, dir: true });
            else if (it.kind === "daemon" && same) await call(target.side, { type: "fs.copy", from: below(it.path, e.rel), to: dest });
            else if (e.kind === "link") res.linksSkipped++;
            else {
              const read =
                it.kind === "daemon"
                  ? (at: number) => call<FsChunkResult>(it.side, { type: "fs.readChunk", path: below(it.path, e.rel), offset: at, length: CHUNK_BYTES })
                  : async (at: number): Promise<FsChunkResult> => {
                      const file = it.items.find((x) => x.rel === e.rel)!.file!;
                      return { data: toBase64(new Uint8Array(await file.slice(at, at + CHUNK_BYTES).arrayBuffer())), size: file.size };
                    };
              for (let at = 0; ; ) {
                stop();
                const c = await read(at);
                const n = byteLength(c.data);
                await call(target.side, { type: "fs.writeChunk", path: dest, offset: at, data: c.data, mode: e.mode });
                at += n;
                prog.bytes += n;
                report();
                if (n === 0 || at >= c.size) break;
              }
            }
            if (e.kind === "file") (prog.files++, report());
          }
          stop();
          const r = await call<FsPathResult>(target.side, { type: "fs.rename", path: staging, name, ...(replace && { replace: true }) });
          res.done.push(r.path);
          // A skipped link would be lost with the source: the source stays.
          const keep = op === "cut" && res.linksSkipped > linksBefore;
          if (keep) res.kept.push(it.name);
          taken.add(key(name));
          moved = it.kind === "daemon" && !keep ? { from: it.path, to: r.path } : undefined;
        } catch (e) {
          await call(target.side, { type: "fs.delete", path: staging }).catch(() => {});
          throw e;
        }
        if (op === "cut" && it.kind === "daemon" && !res.kept.includes(it.name)) await call(it.side, { type: "fs.delete", path: it.path });
        // Reported as moved only when the source is gone too (a failed delete leaves a copy and a "not moved" line).
        if (moved) res.moved.push(moved);
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        fail(it.name, e);
      }
    }
  } catch (e) {
    if (e instanceof Cancelled) res.cancelled = true;
    else res.error = { code: (e as { code?: string }).code ?? "", message: (e as Error).message, name: current };
  }
  return res;
}

function free(taken: Set<string>, key: (n: string) => string, name: string) {
  for (let n = 1; ; n++) {
    const c = copyName(name, n);
    if (!taken.has(key(c))) return c;
  }
}

type Raw = { entry?: FileSystemEntry | null; file?: File | null };
/** The files of a drop or paste, read at once (a DataTransfer is empty after the event handler returns). */
export function rawItems(dt: DataTransfer): Raw[] {
  const raw: Raw[] = [];
  for (const it of Array.from(dt.items ?? [])) if (it.kind === "file") raw.push({ entry: it.webkitGetAsEntry?.(), file: it.getAsFile() });
  if (!raw.length) for (const file of Array.from(dt.files ?? [])) raw.push({ file });
  return raw;
}

const entriesOf = (dir: FileSystemDirectoryEntry) =>
  new Promise<FileSystemEntry[]>((res, rej) => {
    const reader = dir.createReader();
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : res(all)), rej);
    next();
  });
const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));

/**
 * Files (and, when `folders`, dropped folders) as items. A folder that cannot be read (a pasted Finder or Explorer folder arrives as an
 * unreadable File in Chrome and Firefox) is counted in `osFolders` and not pasted; the other files still go.
 */
export async function browserItems(raw: Raw[], folders: boolean): Promise<{ items: Item[]; osFolders: number }> {
  const items: Item[] = [];
  let osFolders = 0;
  const walk = async (dir: FileSystemDirectoryEntry, rel: string, out: BrowserItem[]) => {
    for (const e of await entriesOf(dir)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) (out.push({ rel: r, kind: "dir", size: 0 }), await walk(e as FileSystemDirectoryEntry, r, out));
      else {
        const file = await fileOf(e as FileSystemFileEntry);
        out.push({ rel: r, kind: "file", size: file.size, file });
      }
    }
  };
  for (const { entry, file } of raw) {
    if (entry?.isDirectory) {
      if (!folders) {
        osFolders++;
        continue;
      }
      const out: BrowserItem[] = [{ rel: "", kind: "dir", size: 0 }];
      await walk(entry as FileSystemDirectoryEntry, "", out);
      items.push({ kind: "browser", name: entry.name, isDir: true, items: out });
      continue;
    }
    const f = file ?? (entry?.isFile ? await fileOf(entry as FileSystemFileEntry).catch(() => null) : null);
    if (!f) continue;
    try {
      await f.slice(0, 1).arrayBuffer();
    } catch {
      osFolders++;
      continue;
    }
    items.push({ kind: "browser", name: f.name, isDir: false, items: [{ rel: "", kind: "file", size: f.size, file: f }] });
  }
  return { items, osFolders };
}
