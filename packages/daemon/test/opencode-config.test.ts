// The MCP servers dialog on OpenCode 1 (GH-864 slice 1) and OpenCode 2 (GH-864, the fake OpenCode 2 reads the project's config files as 2.3.0 does): reads and actions through the fake `opencode`, saved changes in the project's opencode.json(c).
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
import { fileURLToPath, pathToFileURL } from "node:url";

const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
const BIN2 = fileURLToPath(new URL("./fixtures/opencode2/fake-opencode2-bin.mjs", import.meta.url));
const TEXT_TURN = fileURLToPath(new URL("./fixtures/opencode/turn-text.json", import.meta.url));
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

async function boot(o: { config?: object; file?: string; fileName?: string; env?: Record<string, string>; mcpWaitMs?: number; orchestration?: boolean; /** The fake OpenCode 2 binary. */ v2?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "occ-")));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  if (o.file !== undefined) writeFileSync(join(project, o.fileName ?? "opencode.jsonc"), o.file);
  const logFile = join(root, "fake.log");
  const dataFile = join(root, "data.json");
  writeFileSync(dataFile, JSON.stringify({ sessions: [], messages: {}, ...(o.config && { config: o.config }) }));
  const env: Record<string, string> = { FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE_DATA: dataFile, FAKE_OPENCODE_SCRIPT: "", XDG_CONFIG_HOME: join(root, "xdg"), ...(o.v2 && { FAKE_OPENCODE2_DATA: dataFile, FAKE_OPENCODE2_SCRIPT: "", FAKE_OPENCODE2_PROJECT_CONFIG: "1" }), ...o.env };
  const appSettings = createSettings();
  appSettings.set({ terminalAccess: { enabled: false }, inlineTask: { enabled: false }, fork: { enabled: false }, ...(o.orchestration && { orchestration: { enabled: true, workerCap: 20 } }) } as never);
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
    opencode: { command: [process.execPath, o.v2 ? BIN2 : BIN], env: () => env, listWaitMs: 500, ...(o.mcpWaitMs !== undefined && { mcpWaitMs: o.mcpWaitMs }) },
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
  const plugins = (msg: object) => ok({ cwd: project, engine: "opencode", ...msg });
  const serverPort = () => log().find((l) => l.type === "start")!.port as number;
  const names = (r: { servers: { name: string }[] }) => r.servers.map((s) => s.name).sort();
  return { root, project, ok, request, requests, inbox, log, mcp, plugins, port: serverPort, names, file: (f = "opencode.jsonc") => readFileSync(join(project, f), "utf8") };
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
});

const V2_FILE = `{
  "mcp": { "servers": {
    "echo": { "type": "local", "command": ["node", "echo.mjs"] },
    "off": { "type": "local", "command": ["node", "off.mjs"], "disabled": true }
  } },
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }]
}
`;
const USER_FILE = `{ "mcp": { "globalsrv": { "type": "remote", "url": "http://127.0.0.1:1/global" } } }\n`;
const jsonOf = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));

describe("OpenCode 2 MCP servers dialog", { timeout: TEST_MS }, () => {
  const bootV2 = async (file: string, fileName = "opencode.json") => {
    const d = await boot({ v2: true, file, fileName });
    mkdirSync(join(d.root, "xdg", "opencode"), { recursive: true });
    writeFileSync(join(d.root, "xdg", "opencode", "opencode.json"), USER_FILE);
    return d;
  };

  it("mcp.list reads the servers of both config shapes with status and scope, the user's servers as user scope, and no server of the daemon", async () => {
    const d = await bootV2(`{ "mcp": { "echo": { "type": "local", "command": ["node", "echo.mjs"] }, "broken": { "type": "local", "command": ["/nonexistent-bin"] }, "oauthy": { "type": "remote", "url": "http://127.0.0.1:1/oauth" }, "off": { "type": "local", "command": ["node", "x"], "enabled": false } } }`);
    const r = await d.mcp({ type: "mcp.list" });
    expect(d.names(r)).toEqual(["broken", "echo", "globalsrv", "oauthy", "off"]);
    const by = Object.fromEntries(r.servers.map((s: any) => [s.name, s]));
    expect(by.echo).toMatchObject({ status: "connected", scope: "project", config: { type: "stdio", command: "node" } });
    expect(by.broken).toMatchObject({ status: "failed", error: "spawn /nonexistent-bin ENOENT" });
    expect(by.off.status).toBe("disabled");
    expect(by.oauthy).toMatchObject({ status: "needs-auth", config: { type: "http", url: "http://127.0.0.1:1/oauth" } });
    expect(by.globalsrv).toMatchObject({ status: "connected", scope: "user" });
    expect(d.requests("GET", "/api/mcp")[0]!.query!["location[directory]"]).toBe(d.project);
  });

  it("mcp.list leaves out the daemon's own servers in OpenCode", async () => {
    const d = await boot({ v2: true, file: V2_FILE, fileName: "opencode.json", orchestration: true });
    await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" });
    await until(() => d.requests("PUT", /^\/api\/experimental\/mcp\/orchestration-/).length > 0);
    expect(d.names(await d.mcp({ type: "mcp.list" }))).toEqual(["echo", "off"]);
  });

  it.each([
    ["an OpenCode 1 file", `{\n  // keep this comment\n  "mcp": { "echo": { "type": "local", "command": ["node", "echo.mjs"] } }\n}\n`, "opencode.jsonc", (t: any) => t.mcp.echo.enabled],
    ["an OpenCode 2 file", V2_FILE, "opencode.json", (t: any) => !t.mcp.servers.echo.disabled],
  ])("mcp.toggle in %s writes the switch into the file and connects or disconnects at once", async (_n, file, name, enabledIn) => {
    const d = await bootV2(file, name);
    const off = await d.mcp({ type: "mcp.toggle", name: "echo", enabled: false });
    expect(d.requests("POST", "/api/experimental/mcp/echo/disconnect")).toHaveLength(1);
    expect(off.servers.find((s: any) => s.name === "echo").status).toBe("disabled");
    const text = d.file(name);
    if (name === "opencode.jsonc") expect(text).toContain("keep this comment");
    expect(enabledIn(jsonOf(text))).toBe(false);
    await d.mcp({ type: "mcp.toggle", name: "echo", enabled: true });
    expect(d.requests("POST", "/api/experimental/mcp/echo/connect")).toHaveLength(1);
    expect(enabledIn(jsonOf(d.file(name)))).toBe(true);
    expect(d.requests("POST", "/api/location/reload")).toHaveLength(0);
  });

  it("mcp.toggle of a server of the user's config only switches it at runtime: OpenCode 2 drops a file entry that holds only the switch", async () => {
    const d = await bootV2(V2_FILE);
    const r = await d.mcp({ type: "mcp.toggle", name: "globalsrv", enabled: false });
    expect(r.servers.find((s: any) => s.name === "globalsrv").status).toBe("disabled");
    expect(d.requests("POST", "/api/experimental/mcp/globalsrv/disconnect")).toHaveLength(1);
    expect(d.file("opencode.json")).toBe(V2_FILE);
  });

  it.each([
    ["an OpenCode 1 file", `{ "mcp": { "echo": { "type": "local", "command": ["node", "echo.mjs"] } } }`, (t: any) => t.mcp],
    ["an OpenCode 2 file", V2_FILE, (t: any) => t.mcp.servers],
    ["no file", undefined, (t: any) => t.mcp],
  ])("mcp.add and mcp.remove in %s edit the project file with its own keys and use the runtime MCP routes, with no folder reload", async (_n, file, servers) => {
    const d = await bootV2(file ?? "{}", "opencode.json");
    await d.mcp({ type: "mcp.list" }); // the dialog lists first: OpenCode has loaded the folder before the file changes
    const added = await d.mcp({ type: "mcp.add", name: "tool", scope: "project", config: { transport: "stdio", command: "node", args: ["t.mjs"], env: ["K=v"] } });
    expect(servers(jsonOf(d.file("opencode.json"))).tool).toEqual({ type: "local", command: ["node", "t.mjs"], environment: { K: "v" } });
    expect(d.requests("PUT", "/api/experimental/mcp/tool")[0]!.body.config).toEqual({ type: "local", command: ["node", "t.mjs"], environment: { K: "v" } });
    expect(added.servers.find((s: any) => s.name === "tool")).toMatchObject({ status: "connected", scope: "project" });
    const dup = await d.request({ type: "mcp.add", cwd: d.project, engine: "opencode", name: "tool", scope: "project", config: { transport: "http", url: "http://127.0.0.1:1/m", headers: [] } });
    expect(dup).toMatchObject({ type: "error", code: "already_exists" });
    const removed = await d.mcp({ type: "mcp.remove", name: "tool", scope: "project" });
    expect(servers(jsonOf(d.file("opencode.json"))).tool).toBeUndefined();
    expect(d.requests("DELETE", "/api/experimental/mcp/tool")).toHaveLength(1);
    expect(d.names(removed)).not.toContain("tool");
    expect(removed.applied).toBeUndefined();
    expect(d.requests("POST", "/api/location/reload")).toHaveLength(0);
  });

  it("mcp.remove of a server of the user's config is refused with the reason", async () => {
    const d = await bootV2(V2_FILE);
    const r = await d.request({ type: "mcp.remove", cwd: d.project, engine: "opencode", name: "globalsrv", scope: "project" });
    expect(r).toMatchObject({ type: "error", code: "invalid_input" });
    expect(d.file("opencode.json")).toBe(V2_FILE);
  });

  it("sign-in actions answer with the reason OpenCode 2 has no route for them, and its capabilities carry the mcpAuth gap", async () => {
    const d = await bootV2(V2_FILE);
    for (const msg of [{ type: "mcp.authenticate", name: "echo" }, { type: "mcp.clearAuth", name: "echo" }, { type: "mcp.oauthCallback", name: "echo", callbackUrl: "http://127.0.0.1/x?code=1" }])
      expect(await d.request({ cwd: d.project, engine: "opencode", ...msg })).toMatchObject({ type: "error", code: "unsupported", message: expect.stringContaining("integrations") });
    const created = await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" });
    expect(created.session.capabilities.config.gaps.mcpAuth).toContain("integrations");
  });

  it("mcp.reconnect disconnects and connects the server again", async () => {
    const d = await bootV2(V2_FILE);
    await d.mcp({ type: "mcp.reconnect", name: "echo" });
    expect(d.log().filter((l) => /\/mcp\/echo\/(dis)?connect$/.test(l.path ?? "")).map((l) => l.path)).toEqual(["/api/experimental/mcp/echo/disconnect", "/api/experimental/mcp/echo/connect"]);
  });
});

const SKILL_FILE = `{
  // keep this comment
  "permission": { "bash": "ask", "skill": { "*": "allow", "legacy": "deny", "team-docs": "allow", "team-*": "ask" } }
}
`;

describe("OpenCode skills dialog", { timeout: TEST_MS }, () => {
  /** A project with skills in the four places OpenCode reads; the user's global folder and ~/.claude/skills point into the test folder. */
  async function bootSkills(file: string | null = SKILL_FILE, mcpWaitMs?: number) {
    const d = await boot({ ...(file !== null && { file }), fileName: "opencode.jsonc", env: { FAKE_OPENCODE_CONFIG_CACHE: "1" }, ...(mcpWaitMs !== undefined && { mcpWaitMs }) });
    const home = join(d.root, "home");
    const xdg = join(d.root, "xdg");
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = xdg;
    cleanups.push(() => Object.entries(saved).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v))));
    const places: [string, string[]][] = [
      [join(d.project, ".opencode/skills"), ["review", "legacy"]],
      [join(d.project, ".claude/skills"), ["team-docs"]],
      [join(xdg, "opencode/skills"), ["mine"]],
      [join(home, ".claude/skills"), ["shared"]],
    ];
    for (const [dir, names] of places)
      for (const n of names) {
        mkdirSync(join(dir, n), { recursive: true });
        writeFileSync(join(dir, n, "SKILL.md"), `---\nname: ${n}\n---\n`);
      }
    const skills = (msg: object = {}) => d.ok({ type: "skills.list", cwd: d.project, engine: "opencode", ...msg });
    const set = (name: string, state: string, msg: object = {}) => d.ok({ type: "skills.setState", cwd: d.project, engine: "opencode", name, state, ...msg });
    const states = (r: { skills: { name: string; state: string }[] }) => Object.fromEntries(r.skills.map((s) => [s.name, s.state]));
    const rules = () => JSON.parse(d.file().replace(/^\s*\/\/.*$/gm, "")).permission.skill as Record<string, string>;
    return { ...d, skills, set, states, rules };
  }

  it("skills.list on OpenCode shows where each skill comes from, no token count, and a denied skill as Off", async () => {
    const d = await bootSkills();
    const r = await d.skills();
    const by = Object.fromEntries(r.skills.map((s: any) => [s.name, s]));
    expect(by["customize-opencode"].source).toBe("built-in");
    expect([by.review.source, by.legacy.source, by["team-docs"].source]).toEqual(["project", "project", "project"]);
    expect(by.mine.source).toBe("user");
    expect(by.shared.source).toBe("external");
    expect(r.skills.some((s: any) => "tokens" in s)).toBe(false);
    // `*` allow, `legacy` deny, then `team-docs` allow and `team-*` ask: the last matching rule wins, so team-docs is Ask.
    expect(d.states(r)).toMatchObject({ review: "on", legacy: "off", "team-docs": "ask", mine: "on", "customize-opencode": "on" });
    expect(by.legacy).toMatchObject({ advertised: true, displayName: "legacy" });
  });

  it("skills.setState writes the skill rule last in opencode.json, keeps the file and the list shows the new state", async () => {
    const d = await bootSkills();
    const ask = await d.set("review", "ask");
    expect(d.states(ask).review).toBe("ask");
    expect(ask.confirmed).toBe(true);
    expect(Object.entries(d.rules()).at(-1)).toEqual(["review", "ask"]);
    expect(d.file()).toContain("// keep this comment");
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(1);
    // Off after Ask: the old exact rule is replaced, never duplicated.
    const off = await d.set("review", "off");
    expect(d.states(off).review).toBe("off");
    expect(Object.keys(d.rules()).filter((k) => k === "review")).toHaveLength(1);
    // On with `*` allow behind it: the exact rule is removed.
    const on = await d.set("review", "on");
    expect(d.states(on).review).toBe("on");
    expect(d.rules()).not.toHaveProperty("review");
    // On under a `team-*` ask pattern needs its own allow rule after the pattern (the old exact rule sat before it and lost).
    const team = await d.set("team-docs", "on");
    expect(d.states(team)["team-docs"]).toBe("on");
    expect(Object.entries(d.rules()).at(-1)).toEqual(["team-docs", "allow"]);
  });

  it("skills.setState while a session of the folder is busy keeps the new state shown and is not confirmed", async () => {
    const d = await bootSkills();
    const id: string = (await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" })).session.id;
    const port = d.log().find((l) => l.type === "start")!.port;
    await fetch(`http://127.0.0.1:${port}/__status`, { method: "POST", body: JSON.stringify({ sessionId: id, status: { type: "busy" } }) });
    const r = await d.set("review", "off");
    expect(r.confirmed).toBe(false);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
    // OpenCode still has the old rule until a dispose: the list keeps showing what the user saved.
    expect(d.states(await d.skills()).review).toBe("off");
    await fetch(`http://127.0.0.1:${port}/__status`, { method: "POST", body: JSON.stringify({ sessionId: id }) });
    const done = await d.set("mine", "off");
    expect(done.confirmed).toBe(true);
    expect(d.states(done)).toMatchObject({ review: "off", mine: "off" });
  });

  it("skills.setState refuses a file whose permission is one string and writes nothing", async () => {
    const d = await bootSkills(`{ "permission": "allow" }\n`);
    const r = await d.request({ type: "skills.setState", cwd: d.project, engine: "opencode", name: "review", state: "off" });
    expect(r).toMatchObject({ type: "error", code: "invalid_input" });
    expect(d.file()).toBe(`{ "permission": "allow" }\n`);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });

  it("skills.setState creates opencode.json when the project has none", async () => {
    const d = await bootSkills(null);
    const r = await d.set("review", "off");
    expect(d.states(r).review).toBe("off");
    expect(JSON.parse(d.file("opencode.json")).permission).toEqual({ skill: { review: "deny" } });
  });
  it("skills.list answers a retryable error within the caller timer and never aborts the read", async () => {
    const d = await bootSkills(SKILL_FILE, 200);
    const port = (await d.skills(), d.log().find((l) => l.type === "start")!.port);
    await fetch(`http://127.0.0.1:${port}/__delay`, { method: "POST", body: JSON.stringify({ path: "/skill", ms: 800 }) });
    const t0 = Date.now();
    expect(await d.request({ type: "skills.list", cwd: d.project, engine: "opencode" })).toMatchObject({ type: "error", code: "opencode_loading" });
    expect(Date.now() - t0).toBeLessThan(700);
    // The read went on (no 499, no dispose): the next list answers.
    await new Promise((r) => setTimeout(r, 900));
    expect(d.states(await d.skills()).review).toBe("on");
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });
});

const PLUGIN_FILE = `{
  // keep this comment
  "theme": "x",
  "plugin": [
    "listed-one",
    ["opts-plugin", { "k": 1 }],
    "listed-two"
  ]
}
`;
const strip = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));

describe("OpenCode Plugins dialog", { timeout: TEST_MS }, () => {
  it("plugins.install on OpenCode appends the spec to the project plugin list and plugins.uninstall removes only that entry", async () => {
    const d = await boot({ file: PLUGIN_FILE, fileName: "opencode.json" });
    const added = await d.plugins({ type: "plugins.install", pluginId: " new-plugin ", scope: "project" });
    expect(added.reload).toEqual({ reloaded: 0, failed: [], errorCount: 0 });
    expect(d.file("opencode.json")).toContain("// keep this comment");
    expect(strip(d.file("opencode.json")).plugin).toEqual(["listed-one", ["opts-plugin", { k: 1 }], "listed-two", "new-plugin"]);
    // Idle folder: disposed so OpenCode loads the new list.
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(1);
    expect((await d.plugins({ type: "plugins.list" })).installed.map((p: any) => p.id)).toContain("new-plugin");
    await d.plugins({ type: "plugins.uninstall", pluginId: "opts-plugin", scope: "project" });
    expect(strip(d.file("opencode.json")).plugin).toEqual(["listed-one", "listed-two", "new-plugin"]);
    expect(d.file("opencode.json")).toContain("// keep this comment");
  });

  it("plugins.install while a session of the folder is busy saves without a dispose and says so", async () => {
    const d = await boot({ file: PLUGIN_FILE, fileName: "opencode.json" });
    const id: string = (await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" })).session.id;
    await fetch(`http://127.0.0.1:${d.port()}/__status`, { method: "POST", body: JSON.stringify({ sessionId: id, status: { type: "busy" } }) });
    const r = await d.plugins({ type: "plugins.install", pluginId: "later", scope: "project" });
    expect(r.applied).toBe(false);
    expect(strip(d.file("opencode.json")).plugin).toContain("later");
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
  });

  it("plugins.list on OpenCode marks folder plugins and global plugins as not removable", async () => {
    const d = await boot({ file: PLUGIN_FILE, fileName: "opencode.json", config: { plugin: ["global-one"] } });
    mkdirSync(join(d.project, ".opencode", "plugins"), { recursive: true });
    writeFileSync(join(d.project, ".opencode", "plugins", "auto.js"), "export default {};\n");
    const { installed, available, marketplaces } = await d.plugins({ type: "plugins.list" });
    const by = Object.fromEntries(installed.map((p: any) => [p.id, p.scope]));
    expect(by["listed-one"]).toBe("project");
    expect(by["opts-plugin"]).toBe("project");
    expect(by["global-one"]).toBe("user");
    expect(Object.entries(by).find(([id]) => id.startsWith("file://") && id.endsWith("/auto.js"))?.[1]).toBe("folder");
    expect([available, marketplaces]).toEqual([[], []]);
    const before = d.file("opencode.json");
    for (const [pluginId, scope] of [["global-one", "user"], [Object.keys(by).find((id) => id.startsWith("file://"))!, "folder"]] as const) {
      expect(await d.request({ type: "plugins.uninstall", cwd: d.project, engine: "opencode", pluginId, scope })).toMatchObject({ type: "error", code: "invalid_input" });
    }
    expect(d.file("opencode.json")).toBe(before);
  });

  it("plugins.list still answers from the config files when GET /config fails", async () => {
    const d = await boot({ file: PLUGIN_FILE, fileName: "opencode.json" });
    await d.plugins({ type: "plugins.list" });
    await fetch(`http://127.0.0.1:${d.port()}/__fail`, { method: "POST", body: JSON.stringify({ path: "/config" }) });
    const r = await d.plugins({ type: "plugins.list" });
    expect(r.installed.map((p: any) => p.id)).toEqual(["listed-one", "opts-plugin", "listed-two"]);
  });

  it("plugins.uninstall removes every occurrence of the plugin from every project file, whatever its position", async () => {
    const d = await boot({ file: `{ "plugin": ["a", "x", "b", ["x", { "k": 1 }], "c"] }\n`, fileName: "opencode.json" });
    writeFileSync(join(d.project, "opencode.jsonc"), `{\n  // second file\n  "plugin": ["x", "d"]\n}\n`);
    await d.plugins({ type: "plugins.uninstall", pluginId: "x", scope: "project" });
    expect(strip(d.file("opencode.json")).plugin).toEqual(["a", "b", "c"]);
    expect(strip(d.file("opencode.jsonc")).plugin).toEqual(["d"]);
    expect(d.file("opencode.jsonc")).toContain("// second file");
  });

  it("plugins.install refuses an empty, spaced or listed spec and turns a path into a file URL", async () => {
    const d = await boot({ file: PLUGIN_FILE, fileName: "opencode.json" });
    const before = d.file("opencode.json");
    for (const pluginId of ["   ", "two words", "listed-one"]) expect(await d.request({ type: "plugins.install", cwd: d.project, engine: "opencode", pluginId, scope: "project" })).toMatchObject({ type: "error" });
    expect(d.file("opencode.json")).toBe(before);
    // A relative path stays as typed (the repo works in another folder); an absolute one becomes the file URL OpenCode takes.
    await d.plugins({ type: "plugins.install", pluginId: "./plugins/mine.js", scope: "project" });
    await d.plugins({ type: "plugins.install", pluginId: join(d.project, "abs.js"), scope: "project" });
    expect(strip(d.file("opencode.json")).plugin.slice(-2)).toEqual(["./plugins/mine.js", pathToFileURL(join(d.project, "abs.js")).href]);
    expect(await d.request({ type: "plugins.install", cwd: d.project, engine: "opencode", pluginId: "./plugins/mine.js", scope: "project" })).toMatchObject({ type: "error", code: "already_exists" });
  });

  it("a relative path is saved relative to the config file that wins, and a listed one is refused as a duplicate", async () => {
    const d = await boot({ file: `{ "plugin": ["./plugins/rel.js"] }\n`, fileName: "opencode.json" });
    expect(await d.request({ type: "plugins.install", cwd: d.project, engine: "opencode", pluginId: "./plugins/../plugins/rel.js", scope: "project" })).toMatchObject({ type: "error", code: "already_exists" });
    mkdirSync(join(d.project, ".opencode"));
    writeFileSync(join(d.project, ".opencode", "opencode.json"), "{}\n");
    await d.plugins({ type: "plugins.install", pluginId: "./plugins/mine.js", scope: "project" });
    // OpenCode resolves the entry against `.opencode/`: it must still point at <project>/plugins/mine.js.
    expect(strip(d.file(".opencode/opencode.json")).plugin).toEqual(["../plugins/mine.js"]);
    // Without OpenCode's answer the list still treats the relative entries as project plugins.
    await fetch(`http://127.0.0.1:${d.port()}/__fail`, { method: "POST", body: JSON.stringify({ path: "/config" }) });
    const { installed } = await d.plugins({ type: "plugins.list" });
    expect(installed.map((p: any) => p.scope)).toEqual(["project", "project"]);
  });

  it("a relative plugin entry that OpenCode reports as a file URL is a project plugin and can be uninstalled", async () => {
    const d = await boot({ file: `{ "plugin": ["./plugins/rel.js", "other"] }\n`, fileName: "opencode.json" });
    const url = pathToFileURL(join(d.project, "plugins", "rel.js")).href;
    await d.plugins({ type: "plugins.list" });
    await fetch(`http://127.0.0.1:${d.port()}/__config`, { method: "POST", body: JSON.stringify({ config: { plugin: [url] } }) });
    const { installed } = await d.plugins({ type: "plugins.list" });
    expect(installed.find((p: any) => p.id === url)?.scope).toBe("project");
    await d.plugins({ type: "plugins.uninstall", pluginId: url, scope: "project" });
    expect(strip(d.file("opencode.json")).plugin).toEqual(["other"]);
  });

  it("plugins.install writes nothing into a file whose plugin key is not a list", async () => {
    const bad = `{ "plugin": "oops" }\n`;
    const d = await boot({ file: bad, fileName: "opencode.json" });
    expect(await d.request({ type: "plugins.install", cwd: d.project, engine: "opencode", pluginId: "x", scope: "project" })).toMatchObject({ type: "error", code: "config_invalid" });
    expect(d.file("opencode.json")).toBe(bad);
  });

  it("plugins.install in a project without an opencode.json creates it with the list", async () => {
    const d = await boot();
    await d.plugins({ type: "plugins.install", pluginId: "first", scope: "project" });
    expect(JSON.parse(d.file("opencode.json")).plugin).toEqual(["first"]);
  });

  it("plugins requests without engine reach Claude and with an OpenCode 2 binary answer opencode_v2_unsupported", async () => {
    const d = await boot({ file: PLUGIN_FILE, fileName: "opencode.json", env: { FAKE_OPENCODE_VERSION: "2.3.0" } });
    expect(await d.request({ type: "plugins.list", cwd: d.project, engine: "opencode" })).toMatchObject({ type: "error", code: "opencode_v2_unsupported" });
    const claude = await d.request({ type: "plugins.list", cwd: d.project });
    expect(JSON.stringify(claude)).not.toContain("listed-one");
  });
});

describe("OpenCode config saved while a session of the folder is busy", { timeout: TEST_MS }, () => {
  const COMBINED = `{
  "mcp": { "echo": { "type": "local", "command": ["node", "echo.mjs"] } },
  "plugin": ["listed-one"],
  "permission": { "skill": { "legacy": "allow" } }
}
`;
  it.each([
    ["a skill state", "skills", { type: "skills.setState", name: "review", state: "off" }, (r: any) => r.confirmed],
    ["an MCP server removal", "mcp", { type: "mcp.remove", name: "echo", scope: "project" }, (r: any) => r.applied !== false],
    ["a plugin install", "plugins", { type: "plugins.install", pluginId: "later", scope: "project" }, (r: any) => r.applied !== false],
  ])("%s is applied when the folder's sessions are idle: the folder is reloaded then and config.changed is sent", async (_name, kind, msg, applied) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "occ-home-")));
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = join(root, "home");
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    cleanups.push(() => Object.entries(saved).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v))));
    const d = await boot({ file: COMBINED, fileName: "opencode.jsonc", env: { FAKE_OPENCODE_CONFIG_CACHE: "1", FAKE_OPENCODE_SCRIPT: TEXT_TURN } });
    mkdirSync(join(d.project, ".opencode/skills/review"), { recursive: true });
    writeFileSync(join(d.project, ".opencode/skills/review/SKILL.md"), "---\nname: review\n---\n");
    const id: string = (await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" })).session.id;
    const status = (body: object) => fetch(`http://127.0.0.1:${d.port()}/__status`, { method: "POST", body: JSON.stringify({ sessionId: id, ...body }) });
    await status({ status: { type: "busy" } });
    const r = await d.ok({ cwd: d.project, engine: "opencode", ...msg });
    expect(applied(r)).toBe(false);
    expect(d.requests("POST", "/instance/dispose")).toHaveLength(0);
    // The turn ends: the session is idle and the folder is reloaded without another change of the user.
    await status({});
    await d.ok({ type: "session.prompt", sessionId: id, text: "hi" });
    await until(() => d.requests("POST", "/instance/dispose").length === 1);
    await until(() => d.inbox.some((m) => m.type === "config.changed" && m.kind === kind && m.cwd === d.project));
  });
});
