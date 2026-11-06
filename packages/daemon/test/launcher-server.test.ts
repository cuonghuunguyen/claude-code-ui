import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { createSettings } from "../src/settings.ts";
import { permissionQuery } from "./fake-query.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const dir = mkdtempSync(join(tmpdir(), "launcher-"));
let on = false;
let fail: Error | undefined;
const shortcut = { installed: () => on, set: async (v: boolean) => (fail ? Promise.reject(fail) : (on = v)) };
const mk = (s?: typeof shortcut) => createDaemon({ webRoot: dir, roots: [dir], query: permissionQuery as never, token, appSettings: createSettings({ file: join(dir, `s${Math.random()}.json`) }), ...(s && { shortcut: s }) });
const withSc = mk(shortcut);
const without = mk();
const ports: number[] = [];
beforeAll(async () => {
  for (const h of [withSc, without]) {
    await new Promise<void>((r) => h.listen(0, "127.0.0.1", r));
    ports.push((h.address() as AddressInfo).port);
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => void (withSc.close(), without.close()));

async function client(p: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${p}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.once("open", r));
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return vi.waitFor(() => inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) ?? Promise.reject(new Error("no reply")), { timeout: 5000 }) as unknown as Promise<any>;
  };
  return { ws, request };
}

describe("launcher over the wire", () => {
  it("settings.get reports the shortcut state", async () => {
    const c = await client(ports[0]!);
    expect((await c.request({ type: "settings.get" })).result.daemon.shortcut).toEqual({ installed: false });
    expect((await c.request({ type: "launcher.shortcut", on: true })).result).toEqual({ installed: true });
    expect((await c.request({ type: "settings.get" })).result.daemon.shortcut).toEqual({ installed: true });
    c.ws.close();
  });
  it("launcher.shortcut fails without a shortcut", async () => {
    const c = await client(ports[1]!);
    expect((await c.request({ type: "launcher.shortcut", on: true })).code).toBe("shortcut_unavailable");
    expect((await c.request({ type: "settings.get" })).result.daemon.shortcut).toBeUndefined();
    c.ws.close();
  });
  it("launcher.shortcut reports a failed write and a bad request", async () => {
    const c = await client(ports[0]!);
    expect((await c.request({ type: "launcher.shortcut", on: "yes" })).code).toBe("bad_request");
    fail = new Error("disk full");
    const r = await c.request({ type: "launcher.shortcut", on: false });
    fail = undefined;
    expect(r).toMatchObject({ code: "shortcut_failed", message: "disk full" });
    c.ws.close();
  });
  it("saved launcher settings round-trip", async () => {
    const c = await client(ports[0]!);
    const r = await c.request({ type: "settings.set", patch: { launcher: { port: 4999, allowBypass: true } } });
    expect(r.result.settings.launcher).toMatchObject({ port: 4999, allowBypass: true, lan: false });
    c.ws.close();
  });
});
