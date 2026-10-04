import { appendFileSync, mkdtempSync, openSync, writeSync, closeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { JsonlTail } from "../src/transcript.ts";

const line = (o: object) => JSON.stringify(o) + "\n";

describe("JsonlTail", () => {
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
