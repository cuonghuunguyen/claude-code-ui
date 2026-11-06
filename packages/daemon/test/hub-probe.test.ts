import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_PROBE, parseHub } from "../src/hub-probe.ts";
import { findHub, hubBridgeScript } from "../src/side-attach.ts";

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
  it("quotes every word and never starts a Hub", () => {
    const s = hubBridgeScript(["/n o/node", "/it's/cli.js"]);
    expect(s).toBe(`exec '/n o/node' '/it'\\''s/cli.js' side --attach`);
    expect(s).not.toContain("--start");
  });
});

describe("findHub", () => {
  it("a failing probe is no Hub", async () => {
    expect(await findHub(async () => ({ stdout: line(info()) }))).toMatchObject({ version: "1.2.1" });
    expect(await findHub(async () => Promise.reject(new Error("x")))).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("HUB_PROBE in a real sh", () => {
  const run = (xdg: string) => spawnSync("sh", ["-c", HUB_PROBE], { env: { ...process.env, XDG_CONFIG_HOME: xdg }, encoding: "utf8" });
  const cfg = (pid: number) => {
    const x = realpathSync(mkdtempSync(join(tmpdir(), "hub-")));
    mkdirSync(join(x, "claude-ui"));
    const text = JSON.stringify(info({ pid })) + "\n";
    writeFileSync(join(x, "claude-ui", "daemon.json"), text);
    return { x, text };
  };
  it("prints the file of a live pid", () => {
    const { x, text } = cfg(process.pid);
    const out = run(x).stdout;
    expect(Buffer.from(out.trim().replace("CLAUDE_UI_CHECK hub=", ""), "base64").toString()).toBe(text);
    expect(out.trim().split("\n")).toHaveLength(1);
  });
  it("prints nothing for a dead pid or no file", () => {
    expect(run(cfg(999999999).x).stdout).toBe("");
    expect(run(realpathSync(mkdtempSync(join(tmpdir(), "hub-")))).stdout).toBe("");
  });
});
