// The server ↔ Engine catalogue contract: server.ts lists, restores and deletes through whichever catalogue owns an id.
// Fake catalogues (ServerOptions.catalogues): no OpenCode process, no transcript store.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ALL_CAPABILITIES, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type Engine as EngineName, type ServerMessage } from "@claude-ui/protocol";
import { claudeEngine } from "../src/claude-engine.ts";
import type { CatalogueContext, EngineCatalogue } from "../src/engine-catalogue.ts";
import { createProjects } from "../src/projects.ts";
import { createSettings } from "../src/settings.ts";
import { createSides, dockerSide, type SideProcess } from "../src/sides.ts";
import { createDaemon } from "../src/server.ts";
import { Session } from "../src/session.ts";
import { fakeQuery } from "./fake-query.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cat-root-")));
const webRoot = realpathSync(mkdtempSync(join(tmpdir(), "cat-web-")));
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const history = { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never };
const A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B_ID = "ses_fakeb1";

/** A catalogue over an in-memory store: `calls` records what the server asked it. */
function fake(ctx: CatalogueContext, o: { name: EngineName; id: RegExp; scope: "roots" | "folders"; stored: string[] }) {
  const calls: string[] = [];
  const engine = { ...claudeEngine, name: o.name };
  const open = (id: string) => ctx.track(Session.restore(id, root, [], { ...ctx.sessionOpts({}), engine }));
  const c: EngineCatalogue & { calls: string[] } = {
    calls,
    engine,
    listScope: o.scope,
    ownsId: (id) => o.id.test(id),
    isLocal: async (id) => o.stored.includes(id),
    knownIds: async () => o.stored,
    entry: () => ({ engine: o.name, capabilities: ALL_CAPABILITIES, permissionModes: ["default"] }),
    startMode: async () => undefined,
    create: async () => undefined,
    list: async (l) => {
      calls.push(`list ${l.folders?.join(",") ?? "-"}`);
      const { links } = l.read();
      const items = o.stored.map((id) => ({ id, cwd: root, state: "closed" as const, model: "default", permissionMode: "default" as const, effort: "default" as const, permissionModes: ["default" as const], capabilities: ALL_CAPABILITIES, engine: o.name, title: `${o.name} ${id}`, lastActivity: 1, archived: false, transcript: true, live: false as const, ...links(id) }));
      return { items, keep: (id) => o.stored.includes(id) };
    },
    restore: async (id) => (calls.push(`restore ${id}`), o.stored.includes(id) ? open(id) : undefined),
    locate: async (id) => (o.stored.includes(id) ? { cwd: root, transcript: true } : undefined),
    title: async () => "fake title",
    rename: async (id, _cwd, title) => void calls.push(`rename ${id} ${title}`),
    archive: async (id) => void calls.push(`archive ${id}`),
    delete: async (id) => void calls.push(`delete ${id}`),
    forkForAside: async () => ({ unavailable: "no fork" }),
    commands: async () => [],
    agents: async () => ({ agents: [] }),
    models: async () => [],
    close: async () => {},
  };
  return c;
}

let a!: ReturnType<typeof fake>;
let b!: ReturnType<typeof fake>;
const daemon = createDaemon({
  webRoot,
  token,
  roots: [root],
  query: fakeQuery as never,
  projects: createProjects(),
  history,
  appSettings: createSettings(),
  catalogues: (ctx) => [(a = fake(ctx, { name: "claude", id: /^[0-9a-f-]{36}$/, scope: "roots", stored: [A_ID] })), (b = fake(ctx, { name: "opencode", id: /^ses_\w+$/, scope: "folders", stored: [B_ID] }))],
});
await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
const { port } = daemon.address() as AddressInfo;
afterAll(() => void daemon.close());

async function client(at = port) {
  const ws = new WebSocket(`ws://127.0.0.1:${at}/ws`, [WS_PROTOCOL, TOKEN_PROTOCOL_PREFIX + token], { origin: `http://127.0.0.1:${at}` });
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

describe("Engine catalogues behind the server", () => {
  it("session.list merges the sessions of every catalogue with their own engine, and has one engines row per catalogue", async () => {
    const c = await client();
    await c.request({ type: "project.open", cwd: root });
    const list = (await c.request({ type: "session.list" })).result;
    expect(Object.fromEntries(list.sessions.map((s: { id: string; engine: string }) => [s.id, s.engine]))).toEqual({ [A_ID]: "claude", [B_ID]: "opencode" });
    expect(list.engines.map((e: { engine: string }) => e.engine)).toEqual(["claude", "opencode"]);
    // The per-folder store is asked for the shown folders, the global one is not.
    expect(a.calls).toContain("list -");
    expect(b.calls).toContain(`list ${root}`);
    c.ws.close();
  });

  it("subscribe restores through the catalogue that owns the id; an id no catalogue owns is unknown", async () => {
    const c = await client();
    expect(await c.request({ type: "session.subscribe", sessionId: B_ID })).toMatchObject({ type: "reply" });
    expect(b.calls).toContain(`restore ${B_ID}`);
    expect(a.calls).not.toContain(`restore ${B_ID}`);
    expect(await c.request({ type: "session.subscribe", sessionId: "not-an-id" })).toMatchObject({ type: "error", code: "unknown_session" });
    c.ws.close();
  });

  it("rename and delete of a session go to its owner, and only to it", async () => {
    const c = await client();
    await c.request({ type: "session.rename", sessionId: B_ID, title: "new name" });
    expect(await c.request({ type: "session.delete", sessionId: B_ID })).toMatchObject({ type: "reply" });
    expect(b.calls).toEqual(expect.arrayContaining([`rename ${B_ID} new name`, `delete ${B_ID}`]));
    expect(a.calls.filter((x) => x.startsWith("rename") || x.startsWith("delete"))).toEqual([]);
    c.ws.close();
  });
});

/** A Side process the test drives by hand: `got` holds what the hub sent it. */
function fakeSide(reply: (m: any) => unknown) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const got: any[] = [];
  let buf = "";
  stdin.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines) {
      const f = JSON.parse(l);
      if (!f.m) continue;
      got.push(f.m);
      stdout.write(JSON.stringify({ c: f.c, m: { type: "reply", reqId: f.m.reqId, result: reply(f.m) ?? {} } }) + "\n");
    }
  });
  stdout.write('{"ready":true,"schema":[1,1],"version":"1.0.0"}\n');
  const ee = new EventEmitter();
  const proc: SideProcess = { stdin, stdout, stderr: new PassThrough(), kill: () => ee.emit("exit", 1), on: (e, l) => ee.on(e, l) };
  return { proc, got };
}

describe("Side routing of a session of a catalogue whose ids are not UUIDs", () => {
  // Regression: only a UUID counted as local, so a listed OpenCode session that was not open was looked up on every Side first,
  // and a Side that listed the same id could claim it.
  it("a stored local session is local: no Side is asked for it, and a Side row with its id is a clash", async () => {
    const side = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: B_ID, cwd: root, lastActivity: 1 }], projects: [root], recentProjects: [] } : m.type === "session.ids" ? { ids: [B_ID] } : null));
    const sides = createSides({ targets: [], localLabel: "Linux", posixLocal: true, localPathExists: () => false, discoverMs: 0, discover: async () => [dockerSide("a")], spawn: () => side.proc });
    await sides.refresh();
    let local!: ReturnType<typeof fake>;
    const hub = createDaemon({ webRoot, token, roots: [root], query: fakeQuery as never, projects: createProjects(), history, appSettings: createSettings(), sides, catalogues: (ctx) => [fake(ctx, { name: "claude", id: /^[0-9a-f-]{36}$/, scope: "roots", stored: [] }), (local = fake(ctx, { name: "opencode", id: /^ses_\w+$/, scope: "folders", stored: [B_ID] }))] });
    await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
    const c = await client((hub.address() as AddressInfo).port);
    await c.request({ type: "side.start", side: "docker:a" });
    await c.request({ type: "project.open", cwd: root });
    await c.request({ type: "session.list" });
    const asked = side.got.length;
    await c.request({ type: "session.rename", sessionId: B_ID, title: "mine" });
    expect(local.calls).toContain(`rename ${B_ID} mine`);
    expect(side.got.slice(asked).map((m) => m.type)).toEqual([]);
    expect(sides.sessionSide.has(B_ID)).toBe(false);
    c.ws.close();
    hub.close();
    sides.close();
  });
});
