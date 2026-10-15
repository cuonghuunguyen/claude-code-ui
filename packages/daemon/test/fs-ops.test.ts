import { chmodSync, linkSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { copyName, countEntries, createEntry, deleteEntry, duplicateFile, renameEntry, type FsOpsContext } from "../src/fs-ops.ts";

const posix = process.platform !== "win32";
const base = realpathSync(mkdtempSync(join(tmpdir(), "fsops-")));
const root = join(base, "root");
const outside = join(base, "outside");
mkdirSync(root);
mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "outside secret");
afterAll(() => rmSync(base, { recursive: true, force: true }));

const inside = (p: string) => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const ctx = (over: Partial<FsOpsContext> = {}): FsOpsContext => ({
  allowed: (p) => {
    try {
      const r = typeof p === "string" ? realpathSync(p) : undefined;
      return r && inside(r) ? r : undefined;
    } catch {
      return undefined;
    }
  },
  refused: () => false,
  missingInRoots: (p) => typeof p === "string" && !existsSync(p) && inside(p),
  roots: [root],
  busy: () => false,
  ...over,
});
let n = 0;
const dir = () => {
  const d = join(root, `d${n++}`);
  mkdirSync(d);
  return d;
};

describe("copyName (GH-360)", () => {
  it("puts copy before the last extension", () => {
    expect(copyName("a.ts", 1)).toBe("a copy.ts");
    expect(copyName("a.ts", 2)).toBe("a copy 2.ts");
    expect(copyName(".env", 1)).toBe(".env copy");
    expect(copyName("Makefile", 3)).toBe("Makefile copy 3");
    expect(copyName("a.tar.gz", 1)).toBe("a.tar copy.gz");
  });
});

describe("countEntries (GH-360)", () => {
  it("counts files and folders, does not enter a link, stops at the limit", async () => {
    const d = dir();
    mkdirSync(join(d, "a/b"), { recursive: true });
    writeFileSync(join(d, "a/f1"), "");
    writeFileSync(join(d, "a/b/f2"), "");
    if (posix) symlinkSync(outside, join(d, "link"));
    expect(await countEntries(d)).toEqual({ files: posix ? 3 : 2, folders: 2 });
    expect(await countEntries(d, 2)).toMatchObject({ more: true });
  });
});

describe("file operations (GH-360)", () => {
  it("create refuses a parent outside the roots and a parent swapped for a link during the request", async () => {
    expect(createEntry(ctx(), join(outside, "x.txt"), false)).toMatchObject({ code: "path_not_allowed" });
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
    if (!posix) return;
    const d = dir();
    const swapping = ctx({
      allowed: (p) => {
        const r = ctx().allowed(p);
        if (p === d) (rmSync(d, { recursive: true }), symlinkSync(outside, d));
        return r;
      },
    });
    expect(createEntry(swapping, join(d, "x.txt"), false)).toMatchObject({ code: "path_not_allowed" });
    expect(existsSync(join(outside, "x.txt"))).toBe(false);
  });

  it.runIf(posix)("delete and rename refuse a parent swapped for a link during the request", async () => {
    for (const op of ["delete", "rename"]) {
      const d = dir();
      writeFileSync(join(d, "f.txt"), "in");
      writeFileSync(join(outside, "f.txt"), "outside");
      const swapping = ctx({
        busy: () => (rmSync(d, { recursive: true }), symlinkSync(outside, d), false),
      });
      const r = op === "delete" ? await deleteEntry(swapping, join(d, "f.txt"), false) : await renameEntry(swapping, join(d, "f.txt"), "g.txt");
      expect(r, op).toMatchObject({ code: "path_not_allowed" });
      expect(readFileSync(join(outside, "f.txt"), "utf8"), op).toBe("outside");
      expect(existsSync(join(outside, "g.txt")), op).toBe(false);
    }
  });

  it("refuses a name with a separator, .. and a root", async () => {
    const d = dir();
    writeFileSync(join(d, "f"), "");
    expect(createEntry(ctx(), `${d}${sep}..`, false)).toMatchObject({ code: "bad_name" });
    expect(await renameEntry(ctx(), join(d, "f"), "a/b")).toMatchObject({ code: "bad_name" });
    expect(await renameEntry(ctx(), join(d, "f"), "..")).toMatchObject({ code: "bad_name" });
    expect(await deleteEntry(ctx(), root, false)).toMatchObject({ code: "root_protected" });
    expect(await renameEntry(ctx(), root, "x")).toMatchObject({ code: "root_protected" });
    expect(existsSync(d)).toBe(true);
  });

  it("rename is allowed for the same inode (case-only) and refused over another entry", async () => {
    const d = dir();
    writeFileSync(join(d, "a.txt"), "a");
    writeFileSync(join(d, "b.txt"), "b");
    expect(await renameEntry(ctx(), join(d, "a.txt"), "b.txt")).toMatchObject({ code: "exists" });
    expect(await renameEntry(ctx(), join(d, "a.txt"), "A.txt")).toEqual({ path: join(d, "A.txt") });
  });

  it("rename onto a hard link of the same file is refused as existing; a case-only name still passes", async () => {
    const d = dir();
    writeFileSync(join(d, "a.txt"), "a");
    linkSync(join(d, "a.txt"), join(d, "b.txt"));
    expect(await renameEntry(ctx(), join(d, "a.txt"), "b.txt")).toMatchObject({ code: "exists" });
    expect(existsSync(join(d, "a.txt"))).toBe(true);
    expect(await renameEntry(ctx(), join(d, "a.txt"), "A.txt")).toEqual({ path: join(d, "A.txt") });
  });

  it.runIf(posix)("duplicate keeps the mode, picks the next free name, refuses a folder and a link", async () => {
    const d = dir();
    writeFileSync(join(d, "x.sh"), "echo");
    chmodSync(join(d, "x.sh"), 0o750);
    const one = await duplicateFile(ctx(), join(d, "x.sh"));
    expect(one).toEqual({ path: join(d, "x copy.sh") });
    expect(statSync(join(d, "x copy.sh")).mode & 0o777).toBe(0o750);
    expect(await duplicateFile(ctx(), join(d, "x.sh"))).toEqual({ path: join(d, "x copy 2.sh") });
    mkdirSync(join(d, "sub"));
    expect(await duplicateFile(ctx(), join(d, "sub"))).toMatchObject({ code: "not_a_file" });
    symlinkSync(join(outside, "secret.txt"), join(d, "ln"));
    expect(await duplicateFile(ctx(), join(d, "ln"))).toMatchObject({ code: "not_a_file", message: "Cannot duplicate a link." });
    expect(existsSync(join(d, "ln copy"))).toBe(false);
  });
});
