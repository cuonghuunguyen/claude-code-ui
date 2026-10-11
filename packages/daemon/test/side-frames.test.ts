// GH-278: a side is another process; a bad stdout line must not crash the hub.
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PushPayload, ServerMessage } from "@claude-ui/protocol";
import { createPush } from "../src/push.ts";
import { createSides, forwardSidePush, MAX_SIDE_LINE_BYTES, runSide, wslSide } from "../src/sides.ts";

const valid = { sessionId: "s1", title: "Done", body: "finished" };

async function setup(o: { before?: string; maxLineChars?: number } = {}) {
  const stdout = new PassThrough();
  const proc = { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: () => {}, on: (e: "exit", l: (c: number | null) => void) => new EventEmitter().on(e, l) };
  const shown: PushPayload[] = [];
  // Wired as main.ts does: a push that fails must only be logged.
  const push = createPush({ dir: mkdtempSync(join(tmpdir(), "side-frames-")), notify: async (p) => void shown.push(p) });
  const sides = createSides({
    targets: [wslSide("Ubuntu")],
    spawn: async () => proc,
    onPush: forwardSidePush(push),
    ...(o.maxLineChars && { maxLineChars: o.maxLineChars }),
  });
  if (o.before) stdout.write(o.before);
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

  it("covers the largest legitimate frame: the cap is at least 128 MiB", () => {
    expect(MAX_SIDE_LINE_BYTES).toBeGreaterThanOrEqual(128 * 1024 * 1024);
  });

  it("accepts a 66 MiB frame (a prompt with images echoed as one event)", async () => {
    const t = await setup();
    await t.feed(JSON.stringify({ c: 1, m: { type: "event", part: { type: "user_text", images: ["x".repeat(66 * 1024 * 1024)] } } }) + "\n");
    expect(t.got).toHaveLength(1);
    expect(logged()).toBe("");
  });

  it("drops a line over the cap, logs it once, recovers on the next line", async () => {
    const t = await setup({ maxLineChars: 1000 });
    await t.feed(JSON.stringify({ c: 1, m: { type: "reply", reqId: "big", result: "x".repeat(5000) } }) + "\n");
    expect(t.got).toEqual([]);
    expect(logged()).toMatch(/too long/);
    await t.proves();
  });

  it("stops buffering at the cap while a line is still arriving, logs once", async () => {
    const t = await setup({ maxLineChars: 1000 });
    for (let i = 0; i < 12; i++) await t.feed("y".repeat(400));
    expect(logged().match(/too long/g)).toHaveLength(1);
    await t.feed("tail\n");
    await t.proves();
  });

  it("does not parse the tail of a dropped long line as a frame", async () => {
    const t = await setup({ maxLineChars: 1000 });
    await t.feed("z".repeat(2000)); // over the cap, no newline yet
    await t.feed(JSON.stringify({ push: valid }) + "\n"); // the end of the same line
    expect(t.shown).toEqual([]);
    await t.feed(JSON.stringify({ push: valid }) + "\n");
    expect(t.shown).toEqual([valid]);
  });

  it("does not parse the tail of a dropped long line sent in one chunk with the next line", async () => {
    const t = await setup({ maxLineChars: 1000 });
    await t.feed("z".repeat(2000));
    await t.feed(JSON.stringify({ push: valid }) + "\n" + JSON.stringify({ push: { ...valid, title: "second" } }) + "\n");
    expect(t.shown).toEqual([{ ...valid, title: "second" }]);
  });

  it("does not log shell start-up output before ready", async () => {
    const t = await setup({ before: "Welcome to Ubuntu\nlast login: today\n" });
    expect(logged()).toBe("");
    await t.feed("still not a frame\n");
    expect(logged()).toMatch(/not JSON/);
  });

  it("logs at most 20 dropped lines per run", async () => {
    const t = await setup();
    for (let i = 0; i < 30; i++) t.stdout.write("garbage " + i + "\n");
    await t.feed("");
    expect(logged().match(/dropped a line/g)).toHaveLength(20);
  });

  it("logs control characters escaped, never raw", async () => {
    const t = await setup();
    await t.feed("\x1b[31mred\x07\r\u0000 text\n");
    expect(logged()).toContain("dropped a line");
    expect(logged()).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/);
  });

  it("a push that fails is logged, never an unhandled rejection (hub wiring)", async () => {
    const forward = forwardSidePush({ send: async () => Promise.reject(new Error("boom")) });
    forward(valid);
    await new Promise((r) => setTimeout(r, 20));
    expect(rejections).toEqual([]);
    expect(logged()).toMatch(/push from a side failed: boom/);
  });

  it("runSide (side process) ignores a null, number or array line from the hub", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const accepted: unknown[] = [];
    runSide({ input, output, accept: (ws) => accepted.push(ws) });
    expect(() => input.write('null\n42\n[1]\n"s"\n{"c":1,"o":1}\n')).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(accepted).toHaveLength(1);
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
