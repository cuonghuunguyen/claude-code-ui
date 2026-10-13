import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openChecked, OPEN_READ, OPEN_WRITE, sameFile } from "../src/fd-check.ts";
import { readSync } from "node:fs";

let base: string;
let root: string;
let outside: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "fdcheck-")));
  root = join(base, "root");
  outside = join(base, "outside");
  mkdirSync(join(root, "d"), { recursive: true });
  mkdirSync(join(outside, "d"), { recursive: true });
  writeFileSync(join(root, "d", "a.txt"), "inside");
  writeFileSync(join(outside, "d", "a.txt"), "outside");
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const text = (fd: number) => {
  const b = Buffer.alloc(64);
  return b.subarray(0, readSync(fd, b, 0, 64, 0)).toString();
};

describe("openChecked", () => {
  it("returns an fd for a canonical in-root file", () => {
    const fd = openChecked(join(root, "d", "a.txt"), OPEN_READ);
    expect(text(fd)).toBe("inside");
    closeSync(fd);
  });

  it.skipIf(process.platform === "win32")("throws ECHANGED when an intermediate directory was swapped for a symlink", () => {
    const canonical = join(root, "d", "a.txt");
    renameSync(join(root, "d"), join(root, "d0"));
    symlinkSync(join(outside, "d"), join(root, "d"));
    expect(() => openChecked(canonical, OPEN_READ)).toThrow(expect.objectContaining({ code: "ECHANGED" }));
  });

  it.skipIf(process.platform === "win32")("refuses a last component swapped for a symlink (no-follow)", () => {
    const canonical = join(root, "d", "a.txt");
    rmSync(canonical);
    symlinkSync(join(outside, "d", "a.txt"), canonical);
    expect(() => openChecked(canonical, OPEN_READ)).toThrow(expect.objectContaining({ code: "ELOOP" }));
  });

  it("OPEN_WRITE never creates a file", () => {
    expect(() => openChecked(join(root, "d", "missing.txt"), OPEN_WRITE)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });
});

describe("sameFile", () => {
  it("is true for the file the path names and false for another file (swap back)", () => {
    const inside = join(root, "d", "a.txt");
    const fdIn = openSync(inside, OPEN_READ);
    const fdOut = openSync(join(outside, "d", "a.txt"), OPEN_READ);
    expect(sameFile(fdIn, inside)).toBe(true);
    expect(sameFile(fdOut, inside)).toBe(false);
    closeSync(fdIn);
    closeSync(fdOut);
    expect(readFileSync(inside, "utf8")).toBe("inside");
  });
});
