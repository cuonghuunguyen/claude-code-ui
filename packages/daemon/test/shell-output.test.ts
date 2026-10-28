import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readTail, taskDirs } from "../src/shell-output.ts";

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "shell-output-"));
  dir = join(root, "tasks");
  mkdirSync(dir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("readTail", () => {
  it("returns the whole small file, the last max chars of a big one, undefined for a missing file", async () => {
    writeFileSync(join(dir, "a.output"), "hello\n");
    expect(await readTail(join(dir, "a.output"), [dir])).toEqual({ output: "hello\n", truncated: false });
    writeFileSync(join(dir, "b.output"), "x".repeat(100) + "END");
    expect(await readTail(join(dir, "b.output"), [dir], 10)).toEqual({ output: "xxxxxxxEND", truncated: true });
    expect(await readTail(join(dir, "none.output"), [dir])).toBeUndefined();
  });

  it("caps the bytes read of a huge file", async () => {
    writeFileSync(join(dir, "big.output"), "y".repeat(2_000_000) + "END");
    const r = (await readTail(join(dir, "big.output"), [dir]))!;
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBe(30_000);
    expect(r.output.endsWith("END")).toBe(true);
  });

  it("refuses a path outside the task folder: absolute, with ../, or a sibling that shares the prefix", async () => {
    writeFileSync(join(root, "secret.txt"), "secret");
    mkdirSync(join(root, "tasks-evil"));
    writeFileSync(join(root, "tasks-evil", "a.output"), "evil");
    expect(await readTail(join(root, "secret.txt"), [dir])).toBeUndefined();
    expect(await readTail(join(dir, "..", "secret.txt"), [dir])).toBeUndefined();
    expect(await readTail(join(root, "tasks-evil", "a.output"), [dir])).toBeUndefined();
    expect(await readTail(dir, [dir])).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("refuses a symlink out of the folder, and a symlink in it", async () => {
    writeFileSync(join(root, "secret.txt"), "secret");
    symlinkSync(join(root, "secret.txt"), join(dir, "link.output"));
    expect(await readTail(join(dir, "link.output"), [dir])).toBeUndefined();
    writeFileSync(join(dir, "real.output"), "ok");
    symlinkSync(join(dir, "real.output"), join(dir, "inside.output"));
    // A link inside the folder resolves to a file inside it: allowed (the real path is what is read).
    expect(await readTail(join(dir, "inside.output"), [dir])).toEqual({ output: "ok", truncated: false });
  });
});

describe("taskDirs", () => {
  const sid = "b9c5189a-5e6f-47aa-82c1-f84492fb8c6a";
  it("names the CLI task folder of the session; none for an odd session id", () => {
    expect(taskDirs("/tmp/proj", sid, "/t")).toContain(join("/t", "claude", "-tmp-proj", sid, "tasks"));
    expect(taskDirs("/tmp/proj", "../x", "/t")).toEqual([]);
  });
});
