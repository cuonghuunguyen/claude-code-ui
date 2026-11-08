// OpenCode in a Side folder (GH-658 step 7): the Side runs its own daemon, so its own fake `opencode` serves the folder; the Hub's never does.
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ServerMessage } from "@claude-ui/protocol";
import { createProjects } from "../src/projects.ts";
import { createSettings } from "../src/settings.ts";
import { createDaemon } from "../src/server.ts";
import { createSides, runSide, wslSide, type SideProcess } from "../src/sides.ts";
import { fakeQuery } from "./fake-query.ts";

const BIN = new URL("./fixtures/opencode/fake-opencode-bin.mjs", import.meta.url).pathname;
const dir = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const hubRoot = dir("oc-hub-");
const sideRoot = dir("oc-side-");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const history = { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never };
const webRoot = dir("oc-web-");
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");

/** A daemon with its own fake OpenCode and a log of what that fake received. */
const opencodeOf = (root: string) => {
  const logFile = join(root, "fake.log");
  const env = { FAKE_OPENCODE_LOG: logFile, FAKE_OPENCODE_DATA: join(root, "data.json") };
  writeFileSync(join(root, "data.json"), JSON.stringify({ sessions: [], messages: {} }));
  const requests = () => {
    try {
      return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>).filter((l) => l.type === "request");
    } catch {
      return [];
    }
  };
  return { opencode: { command: [process.execPath, BIN], env: () => env }, requests };
};
const hubOc = opencodeOf(hubRoot);
const sideOc = opencodeOf(sideRoot);

function inProcessSide(): SideProcess {
  const side = createDaemon({ webRoot, token: "", roots: [sideRoot], appSettings: createSettings(), query: fakeQuery as never, projects: createProjects(), history, opencode: sideOc.opencode });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  runSide({ ready: { schema: [1, 1], version: "1.0.0", startedBy: "attach" }, input: stdin, output: stdout, accept: side.accept, onEnd: () => exit.emit("exit", 0) });
  return { stdin, stdout, stderr: new PassThrough(), kill: () => stdin.end(), on: (e, l) => exit.on(e, l) };
}

const sides = createSides({ targets: [wslSide("Ubuntu")], spawn: () => inProcessSide(), onPush: () => {}, save: () => {}, posixLocal: true });
const hub = createDaemon({ webRoot, token, roots: [hubRoot], query: fakeQuery as never, projects: createProjects(), history, sides, appSettings: createSettings(), opencode: hubOc.opencode });
await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
const { port } = hub.address() as AddressInfo;
afterAll(() => void (hub.close(), sides.close()));

async function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, TOKEN_PROTOCOL_PREFIX + token], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  const request = async (msg: object): Promise<any> => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    for (;;) {
      const m = inbox.find((x) => (x.type === "reply" || x.type === "error") && x.reqId === reqId);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { ws, request };
}

const paths = (oc: ReturnType<typeof opencodeOf>) => oc.requests().map((r) => `${r.method} ${r.path}`);

describe.skipIf(process.platform === "win32")("OpenCode in a side folder", () => {
  it("create and prompt run on the side's OpenCode, not the hub's; models.list and session.commands of a side draft ask the side", async () => {
    const c = await client();
    await c.request({ type: "side.start", side: "wsl:Ubuntu" });
    await c.request({ type: "project.open", cwd: sideRoot, side: "wsl:Ubuntu" });
    const created = await c.request({ type: "session.create", cwd: sideRoot, engine: "opencode" });
    expect(created, JSON.stringify(created)).toMatchObject({ type: "reply" });
    const id = created.result.session.id as string;
    expect(id).toMatch(/^ses_/);
    expect(created.result.session).toMatchObject({ engine: "opencode", cwd: sideRoot });
    expect(await c.request({ type: "session.prompt", sessionId: id, text: "hi" })).toMatchObject({ type: "reply" });
    for (let i = 0; i < 100 && !paths(sideOc).includes(`POST /session/${id}/prompt_async`); i++) await new Promise((x) => setTimeout(x, 25)); // the send is fire and forget
    expect(paths(sideOc)).toContain(`POST /session/${id}/prompt_async`);
    expect(hubOc.requests()).toEqual([]);

    expect((await c.request({ type: "session.commands", cwd: sideRoot, engine: "opencode" })).result.commands.map((x: { name: string }) => x.name)).toContain("review");
    expect(paths(hubOc)).toEqual([]);

    // models.list carries no cwd: `side` routes it; the hub's OpenCode is asked only for the hub's folders.
    const before = sideOc.requests().length;
    const models = await c.request({ type: "models.list", engine: "opencode", cwd: sideRoot });
    expect(models.result.models.length).toBeGreaterThan(1);
    expect(sideOc.requests().length).toBeGreaterThan(before);
    expect(hubOc.requests()).toEqual([]);
    c.ws.close();
  });

  it("the list of a hub with a side keeps one engines entry per engine", async () => {
    const c = await client();
    await c.request({ type: "side.start", side: "wsl:Ubuntu" });
    const list = await c.request({ type: "session.list" });
    expect(list.result.engines.map((e: { engine: string }) => e.engine)).toEqual(["claude", "opencode"]);
    c.ws.close();
  });
});
