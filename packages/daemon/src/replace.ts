// Replace in files (`fs.replace`, `fs.replaceUndo`; docs/spec.md "Editor"). Dry run and apply share one path; the regex runs in a
// thread that is killed at a deadline (a user regex can backtrack without end); the undo of the last replaces lives in memory.
// shortcut: undo lives in memory (lost on restart); Local history keeps each file's previous content.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync } from "node:fs";
import { isAbsolute, join, posix, win32 } from "node:path";
import { Worker } from "node:worker_threads";
import type { FsReplaceResult, ReplaceFile, ReplaceLine, ReplaceSkip } from "@claude-ui/protocol";
import { openChecked, OPEN_READ, readAll, writeAll } from "./fd-check.ts";
import { cutLine, GREP_LIMITS, matcher } from "./grep.ts";

export const REPLACE_LIMITS = { fileBytes: 8 << 20, totalBytes: 64 << 20, ms: 5000, replaceChars: 1000, undoRecords: 5, undoBytes: 64 << 20, undoMs: 3_600_000 };
export type ReplaceLimits = typeof REPLACE_LIMITS;
export class ReplaceError extends Error {
  constructor(message: string, readonly code: "bad_replacement" | "regex_timeout" | "undo_gone" | "busy") {
    super(message);
  }
}

/** Read and write through one fd (the file is read, then rewritten without a reopen gap). No O_CREAT, no O_TRUNC. */
const OPEN_RW = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Error message for a replacement that cannot be used with this query, or undefined. Pure. Regex off: only the length and line break rules. */
export function checkReplacement(query: string, regex: boolean, replace: string): string | undefined {
  if (/[\r\n]/.test(replace)) return "The replacement cannot contain a line break";
  if (replace.length > REPLACE_LIMITS.replaceChars) return `The replacement is longer than ${REPLACE_LIMITS.replaceChars} characters`;
  if (!regex) return undefined;
  const probe = new RegExp(`(?:${query})|`).exec("")!;
  const count = probe.length - 1;
  const names = Object.keys(probe.groups ?? {});
  for (const m of replace.matchAll(/\$(\$|&|<[^>]*>|\d{1,2})/g)) {
    const tok = m[1]!;
    if (tok[0] === "<") {
      if (!names.includes(tok.slice(1, -1))) return `Group ${tok} does not exist`;
    } else if (/^\d/.test(tok)) {
      const two = tok.length === 2 && Number(tok) >= 1 && Number(tok) <= count;
      const one = Number(tok[0]);
      if (!two && one > count) return `Group $${tok[0]} does not exist`;
    }
  }
  return undefined;
}

/**
 * Self-contained (it is stringified into the thread: no outside references, no imports): the new `body` and the [start, end)
 * ranges of the inserted text, or undefined when `source` (flags `gi`) matches nothing. `literal`: `replace` is inserted as is,
 * else `$0` `$&` (whole match) `$1`..`$99` `$<name>` `$$` are expanded; a reference to a missing group stays as typed.
 */
export function replaceLine(body: string, source: string, literal: boolean, replace: string): { text: string; ranges: [number, number][] } | undefined {
  const re = new RegExp(source, "gi");
  let text = "";
  let at = 0;
  let hit = false;
  const ranges: [number, number][] = [];
  const count = (new RegExp(`(?:${source})|`).exec("")?.length ?? 1) - 1;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    hit = true;
    const insert = literal
      ? replace
      : replace.replace(/\$(\$|&|<[^>]*>|\d{1,2})/g, (all: string, tok: string) => {
          if (tok === "$") return "$";
          if (tok === "&") return m[0];
          if (tok[0] === "<") {
            const v = m.groups?.[tok.slice(1, -1)];
            return v === undefined ? (m.groups && tok.slice(1, -1) in m.groups ? "" : all) : v;
          }
          const two = tok.length === 2 && Number(tok) >= 1 && Number(tok) <= count;
          if (two) return m[Number(tok)] ?? "";
          const n = Number(tok[0]);
          if (n > count) return all;
          return (n === 0 ? m[0] : m[n] ?? "") + tok.slice(1);
        });
    text += body.slice(at, m.index);
    ranges.push([text.length, text.length + insert.length]);
    text += insert;
    at = m.index + m[0].length;
  }
  return hit ? { text: text + body.slice(at), ranges } : undefined;
}
type Replaced = ReturnType<typeof replaceLine>;

const REPLACE_THREAD = `
const { parentPort } = require("node:worker_threads");
const replaceLine = ${replaceLine.toString()};
parentPort.on("message", (q) => {
  try { parentPort.postMessage(q.bodies.map((b) => replaceLine(b, q.source, false, q.replace))); }
  catch { parentPort.postMessage(undefined); }
});`;

/**
 * `replaceLine` over lines for one request. A plain query cannot backtrack: it runs in this thread. A regex runs in a worker
 * killed `ms` after the runner was made or when `signal` fires; `run` then gives undefined (and `timedOut` tells which).
 * shortcut: one thread per regex request (about 30 ms).
 */
export function replaceRunner(q: { source: string; literal: boolean; replace: string }, ms: number, signal?: AbortSignal) {
  let timedOut = false;
  let stopped = false;
  let w: Worker | undefined;
  let pending: ((r: Replaced[] | undefined) => void) | undefined;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    void w?.terminate();
    pending?.(undefined);
    pending = undefined;
  };
  const onAbort = () => stop();
  const timer = setTimeout(() => ((timedOut = true), stop()), ms);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) stop();
  return {
    get timedOut() {
      return timedOut;
    },
    run(bodies: string[]): Promise<Replaced[] | undefined> {
      if (stopped) return Promise.resolve(undefined);
      if (q.literal || !bodies.length) return Promise.resolve(bodies.map((b) => replaceLine(b, q.source, q.literal, q.replace)));
      return new Promise((resolve) => {
        pending = resolve;
        try {
          if (!w) {
            w = new Worker(REPLACE_THREAD, { eval: true });
            w.on("message", (r: Replaced[] | undefined) => ((pending = undefined), resolve(r)));
            w.on("error", () => stop());
          }
          w.postMessage({ source: q.source, replace: q.replace, bodies });
        } catch {
          stop();
        }
      });
    },
    close: stop,
  };
}

/** `text` as lines: `end` is the terminator that follows the body ("\n", "\r\n", or "" / "\r" for a last line without one). Joining body+end restores `text`. */
export function splitLines(text: string): { body: string; end: string }[] {
  const parts = text.split("\n");
  return parts.map((p, i) => {
    const last = i === parts.length - 1;
    const cr = p.endsWith("\r");
    return { body: cr ? p.slice(0, -1) : p, end: (cr ? "\r" : "") + (last ? "" : "\n") };
  });
}
const joinLines = (lines: { body: string; end: string }[]) => lines.map((l) => l.body + l.end).join("");

type UndoFile = { rel: string; file: string; before: Buffer; afterHash: string; lines: number };
/** The last few applied replaces, for one undo each: bounded by count, total bytes and age. */
export function createReplaceUndo(limits: Partial<ReplaceLimits> = {}, now: () => number = Date.now) {
  const lim = { ...REPLACE_LIMITS, ...limits };
  const records = new Map<string, { cwd: string; files: UndoFile[]; bytes: number; at: number }>();
  let n = 0;
  const prune = () => {
    for (const [id, r] of records) if (now() - r.at > lim.undoMs) records.delete(id);
    let total = [...records.values()].reduce((s, r) => s + r.bytes, 0);
    for (const [id, r] of records) {
      if (records.size <= lim.undoRecords && total <= lim.undoBytes) break;
      records.delete(id);
      total -= r.bytes;
    }
  };
  return {
    /** The undo id, or undefined when the originals are over the byte limit. */
    put(cwd: string, files: UndoFile[]): string | undefined {
      const bytes = files.reduce((s, f) => s + f.before.length, 0);
      if (bytes > lim.undoBytes) return undefined;
      const id = `${now().toString(36)}-${++n}`;
      records.set(id, { cwd, files, bytes, at: now() });
      prune();
      return id;
    },
    /** The record (removed), or undefined when unknown, expired, evicted or of another folder. */
    take(id: string, cwd: string): { files: UndoFile[] } | undefined {
      prune();
      const r = records.get(id);
      if (!r || r.cwd !== cwd) return undefined;
      records.delete(id);
      return r;
    },
  };
}
export type ReplaceUndo = ReturnType<typeof createReplaceUndo>;

type Opts = {
  /** The canonical path when `p` is inside the roots, else undefined. */
  allowed: (p: string) => string | undefined;
  /** Local history entry of the file's current content, called before each write. */
  snapshot: (file: string, reason: "replace" | "restore") => void;
  undo: ReplaceUndo;
  signal?: AbortSignal;
  afterWrite: () => void;
  limits?: Partial<ReplaceLimits>;
};

/** A path of a request: relative, `/` separated, without `..`, NUL or a drive. */
export function safeRel(p: unknown): p is string {
  return typeof p === "string" && !!p && !p.includes("\0") && !p.includes("\\") && !isAbsolute(p) && !win32.isAbsolute(p) && !posix.isAbsolute(p) && !p.split("/").includes("..");
}

const skipped = (path: string, skipped: ReplaceSkip, message?: string): ReplaceFile => ({ path, skipped, ...(message ? { message } : {}) });
const failOf = (e: unknown): [ReplaceSkip, string] => {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT") return ["not_found", "The file no longer exists"];
  if (code === "ECHANGED") return ["path_not_allowed", "The file changed during the request"];
  return ["fs_error", (e as Error).message];
};
const decode = (b: Buffer): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    return undefined;
  }
};

type Prepared = { path: string; file: string; fd: number; lines: ReturnType<typeof splitLines>; picks: number[]; before: Buffer; found: Replaced[]; mtime: number; size: number };

/**
 * Dry run: each listed line's new text (reads only). Apply: rewrites the listed lines of each file whose `mtime`/`size` still
 * equal the dry run's and whose listed lines still match; every other file is skipped. All files are read and computed first
 * (a regex timeout then writes nothing), then written through the fds they were read from.
 */
export async function replaceInFiles(
  cwd: string,
  q: { query: string; regex: boolean; replace: string; dryRun: boolean; files: { path: string; lines: number[]; mtime?: number; size?: number }[] },
  opts: Opts,
): Promise<FsReplaceResult> {
  const lim = { ...REPLACE_LIMITS, ...opts.limits };
  const bad = checkReplacement(q.query, q.regex, q.replace);
  if (bad) throw new ReplaceError(bad, "bad_replacement");
  const source = matcher(q.query, q.regex).source;
  const runner = replaceRunner({ source, literal: !q.regex, replace: q.replace }, lim.ms, opts.signal);
  const out: ReplaceFile[] = [];
  const prepared: Prepared[] = [];
  let total = 0;
  let cut = false;
  try {
    for (const f of q.files) {
      if (opts.signal?.aborted) break;
      if (!safeRel(f.path)) {
        out.push(skipped(String(f.path), "path_not_allowed", "Path is not allowed"));
        continue;
      }
      const file = opts.allowed(join(cwd, f.path));
      if (!file) {
        const gone = (() => {
          try {
            return void lstatSync(join(cwd, f.path)), false;
          } catch (e) {
            return (e as { code?: string }).code === "ENOENT";
          }
        })();
        out.push(gone ? skipped(f.path, "not_found", "The file no longer exists") : skipped(f.path, "path_not_allowed", "Outside the allowed folders"));
        continue;
      }
      let fd: number | undefined;
      try {
        fd = openChecked(file, q.dryRun ? OPEN_READ : OPEN_RW);
        const st = fstatSync(fd);
        if (!st.isFile()) {
          out.push(skipped(f.path, "fs_error", "Not a file"));
          continue;
        }
        if (st.size > lim.fileBytes || total + st.size > lim.totalBytes) {
          out.push(skipped(f.path, "too_large", "The file is too large"));
          continue;
        }
        if (!q.dryRun && (f.mtime !== st.mtimeMs || f.size !== st.size)) {
          out.push(skipped(f.path, "changed", "Changed on disk after the search"));
          continue;
        }
        total += st.size;
        const before = readAll(fd, st.size);
        const text = decode(before);
        if (text === undefined) {
          out.push(skipped(f.path, "not_utf8", "Not UTF-8 text"));
          continue;
        }
        const lines = splitLines(text);
        const picks = [...new Set(f.lines.filter((n) => Number.isSafeInteger(n) && n >= 1))].sort((a, b) => a - b);
        const found = await runner.run(picks.map((n) => lines[n - 1]?.body ?? ""));
        if (!found) throw new ReplaceError(runner.timedOut ? "The regular expression took too long" : "Canceled", runner.timedOut ? "regex_timeout" : "busy");
        if (q.dryRun) {
          const rows: ReplaceLine[] = picks.map((n, i) => {
            const r = n <= lines.length ? found[i] : undefined;
            if (!r) return { n, none: true };
            const c = cutLine(r.text, r.ranges, GREP_LIMITS.lineChars);
            cut ||= c.cut;
            return { n, after: c.text, ranges: c.ranges ?? [] };
          });
          out.push({ path: f.path, mtime: st.mtimeMs, size: st.size, lines: rows });
        } else if (picks.some((n, i) => n > lines.length || !found[i])) {
          out.push(skipped(f.path, "changed", "A listed line no longer matches"));
        } else {
          prepared.push({ path: f.path, file, fd, lines, picks, before, found, mtime: st.mtimeMs, size: st.size });
          fd = undefined;
        }
      } catch (e) {
        if (e instanceof ReplaceError) throw e;
        const [why, message] = failOf(e);
        out.push(skipped(f.path, why, message));
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (q.dryRun) return { files: out, changedFiles: 0, changedLines: 0, ...(cut ? { cut: true as const } : {}) };
    if (opts.signal?.aborted) throw new ReplaceError("Canceled", "busy");
    // Everything computed: write.
    const done: UndoFile[] = [];
    let changedLines = 0;
    for (const p of prepared.splice(0)) {
      try {
        p.picks.forEach((n, i) => (p.lines[n - 1]!.body = p.found[i]!.text));
        const data = Buffer.from(joinLines(p.lines));
        if (data.equals(p.before)) continue;
        opts.snapshot(p.file, "replace");
        ftruncateSync(p.fd, 0);
        writeAll(p.fd, data);
        done.push({ rel: p.path, file: p.file, before: p.before, afterHash: sha(data), lines: p.picks.length });
        changedLines += p.picks.length;
      } catch (e) {
        const [why, message] = failOf(e);
        out.push(skipped(p.path, why, message));
      } finally {
        closeSync(p.fd);
      }
    }
    if (done.length) opts.afterWrite();
    const undoId = done.length ? opts.undo.put(cwd, done) : undefined;
    return { files: out, changedFiles: done.length, changedLines, ...(undoId ? { undoId } : {}) };
  } finally {
    runner.close();
    for (const p of prepared) closeSync(p.fd);
  }
}

/** Writes back each file's content from before the replace, when the file still has the content the replace wrote. */
export async function undoReplace(cwd: string, id: string, skip: string[], opts: Pick<Opts, "allowed" | "snapshot" | "undo" | "afterWrite">): Promise<FsReplaceResult> {
  const rec = opts.undo.take(id, cwd);
  if (!rec) throw new ReplaceError("Undo is no longer available. Each file's previous content is in its Local history.", "undo_gone");
  const out: ReplaceFile[] = [];
  let files = 0;
  let lines = 0;
  for (const f of rec.files) {
    if (skip.includes(f.rel)) {
      out.push(skipped(f.rel, "unsaved", "Has unsaved changes in an editor tab"));
      continue;
    }
    let fd: number | undefined;
    try {
      const file = opts.allowed(f.file);
      if (!file) {
        out.push(skipped(f.rel, "path_not_allowed", "Outside the allowed folders"));
        continue;
      }
      fd = openChecked(file, OPEN_RW);
      const st = fstatSync(fd);
      if (!st.isFile()) {
        out.push(skipped(f.rel, "fs_error", "Not a file"));
        continue;
      }
      if (st.size > REPLACE_LIMITS.fileBytes * 2 || sha(readAll(fd, st.size)) !== f.afterHash) {
        out.push(skipped(f.rel, "changed", "Changed after the replace"));
        continue;
      }
      opts.snapshot(file, "restore");
      ftruncateSync(fd, 0);
      writeAll(fd, f.before);
      files++;
      lines += f.lines;
    } catch (e) {
      const [why, message] = failOf(e);
      out.push(skipped(f.rel, why, message));
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  if (files) opts.afterWrite();
  return { files: out, changedFiles: files, changedLines: lines };
}
