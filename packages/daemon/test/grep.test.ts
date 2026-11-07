import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGitRunner } from "../src/git-runner.ts";
import { cutLine, findInFiles, grepArgs, GrepError, matcher, parseGlobs, parseGrep, rangesOf } from "../src/grep.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "grep-")));
  dirs.push(d);
  return d;
};
const put = (d: string, rel: string, body: string | Buffer) => {
  mkdirSync(dirname(join(d, rel)), { recursive: true });
  writeFileSync(join(d, rel), body);
};
const init = (d: string) => execFileSync("git", ["init", "-q", "-b", "main"], { cwd: d });
const run = (d: string, query: string, over: { regex?: boolean; globs?: string[]; includeIgnored?: boolean } = {}, opts: Partial<Parameters<typeof findInFiles>[2]> = {}) =>
  findInFiles(d, { query, regex: over.regex ?? false, globs: over.globs ?? [], includeIgnored: over.includeIgnored }, { signal: new AbortController().signal, allowed: () => true, repoAllowed: () => true, repos: [], ...opts });
const paths = (r: Awaited<ReturnType<typeof run>>) => r.files.map((f) => f.path).sort();

afterEach(() => {
  setGitRunner(undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const base = { query: "q", regex: false, globs: [] as string[], includeIgnored: false };
describe("grepArgs", () => {
  it("repository: untracked, ignored files only on request", () => {
    expect(grepArgs({ ...base, git: true })).toContain("--untracked");
    expect(grepArgs({ ...base, git: true })).not.toContain("--no-exclude-standard");
    expect(grepArgs({ ...base, git: true, includeIgnored: true })).toContain("--no-exclude-standard");
  });
  it("outside a repository: --no-index, never with --untracked", () => {
    const on = grepArgs({ ...base, git: false, includeIgnored: true });
    expect(on).toContain("--no-index");
    expect(on).not.toContain("--exclude-standard");
    expect(grepArgs({ ...base, git: false })).toContain("--exclude-standard");
    for (const git of [true, false]) {
      const a = grepArgs({ ...base, git });
      expect(a.includes("--no-index") && a.includes("--untracked")).toBe(false);
    }
  });
  it("plain -F, regex -P, fixed flags, query after -e and globs after --", () => {
    expect(grepArgs({ ...base, git: true })).toContain("-F");
    expect(grepArgs({ ...base, git: true, regex: true })).toContain("-P");
    expect(grepArgs({ ...base, git: true, regex: true })).not.toContain("-E");
    const a = grepArgs({ ...base, query: "-x", git: true, globs: ["*.ts"] });
    for (const f of ["-I", "-n", "-i", "--null", "--column"]) expect(a).toContain(f);
    expect(a.slice(a.indexOf("-C"), a.indexOf("-C") + 2)).toEqual(["-C", "2"]);
    expect(a.slice(a.indexOf("-e"))).toEqual(["-e", "-x", "--", "*.ts"]);
  });
});

describe("parseGrep", () => {
  it("tells match from context by field count, skips breaks, applies the prefix and strips CR", () => {
    const out = ["a.txt\0 2\0b", "a.txt\0 3\0 1\0needle\r", "--", "c/d.ts\0 9\0 4\0x"].join("\n").replace(/ /g, "");
    expect(parseGrep(out, "sub/")).toEqual([
      { path: "sub/a.txt", n: 2, text: "b", match: false },
      { path: "sub/a.txt", n: 3, text: "needle", match: true },
      { path: "sub/c/d.ts", n: 9, text: "x", match: true },
    ]);
  });
});

describe("matcher, rangesOf, cutLine, parseGlobs", () => {
  it("plain query is escaped, case-insensitive, regex finds all", () => {
    expect(rangesOf("a.b aXb A.B", matcher("a.b", false))).toEqual([[0, 3], [8, 11]]);
    expect(rangesOf("fo foo fooo", matcher("fo+", true))).toEqual([[0, 2], [3, 6], [7, 11]]);
  });
  it("an empty match terminates and adds no range", () => {
    expect(rangesOf("abc", matcher("x*", true))).toEqual([]);
  });
  it("cuts a long line around the match", () => {
    const text = "a".repeat(700) + "needle" + "b".repeat(300);
    const c = cutLine(text, [[700, 706]], 300);
    expect(c.cut).toBe(true);
    expect(c.text.length).toBeLessThanOrEqual(302);
    expect(c.text.startsWith("…") && c.text.endsWith("…")).toBe(true);
    const [a, b] = c.ranges![0]!;
    expect(c.text.slice(a, b)).toBe("needle");
    expect(cutLine("short", [[0, 2]], 300)).toEqual({ text: "short", ranges: [[0, 2]], cut: false });
    expect(cutLine("x".repeat(400), undefined, 300).text).toBe("x".repeat(300) + "…");
  });
  it("globs", () => {
    expect(parseGlobs("*.ts, *.tsx")).toEqual(["*.ts", "*.tsx"]);
    expect(parseGlobs("  ")).toEqual([]);
    for (const bad of [":(top)x", "../x", "/etc", Array.from({ length: 21 }, (_, i) => `a${i}`).join(","), "a".repeat(501)]) expect(typeof parseGlobs(bad)).toBe("string");
  });
});

describe("findInFiles", () => {
  const fixture = () => {
    const d = tmp();
    init(d);
    put(d, "a.txt", Array.from({ length: 10 }, (_, i) => (i === 2 || i === 8 ? `line ${i + 1} NEEDLE` : `line ${i + 1}`)).join("\n") + "\n");
    execFileSync("git", ["add", "a.txt"], { cwd: d });
    put(d, "u.ts", "let needle = 1\n");
    put(d, "src/d/x.ts", "needle\n");
    put(d, ".gitignore", "dist/\n");
    put(d, "dist/o.js", "needle\n");
    put(d, "bin.dat", Buffer.from("\0needle\n"));
    return d;
  };

  it("repository: tracked and untracked, no ignored or binary, with context and ranges", async () => {
    const d = fixture();
    const r = await run(d, "needle");
    expect(paths(r)).toEqual(["a.txt", "src/d/x.ts", "u.ts"]);
    expect(r).toMatchObject({ git: true, includeIgnored: false, matches: 4 });
    const a = r.files.find((f) => f.path === "a.txt")!;
    expect(a.lines.map((l) => l.n)).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10]);
    expect(a.lines.filter((l) => l.ranges).map((l) => [l.n, l.ranges])).toEqual([[3, [[7, 13]]], [9, [[7, 13]]]]);
    const on = await run(d, "needle", { includeIgnored: true });
    expect(paths(on)).toContain("dist/o.js");
    expect(paths(on)).not.toContain("bin.dat");
  });

  it("globs filter at any depth", async () => {
    const d = fixture();
    expect(paths(await run(d, "needle", { globs: ["*.ts"] }))).toEqual(["src/d/x.ts", "u.ts"]);
  });

  it("nested repository: own run with the rel prefix; outsideRoots is skipped", async () => {
    const d = fixture();
    put(d, "sub/n.txt", "needle\n");
    init(join(d, "sub"));
    const repo = { path: join(d, "sub"), rel: "sub", kind: "nested" as const };
    expect(paths(await run(d, "needle", {}, { repos: [repo] }))).toContain("sub/n.txt");
    expect(paths(await run(d, "needle", {}, { repos: [{ ...repo, outsideRoots: true }] }))).not.toContain("sub/n.txt");
    expect(paths(await run(d, "needle"))).not.toContain("sub/n.txt");
  });

  it("outside a repository: ignored files included by default, .git folders never", async () => {
    const d = tmp();
    put(d, ".gitignore", "dist/\n");
    put(d, "dist/o.js", "needle\n");
    put(d, "node_modules/m.js", "needle\n");
    put(d, "x/.git/HEAD", "needle\n");
    const r = await run(d, "needle");
    expect(r).toMatchObject({ git: false, includeIgnored: true });
    expect(paths(r)).toEqual(["dist/o.js", "node_modules/m.js"]);
    expect(paths(await run(d, "needle", { includeIgnored: false }))).toEqual(["node_modules/m.js"]);
  });

  it("regex is PCRE: \\d, \\b and \\w work and the highlight follows", async () => {
    const d = tmp();
    init(d);
    put(d, "r.txt", "needle one\nneedle two\nfood\nfoo1 here\n");
    expect((await run(d, "needle (one|two)", { regex: true })).files.find((f) => f.path === "r.txt")!.lines.filter((l) => l.ranges)).toHaveLength(2);
    const digit = (await run(d, "foo\\d", { regex: true })).files[0]!.lines.filter((l) => l.ranges);
    expect(digit).toEqual([{ n: 4, text: "foo1 here", ranges: [[0, 4]] }]);
    expect((await run(d, "\\bfood", { regex: true })).files[0]!.lines.filter((l) => l.ranges).map((l) => l.n)).toEqual([3]);
    expect((await run(d, "\\w+1\\b", { regex: true })).matches).toBe(1);
  });

  it("a pattern PCRE accepts and JS rejects still searches; the highlight is empty, never a crash", async () => {
    const d = tmp();
    init(d);
    put(d, "r.txt", "FOOO\nbar\n");
    expect(() => matcher("(?i)fo++", true)).toThrow();
    const r = await run(d, "(?i)fo++", { regex: true });
    expect(r.matches).toBe(1);
    expect(r.files[0]!.lines.find((l) => l.ranges)).toEqual({ n: 1, text: "FOOO", ranges: [] });
    expect((await run(d, "x++", { regex: true })).matches).toBe(0);
  });

  it("a catastrophic regex cannot block the event loop: the highlight times out, the lines stay", async () => {
    const d = tmp();
    init(d);
    // Git matches `x` at once; the JS highlight then backtracks without end on the `a` run.
    put(d, "r.txt", `x ${"a".repeat(298)}\nx ${"a".repeat(21)}c\n`);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const t0 = Date.now();
    const r = await run(d, "x|(a+)+b", { regex: true }, { limits: { highlightMs: 300 } });
    clearInterval(timer);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.matches).toBe(2);
    expect(r.files[0]!.lines.map((l) => l.ranges)).toEqual([[], []]);
    expect(ticks).toBeGreaterThan(5);
  });

  it("a regex highlight within the time is kept", async () => {
    const d = tmp();
    init(d);
    put(d, "r.txt", "foo1 foo2\n");
    expect((await run(d, "foo\\d", { regex: true })).files[0]!.lines[0]!.ranges).toEqual([[0, 4], [5, 9]]);
  });

  it("PCRE's match limit (git exits with an error) fails the search as grep_failed", async () => {
    const d = fixture();
    setGitRunner(() => Promise.reject(Object.assign(new Error("x"), { code: 128, stderr: "fatal: pcre2_match failed with error code -47: match limit exceeded\n", stdout: Buffer.alloc(0) })));
    await expect(run(d, "(a+)+b", { regex: true })).rejects.toMatchObject({ code: "grep_failed", message: expect.stringContaining("match limit") });
  });

  it("a pattern git refuses is grep_failed with git's message", async () => {
    const d = fixture();
    await expect(run(d, "a(", { regex: true })).rejects.toMatchObject({ code: "grep_failed", message: expect.stringMatching(/\S/) });
  });

  it("a git without PCRE is regex_unsupported, only in regex mode", async () => {
    const d = fixture();
    setGitRunner(() => Promise.reject(Object.assign(new Error("x"), { code: 128, stderr: "fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE\n", stdout: Buffer.alloc(0) })));
    await expect(run(d, "need.e", { regex: true })).rejects.toMatchObject({ code: "regex_unsupported" });
    await expect(run(d, "needle")).rejects.toMatchObject({ code: "grep_failed" });
  });

  it("caps: matches, files, cut lines, run bytes", async () => {
    const d = tmp();
    init(d);
    for (let i = 0; i < 5; i++) put(d, `f${i}.txt`, Array.from({ length: 10 }, () => "needle").join("\n") + "\n");
    expect(await run(d, "needle", {}, { limits: { matches: 3 } })).toMatchObject({ matches: 3, stopped: "matches" });
    const f = await run(d, "needle", {}, { limits: { files: 2 } });
    expect(f.files).toHaveLength(2);
    expect(f.stopped).toBe("files");
    put(d, "long.txt", `${"x".repeat(100)} needle ${"y".repeat(100)}\n`);
    expect((await run(d, "needle", { globs: ["long.txt"] }, { limits: { lineChars: 20 } })).cut).toBe(true);
    const b = await run(d, "needle", {}, { limits: { runBytes: 1000 } });
    expect(b.stopped).toBe("bytes");
    expect(b.matches).toBeGreaterThan(0);
  });

  it("a matches cap keeps the 2 context lines after the last kept match, and none of a new file", async () => {
    const d = tmp();
    init(d);
    put(d, "a.txt", ["needle", "c1", "c2", "c3", "c4", "needle"].join("\n") + "\n");
    put(d, "b.txt", "x\nneedle\n");
    const same = await run(d, "needle", { globs: ["a.txt"] }, { limits: { matches: 1 } });
    expect(same.files[0]!.lines.map((l) => l.n)).toEqual([1, 2, 3]);
    const next = await run(d, "needle", {}, { limits: { matches: 2 } });
    expect(next.files.map((f) => f.path)).toEqual(["a.txt"]);
    expect(next.files[0]!.lines.map((l) => l.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("an aborted signal returns canceled", async () => {
    const d = fixture();
    const ctl = new AbortController();
    const p = run(d, "needle", {}, { signal: ctl.signal });
    ctl.abort();
    const t0 = Date.now();
    expect((await p).stopped).toBe("canceled");
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("the deadline stops a slow search", async () => {
    const d = tmp();
    init(d);
    const big = "x".repeat(20_000) + "\n";
    for (let i = 0; i < 1500; i++) put(d, `g${i % 30}/f${i}.txt`, big);
    const t0 = Date.now();
    const r = await run(d, "zzzz", {}, { limits: { ms: 20 } });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(["time", undefined]).toContain(r.stopped);
  });

  it("git missing", async () => {
    const d = fixture();
    setGitRunner(() => Promise.reject(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT", stderr: "", stdout: Buffer.alloc(0) })));
    const e = await run(d, "needle").catch((x) => x);
    expect(e).toBeInstanceOf(GrepError);
    expect(e.code).toBe("git_missing");
  });

  it("allowed() drops files", async () => {
    const d = fixture();
    expect(paths(await run(d, "needle", {}, { allowed: (p) => !p.endsWith("u.ts") }))).not.toContain("u.ts");
  });
});
