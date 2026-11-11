// GH-549 / ADR 0009: the Side wire protocol. The frame lines below are pinned: a Hub reads every frame an attach server writes, and an attach server understands every line a Hub writes.
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseSideFrame, schemaOverlap } from "../src/side-frame.ts";
import { createSides, mismatchMessage, runSide, type SideProcess } from "../src/sides.ts";
import { sideTarget } from "../src/side-kinds.ts";
import { daemon, pipe } from "./ssh-side-harness.ts";

/** Daemon -> Hub lines of the previous build. */
const OLD_TO_HUB: [string, string][] = [
  ['{"ready":true,"killTree":true,"hb":true}', "ready"],
  ['{"ready":true}', "ready"],
  ['{"hb":1}', "hb"],
  ['{"running":true}', "running"],
  ['{"push":{"sessionId":"s","title":"t","body":"b"}}', "push"],
  ['{"c":1,"m":{"type":"x"}}', "message"],
  ['{"g":1,"out":"","err":""}', "git"],
  ['{"g":2,"out":"","err":"x","error":{"message":"m","code":1,"killed":false,"signal":null}}', "git"],
];

describe("frames stay readable", () => {
  it("a Hub parses every pinned Daemon line; a ready without build names none", () => {
    for (const [line, kind] of OLD_TO_HUB) {
      const r = parseSideFrame(line);
      expect(r, line).toMatchObject({ frame: { kind } });
    }
    expect(parseSideFrame('{"ready":true,"killTree":true,"hb":true}')).toMatchObject({ frame: { build: undefined } });
    expect(parseSideFrame('{"running":true}')).toEqual({ frame: { kind: "running", running: true } });
  });
  it("a Daemon line of the next build that this build does not know is dropped, not fatal; so are the frames of the old protocol (terminals, taken)", () => {
    for (const line of ['{"future":1}', '{"terminals":2}', '{"taken":1}']) expect(parseSideFrame(line), line).toEqual({ error: "unknown frame" });
  });
  it("ready with schema, version and startedBy parses; ready without schema parses too (the Hub then shows a mismatch)", () => {
    expect(parseSideFrame('{"ready":true,"killTree":true,"hb":true,"build":"1.2-3","schema":[1,2],"version":"1.1.0","startedBy":"attach"}')).toMatchObject({ frame: { kind: "ready", build: "1.2-3", schema: [1, 2], version: "1.1.0", startedBy: "attach" } });
    expect(parseSideFrame('{"ready":true}')).toMatchObject({ frame: { kind: "ready", schema: undefined, version: undefined, startedBy: undefined } });
  });
});

describe("an attach server serves the lines a Hub writes", () => {
  it("open, message, close, git, grace and heartbeat", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const opened: string[] = [];
    const msgs: string[] = [];
    const closed: string[] = [];
    let grace = 0;
    const git = vi.fn().mockResolvedValue({ stdout: Buffer.from("ok"), stderr: "" });
    const out: string[] = [];
    output.on("data", (b) => out.push(String(b)));
    runSide({ input, output, accept: (ws) => (opened.push("o"), ws.on("message", (m: string) => msgs.push(m)), ws.on("close", () => closed.push("x"))), git, onGrace: (ms) => (grace = ms) });
    for (const l of ['{"c":1,"o":1}', '{"c":1,"m":{"type":"ping"}}', '{"hb":1}', '{"grace":1800000}', '{"g":1,"git":{"cwd":"/r","args":["status"],"env":{}}}', '{"c":1,"x":1}']) input.write(l + "\n");
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual(["o"]);
    expect(msgs).toEqual(['{"type":"ping"}']);
    expect(closed).toEqual(["x"]);
    expect(grace).toBe(1_800_000);
    expect(git).toHaveBeenCalledTimes(1);
    expect(out.join("")).toContain('{"g":1,"out":"b2s=","err":""}');
  });

  it("every line a Hub writes (hello, open, send, close, git, grace, heartbeat) has a pinned shape; the hello names the schema range", async () => {
    const SHAPES = ['["c","o"]', '["c","m"]', '["c","x"]', '["g","git"]', '["hb"]', '["grace"]', '["hello"]'];
    const stdin = new PassThrough();
    const sent: string[] = [];
    stdin.on("data", (b) => sent.push(...String(b).split("\n").filter(Boolean)));
    const stdout = new PassThrough();
    stdout.write('{"ready":true,"killTree":true,"hb":true,"build":"old","schema":[1,1],"version":"1.1.0"}\n{"running":false}\n');
    const proc: SideProcess = { stdin, stdout, stderr: new PassThrough(), kill: () => {}, on: () => {} };
    vi.useFakeTimers();
    try {
      const sides = createSides({ targets: [sideTarget("ssh", "box")], spawn: () => proc, key: () => "new", heartbeatMs: 1_000, grace: { read: () => ({}), write: () => {} } });
      await sides.start("ssh:box");
      const c = sides.open("ssh:box", () => {})!;
      c.send({ type: "session.list" } as never);
      c.close();
      void sides.git("ssh:box", { cwd: "/r", args: ["status"], env: {} } as never).catch(() => {});
      await vi.advanceTimersByTimeAsync(2_000); // heartbeats
      const shapes = new Set(sent.map((l) => JSON.stringify(Object.keys(JSON.parse(l)).sort())));
      expect([...shapes].every((x) => SHAPES.includes(x)), [...shapes].join(" ")).toBe(true);
      expect(sent[0]).toBe('{"hello":{"schema":[1,1]}}');
      sides.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Hub attaches to an attach server of this build: ready", async () => {
    vi.useFakeTimers();
    try {
      const { d } = daemon();
      const sides = createSides({ targets: [sideTarget("ssh", "box")], spawn: () => pipe(d), heartbeatMs: 1e9 });
      await sides.start("ssh:box");
      expect(sides.list()[0]).toMatchObject({ state: "ready" });
      sides.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ADR 0009: the range of side frame schemas decides whether two Hubs can attach; a mismatch row names which side updates.
it("schemaOverlap: ranges that share a number overlap", () => {
  expect(schemaOverlap([1, 1], [1, 1])).toBe(true);
  expect(schemaOverlap([1, 2], [2, 3])).toBe(true);
  expect(schemaOverlap([1, 1], [2, 2])).toBe(false);
  expect(schemaOverlap([3, 4], [1, 2])).toBe(false);
});

const mismatch = (remoteOlder: boolean) => ({ local: "1.2.0", remote: "1.0.0", localSchema: [1, 1] as [number, number], remoteOlder });
it("mismatchMessage: an older remote is updated there, a newer remote means updating this Hub", () => {
  expect(mismatchMessage("SSH: box", mismatch(true))).toBe("SSH: box runs Claude UI 1.0.0, this is 1.2.0: they cannot work together. Update it there; it attaches by itself afterwards.");
  expect(mismatchMessage("SSH: box", mismatch(false))).toBe("SSH: box runs Claude UI 1.0.0, newer than this 1.2.0: they cannot work together. Update this Claude UI.");
});
