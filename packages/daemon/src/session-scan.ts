import { Worker, type ResourceLimits } from "node:worker_threads";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

/**
 * The SDK's listSessions() in a worker thread. It reads the head and tail of every transcript under ~/.claude/projects and
 * scans them as strings: with a thousand transcripts that is seconds of CPU on the main thread, which held the event loop for
 * hundreds of ms at a time on the first session.list (GH-276). In the thread it blocks only itself. Plain JS, eval'd: nothing
 * to bundle; the SDK stays an external dependency, so its resolved URL loads in both the source checkout and the package.
 * A thread that cannot start, errors, or cannot import the SDK is marked broken and the main-thread call takes over from then
 * on; a thread that exits, or does not answer within `timeoutMs`, is dropped (terminated), its calls are answered on the main
 * thread and the next call starts a new thread.
 * Memory (GH-837): the SDK reads all transcripts at once without a `limit` and, per transcript, builds the entry's strings as
 * slices of the 64 KB head and tail it read, which keep both alive (~1.3 GB for 5900 transcripts). The call is therefore paged
 * (`paged`: 32 transcripts at a time, the same list) and the thread copies short slices, so a scan holds about 32 transcripts'
 * heads and tails, not all of them. The main-thread fallback is paged too, without the slice copy (it cannot patch the daemon's
 * String.prototype).
 */
const SCAN_THREAD = `
"use strict";
// A V8 slice keeps its whole parent string alive. A short slice of a long string is copied instead ("\\0" + s is a new string,
// slice(1) of it a flat copy), so each entry's cwd, summary, ... no longer holds its file's head and tail. Thresholds measured
// on 5890 real transcripts (16 MB retained); do not change without measuring. This thread runs nothing but the scan.
const slice = String.prototype.slice;
String.prototype.slice = function (start, end) {
  const s = slice.call(this, start, end);
  return this.length > 1024 && s.length < 1024 ? slice.call("\\0" + s, 1) : s;
};
const { parentPort } = require("node:worker_threads");
let sdk;
parentPort.on("message", async ({ id, url, options }) => {
  try {
    sdk ??= await import(url);
  } catch (e) {
    parentPort.postMessage({ id, fatal: String((e && e.message) || e) });
    return;
  }
  try {
    parentPort.postMessage({ id, sessions: await sdk.listSessions(options) });
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});`;
/** Test seam: the thread's script and SDK URL; `reset()` drops the thread and the broken mark. */
export const scanThreadConfig = {
  script: SCAN_THREAD,
  sdkUrl: import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
  /** A call the thread has not answered by then drops the thread (the scan has no natural bound, but 30 s is far beyond any real one). */
  timeoutMs: 30_000,
  /** Test only: caps the thread's heap. Production has no cap (an out-of-memory thread would be marked broken for good). */
  resourceLimits: undefined as ResourceLimits | undefined,
  reset() {
    const w = thread;
    thread = undefined;
    broken = false;
    if (w) void w.terminate();
  },
  get broken() {
    return broken;
  },
};
/** Without a limit the SDK reads every transcript at once; with one it reads 32 at a time. Same list. */
const paged = (o: Parameters<typeof listSessions>[0]) => ({ ...o, limit: o?.limit ?? Number.MAX_SAFE_INTEGER });
type Sessions = Awaited<ReturnType<typeof listSessions>>;
let thread: Worker | undefined;
let broken = false;
let nextCall = 0;
const calls = new Map<number, { ok: (s: Sessions) => void; fail: (e: Error) => void; w: Worker; timer: NodeJS.Timeout; options: Parameters<typeof listSessions>[0] }>();
/** A thread that errored or exited: its pending calls are answered by the main-thread scan, not failed. */
function failCalls(w: Worker) {
  for (const [id, c] of calls)
    if (c.w === w) {
      calls.delete(id);
      clearTimeout(c.timer);
      listSessions(c.options).then(c.ok, c.fail);
    }
}
/** Drops `w`: its calls go to the main thread; `unusable` also routes every later call there. */
function retire(w: Worker, unusable: boolean) {
  if (thread === w) thread = undefined;
  if (unusable) broken = true;
  void w.terminate();
  failCalls(w);
}
function scanThread(): Worker | undefined {
  if (thread || broken) return thread;
  try {
    const w = new Worker(scanThreadConfig.script, { eval: true, resourceLimits: scanThreadConfig.resourceLimits });
    w.on("message", ({ id, sessions, error, fatal }: { id: number; sessions?: Sessions; error?: string; fatal?: string }) => {
      const c = calls.get(id);
      if (!c) return;
      if (fatal !== undefined) {
        console.warn(`session-scan: scan thread cannot load the SDK, scanning on the main thread from now on: ${fatal}`);
        return retire(w, true);
      }
      calls.delete(id);
      clearTimeout(c.timer);
      if (error === undefined) c.ok(sessions ?? []);
      else c.fail(new Error(error));
    });
    w.on("error", (e) => {
      console.warn(`session-scan: scan thread failed, scanning on the main thread from now on: ${String(e)}`);
      retire(w, true);
    });
    w.on("exit", () => {
      if (thread === w) thread = undefined;
      failCalls(w);
    });
    w.unref();
    thread = w;
  } catch (e) {
    console.warn(`session-scan: scan thread did not start, scanning on the main thread: ${String(e)}`);
    broken = true;
  }
  return thread;
}
/** listSessions() off the main thread; same signature as the SDK's. */
export const listSessionsOffThread: typeof listSessions = (options) => {
  const w = scanThread();
  if (!w) return listSessions(paged(options));
  const id = ++nextCall;
  return new Promise<Sessions>((ok, fail) => {
    const timer = setTimeout(() => {
      console.warn(`session-scan: scan thread did not answer in ${scanThreadConfig.timeoutMs} ms, dropping it`);
      retire(w, false);
    }, scanThreadConfig.timeoutMs);
    timer.unref();
    const paging = paged(options);
    calls.set(id, { ok, fail, w, timer, options: paging });
    w.postMessage({ id, url: scanThreadConfig.sdkUrl, options: paging });
  });
};

/** `size:mtime` of every transcript under `projectsDir` by `<project dir>/<file>`, read without blocking the event loop; undefined when unreadable. */
export async function transcriptStamp(projectsDir: string): Promise<Map<string, string> | undefined> {
  try {
    const parts = new Map<string, string>();
    for (const dir of (await readdir(projectsDir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!dir.isDirectory()) continue;
      const path = join(projectsDir, dir.name);
      const names = (await readdir(path).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl")).sort();
      const stats = await Promise.all(names.map((f) => stat(join(path, f)).catch(() => undefined)));
      names.forEach((f, i) => stats[i] && parts.set(`${dir.name}/${f}`, `${stats[i].size}:${stats[i].mtimeMs}`));
    }
    return parts;
  } catch {
    return undefined;
  }
}

/** Bytes read first from a transcript's end; most last messages are in it. */
export const FIRST_TAIL_BYTES = 32 * 1024;

/**
 * Time of the last user or assistant entry in the last `tailBytes` of `file`, read async: the last FIRST_TAIL_BYTES first,
 * the full tail only when no entry is in them. `{ version }` is the file's mtime and size; undefined when it cannot be read.
 */
export async function lastEntryTime(file: string, tailBytes: number): Promise<{ version: string; at: number | undefined } | undefined> {
  let fh;
  try {
    fh = await open(file, "r");
    const { size, mtimeMs } = await fh.stat();
    const version = `${mtimeMs}:${size}`;
    for (const want of [FIRST_TAIL_BYTES, tailBytes]) {
      const buf = Buffer.alloc(Math.min(size, want));
      await fh.read(buf, 0, buf.length, size - buf.length);
      const lines = buf.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i]!.includes('"timestamp"')) continue;
        try {
          const e = JSON.parse(lines[i]!) as { type?: string; timestamp?: string };
          const t = (e.type === "user" || e.type === "assistant") && Date.parse(e.timestamp ?? "");
          if (t) return { version, at: t };
        } catch {
          // The first line of the tail is cut.
        }
      }
      if (buf.length >= size) break;
    }
    return { version, at: undefined };
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

/** `fn` over `items`, at most `limit` at a time. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export type Scanned = Awaited<ReturnType<typeof listSessions>>;

/** Tail bytes the SDK reads per transcript (`listSessions`, `getSessionInfo`). */
const SDK_TAIL_BYTES = 64 * 1024;
/** More added or changed transcripts than this: one full scan (in the scan thread) costs less than reading them one by one on the main thread. */
export const PATCH_LIMIT = 200;

/** The full scan's order (SDK listSessions): newest first, then session id descending. */
function bySdkOrder(a: Scanned[number], b: Scanned[number]): number {
  return b.lastModified - a.lastModified || (b.sessionId < a.sessionId ? -1 : b.sessionId > a.sessionId ? 1 : 0);
}

/** Whether the last SDK_TAIL_BYTES of `file` contain `needle`; undefined when unreadable. */
async function tailIncludes(file: string, needle: string): Promise<boolean | undefined> {
  let fh;
  try {
    fh = await open(file, "r");
    const { size } = await fh.stat();
    const buf = Buffer.alloc(Math.min(size, SDK_TAIL_BYTES));
    await fh.read(buf, 0, buf.length, size - buf.length);
    return buf.includes(needle);
  } catch {
    return undefined;
  } finally {
    await fh?.close();
  }
}

/**
 * `last.result` brought up to `stamp` without a full scan: added and changed transcripts are read alone (getSessionInfo),
 * removed ones dropped. undefined when only a full listSessions() gives the same list: a session id in two project folders
 * (the SDK keeps the newer file), a `continued-in` entry (the SDK hides that session while its successor exists), a read
 * that failed, or more than PATCH_LIMIT files to read.
 * Known gap: a session with `continued-in` from before the last full scan stays listed when only its successor changes,
 * until the next full scan.
 */
export async function patchScan(
  last: { stamp: ReadonlyMap<string, string>; result: Scanned },
  stamp: ReadonlyMap<string, string>,
  projectsDir: string,
  getSessionInfo: (id: string) => Promise<Scanned[number] | undefined>,
): Promise<Scanned | undefined> {
  const idOf = (file: string) => file.slice(file.lastIndexOf("/") + 1, -".jsonl".length);
  const count = new Map<string, number>();
  for (const f of stamp.keys()) count.set(idOf(f), (count.get(idOf(f)) ?? 0) + 1);
  const touched = [...stamp].filter(([f, v]) => last.stamp.get(f) !== v).map(([f]) => f);
  const removed = [...last.stamp.keys()].filter((f) => !stamp.has(f));
  if (!touched.length && !removed.length) return last.result;
  if (touched.length > PATCH_LIMIT) return undefined;
  if (touched.some((f) => count.get(idOf(f)) !== 1) || removed.some((f) => count.has(idOf(f)))) return undefined;
  const reads = await mapLimit(touched, 8, async (f) => {
    const id = idOf(f);
    const [info, continued] = await Promise.all([
      getSessionInfo(id).then((i) => ({ i }), () => undefined),
      tailIncludes(join(projectsDir, f), '"type":"continued-in"'),
    ]);
    return { id, info: info?.i, failed: !info, continued };
  });
  if (reads.some((r) => r.failed || r.continued !== false || (r.info && r.info.sessionId !== r.id))) return undefined;
  const drop = new Set([...touched, ...removed].map(idOf));
  return [
    ...last.result.filter((t) => !drop.has(t.sessionId)),
    ...reads.flatMap((r) => (r.info ? [r.info] : [])),
  ].sort(bySdkOrder);
}
