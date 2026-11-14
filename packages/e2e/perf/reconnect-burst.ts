// Reconnect burst harness (GH-760): a phone that reconnects over a slow link to a daemon with hundreds of sessions and live turns.
// Not part of `npm test` or the Cucumber suite (needs `npm run build` and takes minutes):
//   npx tsx packages/e2e/perf/reconnect-burst.ts [--sessions 300 --live 40 --tabs 8 --cpu 6 --kbps 1000 --reconnects 10 --quiet 0 --stream --port 4321 --label base --report-dir <dir> --ping-ms 15000]
// Starts its own daemon (temp XDG_CONFIG_HOME and CLAUDE_CONFIG_DIR, API key variables unset, fake query) behind a throttling TCP proxy,
// opens a 390x844 Chromium page with CPU throttling, cuts the socket `--reconnects` times and counts what each resync costs.
// Per reconnect: bytes down by message class, live generation rate, time until the shown tab caught up (shownMs) and until the link is idle (settledMs).
// `--stream`: the fake turns emit text deltas (streamed parts). `--quiet N`: after the live reconnects, wait until the turns ended and the page caught up, then N more reconnects (nothing changed).
// Exit code 1 when the daemon logs a "no pong ... dropped" line; 2 when the page's last seq of a followed live session differs from the harness client's after the last reconnect (missed events).
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as tcpConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import WebSocket from "ws";

const arg = (name: string, d: string) => process.argv[process.argv.indexOf(`--${name}`) + 1] && process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1]! : d;
const opt = {
  sessions: Number(arg("sessions", "300")),
  live: Number(arg("live", "40")),
  tabs: Number(arg("tabs", "8")),
  cpu: Number(arg("cpu", "6")),
  kbps: Number(arg("kbps", "1000")),
  reconnects: Number(arg("reconnects", "10")),
  port: Number(arg("port", "4321")),
  pingMs: Number(arg("ping-ms", "15000")),
  label: arg("label", "run"),
  reportDir: resolve(arg("report-dir", ".")),
  padKb: Number(arg("pad-kb", "100")),
  quiet: Number(arg("quiet", "0")),
  stream: process.argv.includes("--stream"),
};
const repo = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// Isolated config before any daemon module reads the environment.
const run = mkdtempSync(join(tmpdir(), "claude-ui-perf-"));
process.env.XDG_CONFIG_HOME = join(run, "xdg");
process.env.CLAUDE_CONFIG_DIR = join(run, "claude");
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
const root = join(run, "projects");

// Daemon log lines (the daemon runs in this process): drops, kept, closes.
const daemonLog: string[] = [];
for (const level of ["log", "warn"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (/ ws: /.test(line)) daemonLog.push(line);
    orig(...a);
  };
}

const { createDaemon } = await import("../../daemon/src/server.ts");
const { createProjects } = await import("../../daemon/src/projects.ts");
const { loadToken } = await import("../../daemon/src/token.ts");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- sessions: transcripts of ~padKb each, in `projects` project folders so `session.list` has real work ---
const slug = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
const dirs = Array.from({ length: 10 }, (_, i) => join(root, `p${i}`));
dirs.forEach((d) => mkdirSync(d, { recursive: true }));
const realDirs = dirs.map((d) => resolve(d));
for (let n = 0; n < opt.sessions; n++) {
  const cwd = realDirs[n % realDirs.length]!;
  const dir = join(process.env.CLAUDE_CONFIG_DIR, "projects", slug(cwd));
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const base = { isSidechain: false, userType: "external", cwd, sessionId: id, version: "2.0.0" };
  const rows: object[] = [];
  let parent: string | null = null;
  const t0 = Date.now() - (n + 1) * 60_000;
  const pad = "lorem ipsum dolor sit amet ".repeat(Math.ceil((opt.padKb * 1024) / 20 / 27));
  for (let k = 0; k < 20; k++) {
    const uuid = randomUUID();
    const user = k % 2 === 0;
    rows.push({ ...base, parentUuid: parent, type: user ? "user" : "assistant", uuid, timestamp: new Date(t0 + k * 1000).toISOString(), message: user ? { role: "user", content: k === 0 ? `Session ${n}` : pad } : { id: `msg_${uuid}`, type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: pad }] } });
    parent = uuid;
  }
  writeFileSync(join(dir, `${id}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// --- fake query: a long turn of text and tool calls, so live sessions keep producing events ---
function fakeQuery({ prompt }: { prompt: AsyncIterable<{ message: { content: unknown } }> }) {
  const q = (async function* () {
    for await (const _m of prompt) {
      yield { type: "system", subtype: "init", uuid: randomUUID(), session_id: "x" } as never;
      for (let i = 0; i < 600; i++) {
        const callId = `toolu_${randomUUID()}`;
        const msgId = `msg_${randomUUID()}`;
        if (opt.stream) {
          // SDK includePartialMessages shape: message_start, then text deltas of block 0; the adapter keeps the whole text so far in each streamed part.
          yield { type: "stream_event", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, event: { type: "message_start", message: { id: msgId } } } as never;
          for (let d = 0; d < 10; d++) {
            yield { type: "stream_event", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${d === 0 ? `step ${i}: ` : ""}${"working ".repeat(4)}` } } } as never;
            await sleep(8);
          }
        }
        yield { type: "assistant", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { id: msgId, content: [{ type: "text", text: `step ${i}: ${"working ".repeat(40)}` }, { type: "tool_use", id: callId, name: "Read", input: { file_path: `/tmp/f${i}.txt` } }] } } as never;
        yield { type: "user", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "line\n".repeat(30) }] } } as never;
        await sleep(100);
      }
      yield { type: "result", subtype: "success", uuid: randomUUID(), session_id: "x", is_error: false, duration_ms: 1, total_cost_usd: 0, result: "done", usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [] } as never;
    }
  })();
  return Object.assign(q, {
    setModel: async () => {},
    setPermissionMode: async () => {},
    applyFlagSettings: async () => {},
    supportedModels: async () => [{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default", description: "" }],
    supportedCommands: async () => [],
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ session: {}, subscription_type: "team", rate_limits_available: false }),
    getContextUsage: async () => ({ totalTokens: 1, maxTokens: 1000, rawMaxTokens: 1000, percentage: 0, model: "x", categories: [] }),
    close: () => void q.return(undefined),
  });
}

const token = loadToken();
const projects = createProjects({ file: join(process.env.XDG_CONFIG_HOME, "claude-ui", "projects.json") });
realDirs.forEach((d) => projects.open(d));
const daemonPort = opt.port + 1;
const daemon = createDaemon({
  webRoot: join(repo, "packages/web/dist"),
  token,
  roots: [root],
  query: fakeQuery as never,
  projects,
  pingMs: opt.pingMs,
  settingsFile: join(run, "sessions.json"),
  uploadDir: join(run, "uploads"),
  hostnames: ["127.0.0.1"],
} as never);
await new Promise<void>((r) => daemon.listen(daemonPort, "127.0.0.1", r));

// --- throttling TCP proxy: token bucket per direction, cut() destroys every connection ---
const proxy = (() => {
  const conns = new Set<Socket>();
  let kbps = 0; // 0 = unthrottled
  const stats = { down: 0, up: 0, queuedDown: 0, upgrades: 0 };
  /** Like a TCP window: the source is paused while this much is queued for the slow link, so the backlog stays in the daemon's send buffer (`bufferedAmount`). */
  const WINDOW = 128 * 1024;
  const pipe = (from: Socket, to: Socket, dir: "down" | "up") => {
    let free = Date.now();
    let queued = 0;
    const account = (n: number) => {
      queued += n;
      if (dir === "down") stats.queuedDown += n;
      if (queued > WINDOW) from.pause();
      else if (queued < WINDOW / 2) from.resume();
    };
    from.on("data", (chunk: Buffer) => {
      stats[dir] += chunk.length;
      if (!kbps) return void to.write(chunk);
      // bytes/ms = kbps / 8
      for (let o = 0; o < chunk.length; o += 1400) {
        const piece = chunk.subarray(o, o + 1400);
        free = Math.max(free, Date.now()) + piece.length / (kbps / 8);
        account(piece.length);
        setTimeout(() => (account(-piece.length), !to.destroyed && to.write(piece)), free - Date.now());
      }
    });
  };
  const server = createServer((client) => {
    stats.upgrades++;
    const up = tcpConnect(daemonPort, "127.0.0.1");
    conns.add(client).add(up);
    pipe(client, up, "up");
    pipe(up, client, "down");
    const end = (who: string) => (e?: Error) => {
      if (process.env.PERF_DEBUG && conns.has(client)) console.log(`proxy: ${who} ${e ? `error ${e.message}` : "closed"} at ${new Date().toISOString()}`);
      client.destroy();
      up.destroy();
      conns.delete(client);
      conns.delete(up);
    };
    client.on("close", end("client")).on("error", end("client"));
    up.on("close", end("daemon")).on("error", end("daemon"));
  });
  return {
    listen: () => new Promise<void>((r) => server.listen(opt.port, "127.0.0.1", r)),
    close: () => (conns.forEach((c) => c.destroy()), server.close()),
    cut: () => conns.forEach((c) => c.destroy()),
    setKbps: (k: number) => (kbps = k),
    stats,
  };
})();
await proxy.listen();

// --- live sessions through a harness client straight to the daemon ---
const liveIds: string[] = [];
/** Harness client: bytes it received (live generation rate), last seq per session and turn-ended count. */
const gen = { bytes: 0, msgs: 0 };
const daemonSeq = new Map<string, number>();
await (async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws`, ["claude-ui", `token.${token}`], { origin: `http://127.0.0.1:${daemonPort}` });
  await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
  const waiting = new Map<string, (m: { result?: { session?: { id: string } } }) => void>();
  ws.on("message", (d) => {
    gen.bytes += (d as Buffer).length;
    gen.msgs++;
    const m = JSON.parse(String(d));
    if (m.reqId) waiting.get(m.reqId)?.(m);
    else if (m.sessionId && typeof m.seq === "number") daemonSeq.set(m.sessionId, Math.max(daemonSeq.get(m.sessionId) ?? 0, m.seq));
  });
  const req = (msg: object) => new Promise<{ result?: { session?: { id: string } } }>((res) => ((msg as { reqId: string }).reqId, ws.send(JSON.stringify(msg)), waiting.set((msg as { reqId: string }).reqId, res)));
  for (let i = 0; i < opt.live; i++) {
    const created = await req({ type: "session.create", cwd: realDirs[i % realDirs.length], reqId: `c${i}` });
    const id = created.result?.session?.id;
    if (!id) throw new Error(`session.create failed: ${JSON.stringify(created)}`);
    liveIds.push(id);
    await req({ type: "session.subscribe", sessionId: id, sinceSeq: 0, reqId: `s${i}` });
    await req({ type: "session.prompt", sessionId: id, text: "go", reqId: `p${i}` });
  }
  // The harness client stays connected: its subscriptions keep the turns going.
})();
console.log(`harness: daemon on ${daemonPort}, proxy on ${opt.port}, ${opt.sessions} transcripts, ${liveIds.length} live`);

// --- browser ---
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const pageLines: string[] = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("claude-ui:")) pageLines.push(t);
});
// What the page socket carries, by class; the page's last seq per session (events and subscribe replies).
const cls: Record<string, { n: number; b: number }> = {};
const pageSeq = new Map<string, number>();
let listReplyAt = 0;
const add = (k: string, b: number) => ((cls[k] ??= { n: 0, b: 0 }).n++, (cls[k].b += b));
page.on("websocket", (w) => {
  const reqType = new Map<string, string>();
  const seen = new Map<string, number>();
  w.on("framesent", (f) => {
    try {
      const m = JSON.parse(String(f.payload));
      if (m.reqId) reqType.set(m.reqId, m.type + (m.type === "session.subscribe" ? `:${m.sessionId}${m.background ? ":bg" : ""}` : ""));
    } catch {}
  });
  w.on("framereceived", (f) => {
    const b = Buffer.byteLength(String(f.payload));
    let m: { reqId?: string; type?: string; sessionId?: string; seq?: number; result?: { seq?: number; snapshot?: unknown } };
    try {
      m = JSON.parse(String(f.payload));
    } catch {
      return add("unparsed", b);
    }
    if (m.reqId) {
      const t = reqType.get(m.reqId) ?? "?";
      if (t === "session.list") listReplyAt = Date.now();
      if (t.startsWith("session.subscribe")) {
        const [, id, bg] = t.split(":");
        const seq = m.result?.seq ?? 0;
        pageSeq.set(id!, Math.max(pageSeq.get(id!) ?? 0, seq));
        seen.set(id!, seq);
        return add(`reply session.subscribe${m.result?.snapshot ? " (snapshot)" : ""}${bg ? " bg" : ""}`, b);
      }
      return add(`reply ${t}`, b);
    }
    if (m.sessionId && typeof m.seq === "number") {
      pageSeq.set(m.sessionId, Math.max(pageSeq.get(m.sessionId) ?? 0, m.seq));
      return add(m.seq <= (seen.get(m.sessionId) ?? 0) ? "event replay" : "event live", b);
    }
    add(`other ${m.type}`, b);
  });
});
await page.goto(`http://127.0.0.1:${opt.port}/#token=${token}`);
await page.waitForSelector('[data-testid="titlebar"]', { timeout: 60_000 });
for (const id of liveIds.slice(0, opt.tabs)) {
  await page.evaluate((h) => (location.hash = h), id);
  await sleep(400);
}
await sleep(3000);
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setCPUThrottlingRate", { rate: opt.cpu });
proxy.setKbps(opt.kbps);

// --- reconnects ---
const settled = async (since: number) => {
  const t0 = Date.now();
  let quiet = 0;
  while (Date.now() - t0 < 90_000) {
    await sleep(500);
    // The new socket is up and the slow link has had nothing queued for two checks in a row (live turns keep a trickle of events coming, so silence never comes).
    quiet = proxy.stats.upgrades > since && proxy.stats.queuedDown < 4096 ? quiet + 1 : 0;
    if (quiet >= 4) return Date.now() - t0;
  }
  return -1;
};
type Row = { n: number; phase: "live" | "quiet"; settledMs: number; shownMs: number; bytesDown: number; genKBps: number; classes: Record<string, { n: number; b: number }>; drops: number; kept: number };
const rows: Row[] = [];
const shownId = liveIds[Math.min(opt.tabs, liveIds.length) - 1];
const MB = (n: number) => (n / 2 ** 20).toFixed(2);
async function reconnect(n: number, phase: Row["phase"]) {
  const up0 = proxy.stats.upgrades;
  const down0 = proxy.stats.down;
  const lines0 = daemonLog.length;
  for (const k of Object.keys(cls)) delete cls[k];
  const g0 = gen.bytes;
  const t0 = Date.now();
  const target = shownId ? (daemonSeq.get(shownId) ?? 0) : 0;
  listReplyAt = 0;
  proxy.cut();
  // shownMs: the list reply arrived and the shown tab holds every event the daemon had at the cut.
  let shownMs = -1;
  const shown = (async () => {
    while (Date.now() - t0 < 90_000) {
      if (listReplyAt && (!shownId || (pageSeq.get(shownId) ?? 0) >= target)) return (shownMs = Date.now() - t0);
      await sleep(100);
    }
  })();
  const settledMs = await settled(up0);
  await shown;
  const secs = (Date.now() - t0) / 1000;
  const fresh = daemonLog.slice(lines0);
  const row: Row = { n, phase, settledMs, shownMs, bytesDown: proxy.stats.down - down0, genKBps: (gen.bytes - g0) / secs / 1024, classes: structuredClone(cls), drops: fresh.filter((l) => /no pong .*dropped/.test(l)).length, kept: fresh.filter((l) => /no pong .*kept/.test(l)).length };
  rows.push(row);
  const sec = (ms: number) => (ms < 0 ? ">90s" : `${(ms / 1000).toFixed(1)}s`);
  console.log(`reconnect ${n} (${phase}): shown ${sec(shownMs)}, settled ${sec(settledMs)}, ${MB(row.bytesDown)}MB down, drops ${row.drops}, kept ${row.kept}`);
  console.log(`  live generation (harness client, all ${liveIds.length} live sessions): ${row.genKBps.toFixed(0)} KB/s; link ${opt.kbps / 8} KB/s`);
  for (const [k, v] of Object.entries(row.classes).sort((a, b) => b[1].b - a[1].b)) console.log(`  ${k.padEnd(40)} ${String(v.n).padStart(6)} msgs ${MB(v.b).padStart(7)} MB`);
}
for (let n = 1; n <= opt.reconnects; n++) await reconnect(n, "live");
if (opt.quiet > 0) {
  // Wait until the turns ended (the harness client receives nothing for 5 s) and the page caught up, then reconnect with nothing changed.
  let last = gen.bytes;
  let idle = 0;
  for (let t = 0; t < 600 && idle < 10; t++) {
    await sleep(500);
    idle = gen.bytes === last ? idle + 1 : 0;
    last = gen.bytes;
  }
  console.log(`harness: turns ${idle >= 10 ? "ended" : "still running"}, ${opt.quiet} quiet reconnects`);
  for (let n = 1; n <= opt.quiet; n++) await reconnect(opt.reconnects + n, "quiet");
}

// Missed events: after the last reconnect the page's last seq of every followed live session equals the harness client's (turns must have ended).
await sleep(3000);
const missed = liveIds.filter((id) => pageSeq.has(id) && pageSeq.get(id) !== daemonSeq.get(id)).map((id) => ({ id, page: pageSeq.get(id), daemon: daemonSeq.get(id) }));
console.log(missed.length ? `MISSED EVENTS in ${missed.length} sessions: ${JSON.stringify(missed.slice(0, 5))}` : `no missed events (${[...pageSeq.keys()].filter((id) => liveIds.includes(id)).length} followed live sessions checked)`);

const drops = daemonLog.filter((l) => /no pong .*dropped/.test(l));
const report = { label: opt.label, opts: opt, rows, missed, drops: drops.length, daemonLines: daemonLog.filter((l) => /no pong|closed/.test(l)).slice(-60), pageLines: pageLines.slice(-60) };
mkdirSync(opt.reportDir, { recursive: true });
writeFileSync(join(opt.reportDir, `perf-${opt.label}.json`), JSON.stringify(report, null, 2));
console.log(`\n n | phase | shown s | settled s | MB down | gen KB/s | drops | kept\n${rows.map((r) => `${String(r.n).padStart(2)} | ${r.phase.padEnd(5)} | ${(r.shownMs / 1000).toFixed(1).padStart(7)} | ${(r.settledMs / 1000).toFixed(1).padStart(9)} | ${MB(r.bytesDown).padStart(7)} | ${r.genKBps.toFixed(0).padStart(8)} | ${String(r.drops).padStart(5)} | ${r.kept}`).join("\n")}\ntotal drops: ${drops.length}`);

await browser.close();
proxy.close();
daemon.close();
rmSync(run, { recursive: true, force: true });
process.exit(missed.length ? 2 : drops.length ? 1 : 0);
