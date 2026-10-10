import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type PerfReport, type ServerMessage } from "@claude-ui/protocol";
import { createPerf } from "../src/perf.ts";
import { createDaemon } from "../src/server.ts";
import { createSettings } from "../src/settings.ts";
import { fakeQuery } from "./fake-query.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const root = realpathSync(mkdtempSync(join(tmpdir(), "perf-")));
writeFileSync(join(root, "index.html"), "<h1>app</h1>");
const settings = createSettings();
// worstMs 0: every process and request is kept in the worst list, so the test can read which request a process served.
const perf = createPerf({ worstMs: 0 });
const http = createDaemon({ webRoot: root, roots: [root], query: fakeQuery as never, token, appSettings: settings, perf });
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const port = (http.address() as AddressInfo).port;
afterAll(() => void http.close());

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  const request = (msg: object) =>
    new Promise<{ result?: unknown; code?: string }>((resolve) => {
      const reqId = Math.random().toString(36);
      ws.send(JSON.stringify({ ...msg, reqId }));
      const t = setInterval(() => {
        const m = inbox.find((x) => (x.type === "reply" || x.type === "error") && x.reqId === reqId);
        if (m) (clearInterval(t), resolve(m as never));
      }, 5);
    });
  return new Promise<{ ws: WebSocket; request: typeof request }>((ok) => ws.once("open", () => ok({ ws, request })));
}
const report = async (c: Awaited<ReturnType<typeof client>>) => ((await c.request({ type: "perf.report" })).result as PerfReport).daemon;

describe("performance monitor in the daemon", () => {
  it("session.subscribe records a session.open span", async () => {
    const c = await client();
    await c.request({ type: "perf.clear" });
    const created = (await c.request({ type: "session.create", cwd: root })) as { result: { session: { id: string } } };
    await c.request({ type: "session.subscribe", sessionId: created.result.session.id, sinceSeq: 0 });
    const d = await report(c);
    expect(d.spans["session.open"]?.n).toBe(1);
    expect(d.handlers["session.subscribe"]?.n).toBe(1);
    expect(d.monitor).toBe(true);
    c.ws.close();
  });

  it("git.status records git processes with the request git.status", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x.test", ...a], { cwd: repo });
    git("init", "-q", "-b", "main");
    writeFileSync(join(repo, "secret-file.txt"), "x");
    git("add", ".");
    git("commit", "-q", "-m", "secret prompt text");
    const c = await client();
    await c.request({ type: "perf.clear" });
    await c.request({ type: "git.status", cwd: repo });
    const d = await report(c);
    const kids = d.worst.filter((w) => w.kind === "child" && w.cmd === "git");
    expect(kids.length).toBeGreaterThan(0);
    expect(kids.every((w) => w.kind === "child" && w.request === "git.status")).toBe(true);
    expect(Object.keys(d.children).some((k) => k.startsWith("git "))).toBe(true);
    // Privacy: no path, file name, branch name or message text anywhere in the report.
    const json = JSON.stringify(d);
    for (const s of ["secret", "repo", "main", tmpdir(), "perf-"]) expect(json).not.toContain(s);
    c.ws.close();
  });

  it("perf.clear empties the report", async () => {
    const c = await client();
    await c.request({ type: "git.status", cwd: root });
    expect(Object.keys((await report(c)).handlers).length).toBeGreaterThan(0);
    await c.request({ type: "perf.clear" });
    const d = await report(c);
    // Only the perf.clear reply's own request may remain (it ends after the reply is sent).
    expect(Object.keys(d.handlers).filter((k) => k !== "perf.clear")).toEqual([]);
    expect(d.worst.filter((w) => w.kind !== "handler" || w.request !== "perf.clear")).toEqual([]);
    c.ws.close();
  });

  it("settings.set performance.monitor false stops sampling, true starts it again", async () => {
    const c = await client();
    await c.request({ type: "settings.set", patch: { performance: { monitor: false } } });
    expect((await report(c)).monitor).toBe(false);
    expect(perf.enabled).toBe(false);
    await c.request({ type: "perf.clear" });
    await c.request({ type: "git.status", cwd: root });
    expect(Object.keys((await report(c)).handlers)).toEqual([]);
    await c.request({ type: "settings.set", patch: { performance: { monitor: true } } });
    expect((await report(c)).monitor).toBe(true);
    c.ws.close();
  });
});
