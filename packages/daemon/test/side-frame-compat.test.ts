// GH-549 / ADR 0007: the Side wire protocol stays compatible one build back. The lines below are pinned from GH-548 (main 8ab13bc),
// the build before this one: a new Hub reads every frame an old Daemon writes, and a new Daemon understands every line an old Hub writes.
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parseSideFrame } from "../src/side-frame.ts";
import { createSides, runSide, type SideProcess } from "../src/sides.ts";
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

describe("frames of the previous build (GH-548) stay readable", () => {
  it("a new Hub parses every Daemon line of the previous build; its ready names no build", () => {
    for (const [line, kind] of OLD_TO_HUB) {
      const r = parseSideFrame(line);
      expect(r, line).toMatchObject({ frame: { kind } });
    }
    expect(parseSideFrame('{"ready":true,"killTree":true,"hb":true}')).toMatchObject({ frame: { build: undefined } });
  });
  it("a Daemon line of the next build that this build does not know is dropped, not fatal", () => {
    expect(parseSideFrame('{"future":1}')).toEqual({ error: "unknown frame" });
  });
  it("this build's new frames: ready with build, terminals, taken", () => {
    expect(parseSideFrame('{"ready":true,"killTree":true,"hb":true,"build":"1.2-3"}')).toMatchObject({ frame: { kind: "ready", build: "1.2-3" } });
    expect(parseSideFrame('{"terminals":2}')).toMatchObject({ frame: { kind: "terminals", terminals: 2 } });
    expect(parseSideFrame('{"taken":1}')).toMatchObject({ frame: { kind: "taken" } });
  });
});

describe("a Daemon of this build serves the lines a Hub of the previous build writes", () => {
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

  it("every line a Hub of this build writes (attach, open, send, close, git, grace, heartbeat, update) has the shape of a pinned old line", async () => {
    // Pinned key sets of the previous build's Hub -> Daemon lines.
    // `["hello"]` is new: a Daemon of the previous build reads it as a line with no known key and ignores it (runSide: no `c`, `g`, `hb` or `grace`).
    const OLD_SHAPES = ['["c","o"]', '["c","m"]', '["c","x"]', '["g","git"]', '["hb"]', '["grace"]', '["hello"]'];
    const stdin = new PassThrough();
    const sent: string[] = [];
    stdin.on("data", (b) => sent.push(...String(b).split("\n").filter(Boolean)));
    const stdout = new PassThrough();
    stdout.write('{"ready":true,"killTree":true,"hb":true,"build":"old"}\n{"terminals":0}\n{"running":false}\n');
    const proc: SideProcess = { stdin, stdout, stderr: new PassThrough(), kill: () => {}, on: () => {} };
    vi.useFakeTimers();
    try {
      const sides = createSides({ targets: [sideTarget("ssh", "box")], spawn: () => proc, key: () => "new", hubId: "h", heartbeatMs: 1_000, updateWaitMs: 1e9, grace: { read: () => ({}), write: () => {} } });
      await sides.start("ssh:box"); // ready (grace) ... then the update ({"grace":1}) as nothing runs
      const c = sides.open("ssh:box", () => {})!;
      c.send({ type: "session.list" } as never);
      c.close();
      void sides.git("ssh:box", { cwd: "/r", args: ["status"], env: {} } as never).catch(() => {});
      await vi.advanceTimersByTimeAsync(2_000); // heartbeats
      const shapes = new Set(sent.map((l) => JSON.stringify(Object.keys(JSON.parse(l)).sort())));
      expect([...shapes].every((s) => OLD_SHAPES.includes(s)), [...shapes].join(" ")).toBe(true);
      expect(sent[0]).toBe('{"hello":{"hub":"h","auto":false}}');
      expect(sent.join("")).toContain('{"grace":1}'); // the update line is a `grace` line the old Daemon understands
      sides.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a Daemon of the previous build is served by this Hub: a ready without build, no terminals frame", async () => {
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
