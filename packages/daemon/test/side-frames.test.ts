// GH-278: a side is another process; a bad stdout line must not crash the hub.
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushPayload, ServerMessage } from "@claude-ui/protocol";
import { createPush } from "../src/push.ts";
import { createSides, MAX_SIDE_LINE_BYTES, wslSide } from "../src/sides.ts";

const valid = { sessionId: "s1", title: "Done", body: "finished" };

async function setup() {
  const stdout = new PassThrough();
  const proc = { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => {}, on: (e: "exit", l: (c: number | null) => void) => new EventEmitter().on(e, l) };
  const shown: PushPayload[] = [];
  // Wired as main.ts does: a push that fails must only be logged.
  const push = createPush({ dir: mkdtempSync(join(tmpdir(), "side-frames-")), notify: async (p) => void shown.push(p) });
  const sides = createSides({
    targets: [wslSide("Ubuntu")],
    spawn: async () => proc,
    onPush: (p) => void push.send(p).catch((e) => console.error("push failed:", (e as Error).message)),
  });
  stdout.write('{"ready":true}\n');
  await sides.start("wsl:Ubuntu");
  const got: ServerMessage[] = [];
  const conn = sides.open("wsl:Ubuntu", (m) => got.push(m))!;
  const c = 1;
  /** Writes the text and waits until it was processed. */
  const feed = async (text: string | Buffer) => (stdout.write(text), await new Promise((r) => setTimeout(r, 20)));
  /** A good frame after the bad one: the side still works. */
  const proves = async () => {
    const before = got.length;
    await feed(JSON.stringify({ c, m: { type: "reply", reqId: "ok", result: 1 } }) + "\n");
    expect(got.length).toBe(before + 1);
  };
  return { sides, feed, got, shown, proves, conn, stdout };
}

describe("side frames (GH-278)", () => {
  let err: ReturnType<typeof vi.spyOn>;
  const rejections: unknown[] = [];
  const onRejection = (e: unknown) => rejections.push(e);
  beforeEach(() => {
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    process.on("unhandledRejection", onRejection);
  });
  afterEach(() => {
    process.off("unhandledRejection", onRejection);
    err.mockRestore();
    rejections.length = 0;
  });
  const logged = () => err.mock.calls.map((a) => a.join(" ")).join("\n");

  it.each([
    ["null", "null"],
    ["number", "42"],
    ["string", '"x"'],
    ["array", '[{"c":1,"m":{}}]'],
    ["empty push", '{"push":{}}'],
    ["push without body", '{"push":{"sessionId":"s","title":"t"}}'],
    ["push of wrong types", '{"push":{"sessionId":1,"title":2,"body":3}}'],
    ["push null", '{"push":null}'],
    ["string c", '{"c":"x"}'],
    ["c without m", '{"c":1}'],
    ["null m", '{"c":1,"m":null}'],
    ["array m", '{"c":1,"m":[1]}'],
    ["fractional c", '{"c":1.5,"m":{}}'],
    ["ready false-like", '{"ready":"yes"}'],
    ["unknown key", '{"zzz":1}'],
    ["deeply nested", "[".repeat(100_000) + "]".repeat(100_000)],
  ])("drops %s, logs it, keeps working", async (_n, line) => {
    const t = await setup();
    await t.feed(line + "\n");
    expect(t.got).toEqual([]);
    expect(t.shown).toEqual([]);
    expect(logged()).toMatch(/side wsl:Ubuntu/);
    expect(rejections).toEqual([]);
    await t.proves();
  });

  it("drops a non-JSON line after ready and logs a short prefix only", async () => {
    const t = await setup();
    await t.feed("Welcome to the shell " + "x".repeat(500) + "\n");
    expect(logged()).toMatch(/not JSON/);
    expect(logged().length).toBeLessThan(300);
    await t.proves();
  });

  it("does not log the content of a dropped frame beyond a short prefix", async () => {
    const t = await setup();
    await t.feed(JSON.stringify({ c: "x", secret: "PROMPT-" + "s".repeat(200) }) + "\n");
    expect(logged()).not.toContain("s".repeat(60));
  });

  it("delivers a valid push, also after a bad one", async () => {
    const t = await setup();
    await t.feed('{"push":{}}\n');
    await t.feed(JSON.stringify({ push: valid }) + "\n");
    expect(t.shown).toEqual([valid]);
  });

  it("keeps optional push fields", async () => {
    const t = await setup();
    await t.feed(JSON.stringify({ push: { ...valid, tag: "t", silent: true, replace: false } }) + "\n");
    expect(t.shown).toEqual([{ ...valid, tag: "t", silent: true, replace: false }]);
  });

  it("drops a 10 MB single line and recovers on the next line", async () => {
    const t = await setup();
    await t.feed(JSON.stringify({ c: 1, m: { type: "reply", reqId: "big", result: "x".repeat(10 * 1024 * 1024) } }) + "\n");
    expect(t.got).toEqual([]);
    expect(logged()).toMatch(/too long/);
    await t.proves();
  });

  it("drops an over-long line without a newline in chunks, once, without buffering it", async () => {
    const t = await setup();
    for (let i = 0; i < 12; i++) await t.feed("y".repeat(MAX_SIDE_LINE_BYTES / 4));
    expect(logged().match(/too long/g)).toHaveLength(1);
    await t.feed("tail\n");
    await t.proves();
  });

  it("joins a valid frame split across chunks", async () => {
    const t = await setup();
    const line = JSON.stringify({ c: 1, m: { type: "reply", reqId: "split", result: "é€😀" } }) + "\n";
    const b = Buffer.from(line);
    await t.feed(b.subarray(0, 20));
    await t.feed(b.subarray(20, 47));
    await t.feed(b.subarray(47));
    expect(t.got).toHaveLength(1);
  });

  it("accepts a frame of an exact valid size under the cap", async () => {
    const t = await setup();
    await t.feed(JSON.stringify({ c: 1, m: { type: "reply", reqId: "mid", result: "x".repeat(2 * 1024 * 1024) } }) + "\n");
    expect(t.got).toHaveLength(1);
  });
});
