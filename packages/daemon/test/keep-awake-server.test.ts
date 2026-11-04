import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createKeepAwake } from "../src/keep-awake.ts";
import { createSides, wslSide, type SideProcess } from "../src/sides.ts";
import { createDaemon } from "../src/server.ts";
import { createSettings } from "../src/settings.ts";
import { permissionQuery } from "./fake-query.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const dir = mkdtempSync(join(tmpdir(), "ka-"));
const children: (EventEmitter & { kill: ReturnType<typeof vi.fn> })[] = [];
const spawn = vi.fn(() => {
  const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: () => {} });
  children.push(c);
  return c;
});
const onRunning = vi.fn();
const mk = (keepAwake?: ReturnType<typeof createKeepAwake>) => createDaemon({ webRoot: dir, roots: [dir], query: permissionQuery as never, token, appSettings: createSettings({ file: join(dir, `s${Math.random()}.json`) }), ...(keepAwake && { keepAwake, onRunning }) });
const ka = createKeepAwake({ inhibitor: { cmd: "inh", args: [] }, spawn: spawn as never });
const http = mk(ka);
const plain = mk();
let port = 0;
let plainPort = 0;
beforeAll(async () => {
  for (const h of [http, plain]) await new Promise<void>((r) => h.listen(0, "127.0.0.1", r));
  port = (http.address() as AddressInfo).port;
  plainPort = (plain.address() as AddressInfo).port;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => void plain.close());

async function client(p = port) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${p}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return vi.waitFor(() => inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) ?? Promise.reject(new Error("no reply")), { timeout: 5000 }) as unknown as Promise<{ result?: any }>;
  };
  return { ws, inbox, request };
}
type C = Awaited<ReturnType<typeof client>>;
const set = (c: C, on: boolean) => c.request({ type: "settings.set", patch: { power: { keepAwake: on } } });
async function waiting(c: C) {
  const id = ((await c.request({ type: "session.create", cwd: dir })).result as any).session.id as string;
  await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
  await c.request({ type: "session.prompt", sessionId: id, text: "go" });
  const req = await vi.waitFor(() => c.inbox.filter((m: any) => m.type === "event" && m.sessionId === id && m.part.type === "permission_request").at(-1) ?? Promise.reject(new Error("no request")), { timeout: 5000 });
  return { id, allow: () => c.request({ type: "permission.respond", requestId: (req as any).part.requestId, decision: "allow" }) };
}

describe("keep computer awake in the daemon (GH-523)", { timeout: 20_000 }, () => {
  it("setting off: a session waiting for permission spawns nothing", async () => {
    const c = await client();
    await set(c, false);
    const w = await waiting(c);
    expect(spawn).not.toHaveBeenCalled();
    await w.allow();
    await vi.waitFor(() => expect(onRunning.mock.calls.map((x) => x[0])).toEqual([true, false]));
    c.ws.close();
  });

  it("setting on: needs_input holds one inhibitor; a second waiting session spawns none; both answered -> killed", async () => {
    const c = await client();
    await set(c, true);
    const a = await waiting(c);
    expect(spawn).toHaveBeenCalledTimes(1);
    const b = await waiting(c);
    expect(spawn).toHaveBeenCalledTimes(1);
    await a.allow();
    expect(children[0]!.kill).not.toHaveBeenCalled();
    await b.allow();
    await vi.waitFor(() => expect(children[0]!.kill).toHaveBeenCalledTimes(1));
    await set(c, false);
    c.ws.close();
  });

  it("turning the setting off while a session waits kills it; on again spawns it", async () => {
    const c = await client();
    await set(c, true);
    const w = await waiting(c);
    const n = children.length;
    await set(c, false);
    expect(children[n - 1]!.kill).toHaveBeenCalledTimes(1);
    await set(c, true);
    expect(children.length).toBe(n + 1);
    await w.allow();
    await set(c, false);
    c.ws.close();
  });

  it("settings.get reports daemon.keepAwake; a spawn error broadcasts settings_changed, keeps the setting on and shows the error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const c = await client();
    expect(((await c.request({ type: "settings.get" })).result as any).daemon.keepAwake).toEqual({ supported: true });
    await set(c, true);
    const w = await waiting(c);
    const before = c.inbox.filter((m) => m.type === "settings_changed").length;
    children.at(-1)!.emit("error", new Error("spawn inh ENOENT"));
    await vi.waitFor(() => expect(c.inbox.filter((m) => m.type === "settings_changed").length).toBe(before + 1));
    const r = (await c.request({ type: "settings.get" })).result as any;
    expect(r.settings.power.keepAwake).toBe(true);
    expect(r.daemon.keepAwake.error).toContain("ENOENT");
    await w.allow();
    await set(c, false);
    expect(((await c.request({ type: "settings.get" })).result as any).daemon.keepAwake).toEqual({ supported: true });
    c.ws.close();
  });

  it("a daemon without keepAwake replies without daemon.keepAwake", async () => {
    const c = await client(plainPort);
    expect(((await c.request({ type: "settings.get" })).result as any).daemon.keepAwake).toBeUndefined();
    c.ws.close();
  });

  it("daemon close kills the held inhibitor", async () => {
    const c = await client();
    await set(c, true);
    await waiting(c);
    const held = children.at(-1)!;
    c.ws.close();
    http.close();
    http.closeAllConnections();
    await vi.waitFor(() => expect(held.kill).toHaveBeenCalledTimes(1));
  });
});

describe("keep computer awake with a Side (GH-523)", { timeout: 20_000 }, () => {
  /** A Hub with one WSL Side (fake process) and a keepAwake on; `procs` = every Side process spawned, `held` = inhibitor children. */
  async function hub() {
    const procs: { stdout: PassThrough; exit: EventEmitter }[] = [];
    const held: (EventEmitter & { kill: ReturnType<typeof vi.fn> })[] = [];
    const sides = createSides({
      reconnectMs: [10],
      targets: [wslSide("Ubuntu")],
      restartMs: [10],
      spawn: async () => {
        const stdout = new PassThrough();
        const exit = new EventEmitter();
        stdout.write(JSON.stringify({ ready: true, schema: [1, 1] }) + "\n");
        procs.push({ stdout, exit });
        return { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => {}, on: (e, l) => exit.on(e, l) } satisfies SideProcess;
      },
    });
    const keepAwake = createKeepAwake({ inhibitor: { cmd: "inh", args: [] }, spawn: (() => (held.push(Object.assign(new EventEmitter(), { stdin: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), unref: () => {} })), held.at(-1))) as never });
    const appSettings = createSettings({ file: join(dir, `side${Math.random()}.json`) });
    appSettings.set({ power: { keepAwake: true } });
    const d = createDaemon({ webRoot: dir, roots: [dir], token, appSettings, sides, keepAwake });
    await sides.start("wsl:Ubuntu");
    return { procs, held, d, sides, running: (on: boolean) => procs.at(-1)!.stdout.write(JSON.stringify({ running: on }) + "\n") };
  }

  it("a Side's running frame holds the inhibitor and its end releases it", async () => {
    const h = await hub();
    h.running(true);
    await vi.waitFor(() => expect(h.held).toHaveLength(1));
    h.running(false);
    await vi.waitFor(() => expect(h.held[0]!.kill).toHaveBeenCalledTimes(1));
    h.d.close();
  });

  it("a Side that exits while running releases the inhibitor", async () => {
    const h = await hub();
    h.running(true);
    await vi.waitFor(() => expect(h.held).toHaveLength(1));
    h.sides.close();
    h.procs.at(-1)!.exit.emit("exit", 1);
    await vi.waitFor(() => expect(h.held[0]!.kill).toHaveBeenCalledTimes(1));
    h.d.close();
  });

  it("a Side that crashes during a turn and restarts to ready no longer counts as running", async () => {
    const h = await hub();
    h.running(true);
    await vi.waitFor(() => expect(h.held).toHaveLength(1));
    h.procs.at(-1)!.exit.emit("exit", 1);
    await vi.waitFor(() => expect(h.procs).toHaveLength(2));
    await vi.waitFor(() => expect(h.sides.list().find((s) => s.id === "wsl:Ubuntu")?.state).toBe("ready"));
    await vi.waitFor(() => expect(h.held[0]!.kill).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(h.held).toHaveLength(1);
    h.d.close();
  });
});
