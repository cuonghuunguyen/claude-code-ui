import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, readdirSync, statSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { gitRollback, gitRollbackHunk, gitRollbackPreview, revertHunk } from "../src/git-write.ts";

if (process.platform === "win32") vi.setConfig({ testTimeout: 120_000 });
const posix = process.platform !== "win32";
const run = (cwd: string, ...args: string[]) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
};
const put = (dir: string, f: string, text: string) => writeFileSync(join(dir, f), text);
const get = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
/** A repository with a.txt, b.txt, c.txt, d.txt committed. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gwrb-")));
  const dir = join(root, "r");
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  for (const f of ["a", "b", "c", "d"]) put(dir, `${f}.txt`, `${f}0\n`);
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "init");
  const seen: { path: string; text: string }[] = [];
  const o = { allowed: (p: string) => p.startsWith(root), snapshot: (p: string) => seen.push({ path: p, text: readFileSync(p, "utf8") }) };
  return { root, dir, o, seen };
}
const roll = async (dir: string, o: ReturnType<typeof repo>["o"], paths: string[], extra: { deleteAdded?: boolean } = {}) => {
  const p = await gitRollbackPreview(dir, { paths, ...o });
  return gitRollback(dir, { paths, token: p!.token, ...extra, ...o });
};

describe("gitRollback", () => {
  it("restores HEAD in the work tree and the index of a file with staged and unstaged edits; lists a path once when deleted in the index and present as an untracked copy; deleteAdded on an added file already deleted from the work tree unstages it", async () => {
    const { dir, o, seen } = repo();
    {
      put(dir, "a.txt", "a1\n");
      run(dir, "add", "a.txt");
      put(dir, "a.txt", "a2\n");
      await roll(dir, o, ["a.txt"]);
      expect(get(dir, "a.txt")).toBe("a0\n");
      expect(run(dir, "status", "--porcelain")).toBe("");
      expect(seen.map((s) => s.text)).toEqual(["a2\n"]);
    }
    {
      run(dir, "rm", "-q", "--cached", "a.txt");
      put(dir, "a.txt", "changed\n");
      const p = await gitRollbackPreview(dir, { paths: ["a.txt"], ...o });
      expect(p?.files).toEqual([{ path: "a.txt", kind: "D" }]);
      await roll(dir, o, ["a.txt"]);
      expect(get(dir, "a.txt")).toBe("a0\n");
      expect(run(dir, "status", "--porcelain")).toBe("");
    }
    {
      put(dir, "n.txt", "n\n");
      run(dir, "add", "n.txt");
      rmSync(join(dir, "n.txt"));
      await roll(dir, o, ["n.txt"], { deleteAdded: true });
      expect(run(dir, "status", "--porcelain")).toBe("");
    }
  });


  it("moves a rename back: the old path is restored, the new path is gone; restores a deleted file (work tree and `git rm`) and leaves other changes alone", async () => {
    const { dir, o, seen } = repo();
    {
      run(dir, "mv", "a.txt", "a2.txt");
      put(dir, "a2.txt", "edited\n");
      const p = await gitRollbackPreview(dir, { paths: ["a.txt", "a2.txt"], ...o });
      expect(p?.files).toEqual([{ path: "a2.txt", kind: "R", oldPath: "a.txt" }]);
      await roll(dir, o, ["a.txt", "a2.txt"]);
      expect(existsSync(join(dir, "a2.txt"))).toBe(false);
      expect(get(dir, "a.txt")).toBe("a0\n");
      expect(run(dir, "status", "--porcelain")).toBe("");
      expect(seen.map((s) => s.text)).toEqual(["edited\n"]);
    }
    {
      rmSync(join(dir, "b.txt"));
      run(dir, "rm", "-q", "c.txt");
      put(dir, "d.txt", "d1\n");
      put(dir, "a.txt", "a1\n");
      run(dir, "add", "a.txt");
      await roll(dir, o, ["b.txt", "c.txt"]);
      expect(run(dir, "status", "--porcelain")).toBe("M  a.txt\n M d.txt");
    }
  });

  it("keeps added files as untracked files, deletes them with deleteAdded", async () => {
    const { dir, o, seen } = repo();
    put(dir, "n1.txt", "n1\n");
    put(dir, "n2.txt", "n2\n");
    run(dir, "add", "n2.txt");
    const p = await gitRollbackPreview(dir, { paths: ["n1.txt", "n2.txt"], ...o });
    expect(p?.files.map((f) => f.kind)).toEqual(["A", "A"]);
    await roll(dir, o, ["n1.txt", "n2.txt"]);
    expect(run(dir, "status", "--porcelain")).toBe("?? n1.txt\n?? n2.txt");
    expect(seen).toEqual([]);
    await roll(dir, o, ["n1.txt", "n2.txt"], { deleteAdded: true });
    expect(existsSync(join(dir, "n1.txt")) || existsSync(join(dir, "n2.txt"))).toBe(false);
    expect(run(dir, "status", "--porcelain")).toBe("");
    expect(seen.map((s) => s.text).sort()).toEqual(["n1\n", "n2\n"]);
  });



  it("refuses with stale when a listed file or HEAD changed after the preview; nothing changes", async () => {
    const { dir, o } = repo();
    put(dir, "a.txt", "a1\n");
    const p = await gitRollbackPreview(dir, { paths: ["a.txt"], ...o });
    put(dir, "a.txt", "a2 longer\n");
    await expect(gitRollback(dir, { paths: ["a.txt"], token: p!.token, ...o })).rejects.toMatchObject({ code: "stale" });
    expect(get(dir, "a.txt")).toBe("a2 longer\n");
    const q = await gitRollbackPreview(dir, { paths: ["a.txt"], ...o });
    run(dir, "commit", "-q", "-am", "next");
    put(dir, "a.txt", "a3\n");
    await expect(gitRollback(dir, { paths: ["a.txt"], token: q!.token, ...o })).rejects.toMatchObject({ code: "stale" });
    expect(get(dir, "a.txt")).toBe("a3\n");
  });

  it("refuses a path with unmerged entries, and an unborn HEAD", async () => {
    const { dir, o } = repo();
    run(dir, "checkout", "-q", "-b", "x");
    put(dir, "a.txt", "x\n");
    run(dir, "commit", "-q", "-am", "x");
    run(dir, "checkout", "-q", "main");
    put(dir, "a.txt", "m\n");
    run(dir, "commit", "-q", "-am", "m");
    try { run(dir, "merge", "x"); } catch { /* conflict */ }
    await expect(gitRollbackPreview(dir, { paths: ["a.txt"], ...o })).rejects.toThrow("Resolve the conflict first");
    await expect(gitRollbackHunk(dir, { path: "a.txt", hunk: { newStart: 1, lines: ["-m", "+<<<"] }, maxBytes: 1e6, ...o })).rejects.toThrow("Resolve the conflict first");
    // another path still rolls back while the merge runs
    put(dir, "b.txt", "b1\n");
    await roll(dir, o, ["b.txt"]);
    expect(get(dir, "b.txt")).toBe("b0\n");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gwrb-")));
    run(root, "init", "-q");
    put(root, "u.txt", "u\n");
    await expect(gitRollbackPreview(root, { paths: ["u.txt"], allowed: () => true, snapshot: () => {} })).rejects.toThrow("No commit to roll back to");
  });

  it("refuses paths and directories outside the allowed roots, and bad arguments", async () => {
    const { dir, root, o } = repo();
    await expect(gitRollbackPreview(dir, { paths: ["../x"], ...o })).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitRollbackPreview(dir, { paths: [], ...o })).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitRollback(dir, { paths: ["a.txt"], token: 1, ...o })).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitRollback(dir, { paths: ["a.txt"], token: "x", deleteAdded: "yes", ...o })).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitRollbackPreview(dir, { paths: ["a.txt"], allowed: (p) => !p.startsWith(root), snapshot: () => {} })).rejects.toBeTruthy();
  });

  it("acts in a nested repository named by cwd", async () => {
    const { dir, o } = repo();
    const sub = join(dir, "sub");
    mkdirSync(sub);
    run(sub, "init", "-q", "-b", "main");
    put(sub, "s.txt", "s0\n");
    run(sub, "add", "-A");
    run(sub, "commit", "-q", "-m", "s");
    put(sub, "s.txt", "s1\n");
    await roll(sub, o, ["s.txt"]);
    expect(get(sub, "s.txt")).toBe("s0\n");
  });
});

const hunkOf = (...lines: string[]) => lines;
describe("revertHunk", () => {
  const text = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n";
  it("undoes a modification, an addition and a deletion", () => {
    expect(revertHunk("l1\nX\nl3\n", { newStart: 1, lines: hunkOf(" l1", "-l2", "+X", " l3") })).toBe("l1\nl2\nl3\n");
    expect(revertHunk("l1\nnew\nl2\n", { newStart: 2, lines: hunkOf("+new") })).toBe("l1\nl2\n");
    expect(revertHunk("l1\nl3\n", { newStart: 1, lines: hunkOf(" l1", "-l2", " l3") })).toBe("l1\nl2\nl3\n");
    expect(revertHunk("l1\nl3\n", { newStart: 1, lines: hunkOf("-l2") })).toBe("l1\nl2\nl3\n"); // pure deletion names the line before
    expect(revertHunk("l1\nl3\n", { newStart: 0, lines: hunkOf("-l0") })).toBe("l0\nl1\nl3\n");
    expect(revertHunk("a\n", { newStart: 1, lines: hunkOf("+a") })).toBe("");
  });
  it("only touches the lines at newStart", () => {
    expect(revertHunk(text.replace("l6", "Y"), { newStart: 6, lines: hunkOf("-l6", "+Y") })).toBe(text);
    expect(revertHunk(text.replace("l6", "Y"), { newStart: 2, lines: hunkOf("-l6", "+Y") })).toBeUndefined();
    expect(revertHunk(text, { newStart: 9, lines: hunkOf("-x", "+l9") })).toBeUndefined();
  });
  it("keeps CRLF files CRLF", () => {
    expect(revertHunk("a\r\nX\r\nc\r\n", { newStart: 1, lines: hunkOf(" a", "-b", "+X", " c") })).toBe("a\r\nb\r\nc\r\n");
    expect(revertHunk("a\r\nX\r\nc\r\n", { newStart: 2, lines: hunkOf("-b1", "-b2", "+X") })).toBe("a\r\nb1\r\nb2\r\nc\r\n");
  });
  it("honours the final newline", () => {
    const m = "\\ No newline at end of file";
    // new side lacks the final newline: "a\nb" was "a\nb\n"
    expect(revertHunk("a\nb", { newStart: 2, lines: hunkOf("-b", "+b", m) })).toBe("a\nb\n");
    // old side lacked it: "a\nb\n" was "a\nb"
    expect(revertHunk("a\nb\n", { newStart: 2, lines: hunkOf("-b", m, "+b") })).toBe("a\nb");
    // the file has no final newline but the hunk says it has
    expect(revertHunk("a\nb", { newStart: 2, lines: hunkOf("-c", "+b") })).toBeUndefined();
    // both sides lack it
    expect(revertHunk("a\nX", { newStart: 1, lines: hunkOf("-a", "+a", " X", m) })).toBe("a\nX");
  });
});

describe("gitRollbackHunk", () => {
  const big = () => Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  it("rolls back the first of two hunks (second edit and index stay, history gets the old text); keeps CRLF and refuses with stale when the lines changed; validates the hunk, the size and the path", async () => {
    const { dir, o, seen } = repo();
    {
      put(dir, "big.txt", big().join("\n") + "\n");
      run(dir, "add", "-A");
      run(dir, "commit", "-q", "-m", "big");
      const l = big();
      l[1] = "EDIT 2";
      l[25] = "EDIT 26";
      put(dir, "big.txt", l.join("\n") + "\n");
      const before = get(dir, "big.txt");
      const r = await gitRollbackHunk(dir, { path: "big.txt", hunk: { newStart: 1, lines: [" line 1", "-line 2", "+EDIT 2", " line 3"] }, maxBytes: 1e6, ...o });
      expect(r).toEqual({ output: "" });
      expect(get(dir, "big.txt").split("\n")[1]).toBe("line 2");
      expect(get(dir, "big.txt").split("\n")[25]).toBe("EDIT 26");
      expect(run(dir, "diff", "--cached", "--name-only")).toBe("");
      expect(seen).toEqual([{ path: join(dir, "big.txt"), text: before }]);
    }
    {
      put(dir, "w.txt", "a\r\nX\r\nc\r\n");
      const lines = [" a", "-b", "+X", " c"];
      await gitRollbackHunk(dir, { path: "w.txt", hunk: { newStart: 1, lines }, maxBytes: 1e6, ...o });
      expect(get(dir, "w.txt")).toBe("a\r\nb\r\nc\r\n");
      await expect(gitRollbackHunk(dir, { path: "w.txt", hunk: { newStart: 1, lines }, maxBytes: 1e6, ...o })).rejects.toMatchObject({ code: "stale" });
      expect(get(dir, "w.txt")).toBe("a\r\nb\r\nc\r\n");
    }
    {
      const call = (hunk: unknown, path: unknown = "a.txt", maxBytes = 1e6) => gitRollbackHunk(dir, { path, hunk, maxBytes, ...o });
      for (const h of [null, { newStart: -1, lines: ["+x"] }, { newStart: 1.5, lines: ["+x"] }, { newStart: 1, lines: [] }, { newStart: 1, lines: [" x"] }, { newStart: 1, lines: ["xy"] }, { newStart: 1, lines: ["+a\nb"] }, { newStart: 1, lines: [1] }]) {
        await expect(call(h)).rejects.toMatchObject({ code: "bad_request" });
      }
      await expect(call({ newStart: 1, lines: ["-a0", "+x"] }, "a.txt", 1)).rejects.toMatchObject({ code: "bad_request" });
      expect(get(dir, "a.txt")).toBe("a0\n");
    }
  });


  it("refuses a path that escapes the repository (../a.txt) with bad_request and leaves a.txt unchanged", async () => {
    const { dir, o } = repo();
    await expect(gitRollbackHunk(dir, { path: "../a.txt", hunk: { newStart: 1, lines: ["-a0", "+x"] }, maxBytes: 1e6, ...o })).rejects.toMatchObject({ code: "bad_request" });
    expect(get(dir, "a.txt")).toBe("a0\n");
  });

  it.skipIf(!posix || process.getuid?.() === 0)("is atomic: a failed write leaves the original and no temp file; a success keeps the mode", async () => {
    const { dir, o } = repo();
    put(dir, "x.txt", "one\ntwo\n");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "x");
    put(dir, "x.txt", "one\nTWO\n");
    chmodSync(join(dir, "x.txt"), 0o640);
    const hunk = { newStart: 1, lines: [" one", "-two", "+TWO"] };
    const files = () => readdirSync(dir).sort();
    const before = files();
    chmodSync(dir, 0o555); // the temp file cannot be created
    try {
      await expect(gitRollbackHunk(dir, { path: "x.txt", hunk, maxBytes: 1e6, ...o })).rejects.toBeTruthy();
    } finally {
      chmodSync(dir, 0o755);
    }
    expect(get(dir, "x.txt")).toBe("one\nTWO\n");
    expect(files()).toEqual(before);
    await gitRollbackHunk(dir, { path: "x.txt", hunk, maxBytes: 1e6, ...o });
    expect(get(dir, "x.txt")).toBe("one\ntwo\n");
    expect(statSync(join(dir, "x.txt")).mode & 0o777).toBe(0o640);
    expect(files()).toEqual(before);
  });

  it.skipIf(!posix)("refuses a symlink pointing outside the allowed roots", async () => {
    const { dir, o } = repo();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "gwrb-out-")));
    put(outside, "t.txt", "x\n");
    symlinkSync(join(outside, "t.txt"), join(dir, "link.txt"));
    await expect(gitRollbackHunk(dir, { path: "link.txt", hunk: { newStart: 1, lines: ["-y", "+x"] }, maxBytes: 1e6, ...o })).rejects.toBeTruthy();
    expect(readFileSync(join(outside, "t.txt"), "utf8")).toBe("x\n");
    expect(lstatSync(join(dir, "link.txt")).isSymbolicLink()).toBe(true);
  });
});
