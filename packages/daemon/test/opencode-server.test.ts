// The OpenCode engine over the daemon's WebSocket: a real daemon, the fake `opencode` binary and its fake server (fixtures/opencode).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ALL_CAPABILITIES, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ServerMessage } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createSettings } from "../src/settings.ts";
import { createDaemon } from "../src/server.ts";
import { OPENCODE_CAPABILITIES } from "../src/opencode-engine.ts";
import { fakeQuery } from "./fake-query.ts";

const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
const history = JSON.parse(readFileSync(new URL("./fixtures/opencode/history.json", import.meta.url), "utf8"));
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const alive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};
/** A poll bound (10 s default): a reply waits for the daemon to spawn the fake OpenCode, seconds on Windows under load (a 10 s wait was exceeded in a full suite). */
const until = async (cond: () => boolean, ms = 10_000) => {
  for (let i = 0; i < ms / 25 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

async function boot(o: { engine?: "claude" | "opencode"; path?: string; env?: Record<string, string>; sessionsJson?: object; opencode?: object } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "oc-")));
  const project = join(root, "project");
  const other = join(root, "other");
  mkdirSync(project);
  mkdirSync(other);
  const logFile = join(root, "fake.log");
  const row = (id: string, directory: string, title: string, updated: number, extra = {}) => ({ id, slug: id, projectID: "global", directory, title, version: "1.18.34", time: { created: 1, updated }, ...extra });
  writeFileSync(
    join(root, "data.json"),
    JSON.stringify({ sessions: [row("ses_hist", project, "Listed files", 5000), row("ses_child", project, "subagent", 9000, { parentID: "ses_hist" }), row("ses_other", other, "Elsewhere", 7000)], messages: { ses_hist: history } }),
  );
  if (o.sessionsJson) writeFileSync(join(root, "sessions.json"), JSON.stringify(o.sessionsJson));
  const env: Record<string, string> = { FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE_DATA: join(root, "data.json"), ...o.env };
  const appSettings = createSettings();
  if (o.engine || o.path) appSettings.set({ ...(o.engine && { sessions: { engine: o.engine } }), ...(o.path && { opencode: { path: o.path } }) });
  const http = createDaemon({
    webRoot: root,
    roots: [root],
    query: fakeQuery as never,
    token,
    projects: (() => {
      const p = createProjects();
      p.open(project);
      return p;
    })(),
    appSettings,
    settingsFile: join(root, "sessions.json"),
    claudeDir: join(root, "claude"),
    projectsDir: join(root, "claude", "projects"),
    uploadSweepMs: 0,
    // session.list waits listWaitMs (3 s by default) for the OpenCode server to start; a start takes longer on a loaded Windows machine and the list then answers without the OpenCode sessions the test is about. Tests of the wait itself pass their own.
    opencode: { command: [process.execPath, BIN], env: () => env, ...(process.platform === "win32" && { listWaitMs: 60_000 }), ...o.opencode },
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  let n = 0;
  const request = async (msg: object) => {
    const reqId = `r${++n}`;
    ws.send(JSON.stringify({ ...msg, reqId }));
    await until(() => inbox.some((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId), process.platform === "win32" ? 60_000 : 10_000);
    return inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) as { type: "reply"; result: any } | { type: "error"; code: string; message: string };
  };
  const log = () =>
    (() => {
      try {
        return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
      } catch {
        return [];
      }
    })();
  const starts = () => log().filter((l) => l.type === "start");
  cleanups.push(() => (ws.close(), http.close()));
  return { root, project, other, http, ws, request, log, starts, appSettings, inbox, ok: async (msg: object) => (await request(msg)) as { type: "reply"; result: any } };
}

describe("OpenCode engine: lifecycle, create and list", () => {
  it("a Claude-only user never starts OpenCode; every list item has its engine and flags; the reply names both engines", async () => {
    const d = await boot();
    const created = await d.ok({ type: "session.create", cwd: d.project });
    expect(created.result.session).toMatchObject({ engine: "claude", capabilities: ALL_CAPABILITIES });
    const listed = (await d.ok({ type: "session.list" })).result;
    expect(listed.sessions.length).toBeGreaterThan(0);
    for (const s of listed.sessions) expect(s).toMatchObject({ engine: "claude", capabilities: ALL_CAPABILITIES });
    expect(listed.engines.map((e: any) => e.engine)).toEqual(["claude", "opencode"]);
    expect(listed.engines[1]).toMatchObject({ capabilities: OPENCODE_CAPABILITIES, permissionModes: ["config", "default", "acceptEdits"] });
    expect(d.starts()).toHaveLength(0);
  });

  it("session.create with engine opencode starts one authenticated local server, tags the session, remembers the engine and lists it", async () => {
    const d = await boot();
    const created = await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" });
    const id: string = created.result.session.id;
    expect(id).toMatch(/^ses_/);
    expect(created.result.session).toMatchObject({ engine: "opencode", capabilities: OPENCODE_CAPABILITIES, cwd: d.project });
    expect(d.starts()).toHaveLength(1);
    expect(d.starts()[0]).toMatchObject({ passwordSet: true, hostname: "127.0.0.1" });
    expect(d.starts()[0]!.argv).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    const requests = d.log().filter((l) => l.type === "request");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.authed)).toBe(true);
    expect(d.appSettings.get().sessions.engine).toBe("opencode");
    const listed = (await d.ok({ type: "session.list" })).result;
    expect(listed.sessions.find((s: any) => s.id === id)).toMatchObject({ engine: "opencode", cwd: d.project });
  });

  it("session.list lists the OpenCode sessions of the project's directory only, without child sessions, with OpenCode's title and time", async () => {
    const d = await boot({ engine: "opencode" });
    const listed = (await d.ok({ type: "session.list" })).result;
    const oc = listed.sessions.filter((s: any) => s.engine === "opencode");
    expect(oc.map((s: any) => s.id)).toEqual(["ses_hist"]);
    expect(oc[0]).toMatchObject({ title: "Listed files", lastActivity: 5000, archived: false, transcript: true, state: "closed", live: false, capabilities: OPENCODE_CAPABILITIES, cwd: d.project });
    expect(d.starts()).toHaveLength(1);
    const asked = d.log().find((l) => l.type === "request" && l.path === "/session" && l.method === "GET")!;
    expect(asked.query).toMatchObject({ directory: d.project, roots: "true" });
  });

  it("opening a listed OpenCode session shows its stored history as parts", async () => {
    const d = await boot({ engine: "opencode" });
    await d.ok({ type: "session.list" });
    const sub = (await d.ok({ type: "session.subscribe", sessionId: "ses_hist", sinceSeq: 0, paged: true })).result;
    expect(sub.session).toMatchObject({ engine: "opencode", id: "ses_hist" });
    expect(sub.title).toBe("Listed files");
    const parts = sub.snapshot.page.parts.map((p: any) => `${p.type}:${p.id}`);
    expect(parts).toEqual(["user_text:msg_u1", "thinking:prt_a1", "tool_call:call_1", "tool_result:call_1:result", "tool_call:call_2", "tool_result:call_2:result", "tool_call:call_3", "assistant_text:prt_a6"]);
  });

  it("a missing binary and an old version answer opencode_missing and opencode_old with an actionable message", async () => {
    const d = await boot({ path: join(tmpdir(), "no-such-opencode-binary") });
    const missing = await d.request({ type: "session.create", cwd: d.project, engine: "opencode" });
    expect(missing).toMatchObject({ type: "error", code: "opencode_missing" });
    expect((missing as any).message).toContain("Settings › OpenCode");
    const o = await boot({ env: { FAKE_OPENCODE_VERSION: "1.10.0" } });
    const old = await o.request({ type: "session.create", cwd: o.project, engine: "opencode" });
    expect(old).toMatchObject({ type: "error", code: "opencode_old" });
    expect((old as any).message).toContain("1.10.0");
    expect((old as any).message).toContain("1.18.0");
    expect(o.starts()).toHaveLength(0);
  });

  it("concurrent creates share one start; a crashed server is started again by the next create", async () => {
    const d = await boot();
    const both = await Promise.all([d.ok({ type: "session.create", cwd: d.project, engine: "opencode" }), d.ok({ type: "session.create", cwd: d.project, engine: "opencode" })]);
    expect(both[0]!.result.session.id).not.toBe(both[1]!.result.session.id);
    expect(d.starts()).toHaveLength(1);
    const pid = d.starts()[0]!.pid as number;
    process.kill(pid);
    await until(() => !alive(pid));
    // The create right after the crash must wait for the restarted server, not fail: the daemon may not have seen the exit yet (the pid is gone before the watcher's exit event arrives, a moment longer on Windows).
    const after = await d.request({ type: "session.create", cwd: d.project, engine: "opencode" });
    expect(after, JSON.stringify(after)).toMatchObject({ type: "reply" });
    expect(d.starts()).toHaveLength(2);
  });

  it("three quick crashes in a row stop the restarts with opencode_failed and the last output", async () => {
    const d = await boot({ env: { FAKE_OPENCODE_CRASH: "1" } });
    for (let i = 0; i < 3; i++) expect(await d.request({ type: "session.create", cwd: d.project, engine: "opencode" })).toMatchObject({ type: "error", code: "opencode_failed" });
    expect(d.starts()).toHaveLength(3);
    const fourth = await d.request({ type: "session.create", cwd: d.project, engine: "opencode" });
    expect(fourth).toMatchObject({ type: "error", code: "opencode_failed" });
    expect((fourth as any).message).toContain("crashed on purpose");
    expect(d.starts()).toHaveLength(3);
  });

  it("closing the daemon ends the OpenCode process", async () => {
    const d = await boot();
    await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" });
    const pid = d.starts()[0]!.pid as number;
    expect(alive(pid)).toBe(true);
    // The server's close event waits for the open WebSocket.
    d.ws.close();
    d.http.close();
    await until(() => !alive(pid));
  });

  it("an OpenCode entry of sessions.json survives a list while OpenCode is not reachable, and goes when OpenCode answered without it", async () => {
    const entry = { "ses_gone": { model: "default", permissionMode: "default", effort: "default", saved: 1 } };
    // No binary: the list waits its whole listWaitMs for a server that never comes, so the short wait here.
    const down = await boot({ engine: "opencode", path: join(tmpdir(), "no-such-opencode-binary"), sessionsJson: entry, opencode: { listWaitMs: 3000 } });
    await d_list(down);
    expect(Object.keys(JSON.parse(readFileSync(join(down.root, "sessions.json"), "utf8")))).toContain("ses_gone");
    const up = await boot({ engine: "opencode", sessionsJson: entry });
    await d_list(up);
    expect(Object.keys(JSON.parse(readFileSync(join(up.root, "sessions.json"), "utf8")))).not.toContain("ses_gone");
  }, process.platform === "win32" ? 60_000 : 15_000); // two daemons and one OpenCode server start, which takes seconds on a loaded Windows machine

  it("session.list answers in the list wait while OpenCode does not start, with the Claude items and the OpenCode entry of sessions.json kept", async () => {
    const entry = { ses_gone: { model: "default", permissionMode: "default", effort: "default", saved: 1 } };
    const d = await boot({ engine: "opencode", env: { FAKE_OPENCODE_HANG: "1" }, sessionsJson: entry, opencode: { listWaitMs: 300, startTimeoutMs: 20_000 } });
    const t = Date.now();
    const listed = (await d_list(d)).result;
    // The point: the list answers after its own wait, not after the 20 s start timeout (3.0 s alone, 5.1 s seen under a full suite).
    expect(Date.now() - t).toBeLessThan(process.platform === "win32" ? 10_000 : 5000);
    expect(listed.sessions.filter((s: any) => s.engine === "opencode")).toEqual([]);
    expect(Object.keys(JSON.parse(readFileSync(join(d.root, "sessions.json"), "utf8")))).toContain("ses_gone");
  }, 30_000);

  it("the OpenCode server ends with a daemon that is killed (SIGKILL)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "oc-")));
    const logFile = join(root, "fake.log");
    const host = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/opencode/serve-host.ts", import.meta.url))], { env: { ...process.env, FAKE_OPENCODE_LOG: logFile }, stdio: ["ignore", "pipe", "inherit"] });
    cleanups.push(() => host.kill("SIGKILL"));
    await new Promise<void>((r, reject) => (host.stdout!.on("data", (d) => String(d).includes("up") && r()), host.once("exit", () => reject(new Error("host exited")))));
    const pid = (JSON.parse(readFileSync(logFile, "utf8").trim().split("\n")[0]!) as { pid: number }).pid;
    expect(alive(pid)).toBe(true);
    host.kill("SIGKILL");
    await until(() => !alive(pid));
  }, 20_000);

  it("opencode.status reports missing, old, stopped and running and never starts the server", async () => {
    const missing = await boot({ path: join(tmpdir(), "no-such-opencode-binary") });
    expect((await missing.ok({ type: "opencode.status" })).result).toMatchObject({ state: "missing" });
    const old = await boot({ env: { FAKE_OPENCODE_VERSION: "1.10.0" } });
    expect((await old.ok({ type: "opencode.status" })).result).toMatchObject({ state: "old" });
    const d = await boot();
    expect((await d.ok({ type: "opencode.status" })).result).toMatchObject({ state: "stopped", version: "1.18.34" });
    expect(d.starts()).toHaveLength(0);
    await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" });
    expect((await d.ok({ type: "opencode.status" })).result).toMatchObject({ state: "running", version: "1.18.34" });
    expect(d.starts()).toHaveLength(1);
  });

  it("changing the binary path stops the running server", async () => {
    const d = await boot();
    await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" });
    const pid = d.starts()[0]!.pid as number;
    await d.ok({ type: "settings.set", patch: { opencode: { path: join(tmpdir(), "no-such-opencode-binary") } } });
    await until(() => !alive(pid));
  });

  it("settings refuse a relative OpenCode path and an unknown engine", async () => {
    const d = await boot();
    expect(await d.request({ type: "settings.set", patch: { opencode: { path: "opencode" } } })).toMatchObject({ type: "error", code: "bad_settings" });
    expect(await d.request({ type: "settings.set", patch: { sessions: { engine: "gpt" } } })).toMatchObject({ type: "error", code: "bad_settings" });
    expect(await d.request({ type: "session.create", cwd: d.project, engine: "gpt" })).toMatchObject({ type: "error", code: "bad_request" });
  });
});

const d_list = (d: Awaited<ReturnType<typeof boot>>) => d.ok({ type: "session.list" });
