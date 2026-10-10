import { appendFileSync, mkdirSync, mkdtempSync, openSync, writeSync, closeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { cliTurnRunning, JsonlTail, parseJsonl, transcriptEnd } from "../src/transcript.ts";

const line = (o: object) => JSON.stringify(o) + "\n";

describe("parseJsonl", () => {
  it("parses each line, skips blank and unparsable lines, and a last line without newline", async () => {
    expect(await parseJsonl(Buffer.from('{"a":1}\n\nnot json\n{"b":2}'))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reads CRLF lines, a cut last line only when it ends at `end`, and a very long line", async () => {
    expect(await parseJsonl(Buffer.from('{"a":1}\r\n{"b":2}\r\n'))).toEqual([{ a: 1 }, { b: 2 }]);
    const long = "x".repeat(3_000_000);
    expect(await parseJsonl(Buffer.from(`{"long":"${long}"}\n{"cut":`), 3_000_012)).toEqual([{ long }]);
    expect(await parseJsonl(Buffer.from('{"a":1}\n{"cut":'))).toEqual([{ a: 1 }]);
  });

  it("stops at end, and yields to the event loop between slices", async () => {
    const buf = Buffer.from(Array.from({ length: 2000 }, (_, i) => JSON.stringify({ i })).join("\n") + "\n");
    const order: string[] = [];
    setImmediate(() => order.push("immediate"));
    const parsed = await parseJsonl(buf, buf.length, 0);
    order.push("done");
    expect(parsed).toHaveLength(2000);
    expect(order).toEqual(["immediate", "done"]);
    expect(await parseJsonl(Buffer.from('{"a":1}\n{"b":2}\n'), 8)).toEqual([{ a: 1 }]);
  });
});

describe("JsonlTail", () => {
  it("a multi-byte character split across two reads is whole in the entry; a cut last line waits", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tail-")), "t.jsonl");
    const bytes = Buffer.from(line({ uuid: "a", text: "é€😀 ok" }) + line({ uuid: "b" }));
    const cut = bytes.indexOf(Buffer.from("€")) + 1; // inside the 3-byte character
    writeFileSync(file, bytes.subarray(0, cut));
    const tail = new JsonlTail();
    await tail.read(file);
    expect(tail.entries).toEqual([]);
    appendFileSync(file, bytes.subarray(cut));
    await tail.read(file);
    expect(tail.entries).toEqual([{ uuid: "a", text: "é€😀 ok" }, { uuid: "b" }]);
  });

  it("overlapping reads run one after another: no entry twice", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tail-")), "t.jsonl");
    writeFileSync(file, line({ uuid: "a" }) + line({ uuid: "b" }) + line({ uuid: "c" }));
    const tail = new JsonlTail();
    await Promise.all([tail.read(file), tail.read(file)]);
    appendFileSync(file, line({ uuid: "d" }));
    await Promise.all([tail.read(file), tail.read(file)]);
    expect(tail.entries.map((e) => e.uuid)).toEqual(["a", "b", "c", "d"]);
  });

  it("reads only the bytes added since the last read, leaves a cut last line for the next read, starts over on a shorter file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tail-")), "t.jsonl");
    writeFileSync(file, line({ uuid: "a" }) + line({ uuid: "b" }));
    const tail = new JsonlTail();
    await tail.read(file);
    expect(tail.entries).toEqual([{ uuid: "a" }, { uuid: "b" }]);
    // Overwrite line "a" in place (same length): a reader that starts over would see "x"; this one reads on from its offset.
    const fd = openSync(file, "r+");
    writeSync(fd, line({ uuid: "x" }), 0);
    closeSync(fd);
    appendFileSync(file, line({ uuid: "c" }) + '{"uuid":"d"');
    await tail.read(file);
    expect(tail.entries.map((e) => e.uuid)).toEqual(["a", "b", "c"]);
    appendFileSync(file, "}\nnot json\n");
    await tail.read(file);
    expect(tail.entries.map((e) => e.uuid)).toEqual(["a", "b", "c", "d"]);
    writeFileSync(file, line({ uuid: "z" }));
    await tail.read(file);
    expect(tail.entries).toEqual([{ uuid: "z" }]);
  });

  it("as an SDK session store, gives getSessionMessages() the main chain the CLI's file holds", async () => {
    const id = "6f1d2c3b-4a5e-4f60-8a7b-9c8d7e6f5a4b";
    const at = "2026-10-04T10:00:00.000Z";
    const base = { sessionId: id, isSidechain: false, timestamp: at, cwd: "/p", userType: "external" };
    const file = join(mkdtempSync(join(tmpdir(), "tail-")), `${id}.jsonl`);
    writeFileSync(
      file,
      line({ ...base, type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "hi" } }) +
        line({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn" } }),
    );
    const tail = new JsonlTail();
    await tail.read(file);
    const chain = await getSessionMessages(id, { dir: "/p", sessionStore: tail.store() });
    expect(chain.map((m) => m.uuid)).toEqual(["u1", "a1"]);
  });
});

describe("cliTurnRunning", () => {
  it("true only for a live CLI process whose session file names the session as busy or waiting", () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "claude-"));
    expect(cliTurnRunning(claudeDir, "s1")).toBe(false);
    mkdirSync(join(claudeDir, "sessions"));
    const write = (pid: number, o: object) => writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify({ pid, ...o }));
    write(process.pid, { sessionId: "s1", status: "idle" });
    expect(cliTurnRunning(claudeDir, "s1")).toBe(false);
    write(process.pid, { sessionId: "s1", status: "waiting" });
    expect(cliTurnRunning(claudeDir, "s1")).toBe(true);
    expect(cliTurnRunning(claudeDir, "s2")).toBe(false);
    write(process.pid, { sessionId: "s1", status: "busy" });
    expect(cliTurnRunning(claudeDir, "s1")).toBe(true);
    // An exited process left its file behind.
    write(process.pid, { sessionId: "other" });
    write(2 ** 22 + 1, { sessionId: "s1", status: "busy" });
    expect(cliTurnRunning(claudeDir, "s1")).toBe(false);
    writeFileSync(join(claudeDir, "sessions", "7.json"), "{not json");
    expect(cliTurnRunning(claudeDir, "s1")).toBe(false);
  });
});

describe("transcriptEnd (GH-239)", () => {
  const rec = (type: string, extra = {}) => line({ type, uuid: `${type}-${Math.random()}`, ...extra });
  it("gives the size and the last main-chain user or assistant record; skips subagent records, other types and a cut last line", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "end-")), "t.jsonl");
    const text = rec("user") + rec("assistant", { message: { stop_reason: "end_turn" } }) + rec("assistant", { isSidechain: true }) + rec("artifact-autoreact-ledger") + '{"type":"user","cut';
    writeFileSync(file, text);
    const end = await transcriptEnd(file);
    expect(end.size).toBe(Buffer.byteLength(text));
    expect(end.last).toMatchObject({ type: "assistant", message: { stop_reason: "end_turn" }, parent_tool_use_id: null });
  });

  it("reads only the tail: a record before it is not found, a cut first line is skipped", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "end-")), "t.jsonl");
    writeFileSync(file, rec("assistant") + rec("summary", { pad: "x".repeat(200) }));
    expect((await transcriptEnd(file, 100)).last).toBeUndefined();
    expect((await transcriptEnd(file)).last?.type).toBe("assistant");
  });
});
