import { chmodSync, linkSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { copyEntry, copyName, countEntries, createEntry, deleteEntry, duplicateFile, readFileChunk, renameEntry, walkEntry, writeFileChunk, type FsOpsContext } from "../src/fs-ops.ts";

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

describe("copy, paste and drop primitives (GH-555)", () => {
  it("walk lists a nested folder, folders first, does not follow a link, caps before more is read", async () => {
    const d = dir();
    mkdirSync(join(d, "a/b"), { recursive: true });
    writeFileSync(join(d, "a/f1"), "12345");
    writeFileSync(join(d, "a/b/f2"), "123");
    if (posix) symlinkSync(outside, join(d, "link"));
    const r = (await walkEntry(ctx(), d)) as { entries: { rel: string; kind: string; target?: string }[]; bytes: number };
    expect(r.bytes).toBe(8);
    const rels = r.entries.map((e) => e.rel);
    expect([...rels].sort()).toEqual(["", "a", "a/b", "a/b/f2", "a/f1", ...(posix ? ["link"] : [])].sort());
    expect(rels[0]).toBe("");
    expect(rels.indexOf("a")).toBeLessThan(rels.indexOf("a/b"));
    expect(rels.indexOf("a/b")).toBeLessThan(rels.indexOf("a/b/f2"));
    if (posix) expect(r.entries.find((e) => e.rel === "link")?.target).toBe(outside);
    expect(await walkEntry(ctx(), d, 2)).toMatchObject({ code: "too_many" });
    expect(await walkEntry(ctx(), d, 100, 7)).toMatchObject({ code: "too_large" });
    expect(await walkEntry(ctx(), join(d, "nope"))).toMatchObject({ code: "not_found" });
    expect(await walkEntry(ctx(), join(outside, "secret.txt"))).toMatchObject({ code: "path_not_allowed" });
  });

  it("copy keeps bytes and mode, keeps a link a link, refuses an existing target and a folder, removes nothing it did not make", async () => {
    const d = dir();
    writeFileSync(join(d, "a.sh"), "echo");
    if (posix) chmodSync(join(d, "a.sh"), 0o750);
    expect(await copyEntry(ctx(), join(d, "a.sh"), join(d, "b.sh"))).toEqual({ path: join(d, "b.sh") });
    expect(readFileSync(join(d, "b.sh"), "utf8")).toBe("echo");
    if (posix) expect(statSync(join(d, "b.sh")).mode & 0o777).toBe(0o750);
    expect(await copyEntry(ctx(), join(d, "a.sh"), join(d, "b.sh"))).toMatchObject({ code: "exists" });
    expect(readFileSync(join(d, "b.sh"), "utf8")).toBe("echo");
    mkdirSync(join(d, "sub"));
    expect(await copyEntry(ctx(), join(d, "sub"), join(d, "sub2"))).toMatchObject({ code: "not_a_file" });
    expect(await copyEntry(ctx(), join(d, "a.sh"), join(outside, "x"))).toMatchObject({ code: "path_not_allowed" });
    if (posix) {
      symlinkSync("a.sh", join(d, "l"));
      await copyEntry(ctx(), join(d, "l"), join(d, "l2"));
      expect(readlinkSync(join(d, "l2"))).toBe("a.sh");
    }
  });

  it("readChunk and writeChunk round-trip a file in three pieces; the rules of offset hold", async () => {
    const d = dir();
    const src = join(d, "src.bin");
    writeFileSync(src, "abcdefghij");
    const dest = join(d, "dest.bin");
    let size = 0;
    for (const len of [4, 4, 4]) {
      const c = (await readFileChunk(ctx(), src, size, len)) as { data: string; size: number };
      expect(c.size).toBe(10);
      const w = (await writeFileChunk(ctx(), dest, size, Buffer.from(c.data, "base64"))) as { size: number };
      size = w.size;
    }
    expect(size).toBe(10);
    expect(readFileSync(dest, "utf8")).toBe("abcdefghij");
    expect(await writeFileChunk(ctx(), dest, 0, Buffer.from("x"))).toMatchObject({ code: "exists" });
    expect(await writeFileChunk(ctx(), dest, 4, Buffer.from("x"))).toMatchObject({ code: "conflict" });
    expect(await writeFileChunk(ctx(), join(d, "missing"), 3, Buffer.from("x"))).toMatchObject({ code: "not_found" });
    expect(await readFileChunk(ctx(), join(outside, "secret.txt"), 0, 4)).toMatchObject({ code: "path_not_allowed" });
    expect(await writeFileChunk(ctx(), join(outside, "w"), 0, Buffer.from("x"))).toMatchObject({ code: "path_not_allowed" });
    expect(await readFileChunk(ctx(), d, 0, 4)).toMatchObject({ code: expect.stringMatching(/not_a_file|fs_error/) });
    if (posix) {
      symlinkSync(src, join(d, "ln"));
      expect(await readFileChunk(ctx(), join(d, "ln"), 0, 4)).toHaveProperty("code");
      expect(await writeFileChunk(ctx(), join(d, "ln"), 0, Buffer.from("x"))).toMatchObject({ code: "exists" });
      expect(readFileSync(src, "utf8")).toBe("abcdefghij");
    }
  });

  it("rename with dir moves; refuses into itself, a busy source, a root; replace swaps a file (history called) and a whole folder", async () => {
    const d = dir();
    mkdirSync(join(d, "from/inner"), { recursive: true });
    mkdirSync(join(d, "to"));
    writeFileSync(join(d, "from/inner/f"), "f");
    expect(await renameEntry(ctx(), join(d, "from"), "from", join(d, "from/inner"))).toMatchObject({ code: "into_itself" });
    expect(await renameEntry(ctx(), join(d, "from"), "from", join(d, "from"))).toMatchObject({ code: "into_itself" });
    expect(await renameEntry(ctx({ busy: () => true }), join(d, "from"), "from", join(d, "to"))).toMatchObject({ code: "in_use" });
    expect(await renameEntry(ctx(), root, "x", join(d, "to"))).toMatchObject({ code: "root_protected" });
    expect(await renameEntry(ctx(), join(d, "from"), "from", join(outside))).toMatchObject({ code: "path_not_allowed" });
    expect(await renameEntry(ctx(), join(d, "from"), "from", join(d, "to"))).toEqual({ path: join(d, "to/from") });
    expect(existsSync(join(d, "to/from/inner/f"))).toBe(true);
    expect(existsSync(join(d, "from"))).toBe(false);

    writeFileSync(join(d, "n.txt"), "new");
    writeFileSync(join(d, "to/n.txt"), "old");
    expect(await renameEntry(ctx(), join(d, "n.txt"), "n.txt", join(d, "to"))).toMatchObject({ code: "exists" });
    const seen: string[] = [];
    expect(await renameEntry(ctx(), join(d, "n.txt"), "n.txt", join(d, "to"), true, (f) => seen.push(f))).toEqual({ path: join(d, "to/n.txt") });
    expect(seen).toEqual([join(d, "to/n.txt")]);
    expect(readFileSync(join(d, "to/n.txt"), "utf8")).toBe("new");

    mkdirSync(join(d, "src/x"), { recursive: true });
    writeFileSync(join(d, "src/x/new"), "1");
    mkdirSync(join(d, "to/x"));
    writeFileSync(join(d, "to/x/old"), "2");
    const r = await renameEntry(ctx(), join(d, "src/x"), "x", join(d, "to"), true, (f) => seen.push(f));
    expect(r).toEqual({ path: join(d, "to/x") });
    expect(readdirSync(join(d, "to/x"))).toEqual(["new"]);
    expect(readdirSync(join(d, "to")).filter((n) => n.includes("replaced"))).toEqual([]);
    expect(seen).toHaveLength(1);
  });
});
