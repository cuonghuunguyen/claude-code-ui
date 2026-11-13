import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkReplacement, createReplaceUndo, ReplaceError, replaceInFiles, replaceLine, replaceRunner, safeRel, splitLines, undoReplace } from "../src/replace.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "replace-")));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const put = (d: string, rel: string, body: string | Buffer) => {
  mkdirSync(dirname(join(d, rel)), { recursive: true });
  writeFileSync(join(d, rel), body);
};
const read = (d: string, rel: string) => readFileSync(join(d, rel), "utf8");

const setup = (root: string, over: Partial<Parameters<typeof replaceInFiles>[2]> = {}) => {
  const snaps: [string, string][] = [];
  const undo = createReplaceUndo();
  let writes = 0;
  const opts = { allowed: (p: string) => {
    try {
      const r = realpathSync(p);
      return r.startsWith(root) ? r : undefined;
    } catch {
      return undefined;
    }
  }, snapshot: (f: string, r: string) => void snaps.push([f, r]), undo, afterWrite: () => void writes++, ...over } as Parameters<typeof replaceInFiles>[2];
  const stamp = (rel: string) => {
    const st = statSync(join(root, rel));
    return { mtime: st.mtimeMs, size: st.size };
  };
  const apply = (query: string, replace: string, files: { path: string; lines: number[] }[], regex = false) =>
    replaceInFiles(root, { query, regex, replace, dryRun: false, files: files.map((f) => ({ ...f, ...stamp(f.path) })) }, opts);
  const dry = (query: string, replace: string, files: { path: string; lines: number[] }[], regex = false) => replaceInFiles(root, { query, regex, replace, dryRun: true, files }, opts);
  return { snaps, undo, opts, apply, dry, stamp, writes: () => writes };
};

describe("checkReplacement", () => {
  it("accepts references that exist", () => {
    expect(checkReplacement("(a)(?<n>b)", true, "$0 $& $1 $<n> $$ $2")).toBeUndefined();
  });
  it("rejects a missing group or name", () => {
    expect(checkReplacement("(a)", true, "$2")).toMatch(/\$2/);
    expect(checkReplacement("a", true, "$1")).toMatch(/\$1/);
    expect(checkReplacement("(a)", true, "$<x>")).toMatch(/x/);
  });
  it("two digits when that group exists, else one digit", () => {
    expect(checkReplacement("(a)", true, "$10")).toBeUndefined(); // $1 then "0"
    expect(checkReplacement("(a)", true, "$20")).toMatch(/\$2/);
  });
  it("plain text: $ stays literal, line breaks and length refused", () => {
    expect(checkReplacement("a", false, "$1")).toBeUndefined();
    expect(checkReplacement("a", false, "x\ny")).toBeDefined();
    expect(checkReplacement("a", false, "x\ry")).toBeDefined();
    expect(checkReplacement("a", false, "x".repeat(1001))).toBeDefined();
  });
});

describe("replaceLine", () => {
  it("literal replaces every occurrence, case-insensitive, with inserted ranges", () => {
    const r = replaceLine("Foo foo", "foo", true, "$1");
    expect(r).toEqual({ text: "$1 $1", ranges: [[0, 2], [3, 5]] });
  });
  it("regex references", () => {
    expect(replaceLine("a-b", "(\\w)-(\\w)", false, "$2-$1|$0|$&|$$")?.text).toBe("b-a|a-b|a-b|$");
    expect(replaceLine("2024-05", "(?<y>\\d+)-(?<m>\\d+)", false, "$<m>/$<y>")?.text).toBe("05/2024");
    expect(replaceLine("ab", "(a)(b)", false, "$10")?.text).toBe("a0");
  });
  it("non-participating group is empty; unknown group stays as typed", () => {
    expect(replaceLine("b", "(a)?b", false, "[$1]")?.text).toBe("[]");
    expect(replaceLine("b", "b", false, "$3")?.text).toBe("$3");
  });
  it("no match: undefined; empty matches skipped", () => {
    expect(replaceLine("xyz", "q", true, "z")).toBeUndefined();
    expect(replaceLine("abc", "x*", false, "-")).toBeUndefined();
  });
  it("delete: an empty replacement", () => {
    expect(replaceLine("a b a", "a", true, "")?.text).toBe(" b ");
  });
  it("runs in the thread", async () => {
    const r = replaceRunner({ source: "(\\d+)", literal: false, replace: "<$1>" }, 5000);
    try {
      expect((await r.run(["a1", "none", "22 3"]))?.map((x) => x?.text)).toEqual(["a<1>", undefined, "<22> <3>"]);
    } finally {
      r.close();
    }
  });
});

describe("splitLines", () => {
  it.each(["a\nb\n", "a\r\nb\r\n", "a\r\nb\nc", "", "\n", "a\r", "a\r\n\r\nb"])("round trips %j", (s) => {
    expect(splitLines(s).map((l) => l.body + l.end).join("")).toBe(s);
  });
  it("strips the CR from the body", () => {
    expect(splitLines("a\r\nb")).toEqual([{ body: "a", end: "\r\n" }, { body: "b", end: "" }]);
  });
});

describe("safeRel", () => {
  it("only relative, forward-slash paths without ..", () => {
    expect(safeRel("a/b.txt")).toBe(true);
    for (const p of ["", "../a", "a/../b", "/etc/passwd", "C:\\x", "C:/x", "a\\b", "a\0b", 3]) expect(safeRel(p)).toBe(false);
  });
});

describe("replaceInFiles", () => {
  it("dry run: new text and ranges, nothing written", async () => {
    const d = tmp();
    put(d, "a.txt", "one foo\ntwo\nfoo foo\n");
    const s = setup(d);
    const r = await s.dry("foo", "bar", [{ path: "a.txt", lines: [1, 3, 2] }]);
    expect(r.files[0]).toMatchObject({ path: "a.txt", ...s.stamp("a.txt"), lines: [{ n: 1, after: "one bar", ranges: [[4, 7]] }, { n: 2, none: true }, { n: 3, after: "bar bar", ranges: [[0, 3], [4, 7]] }] });
    expect(read(d, "a.txt")).toBe("one foo\ntwo\nfoo foo\n");
    expect(s.snaps).toEqual([]);
  });
  it("apply: only the listed lines, every occurrence on them", async () => {
    const d = tmp();
    put(d, "a.txt", "foo 1\nfoo 2\nFOO foo 3\n");
    const s = setup(d);
    const r = await s.apply("foo", "bar", [{ path: "a.txt", lines: [1, 3] }]);
    expect(read(d, "a.txt")).toBe("bar 1\nfoo 2\nbar bar 3\n");
    expect(r).toMatchObject({ files: [], changedFiles: 1, changedLines: 2 });
    expect(r.undoId).toBeTruthy();
    expect(s.snaps).toEqual([[join(d, "a.txt"), "replace"]]);
    expect(s.writes()).toBe(1);
  });
  it("regex with $1", async () => {
    const d = tmp();
    put(d, "a.txt", "const x = f(1)\n");
    const s = setup(d);
    await s.apply("f\\((\\d)\\)", "g($1, $1)", [{ path: "a.txt", lines: [1] }], true);
    expect(read(d, "a.txt")).toBe("const x = g(1, 1)\n");
  });
  it("bad replacement: nothing written", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\n");
    const s = setup(d);
    await expect(s.apply("(foo)", "$2", [{ path: "a.txt", lines: [1] }], true)).rejects.toMatchObject({ code: "bad_replacement" });
    await expect(s.apply("foo", "a\nb", [{ path: "a.txt", lines: [1] }])).rejects.toBeInstanceOf(ReplaceError);
    expect(read(d, "a.txt")).toBe("foo\n");
  });
  it("skips a file changed after the dry run (mtime or size)", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\n");
    put(d, "b.txt", "foo\n");
    const s = setup(d);
    const stamps = { a: s.stamp("a.txt"), b: s.stamp("b.txt") };
    writeFileSync(join(d, "a.txt"), "foo!\n");
    utimesSync(join(d, "b.txt"), new Date(1e12), new Date(1e12));
    const r = await replaceInFiles(d, { query: "foo", regex: false, replace: "x", dryRun: false, files: [{ path: "a.txt", lines: [1], ...stamps.a }, { path: "b.txt", lines: [1], ...stamps.b }] }, s.opts);
    expect(r.files.map((f) => [f.path, f.skipped])).toEqual([["a.txt", "changed"], ["b.txt", "changed"]]);
    expect(r.changedFiles).toBe(0);
    expect(read(d, "a.txt")).toBe("foo!\n");
  });
  it("apply without mtime and size: changed", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\n");
    const s = setup(d);
    const r = await replaceInFiles(d, { query: "foo", regex: false, replace: "x", dryRun: false, files: [{ path: "a.txt", lines: [1] }] }, s.opts);
    expect(r.files[0]?.skipped).toBe("changed");
  });
  it("skips a file whose listed line no longer matches", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\nbar\n");
    const s = setup(d);
    const r = await s.apply("foo", "x", [{ path: "a.txt", lines: [1, 2] }]);
    expect(r.files[0]).toMatchObject({ path: "a.txt", skipped: "changed" });
    expect(read(d, "a.txt")).toBe("foo\nbar\n");
  });
  it("path_not_allowed: .., absolute, outside roots, link out of roots", async () => {
    const d = tmp();
    const outside = tmp();
    put(outside, "secret.txt", "foo\n");
    symlinkSync(join(outside, "secret.txt"), join(d, "link.txt"));
    symlinkSync(outside, join(d, "dir"));
    put(d, "ok.txt", "foo\n");
    const s = setup(d);
    const files = ["../x.txt", join(outside, "secret.txt"), "link.txt", "dir/secret.txt"].map((path) => ({ path, lines: [1], mtime: 1, size: 4 }));
    const r = await replaceInFiles(d, { query: "foo", regex: false, replace: "x", dryRun: false, files }, s.opts);
    expect(r.files.map((f) => f.skipped)).toEqual(["path_not_allowed", "path_not_allowed", "path_not_allowed", "path_not_allowed"]);
    expect(read(outside, "secret.txt")).toBe("foo\n");
  });
  it("not_utf8, too_large, not_found", async () => {
    const d = tmp();
    put(d, "bin.txt", Buffer.from([0x66, 0x6f, 0x6f, 0xff, 0x0a]));
    put(d, "big.txt", "foo " + "x".repeat(100) + "\n");
    const s = setup(d, { limits: { fileBytes: 50 } });
    const r = await s.dry("foo", "x", [{ path: "bin.txt", lines: [1] }, { path: "big.txt", lines: [1] }, { path: "gone.txt", lines: [1] }]);
    expect(r.files.map((f) => f.skipped)).toEqual(["not_utf8", "too_large", "not_found"]);
  });
  it("total bytes cap skips later files", async () => {
    const d = tmp();
    put(d, "a.txt", "foo 1\n");
    put(d, "b.txt", "foo 2\n");
    const s = setup(d, { limits: { totalBytes: 8 } });
    const r = await s.dry("foo", "x", [{ path: "a.txt", lines: [1] }, { path: "b.txt", lines: [1] }]);
    expect(r.files.map((f) => f.skipped)).toEqual([undefined, "too_large"]);
  });
  it("keeps LF, CRLF, mixed endings, no final newline and BOM byte-identical outside the replacement", async () => {
    const d = tmp();
    const cases: [string, string, string][] = [
      ["crlf.txt", "foo\r\nbar\r\nfoo\r\n", "X\r\nbar\r\nX\r\n"],
      ["mixed.txt", "foo\nbar\r\nfoo", "X\nbar\r\nX"],
      ["bom.txt", "\uFEFFfoo\nbar\n", "\uFEFFX\nbar\n"],
      ["nonl.txt", "bar\nfoo", "bar\nX"],
      ["anchor.txt", "foo\r\n", "X\r\n"],
    ];
    for (const [f, body] of cases) put(d, f, body);
    const s = setup(d);
    const regexFile = "anchor.txt";
    await s.apply("foo", "X", [{ path: "crlf.txt", lines: [1, 3] }, { path: "mixed.txt", lines: [1, 3] }, { path: "bom.txt", lines: [1] }, { path: "nonl.txt", lines: [2] }]);
    await s.apply("foo$", "X", [{ path: regexFile, lines: [1] }], true);
    for (const [f, , want] of cases) expect(readFileSync(join(d, f)).equals(Buffer.from(want))).toBe(true);
  });
  it.skipIf(process.platform === "win32")("keeps the file mode and inode", async () => {
    const d = tmp();
    put(d, "a.sh", "foo\n");
    chmodSync(join(d, "a.sh"), 0o750);
    const ino = statSync(join(d, "a.sh")).ino;
    await setup(d).apply("foo", "x", [{ path: "a.sh", lines: [1] }]);
    const st = statSync(join(d, "a.sh"));
    expect(st.mode & 0o777).toBe(0o750);
    expect(st.ino).toBe(ino);
  });
  it("regex timeout: error, nothing written", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\n");
    put(d, "evil.txt", "a".repeat(40) + "b\n");
    const s = setup(d, { limits: { ms: 300 } });
    const t0 = Date.now();
    await expect(s.apply("(a+)+$", "x", [{ path: "a.txt", lines: [1] }, { path: "evil.txt", lines: [1] }], true)).rejects.toMatchObject({ code: "regex_timeout" });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(read(d, "a.txt")).toBe("foo\n");
    expect(read(d, "evil.txt")).toBe("a".repeat(40) + "b\n");
  });
  it("regex replace over several files (one thread, several runs)", async () => {
    const d = tmp();
    for (const f of ["a", "b", "c"]) put(d, `${f}.txt`, "f(1)\nf(2)\n");
    const s = setup(d);
    const files = ["a", "b", "c"].map((f) => ({ path: `${f}.txt`, lines: [1, 2] }));
    const dry = await s.dry("f\\((\\d)\\)", "g($1)", files, true);
    expect(dry.files.map((f) => f.lines?.[1]?.after)).toEqual(["g(2)", "g(2)", "g(2)"]);
    const r = await s.apply("f\\((\\d)\\)", "g($1)", files, true);
    expect(r).toMatchObject({ changedFiles: 3, changedLines: 6 });
    expect(read(d, "c.txt")).toBe("g(1)\ng(2)\n");
  });
  it("a file changed while later files were prepared is skipped, not overwritten", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\n");
    put(d, "b.txt", "foo\n");
    const s = setup(d);
    let n = 0;
    // The second file's allowed() check runs after the first was read and before any write.
    const opts = { ...s.opts, allowed: (p: string) => (n++ === 1 ? (writeFileSync(join(d, "a.txt"), "foo\nedited\n"), s.opts.allowed(p)) : s.opts.allowed(p)) };
    const r = await replaceInFiles(d, { query: "foo", regex: false, replace: "x", dryRun: false, files: ["a.txt", "b.txt"].map((path) => ({ path, lines: [1], ...s.stamp(path) })) }, opts);
    expect(r.files.map((f) => [f.path, f.skipped])).toEqual([["a.txt", "changed"]]);
    expect(read(d, "a.txt")).toBe("foo\nedited\n");
    expect(read(d, "b.txt")).toBe("x\n");
  });
  it("a line whose JS regex finds nothing is none in the dry run", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\n");
    const r = await setup(d).dry("bar", "x", [{ path: "a.txt", lines: [1, 9] }]);
    expect(r.files[0]?.lines).toEqual([{ n: 1, none: true }, { n: 9, none: true }]);
  });
  it("a long line is cut around the first insert", async () => {
    const d = tmp();
    put(d, "a.txt", "y".repeat(500) + "foo" + "y".repeat(500) + "\n");
    const r = await setup(d).dry("foo", "bar", [{ path: "a.txt", lines: [1] }]);
    const l = r.files[0]!.lines![0]!;
    expect(l.after!.length).toBeLessThanOrEqual(302);
    const [a, b] = l.ranges![0]!;
    expect(l.after!.slice(a, b)).toBe("bar");
    expect(r.cut).toBe(true);
  });
});

describe("undo", () => {
  it("restores the originals once; a second undo is gone", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\r\nbar\n");
    put(d, "b.txt", "foo\n");
    const s = setup(d);
    const r = await s.apply("foo", "x", [{ path: "a.txt", lines: [1] }, { path: "b.txt", lines: [1] }]);
    const u = await undoReplace(d, r.undoId!, [], s.opts);
    expect(u).toMatchObject({ files: [], changedFiles: 2, changedLines: 2 });
    expect(read(d, "a.txt")).toBe("foo\r\nbar\n");
    expect(read(d, "b.txt")).toBe("foo\n");
    expect(s.snaps.filter(([, why]) => why === "restore")).toHaveLength(2);
    await expect(undoReplace(d, r.undoId!, [], s.opts)).rejects.toMatchObject({ code: "undo_gone" });
  });
  it("skips a file changed after the replace and one listed in skip", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\n");
    put(d, "b.txt", "foo\n");
    put(d, "c.txt", "foo\n");
    const s = setup(d);
    const r = await s.apply("foo", "x", [{ path: "a.txt", lines: [1] }, { path: "b.txt", lines: [1] }, { path: "c.txt", lines: [1] }]);
    writeFileSync(join(d, "a.txt"), "edited\n");
    const u = await undoReplace(d, r.undoId!, ["b.txt"], s.opts);
    expect(u.files.map((f) => [f.path, f.skipped])).toEqual([["a.txt", "changed"], ["b.txt", "unsaved"]]);
    expect(u.changedFiles).toBe(1);
    expect(read(d, "a.txt")).toBe("edited\n");
    expect(read(d, "b.txt")).toBe("x\n");
    expect(read(d, "c.txt")).toBe("foo\n");
  });
  it("another folder's id is gone", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\n");
    const s = setup(d);
    const r = await s.apply("foo", "x", [{ path: "a.txt", lines: [1] }]);
    await expect(undoReplace(join(d, "other"), r.undoId!, [], s.opts)).rejects.toMatchObject({ code: "undo_gone" });
  });
  it("no undo id when the originals exceed the byte limit", async () => {
    const d = tmp();
    put(d, "a.txt", "foo\n");
    const s = setup(d, { undo: createReplaceUndo({ undoBytes: 2 }) });
    const r = await s.apply("foo", "x", [{ path: "a.txt", lines: [1] }]);
    expect(r.changedFiles).toBe(1);
    expect(r.undoId).toBeUndefined();
  });
});

describe("createReplaceUndo", () => {
  const f = (n: number) => [{ rel: "a", file: "/a", before: Buffer.alloc(n), afterHash: "h", lines: 1 }];
  it("keeps the last records, drops by age and bytes", () => {
    let t = 0;
    const u = createReplaceUndo({ undoRecords: 2, undoMs: 100, undoBytes: 10 }, () => t);
    const a = u.put("/", f(1))!;
    const b = u.put("/", f(1))!;
    const c = u.put("/", f(1))!;
    expect(u.take(a, "/")).toBeUndefined();
    expect(u.take(b, "/")).toBeDefined();
    const d = u.put("/", f(6))!;
    const e = u.put("/", f(6))!;
    expect(u.take(d, "/")).toBeUndefined();
    t = 1000;
    expect(u.take(e, "/")).toBeUndefined();
    expect(u.take(c, "/")).toBeUndefined();
  });
});
