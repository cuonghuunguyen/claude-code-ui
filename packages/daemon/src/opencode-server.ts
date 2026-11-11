// The OpenCode server of this daemon (docs/spec.md "OpenCode engine"): one `opencode serve` child, started on first use, stopped with the daemon.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { OPENCODE_MIN, type OpenCodeStatus } from "@claude-ui/protocol";
import { SERVE_WATCHER } from "./tailscale.ts";
import { winQuote } from "./update.ts";

export type OpenCodeErrorCode = "opencode_missing" | "opencode_old" | "opencode_failed";
/** A non-2xx answer: `status` and the parsed `body` let callers map OpenCode's error `name`. */
export class OpenCodeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}
/** A start problem the user can act on; `code` goes to the wire as the error code. */
export class OpenCodeError extends Error {
  constructor(
    readonly code: OpenCodeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 3_000;
/** Crash loop guard: this many exits, each within FAST_MS of its start, stop restarts for GUARD_MS. */
const FAST_EXITS = 3;
const FAST_MS = 30_000;
const GUARD_MS = 5 * 60_000;
/** Every fetch to the server goes through here: a new connection each time (`connection: close`), so a dead server only fails the connect, which proves the
 * request never reached it (see request()). A pooled connection of a dead server can still look open (Windows: the pid is gone before its sockets close) and
 * takes the request. One fetch to the server without the header puts a socket in the pool that the next request may reuse. */
const ocFetch = (url: string | URL, init: RequestInit & { headers: Record<string, string> }) => fetch(url, { ...init, headers: { ...init.headers, connection: "close" } });
const missing = () => new OpenCodeError("opencode_missing", "OpenCode is not installed or not found on PATH. Install it (https://opencode.ai/docs) or set its path in Settings › OpenCode.");

/** `x.y.z` as numbers; undefined when the text has none. */
export const parseVersion = (text: string) => /(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1, 4).map(Number);
/** a < b for `x.y.z` lists. */
export const olderThan = (a: number[], b: number[]) => (a.find((n, i) => n !== b[i]) ?? 0) < (b.find((n, i) => n !== a[i]) ?? 0);

/** The binary on PATH: `opencode`; on Windows `opencode.exe`, else `opencode.cmd` (run through cmd.exe, see invocation). */
function lookup(env: NodeJS.ProcessEnv): string[] | undefined {
  const win = process.platform === "win32";
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean))
    for (const name of win ? ["opencode.exe", "opencode.cmd"] : ["opencode"]) {
      const file = join(dir, name);
      if (existsSync(file)) return [file];
    }
}

/** How to run `binary ...args`: a Windows .cmd/.bat goes through cmd.exe as one quoted line (`/s` strips the outer quotes), passed verbatim, so a path with spaces survives. */
export function invocation(binary: string, args: string[], platform: NodeJS.Platform = process.platform): { file: string; args: string[]; verbatim: boolean } {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(binary)) return { file: binary, args, verbatim: false };
  return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${[binary, ...args].map(winQuote).join(" ")}"`], verbatim: true };
}

/** A consumer of the server's event stream: `event` per payload of `GET /global/event`; `resync` after a reconnect (events may be lost). */
export type OpenCodeEvents = { event(directory: string | undefined, payload: { type: string; properties: Record<string, any> }): void; resync(): void };
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10_000;
/** A prompt waits this long for the stream before it is sent anyway. */
const STREAM_WAIT_MS = 5000;

export type OpenCodeServerOpts = {
  /** Settings `opencode.path`: "" = look `opencode` up on PATH. */
  path: () => string;
  /** Test seam: the argv prefix used while `path()` is "" (replaces the PATH lookup). */
  command?: string[];
  /** Test seam: added to the daemon's environment for the child. */
  env?: () => NodeJS.ProcessEnv;
  now?: () => number;
  startTimeoutMs?: number;
};

type Up = { url: string; auth: string; version: string };

/**
 * E2E harness only: when `CLAUDE_UI_E2E_OPENCODE_INFO` names a file, the daemon writes `{url, auth}` of its OpenCode server there (mode 600) each time the
 * server is up, so a test can talk to the same server the app uses. Never logged. Without the variable nothing is written.
 */
function shareWithE2e(up: { url: string; auth: string }) {
  const file = process.env.CLAUDE_UI_E2E_OPENCODE_INFO;
  if (!file) return;
  try {
    writeFileSync(file, JSON.stringify({ url: up.url, auth: up.auth }), { mode: 0o600 });
  } catch {}
}

export function createOpenCodeServer(o: OpenCodeServerOpts) {
  const now = o.now ?? Date.now;
  const env = () => ({ ...process.env, ...o.env?.() });
  let child: ChildProcess | undefined;
  let up: Up | undefined;
  let starting: Promise<Up> | undefined;
  /** Start times of recent exits that came within FAST_MS of their start. */
  let fastExits: number[] = [];
  let lastError: string | undefined;
  let stderr = "";
  let stopRequested = false;
  // The child is SERVE_WATCHER (tailscale.ts): it runs `opencode serve` in its own process group and kills that group when its stdin closes,
  // so the serve ends with the daemon even when the daemon is killed (the pipe closes). Closing stdin is the way to stop it.
  const killSync = () => child?.stdin?.destroy();

  const argv = () => {
    const path = o.path();
    if (path) return existsSync(path) ? [path] : undefined;
    return o.command ?? lookup(env());
  };

  /** Binary and version, never a server: throws OpenCodeError. The bound is the start timeout, not a shorter one of its own: `--version` starts the same binary, so a machine too busy to answer it in 10 s would refuse to start OpenCode although `serve` is given 20 s. */
  async function check() {
    const cmd = argv();
    if (!cmd) throw missing();
    const run = invocation(cmd[0]!, [...cmd.slice(1), "--version"]);
    const out = await new Promise<string>((resolve, reject) =>
      execFile(run.file, run.args, { env: env(), timeout: o.startTimeoutMs ?? START_TIMEOUT_MS, windowsHide: true, windowsVerbatimArguments: run.verbatim }, (err, stdout, errout) => (err ? reject(err) : resolve(`${stdout}${errout}`))),
    ).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw missing();
      throw new OpenCodeError("opencode_failed", `OpenCode did not answer --version: ${err.message}`);
    });
    const version = parseVersion(out);
    if (!version) throw new OpenCodeError("opencode_failed", `OpenCode --version printed no version: ${out.trim().slice(0, 200)}`);
    const text = version.join(".");
    if (olderThan(version, parseVersion(OPENCODE_MIN)!)) throw new OpenCodeError("opencode_old", `OpenCode ${text} is older than the minimum ${OPENCODE_MIN}. Upgrade it with \`opencode upgrade\`.`);
    return { cmd, version: text };
  }

  const failed = (why: string) => new OpenCodeError("opencode_failed", `OpenCode server did not start: ${why}`);
  const tail = () => stderr.trim().split("\n").slice(-5).join("\n") || "no output";

  async function start(): Promise<Up> {
    const exits = fastExits.filter((t) => now() - t < GUARD_MS);
    if (exits.length >= FAST_EXITS) throw failed(`it exited ${exits.length} times right after starting. Last output: ${tail()}`);
    const { cmd, version } = await check();
    const password = randomBytes(32).toString("hex");
    stderr = "";
    stopRequested = false;
    const startedAt = now();
    // A start that fails counts as a quick exit, once (the exit event may count it too).
    let counted = false;
    const count = () => !counted && ((counted = true), fastExits.push(startedAt));
    const run = invocation(cmd[0]!, [...cmd.slice(1), "serve", "--hostname", "127.0.0.1", "--port", "0"]);
    const proc = spawn(process.execPath, ["-e", SERVE_WATCHER, run.file, ...run.args], {
      env: { ...env(), OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child = proc;
    const exited = new Promise<never>((_, reject) => {
      proc.once("error", (err) => reject(failed(err.message)));
      proc.once("exit", (code, signal) => {
        if (child === proc) (child = undefined), (up = undefined);
        if (!stopRequested && now() - startedAt < FAST_MS) count();
        else if (!stopRequested) fastExits = [];
        reject(failed(`the process ended (${signal ?? `exit ${code}`}). Last output: ${tail()}`));
      });
    });
    exited.catch(() => {});
    proc.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    const listening = new Promise<string>((resolve) => {
      let buf = "";
      proc.stdout!.on("data", (d) => {
        buf = (buf + d).slice(-4000);
        const m = /listening on (http:\/\/\S+)/.exec(buf);
        if (m) resolve(m[1]!);
      });
    });
    const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    let timer: NodeJS.Timeout | undefined;
    try {
      const url = await Promise.race([
        listening,
        exited,
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(failed(`no answer in ${(o.startTimeoutMs ?? START_TIMEOUT_MS) / 1000} s. Last output: ${tail()}`)), o.startTimeoutMs ?? START_TIMEOUT_MS))),
      ]);
      const health = await Promise.race([
        ocFetch(`${url}/global/health`, { headers: { authorization: auth }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).then((r) => (r.ok ? (r.json() as Promise<{ healthy?: boolean }>) : Promise.reject(new Error(`health answered ${r.status}`)))),
        exited,
      ]);
      if (!health.healthy) throw new Error("health says not healthy");
      up = { url: url.replace(/\/$/, ""), auth, version };
      shareWithE2e(up);
      lastError = undefined;
      return up;
    } catch (err) {
      // A process that died shows its last output: give its exit event a moment.
      await Promise.race([exited.catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
      count();
      stopRequested = true;
      killSync();
      child = undefined;
      throw err instanceof OpenCodeError ? err : failed(`${err instanceof Error ? err.message : String(err)}. Last output: ${tail()}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Starts the server unless it runs; concurrent calls share one start. */
  const ensure = (): Promise<Up> => {
    if (up && child) return Promise.resolve(up);
    return (starting ??= start()
      .catch((err) => {
        lastError = err instanceof Error ? err.message : String(err);
        throw err;
      })
      .finally(() => (starting = undefined)));
  };

  // The event stream (`GET /global/event`, one for every folder): open while a handler exists, reconnected through ensure() with a growing delay.
  const handlers = new Set<OpenCodeEvents>();
  let pumping = false;
  let streamAbort: AbortController | undefined;
  let connected: Promise<void> = Promise.resolve();
  let markConnected = () => {};
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function readStream(res: Response) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let msg: { directory?: string; payload?: { type: string; properties: Record<string, any> } };
        try {
          msg = JSON.parse(data);
        } catch {
          continue;
        }
        const payload = msg.payload;
        if (!payload || payload.type === "sync" || payload.type === "server.heartbeat" || payload.type === "server.connected") continue;
        for (const h of [...handlers]) h.event(msg.directory, payload);
      }
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    let delay = RECONNECT_MIN_MS;
    let again = false;
    connected = new Promise<void>((r) => (markConnected = r));
    while (handlers.size) {
      try {
        const u = await ensure();
        if (!handlers.size) break;
        streamAbort = new AbortController();
        const res = await ocFetch(`${u.url}/global/event`, { headers: { authorization: u.auth, accept: "text/event-stream" }, signal: streamAbort.signal });
        if (!res.ok || !res.body) throw new Error(`event stream answered ${res.status}`);
        if (again) for (const h of [...handlers]) h.resync();
        again = true;
        delay = RECONNECT_MIN_MS;
        markConnected();
        await readStream(res);
      } catch {
        // Retried below; a start failure shows when the next request needs the server.
      }
      if (!handlers.size) break;
      // Down until the next connect: a prompt waits for it.
      connected = new Promise<void>((r) => (markConnected = r));
      await sleep(delay);
      delay = Math.min(delay * 2, RECONNECT_MAX_MS);
    }
    pumping = false;
    markConnected();
  }

  /** Stops the child and its tree; resolves when it is gone. The next `ensure()` starts a new one. */
  const stop = async () => {
    const proc = child;
    streamAbort?.abort();
    stopRequested = true;
    child = undefined;
    up = undefined;
    if (proc?.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
    const gone = new Promise<void>((r) => proc.once("exit", () => r()));
    proc.stdin?.end();
    // The watcher normally ends the server at once; a SIGTERM makes it do the same when stdin did not.
    const timer = setTimeout(() => proc.kill("SIGTERM"), 2000);
    await gone;
    clearTimeout(timer);
  };

  return {
    ensure,
    stop,
    /** The daemon ends: no more event stream, the server stops and stays down. */
    close: () => (handlers.clear(), stop()),
    /** Registers a consumer of the event stream (opened now when it was not); returns its unsubscribe. */
    events(h: OpenCodeEvents) {
      handlers.add(h);
      void pump();
      return () => {
        handlers.delete(h);
        if (!handlers.size) streamAbort?.abort();
      };
    },
    /** Resolves when the event stream is connected (or after a few seconds): a prompt sent before it would lose its first events. */
    streamReady: () => {
      let timer: NodeJS.Timeout;
      return Promise.race([connected, new Promise((r) => (timer = setTimeout(r, STREAM_WAIT_MS)))]).then(() => clearTimeout(timer));
    },
    /** The path setting changed: stop, and forget crashes (the new binary gets a fresh start). */
    reset: () => ((fastExits = []), (lastError = undefined), stop()),
    running: () => !!up && !!child,
    /** Binary and version only, never `serve`. */
    async status(): Promise<OpenCodeStatus> {
      const path = o.path() || undefined;
      try {
        const { version } = await check();
        if (up && child) return { state: "running", version, ...(path && { path }) };
        return lastError ? { state: "failed", version, message: lastError, ...(path && { path }) } : { state: "stopped", version, ...(path && { path }) };
      } catch (err) {
        if (!(err instanceof OpenCodeError)) throw err;
        return { state: err.code === "opencode_missing" ? "missing" : err.code === "opencode_old" ? "old" : "failed", message: err.message, ...(path && { path }) };
      }
    },
    /** JSON in and out; starts the server when it is down (a crash restarts here); `directory` scopes the request to a project. */
    async request<T>(path: string, r: { method?: string; directory?: string; body?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
      // The caller's timeout counts from each send (a start or restart of the server is not part of it, as before the merge of GH-685).
      const ms = r.timeoutMs ?? REQUEST_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectLate!: (err: Error) => void;
      const late = new Promise<never>((_, reject) => (rejectLate = reject));
      const sending = () => {
        if (r.timeoutMs === 0) return;
        clearTimeout(timer);
        timer = setTimeout(() => rejectLate(Object.assign(new Error(`OpenCode ${r.method ?? "GET"} ${path} did not answer in ${ms} ms`), { name: "TimeoutError" })), ms);
      };
      const work = (async () => {
        // The server died and its exit event has not reached us yet (the pid is gone first, a moment longer on Windows): the connect fails (no pooled connections, ocFetch).
        // If the server does not answer a health probe either, drop it, start the next one and send the request once more. Any other failure, also a connection that
        // broke after the connect, is the caller's (OpenCode may have got the request), and a live server is never restarted.
        // `srv` is the server this request used: only when it is still the current one (`up`) is it dropped; a server another request restarted meanwhile is kept.
        let res: Response;
        for (let retry = true; ; retry = false) {
          const srv = await ensure();
          const url = new URL(path, `${srv.url}/`);
          if (r.directory) url.searchParams.set("directory", r.directory);
          sending();
          try {
            res = await ocFetch(url, {
              method: r.method ?? "GET",
              headers: { authorization: srv.auth, ...(r.body !== undefined && { "content-type": "application/json" }) },
              body: r.body === undefined ? undefined : JSON.stringify(r.body),
              // Only the caller's own signal aborts. A timeout never does (below).
              signal: r.signal,
            });
            break;
          } catch (err) {
            // Nothing reached the server: the probe and a restart are not the caller's wait either.
            if (retry && neverArrived(err)) clearTimeout(timer);
            if (!retry || !neverArrived(err) || (await alive(srv))) throw err;
            if (up === srv) {
              stopRequested = true;
              killSync();
              child = undefined;
              up = undefined;
            }
          }
        }
        const text = await res.text();
        if (!res.ok) {
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {}
          // The path only, never the request body: a login body holds the key.
          throw new OpenCodeHttpError(`OpenCode ${r.method ?? "GET"} ${path} answered ${res.status}: ${text.slice(0, 300)}`, res.status, body);
        }
        return (text ? JSON.parse(text) : undefined) as T;
      })();
      // `timeoutMs: 0` = wait for as long as it takes (a command answers when its turn ends).
      if (r.timeoutMs === 0) return work;
      // The timeout only stops this caller from waiting: the request keeps running. OpenCode loads a folder's state (MCP servers, providers, agents,
      // commands) on the first request that needs it and caches the result of that load, an interruption included (1.19.5): a request the client
      // cut off during the load would leave the folder broken until its instance is disposed. See `brokenMcp` (opencode-engine.ts).
      work.catch(() => {});
      late.catch(() => {});
      return Promise.race([work, late]).finally(() => clearTimeout(timer));
    },
  };
}

/** A fetch whose connect failed (any code: ECONNREFUSED, a reset, undici's connect timeout): with a new connection per request (ocFetch) the server read nothing. */
const neverArrived = (err: unknown): boolean => {
  const c = (err as { cause?: { syscall?: string; code?: string } } | undefined)?.cause;
  return c?.syscall === "connect" || c?.code === "UND_ERR_CONNECT_TIMEOUT";
};
/** Whether the server answers its health check at all. */
const alive = (srv: { url: string; auth: string }) =>
  ocFetch(`${srv.url}/global/health`, { headers: { authorization: srv.auth }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).then(
    () => true,
    () => false,
  );

export type OpenCodeServer = ReturnType<typeof createOpenCodeServer>;
