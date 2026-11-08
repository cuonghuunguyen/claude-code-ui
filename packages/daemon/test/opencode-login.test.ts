// OpenCode provider login over the daemon's WebSocket: a real daemon, the fake `opencode` binary with its credential store and OAuth routes.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ServerMessage } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createSettings } from "../src/settings.ts";
import { createDaemon } from "../src/server.ts";
import { fakeQuery } from "./fake-query.ts";

const BIN = fileURLToPath(new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url));
const turn = (name: string) => fileURLToPath(new URL(`./fixtures/opencode/turn-${name}.json`, import.meta.url));
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const KEY = "sk-test-secret-0123456789";
const until = async (cond: () => boolean, ms = 5000) => {
  for (let i = 0; i < ms / 25 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(cond()).toBe(true);
};
const cleanups: (() => void)[] = [];
afterEach(() => (cleanups.splice(0).forEach((c) => c()), vi.restoreAllMocks()));

async function boot(o: { script?: string[] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocl-")));
  const project = join(root, "project");
  mkdirSync(project);
  const logFile = join(root, "fake.log");
  const dataFile = join(root, "data.json");
  writeFileSync(dataFile, JSON.stringify({ sessions: [], messages: {} }));
  const env = { FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE_DATA: dataFile, FAKE_OPENCODE_SCRIPT: (o.script ?? []).map(turn).join(",") };
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
    appSettings: createSettings(),
    settingsFile: join(root, "sessions.json"),
    claudeDir: join(root, "claude"),
    projectsDir: join(root, "claude", "projects"),
    uploadSweepMs: 0,
    opencode: { command: [process.execPath, BIN], env: () => env },
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  let n = 0;
  const reply = (reqId: string) => inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) as { type: "reply"; result: any } | { type: "error"; code: string; message: string } | undefined;
  /** Sends and returns a promise of the answer (a pending OAuth wait stays pending). */
  const send = (msg: object) => {
    const reqId = `r${++n}`;
    ws.send(JSON.stringify({ ...msg, reqId }));
    return until(() => !!reply(reqId), 15_000).then(() => reply(reqId)!);
  };
  const log = () => {
    try {
      return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
    } catch {
      return [];
    }
  };
  const calls = (method: string, path: RegExp | string) => log().filter((l) => l.type === "request" && l.method === method && (typeof path === "string" ? l.path === path : path.test(l.path)));
  const fake = (path: string, body: object = {}) => fetch(`http://127.0.0.1:${log().find((l) => l.type === "start")!.port}${path}`, { method: "POST", body: JSON.stringify(body) });
  cleanups.push(() => (ws.close(), http.close()));
  const ok = async (msg: object) => {
    const r = await send(msg);
    if (r.type === "error") throw new Error(`${r.code}: ${r.message}`);
    return r.result;
  };
  return { root, project, send, ok, log, calls, fake, inbox };
}

const connected = (r: { providers: { id: string; connected: boolean }[] }) => r.providers.filter((p) => p.connected).map((p) => p.id);

describe("OpenCode provider login", { timeout: 30_000 }, () => {
  it("lists providers: connected first, free opencode not connected, methods merged, no models", async () => {
    const d = await boot();
    const r = await d.ok({ type: "opencode.providers" });
    expect(r.providers.map((p: any) => p.id)).toEqual(["cfgprov", "envprov", "opencode", "fakeprov", "groq"]);
    expect(connected(r)).toEqual(["cfgprov", "envprov"]);
    const by = (id: string) => r.providers.find((p: any) => p.id === id);
    expect(by("cfgprov")).toMatchObject({ source: "config", connected: true });
    expect(by("envprov")).toMatchObject({ source: "env" });
    expect(by("opencode").connected).toBe(false);
    expect(by("groq").methods).toEqual([{ type: "api", label: "API key" }]);
    expect(by("fakeprov").methods.map((m: any) => m.label)).toEqual(["Fake browser login", "Fake code login", "API key"]);
    expect(by("fakeprov").methods[1].prompts[0]).toMatchObject({ key: "team" });
    for (const p of r.providers) expect(p).not.toHaveProperty("models");
  });

  it("an API key login stores the key as given, then refreshes the model lists", async () => {
    const d = await boot();
    const r = await d.ok({ type: "opencode.login", provider: "groq", method: 0, key: KEY });
    expect(d.calls("PUT", "/auth/groq")[0]!.body).toEqual({ type: "api", key: KEY });
    await until(() => d.calls("POST", "/global/dispose").length === 1);
    expect(r.providers.find((p: any) => p.id === "groq")).toMatchObject({ connected: true, source: "api" });
  });

  it("API method prompts go to metadata", async () => {
    const d = await boot();
    await d.ok({ type: "opencode.login", provider: "fakeprov", method: 2, key: KEY, inputs: { region: "eu" } });
    expect(d.calls("PUT", "/auth/fakeprov")[0]!.body).toEqual({ type: "api", key: KEY, metadata: { region: "eu" } });
  });

  it("bad input is refused with a field name and nothing reaches OpenCode; the key is not echoed", async () => {
    const d = await boot();
    const cases: [object, string][] = [
      [{ provider: "groq", method: 0, key: "" }, "key: Enter the API key"],
      [{ provider: "groq", method: 0, key: "  " }, "key: Enter the API key"],
      [{ provider: "groq", method: 0, key: "sk with space" }, "key: An API key has no spaces"],
      [{ provider: "groq", method: 0, key: "x".repeat(4097) }, "key: An API key has at most 4096 characters"],
      [{ provider: "nope", method: 0, key: KEY }, "provider: Unknown provider"],
      [{ provider: "groq", method: 5, key: KEY }, "method: Unknown login method"],
      [{ provider: "fakeprov", method: 0, key: KEY }, "method: Unknown login method"],
      [{ provider: "groq", method: 0, key: KEY, inputs: { a: 1 } }, "inputs: Expected text values"],
    ];
    for (const [msg, text] of cases) {
      const r = await d.send({ type: "opencode.login", ...msg });
      expect(r).toMatchObject({ type: "error", code: "invalid_input", message: text });
      expect((r as any).message).not.toContain(KEY);
    }
    expect(d.calls("PUT", /^\/auth/)).toHaveLength(0);
    expect(d.calls("POST", /oauth/)).toHaveLength(0);
  });

  it("OAuth auto: login returns the page, loginFinish waits for the browser, then the provider is connected", async () => {
    const d = await boot();
    const start = await d.ok({ type: "opencode.login", provider: "fakeprov", method: 0 });
    expect(start).toEqual({ url: "http://127.0.0.1/fake-login?provider=fakeprov", mode: "auto", instructions: "Code: ABCD-1234" });
    const finish = d.send({ type: "opencode.loginFinish", provider: "fakeprov", method: 0 });
    await until(() => d.calls("POST", "/provider/fakeprov/oauth/callback").length === 1);
    expect(d.inbox.some((m) => m.type === "reply" && m.reqId === "r2")).toBe(false);
    await d.fake("/__oauth", { result: "success" });
    const r = await finish;
    expect(connected((r as any).result)).toContain("fakeprov");
    expect((r as any).result.providers.find((p: any) => p.id === "fakeprov").source).toBe("custom");
    await until(() => d.calls("POST", "/global/dispose").length === 1);
  });

  it("OAuth auto that fails says so", async () => {
    const d = await boot();
    await d.ok({ type: "opencode.login", provider: "fakeprov", method: 0 });
    const finish = d.send({ type: "opencode.loginFinish", provider: "fakeprov", method: 0 });
    await until(() => d.calls("POST", "/provider/fakeprov/oauth/callback").length === 1);
    await d.fake("/__oauth", { result: "failed" });
    expect(await finish).toMatchObject({ type: "error", code: "login_failed", message: "Login was not completed. Try again." });
  });

  it("loginCancel ends the pending wait with `cancelled`; a new login of the provider aborts the old wait", async () => {
    const d = await boot();
    await d.ok({ type: "opencode.login", provider: "fakeprov", method: 0 });
    const first = d.send({ type: "opencode.loginFinish", provider: "fakeprov", method: 0 });
    await until(() => d.calls("POST", "/provider/fakeprov/oauth/callback").length === 1);
    expect(await d.ok({ type: "opencode.loginCancel", provider: "fakeprov" })).toEqual({});
    expect(await first).toMatchObject({ type: "error", code: "cancelled" });
    await d.ok({ type: "opencode.login", provider: "fakeprov", method: 0 });
    const second = d.send({ type: "opencode.loginFinish", provider: "fakeprov", method: 0 });
    await until(() => d.calls("POST", "/provider/fakeprov/oauth/callback").length === 2);
    await d.ok({ type: "opencode.login", provider: "fakeprov", method: 0 });
    expect(await second).toMatchObject({ type: "error", code: "cancelled" });
  });

  it("OAuth code: a wrong code fails and can be retried; a prompt the plugin rejects names its field", async () => {
    const d = await boot();
    expect(await d.send({ type: "opencode.login", provider: "fakeprov", method: 1, inputs: { team: "bad" } })).toMatchObject({ type: "error", code: "login_failed", message: "team: Team is not valid" });
    const start = await d.ok({ type: "opencode.login", provider: "fakeprov", method: 1, inputs: { team: "acme" } });
    expect(start.mode).toBe("code");
    expect(await d.send({ type: "opencode.loginFinish", provider: "fakeprov", method: 1, code: "wrong" })).toMatchObject({ type: "error", code: "login_failed", message: "Login was not completed. Try again." });
    expect(await d.send({ type: "opencode.loginFinish", provider: "fakeprov", method: 1 })).toMatchObject({ type: "error", message: "code: Enter the code" });
    expect(connected(await d.ok({ type: "opencode.loginFinish", provider: "fakeprov", method: 1, code: "good" }))).toContain("fakeprov");
  });

  it("logout deletes the credential and refreshes; unknown provider is refused", async () => {
    const d = await boot();
    await d.ok({ type: "opencode.login", provider: "groq", method: 0, key: KEY });
    const r = await d.ok({ type: "opencode.logout", provider: "groq" });
    expect(d.calls("DELETE", "/auth/groq")).toHaveLength(1);
    expect(connected(r)).not.toContain("groq");
    expect(await d.send({ type: "opencode.logout", provider: "nope" })).toMatchObject({ type: "error", code: "invalid_input" });
  });

  it("the model refresh waits while an OpenCode turn runs (dispose cancels turns) and runs once it is idle", async () => {
    const d = await boot({ script: ["bash"] });
    const id: string = (await d.ok({ type: "session.create", cwd: d.project, engine: "opencode" })).session.id;
    await d.ok({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await d.ok({ type: "session.prompt", sessionId: id, text: "run ls" });
    await until(() => d.inbox.some((m) => m.type === "event" && m.sessionId === id && m.part.type === "permission_request"));
    await d.ok({ type: "opencode.login", provider: "groq", method: 0, key: KEY });
    await new Promise((r) => setTimeout(r, 300));
    expect(d.calls("POST", "/global/dispose")).toHaveLength(0);
    await d.ok({ type: "session.interrupt", sessionId: id });
    await until(() => d.calls("POST", "/global/dispose").length === 1, 8000);
  });

  it("opencode.status never starts the server; opencode.providers does", async () => {
    const d = await boot();
    await d.ok({ type: "opencode.status" });
    expect(d.log().filter((l) => l.type === "start")).toHaveLength(0);
    await d.ok({ type: "opencode.providers" });
    expect(d.log().filter((l) => l.type === "start")).toHaveLength(1);
  });

  it("the key and the OAuth code reach no daemon log", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info"), vi.spyOn(process.stdout, "write"), vi.spyOn(process.stderr, "write")];
    const d = await boot();
    await d.send({ type: "opencode.login", provider: "groq", method: 0, key: KEY });
    await d.send({ type: "opencode.login", provider: "groq", method: 0, key: `${KEY} x` });
    await d.send({ type: "opencode.login", provider: "fakeprov", method: 1, inputs: { team: "acme" } });
    await d.send({ type: "opencode.loginFinish", provider: "fakeprov", method: 1, code: "SECRET-CODE-77" });
    const out = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(out).not.toContain(KEY);
    expect(out).not.toContain("SECRET-CODE-77");
    expect(d.inbox.some((m) => JSON.stringify(m).includes(KEY) && m.type === "error")).toBe(false);
  });
});
