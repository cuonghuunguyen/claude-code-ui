import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { createSettings } from "../src/settings.ts";
import type { Launcher, OpenCommand } from "../src/open-external.ts";
import { permissionQuery } from "./fake-query.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const dir = realpathSync(mkdtempSync(join(tmpdir(), "oe-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "oe-out-")));
const root = join(dir, "root");
mkdirSync(join(root, "sub"), { recursive: true });
writeFileSync(join(root, "a.txt"), "x");
writeFileSync(join(outside, "o.txt"), "x");
symlinkSync(join(outside, "o.txt"), join(root, "link.txt"));

const run = vi.fn<(c: OpenCommand) => Promise<void>>(async () => {});
const editors = new Map<"code", Launcher>([["code", { cli: "/bin/code" }]]);
const mk = (extra: object = {}) => createDaemon({ webRoot: dir, roots: [root], query: permissionQuery as never, token, appSettings: createSettings({ file: join(dir, `s${Math.random()}.json`) }), openExternal: { run, editors: () => editors }, ...extra });
const d = mk();
const tail = mk({ hostnames: ["box.tail1234.ts.net"] });
let port = 0;
let tailPort = 0;
beforeAll(async () => {
  for (const h of [d, tail]) await new Promise<void>((r) => h.listen(0, "127.0.0.1", r));
  port = (d.address() as AddressInfo).port;
  tailPort = (tail.address() as AddressInfo).port;
});
afterAll(() => void (d.close(), tail.close()));

async function client(p: number, host?: string) {
  const headers = host ? { host, origin: `http://${host}` } : { origin: `http://127.0.0.1:${p}` };
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { headers });
  const inbox: ServerMessage[] = [];
  ws.on("message", (x) => inbox.push(JSON.parse(String(x))));
  await new Promise((r) => ws.once("open", r));
  return async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return vi.waitFor(() => inbox.find((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId) ?? Promise.reject(new Error("no reply")), { timeout: 5000 }) as unknown as Promise<any>;
  };
}
const open = (path: string, w: string, cwd = root) => ({ type: "fs.openExternal", path, cwd, with: w });

describe("fs.openExternal", () => {
  it("local connection: spawns the command for the canonical path", async () => {
    run.mockClear();
    const req = await client(port);
    expect(await req(open(join(root, "a.txt"), "reveal"))).toMatchObject({ type: "reply", result: {} });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].args).toContain(process.platform === "linux" ? root : join(root, "a.txt"));
    expect(await req(open(join(root, "a.txt"), "code"))).toMatchObject({ type: "reply" });
    expect(run.mock.calls[1]![0]).toMatchObject({ cmd: "/bin/code", args: [root, join(root, "a.txt")] });
    expect(await req(open(join(root, "sub"), "reveal"))).toMatchObject({ type: "reply" });
  });
  it("refuses a Host that is not local (tailscale, LAN) and runs nothing", async () => {
    run.mockClear();
    const req = await client(tailPort, "box.tail1234.ts.net");
    expect(await req(open(join(root, "a.txt"), "reveal"))).toMatchObject({ type: "error", code: "not_local" });
    expect(run).not.toHaveBeenCalled();
  });
  it("refuses bad input", async () => {
    run.mockClear();
    const req = await client(port);
    expect(await req(open(join(outside, "o.txt"), "reveal"))).toMatchObject({ code: "path_not_allowed" });
    expect(await req(open(join(root, "link.txt"), "reveal"))).toMatchObject({ code: "path_not_allowed" });
    expect(await req(open("rel.txt", "reveal"))).toMatchObject({ code: "path_not_allowed" });
    expect(await req(open(join(root, "gone.txt"), "reveal"))).toMatchObject({ code: "not_found" });
    expect(await req(open(join(root, "a.txt"), "reveal", outside))).toMatchObject({ code: "cwd_not_allowed" });
    expect(await req(open(join(root, "a.txt"), "rm -rf"))).toMatchObject({ code: "bad_request" });
    expect(await req(open(join(root, "sub"), "default"))).toMatchObject({ code: "bad_request" });
    expect(await req(open(join(root, "a.txt"), "idea"))).toMatchObject({ code: "editor_missing" });
    expect(run).not.toHaveBeenCalled();
  });
  it("a failing spawn is open_failed", async () => {
    run.mockRejectedValueOnce(new Error("boom"));
    expect(await (await client(port))(open(join(root, "a.txt"), "reveal"))).toMatchObject({ code: "open_failed", message: "boom" });
  });
  it("settings.get lists the detected editors; absent without the option", async () => {
    expect((await (await client(port))({ type: "settings.get" })).result.daemon.editors).toEqual([{ id: "code", label: "VS Code" }]);
    const plain = mk({ openExternal: undefined });
    await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
    try {
      const req = await client((plain.address() as AddressInfo).port);
      expect((await req({ type: "settings.get" })).result.daemon.editors).toBeUndefined();
    } finally {
      plain.close();
    }
  });
});
