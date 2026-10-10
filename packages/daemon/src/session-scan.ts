import { Worker } from "node:worker_threads";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

/**
 * The SDK's listSessions() in a worker thread. It reads the head and tail of every transcript under ~/.claude/projects and
 * scans them as strings: with a thousand transcripts that is seconds of CPU on the main thread, which held the event loop for
 * hundreds of ms at a time on the first session.list (GH-276). In the thread it blocks only itself. Plain JS, eval'd: nothing
 * to bundle; the SDK stays an external dependency, so its resolved URL loads in both the source checkout and the package.
 * A thread that errors (cannot start, SDK import fails) is marked broken and the main-thread call takes over; a thread that
 * exits starts again on the next call.
 */
const SCAN_THREAD = `
const { parentPort } = require("node:worker_threads");
let sdk;
parentPort.on("message", async ({ id, url, options }) => {
  try {
    sdk ??= await import(url);
    parentPort.postMessage({ id, sessions: await sdk.listSessions(options) });
  } catch (e) {
    parentPort.postMessage({ id, error: String((e && e.message) || e) });
  }
});`;
/** Test seam: the thread's script and SDK URL; `reset()` drops the thread and the broken mark. */
export const scanThreadConfig = {
  script: SCAN_THREAD,
  sdkUrl: import.meta.resolve("@anthropic-ai/claude-agent-sdk"),
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
type Sessions = Awaited<ReturnType<typeof listSessions>>;
let thread: Worker | undefined;
let broken = false;
let nextCall = 0;
const calls = new Map<number, { ok: (s: Sessions) => void; fail: (e: Error) => void; w: Worker; options: Parameters<typeof listSessions>[0] }>();
/** A thread that errored or exited: its pending calls are answered by the main-thread scan, not failed. */
function failCalls(w: Worker) {
  for (const [id, c] of calls)
    if (c.w === w) {
      calls.delete(id);
      listSessions(c.options).then(c.ok, c.fail);
    }
}
function scanThread(): Worker | undefined {
  if (thread || broken) return thread;
  try {
    const w = new Worker(scanThreadConfig.script, { eval: true });
    w.on("message", ({ id, sessions, error }: { id: number; sessions?: Sessions; error?: string }) => {
      const c = calls.get(id);
      if (!c) return;
      calls.delete(id);
      if (error === undefined) c.ok(sessions ?? []);
      else c.fail(new Error(error));
    });
    w.on("error", (e) => {
      console.warn(`session-scan: scan thread failed, scanning on the main thread from now on: ${String(e)}`);
      if (thread === w) (thread = undefined, (broken = true));
      failCalls(w);
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
  if (!w) return listSessions(options);
  const id = ++nextCall;
  return new Promise<Sessions>((ok, fail) => {
    calls.set(id, { ok, fail, w, options });
    w.postMessage({ id, url: scanThreadConfig.sdkUrl, options });
  });
};

/** Names, sizes and mtimes of every transcript under `projectsDir`, read without blocking the event loop; undefined when unreadable. */
export async function transcriptStamp(projectsDir: string): Promise<string | undefined> {
  try {
    const parts: string[] = [];
    for (const dir of (await readdir(projectsDir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!dir.isDirectory()) continue;
      const path = join(projectsDir, dir.name);
      const names = (await readdir(path).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl")).sort();
      const stats = await Promise.all(names.map((f) => stat(join(path, f)).catch(() => undefined)));
      names.forEach((f, i) => stats[i] && parts.push(`${dir.name}/${f}:${stats[i].size}:${stats[i].mtimeMs}`));
    }
    return parts.join("\n");
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
