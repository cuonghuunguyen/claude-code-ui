// The MCP servers dialog on OpenCode 1 (GH-864 slice 1): reads and actions through the fake `opencode`, saved changes in the project's opencode.json(c).
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ServerMessage } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createSettings } from "../src/settings.ts";
import { createDaemon } from "../src/server.ts";
import { fakeQuery } from "./fake-query.ts";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const until = async (cond: () => boolean, ms = 8000) => {
  for (let i = 0; i < ms / 25 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};
const REPLY_MS = process.platform === "win32" ? 60_000 : 8000;
const TEST_MS = process.platform === "win32" ? 90_000 : 30_000;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const FILE = `{
  // keep this comment
  "theme": "x",
  "mcp": {
    "echo": { "type": "local", "command": ["node", "echo.mjs"] },
    "broken": { "type": "local", "command": ["/nonexistent-bin"] },
    "off": { "type": "local", "command": ["node", "off.mjs"], "enabled": false },
    "oauthy": { "type": "remote", "url": "http://127.0.0.1:1/oauth" }
  }
}
`;

async function boot(o: { file?: string; fileName?: string; env?: Record<string, string>; mcpWaitMs?: number; orchestration?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "occ-")));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  if (o.file !== undefined) writeFileSync(join(project, o.fileName ?? "opencode.jsonc"), o.file);
  const logFile = join(root, "fake.log");
  const dataFile = join(root, "data.json");
  writeFileSync(dataFile, JSON.stringify({ sessions: [], messages: {} }));
  const env: Record<string, string> = { FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE_DATA: dataFile, FAKE_OPENCODE_SCRIPT: "", XDG_CONFIG_HOME: join(root, "xdg"), ...o.env };
  const appSettings = createSettings();
  appSettings.set({ terminalAccess: { enabled: false }, inlineTask: { enabled: false }, ...(o.orchestration && { orchestration: { enabled: true, workerCap: 20 } }) } as never);
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
    modelListWaitMs: 0,
    opencode: { command: [process.execPath, BIN], env: () => env, listWaitMs: 500, ...(o.mcpWaitMs !== undefined && { mcpWaitMs: o.mcpWaitMs }) },
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
    await until(() => inbox.some((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId), REPLY_MS);
    return inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) as { type: "reply"; result: any } | { type: "error"; code: string; message: string };
  };
  const ok = async (msg: object) => {
    const r = await request(msg);
    if (r.type === "error") throw new Error(`${r.code}: ${r.message}`);
    return r.result;
  };
  const log = () => {
    try {
      return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
    } catch {
      return [];
    }
  };
  const requests = (method: string, path: RegExp | string) => log().filter((l) => l.type === "request" && l.method === method && (typeof path === "string" ? l.path === path : path.test(l.path)));
  cleanups.push(() => (ws.close(), http.close()));
  const mcp = (msg: object) => ok({ cwd: project, engine: "opencode", ...msg });
  const names = (r: { servers: { name: string }[] }) => r.servers.map((s) => s.name).sort();
  return { root, project, ok, request, requests, log, mcp, names, file: (f = "opencode.jsonc") => readFileSync(join(project, f), "utf8") };
}

describe("OpenCode MCP servers dialog", { timeout: TEST_MS }, () => {
  it("mcp.list on an OpenCode session lists the project servers with status and scope and leaves out the daemon's own servers", async () => {
    const d = await boot({ file: FILE, orchestration: true });
    const id: string = (await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" })).session.id;
    await until(() => d.requests("POST", "/mcp").some((r) => /^orchestration-/.test(r.body.name)));
    const r = await d.ok({ type: "mcp.list", cwd: d.project, sessionId: id });
    expect(d.names(r)).toEqual(["broken", "echo", "oauthy", "off"]);
    const by = Object.fromEntries(r.servers.map((s: any) => [s.name, s]));
    expect(by.echo).toMatchObject({ status: "connected", scope: "project", config: { type: "stdio", command: "node" } });
    expect(by.broken).toMatchObject({ status: "failed", error: "spawn failed" });
    expect(by.off.status).toBe("disabled");
    expect(by.oauthy).toMatchObject({ status: "needs-auth", config: { type: "http", url: "http://127.0.0.1:1/oauth" } });
  });

  it("mcp.list from the new-session tab with engine opencode reads OpenCode; without engine it reads Claude", async () => {
    const d = await boot({ file: FILE });
    await d.mcp({ type: "mcp.list" });
    expect(d.requests("GET", "/mcp")).toHaveLength(1);
    // No engine and no session: Claude's config query answers (or fails here), OpenCode is not asked again.
    await d.request({ type: "mcp.list", cwd: d.project });
    expect(d.requests("GET", "/mcp")).toHaveLength(1);
  });

  it("mcp.toggle off writes enabled false into opencode.json keeping its comments and disconnects at once", async () => {
    const d = await boot({ file: FILE });
    const r = await d.mcp({ type: "mcp.toggle", name: "echo", enabled: false });
    expect(d.requests("POST", "/mcp/echo/disconnect")).toHaveLength(1);
    expect(r.servers.find((s: any) => s.name === "echo").status).toBe("disabled");
    const text = d.file();
    expect(text).toContain("// keep this comment");
    expect(JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")).mcp.echo).toMatchObject({ enabled: false });
    await d.mcp({ type: "mcp.toggle", name: "echo", enabled: true });
    expect(d.requests("POST", "/mcp/echo/connect")).toHaveLength(1);
  });

  it("mcp.add and mcp.remove edit the project file; remove disposes the folder only when no session is busy", async () => {
    const d = await boot({ file: FILE, fileName: "opencode.json" });
    const added = await d.mcp({ type: "mcp.add", name: "tool", scope: "project", config: { transport: "stdio", command: "node", args: ["t.mjs"], env: ["K=v"] } });
    expect(d.names(added)).toContain("tool");
    expect(JSON.parse(d.file("opencode.json").replace(/^\s*\/\/.*$/gm, "")).mcp.tool).toEqual({ type: "local", command: ["node", "t.mjs"], environment: { K: "v" } });
    expect(d.requests("POST", "/mcp").find((r) => r.body.name === "tool")!.body.config.command).toEqual(["node", "t.mjs"]);
    // Busy: the file is edited, no dispose, the server is hidden and the reply says it was not applied.
    const id: string = (await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" })).session.id;
    await fetch(`http://127.0.0.1:${d.log().find((l) => l.type === "start")!.port}/__status`, { method: "POST", body: JSON.stringify({ sessionId: id, status: { type: "busy" } }) });
    const busy = await d.mcp({ type: "mcp.remove", name: "tool", scope: "project" });
    expect(JSON.parse(d.file("opencode.json").replace(/^\s*\/\/.*$/gm, "")).mcp.tool).toBeUndefined();
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
    expect(busy.applied).toBe(false);
    expect(d.names(busy)).not.toContain("tool");
    // Idle: a remove disposes.
    await fetch(`http://127.0.0.1:${d.log().find((l) => l.type === "start")!.port}/__status`, { method: "POST", body: JSON.stringify({ sessionId: id }) });
    const idle = await d.mcp({ type: "mcp.remove", name: "echo", scope: "project" });
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(1);
    expect(idle.applied).toBeUndefined();
    expect(d.names(idle)).not.toContain("echo");
  });

  it("a slow GET /mcp answers pending within the caller timer and is never aborted", async () => {
    const d = await boot({ file: FILE, env: { FAKE_OPENCODE_MCP_LOAD_MS: "1500" }, mcpWaitMs: 200 });
    const first = await d.mcp({ type: "mcp.list" });
    expect(first.servers.map((s: any) => [s.name, s.status]).sort()).toEqual([["broken", "pending"], ["echo", "pending"], ["oauthy", "pending"], ["off", "disabled"]]);
    // The read went on: the folder is not marked broken, a later list shows the real states.
    await new Promise((r) => setTimeout(r, 1600));
    const later = await d.mcp({ type: "mcp.list" });
    expect(later.servers.find((s: any) => s.name === "echo").status).toBe("connected");
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });

  it("mcp.oauthCallback sends the code of the pasted URL to OpenCode", async () => {
    const d = await boot({ file: FILE });
    await d.mcp({ type: "mcp.oauthCallback", name: "oauthy", callbackUrl: "http://127.0.0.1:19876/mcp/oauth/callback?code=abc123&state=fake" });
    expect(d.requests("POST", "/mcp/oauthy/auth/callback")[0]!.body).toEqual({ code: "abc123" });
    const bad = await d.request({ type: "mcp.oauthCallback", cwd: d.project, engine: "opencode", name: "oauthy", callbackUrl: "http://127.0.0.1:19876/x" });
    expect(bad.type).toBe("error");
  });

  it("mcp.authenticate uses /authenticate for a browser on the daemon machine", async () => {
    const d = await boot({ file: FILE, env: { FAKE_OPENCODE_AUTH_MS: "1500" } });
    const r = await d.mcp({ type: "mcp.authenticate", name: "oauthy" });
    expect(r).toEqual({ requiresUserAction: true, opened: true });
    expect(d.requests("POST", "/mcp/oauthy/auth/authenticate")).toHaveLength(1);
    expect(d.requests("POST", "/mcp/oauthy/auth")).toHaveLength(0);
  });

  it("an edit never touches a project file that does not parse", async () => {
    const bad = `{ // mine\n  "mcp": { "a": \n`;
    const d = await boot({ file: bad });
    const r = await d.request({ type: "mcp.toggle", cwd: d.project, engine: "opencode", name: "a", enabled: false });
    expect(r).toMatchObject({ type: "error", code: "config_invalid" });
    expect(d.file()).toBe(bad);
  });

  it("an edit of a symlinked opencode.json updates the link target and keeps the link", async () => {
    const d = await boot();
    const target = join(d.root, "dotfiles-opencode.json");
    writeFileSync(target, FILE);
    symlinkSync(target, join(d.project, "opencode.json"));
    await d.mcp({ type: "mcp.toggle", name: "echo", enabled: false });
    expect(lstatSync(join(d.project, "opencode.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain('"enabled": false');
  });

  it("mcp.list still answers when GET /config fails", async () => {
    const d = await boot({ file: FILE });
    await d.mcp({ type: "mcp.list" });
    const port = d.log().find((l) => l.type === "start")!.port;
    await fetch(`http://127.0.0.1:${port}/__fail`, { method: "POST", body: JSON.stringify({ path: "/config" }) });
    const r = await d.mcp({ type: "mcp.list" });
    expect(d.names(r)).toEqual(["broken", "echo", "oauthy", "off"]);
    expect(r.servers.find((s: any) => s.name === "echo").config).toBeUndefined();
  });

  it("mcp.add in a project without an opencode.json creates it", async () => {
    const d = await boot();
    await d.mcp({ type: "mcp.add", name: "tool", scope: "project", config: { transport: "http", url: "http://127.0.0.1:1/mcp", headers: [] } });
    expect(JSON.parse(d.file("opencode.json")).mcp.tool).toEqual({ type: "remote", url: "http://127.0.0.1:1/mcp" });
  });

  it("config requests with an OpenCode 2 binary answer opencode_v2_unsupported", async () => {
    const d = await boot({ file: FILE, env: { FAKE_OPENCODE_VERSION: "2.3.0" } });
    const r = await d.request({ type: "mcp.list", cwd: d.project, engine: "opencode" });
    expect(r).toMatchObject({ type: "error", code: "opencode_v2_unsupported" });
  });
});
