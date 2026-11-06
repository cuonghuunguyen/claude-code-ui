import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HUB_PROBE, parseHub } from "../src/hub-probe.ts";
import { findHub, hubBridgeScript, hubExec } from "../src/side-attach.ts";

const info = (o: Record<string, unknown> = {}) => ({ port: 1, pid: 2, version: "1.2.1", startedAt: "x", attach: "/x/attach.sock", schema: [1, 1], exec: ["/usr/bin/node", "/a b/cli.js"], ...o });
const line = (v: unknown) => `motd\nCLAUDE_UI_CHECK hub=${Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64")}\nbye\r\n`;

describe("parseHub", () => {
  it("returns exec and version of a live compatible Hub, past login noise", () => {
    expect(parseHub(line(info()))).toEqual({ exec: ["/usr/bin/node", "/a b/cli.js"], version: "1.2.1" });
  });
  it("refuses a Hub it cannot bridge through", () => {
    for (const v of [info({ schema: [0, 0] }), info({ schema: [1] }), info({ attach: undefined }), info({ exec: undefined }), info({ exec: [] }), info({ exec: ["node", "/c.js"] }), info({ exec: ["/n", 1] }), info({ exec: ["/n", ""] }), info({ version: undefined }), "not json"]) expect(parseHub(line(v))).toBeUndefined();
    expect(parseHub("CLAUDE_UI_CHECK hub=%%%")).toBeUndefined();
    expect(parseHub("no hub line")).toBeUndefined();
  });
});

describe("hubBridgeScript", () => {
  it("quotes every word and may start a Hub of that build", () => {
    const s = hubBridgeScript(["/n o/node", "/it's/cli.js"]);
    expect(s).toBe(`exec '/n o/node' '/it'\\''s/cli.js' side --attach --start`);
  });
});

describe("hubExec", () => {
  it("keeps the loader flags and drops debugger flags", () => {
    const prev = process.execArgv;
    process.execArgv = ["--import", "tsx", "--inspect=9229", "--debug-port=1"];
    try {
      expect(hubExec().slice(1, -1)).toEqual(["--import", "tsx"]);
    } finally {
      process.execArgv = prev;
    }
  });
});

describe("findHub", () => {
  const r = (o: Record<string, unknown> = {}) => ({ code: 0, stdout: line(info()), stderr: "", ...o });
  const find = (o: Record<string, unknown> = {}, res = r()) => findHub({ runArgs: "attach", setup: "needed", run: async () => res, ...o } as Parameters<typeof findHub>[0]);
  it("finds a compatible Hub, whatever the probe's exit code", async () => {
    expect(await find()).toMatchObject({ version: "1.2.1" });
    expect(await find({}, r({ code: 1 }))).toMatchObject({ version: "1.2.1" });
  });
  it("a probe that throws is no Hub", async () => {
    expect(await find({ run: () => Promise.reject(new Error("x")) })).toBeUndefined();
  });
  it("an update, Reinstall or pinned start does not probe (a Hub with a broken exec must not block the install)", async () => {
    let n = 0;
    const run = async () => (n++, r());
    for (const o of [{ runArgs: "update" }, { setup: "force" }, { pinned: true }]) expect(await find({ run, ...o })).toBeUndefined();
    expect(n).toBe(0);
  });
  it("an error the install path would hit too is thrown at once", async () => {
    await expect(find({ fatal: () => "SSH: box is not reachable" }, r({ code: 255 }))).rejects.toThrow("not reachable");
    // A reattach (backoff retries) must not throw: the side would stay in error.
    expect(await find({ runArgs: "side --attach", fatal: () => "x" }, r({ code: 255, stdout: "" }))).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("HUB_PROBE in a real sh", () => {
  const servers: Server[] = [];
  afterEach(() => servers.splice(0).forEach((v) => v.close()));
  /** `socket`: a real Unix socket at `attach` (the probe tests `-S`). */
  const cfg = async (pid: number, socket = true) => {
    const x = realpathSync(mkdtempSync(join(tmpdir(), "hub-")));
    mkdirSync(join(x, "claude-ui"));
    const sock = join(x, "claude-ui", "attach.sock");
    if (socket) await new Promise<void>((r) => servers.push(createServer().listen(sock, r)));
    const text = JSON.stringify(info({ pid, attach: sock })) + "\n";
    writeFileSync(join(x, "claude-ui", "daemon.json"), text);
    return { x, text };
  };
  // spawnSync would block the event loop that serves the socket: the probe runs async.
  const run = (xdg: string) => new Promise<string>((r) => execFile("sh", ["-c", HUB_PROBE], { env: { ...process.env, XDG_CONFIG_HOME: xdg } }, (_e, out) => r(out)));
  it("prints the file of a live pid with a socket", async () => {
    const { x, text } = await cfg(process.pid);
    const out = await run(x);
    expect(Buffer.from(out.trim().replace("CLAUDE_UI_CHECK hub=", ""), "base64").toString()).toBe(text);
    expect(out.trim().split("\n")).toHaveLength(1);
  });
  it("prints nothing for a dead pid, a missing socket (stale file, reused pid) or no file", async () => {
    expect(await run((await cfg(999999999)).x)).toBe("");
    expect(await run((await cfg(process.pid, false)).x)).toBe("");
    expect(await run(realpathSync(mkdtempSync(join(tmpdir(), "hub-"))))).toBe("");
  });
});
