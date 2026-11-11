import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setGitRunner, threadRunner } from "../src/git-runner.ts";
import { gitBranch } from "../src/git-remote.ts";
import { diffConfig, gitCommitDiff, gitCommitFiles } from "../src/git-write.ts";

if (process.platform === "win32") vi.setConfig({ testTimeout: 120_000 });
const posix = process.platform !== "win32";
const run = (cwd: string, ...args: string[]) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
};
const put = (dir: string, f: string, text: string) => writeFileSync(join(dir, f), text);
/** A repository with a.txt, b.txt, c.txt, d.txt committed. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gwr-")));
  const dir = join(root, "r");
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  for (const f of ["a", "b", "c", "d"]) put(dir, `${f}.txt`, `${f}0\n`);
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "init");
  return { root, dir, inside: (p: string) => p.startsWith(root) };
}
const hook = (dir: string, name: string, body: string) => {
  const p = join(dir, ".git", "hooks", name);
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
};
const names = (dir: string, ...a: string[]) => run(dir, ...a).split("\n").filter(Boolean);

describe("gitCommitFiles", () => {
  it("commits only the checked paths; unchecked unstaged and staged entries stay; no temp index is left", async () => {
    const { dir, inside } = repo();
    put(dir, "a.txt", "a1\n");
    put(dir, "b.txt", "b1\n");
    put(dir, "c.txt", "c1\n");
    run(dir, "add", "c.txt");
    const r = await gitCommitFiles(dir, { paths: ["a.txt"], message: "only a", allowed: inside });
    expect(r?.hash).toBe(run(dir, "rev-parse", "HEAD"));
    expect(names(dir, "show", "--name-only", "--format=", "HEAD")).toEqual(["a.txt"]);
    expect(run(dir, "log", "-1", "--format=%s")).toBe("only a");
    expect(run(dir, "status", "--porcelain")).toBe(" M b.txt\nM  c.txt");
    expect(names(dir, "diff", "--cached", "--name-only")).toEqual(["c.txt"]);
    expect(r?.refs).toBeTruthy();
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
    expect(readdirSync(join(dir, ".git")).filter((f) => f.includes("claude-ui-commit"))).toEqual([]);
  });

  it("commits added, untracked, deleted and renamed paths", async () => {
    const { dir, inside } = repo();
    put(dir, "new.txt", "n\n");
    rmSync(join(dir, "b.txt"));
    renameSync(join(dir, "c.txt"), join(dir, "c2.txt"));
    put(dir, "d.txt", "d1\n");
    put(dir, "other.txt", "o\n");
    await gitCommitFiles(dir, { paths: ["new.txt", "b.txt", "c.txt", "c2.txt", "d.txt"], message: "all", allowed: inside });
    expect(names(dir, "show", "--name-status", "--format=", "HEAD").sort()).toEqual(["A\tnew.txt", "D\tb.txt", "M\td.txt", "R100\tc.txt\tc2.txt"].sort());
    expect(run(dir, "status", "--porcelain")).toBe("?? other.txt");
  });

  it("commits the working-tree content of a path with a different staged version", async () => {
    const { dir, inside } = repo();
    put(dir, "a.txt", "staged\n");
    run(dir, "add", "a.txt");
    put(dir, "a.txt", "worktree\n");
    await gitCommitFiles(dir, { paths: ["a.txt"], message: "wt", allowed: inside });
    expect(run(dir, "show", "HEAD:a.txt")).toBe("worktree");
    expect(run(dir, "status", "--porcelain")).toBe("");
  });

  it("treats a path with glob characters literally", async () => {
    const { dir, inside } = repo();
    put(dir, "x[1].txt", "1\n");
    put(dir, "x2.txt", "2\n");
    await gitCommitFiles(dir, { paths: ["x[1].txt"], message: "lit", allowed: inside });
    expect(names(dir, "show", "--name-only", "--format=", "HEAD")).toEqual(["x[1].txt"]);
    expect(run(dir, "status", "--porcelain")).toBe("?? x2.txt");
  });


  it("amend rewrites HEAD with the checked files and the new message; amend with no checked file rewrites only the message of HEAD", async () => {
    const { dir, inside } = repo();
    {
      put(dir, "a.txt", "a1\n");
      const tree = run(dir, "rev-parse", "HEAD^{tree}");
      const r = await gitCommitFiles(dir, { paths: [], message: "reworded", amend: true, allowed: inside });
      expect(r?.hash).toBe(run(dir, "rev-parse", "HEAD"));
      expect(run(dir, "log", "-1", "--format=%s")).toBe("reworded");
      expect(run(dir, "rev-parse", "HEAD^{tree}")).toBe(tree);
      expect(run(dir, "status", "--porcelain")).toBe(" M a.txt");
    }
    {
      const parent = run(dir, "rev-parse", "HEAD~0");
      put(dir, "a.txt", "a1\n");
      await gitCommitFiles(dir, { paths: ["a.txt"], message: "amended", amend: true, allowed: inside });
      expect(run(dir, "rev-list", "--count", "HEAD")).toBe("1");
      expect(run(dir, "log", "-1", "--format=%s")).toBe("amended");
      expect(run(dir, "show", "HEAD:a.txt")).toBe("a1");
      expect(run(dir, "rev-parse", "HEAD")).not.toBe(parent);
    }
  });

  it("refuses while a merge is in progress; nothing is committed and MERGE_HEAD stays", async () => {
    const { dir, inside } = repo();
    run(dir, "checkout", "-q", "-b", "f");
    put(dir, "a.txt", "a-f\n");
    put(dir, "b.txt", "b-f\n");
    run(dir, "commit", "-q", "-am", "f");
    run(dir, "checkout", "-q", "main");
    put(dir, "c.txt", "c1\n");
    run(dir, "commit", "-q", "-am", "c");
    run(dir, "merge", "-q", "--no-commit", "f");
    const head = run(dir, "rev-parse", "HEAD");
    await expect(gitCommitFiles(dir, { paths: ["a.txt"], message: "m", allowed: inside })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("merge") });
    expect(run(dir, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
  });

  /** Main and branch f both change a.txt: merging, rebasing or cherry-picking one onto the other conflicts. */
  function diverged() {
    const r = repo();
    run(r.dir, "checkout", "-q", "-b", "f");
    put(r.dir, "a.txt", "a-f\n");
    run(r.dir, "commit", "-q", "-am", "f");
    run(r.dir, "checkout", "-q", "main");
    put(r.dir, "a.txt", "a-main\n");
    run(r.dir, "commit", "-q", "-am", "main");
    return r;
  }
  const soft = (cwd: string, ...args: string[]) => {
    try {
      run(cwd, ...args);
    } catch {
      // a conflict exits non-zero
    }
  };
  /** Refused with `message`; HEAD and the real index (conflict entries included) are unchanged. */
  async function refused(dir: string, message: string, paths = ["a.txt", "b.txt"]) {
    const head = run(dir, "rev-parse", "HEAD");
    const index = run(dir, "ls-files", "-s");
    put(dir, "b.txt", "b-new\n");
    await expect(gitCommitFiles(dir, { paths, message: "m", allowed: (p: string) => p.startsWith(dirname(dir)) })).rejects.toMatchObject({ code: "bad_request", message });
    expect(run(dir, "rev-parse", "HEAD")).toBe(head);
    expect(run(dir, "ls-files", "-s")).toBe(index);
  }

  it("refuses during a rebase conflict; the conflict entries stay", async () => {
    const { dir } = diverged();
    run(dir, "checkout", "-q", "f");
    soft(dir, "rebase", "main");
    expect(run(dir, "ls-files", "-u")).not.toBe("");
    await refused(dir, "Resolve the conflicts first");
  });

  it("refuses after a stash pop conflict (no operation state at all)", async () => {
    const { dir } = repo();
    put(dir, "a.txt", "a-stash\n");
    run(dir, "stash", "push", "-q");
    put(dir, "a.txt", "a-head\n");
    run(dir, "commit", "-q", "-am", "h");
    soft(dir, "stash", "pop");
    expect(run(dir, "ls-files", "-u")).not.toBe("");
    await refused(dir, "Resolve the conflicts first");
  });

  it("refuses a merge whose conflicts are resolved: the commit would lose MERGE_HEAD as second parent", async () => {
    const { dir } = diverged();
    soft(dir, "merge", "f");
    put(dir, "a.txt", "a-both\n");
    run(dir, "add", "a.txt");
    expect(run(dir, "ls-files", "-u")).toBe("");
    await refused(dir, "Finish or abort the merge first");
    expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);
  });

  it("refuses a cherry-pick with resolved conflicts", async () => {
    const { dir } = diverged();
    soft(dir, "cherry-pick", "f");
    put(dir, "a.txt", "a-both\n");
    run(dir, "add", "a.txt");
    await refused(dir, "Finish or abort the cherry-pick first");
  });

  it("refuses a rebase stopped without a conflict, in a linked worktree (git-path aware)", async () => {
    const { root, dir } = repo();
    put(dir, "a.txt", "a1\n");
    run(dir, "commit", "-q", "-am", "one");
    const wt = join(root, "wt");
    run(dir, "worktree", "add", "-q", "-b", "w", wt);
    soft(wt, "rebase", "-q", "--exec", "false", "HEAD~1");
    expect(run(wt, "ls-files", "-u")).toBe("");
    expect(existsSync(join(dir, ".git", "worktrees", "wt", "rebase-merge"))).toBe(true);
    await refused(wt, "Finish or abort the rebase first");
  });

  it("gitCommitFiles refuses paths ../x, -x and /abs with bad_request", async () => {
    const { dir, inside } = repo();
    for (const p of ["../x", "-x", "/abs"]) await expect(gitCommitFiles(dir, { paths: [p], message: "m", allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("an empty path list without amend is bad_request; rejects bad input; push: true on a detached HEAD is bad_request and nothing is committed", async () => {
    const { dir, inside } = repo();
    {
      await expect(gitCommitFiles(dir, { paths: [], message: "m", allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
    }
    {
      const ok = { paths: ["a.txt"], message: "m", allowed: inside };
      const bad = (o: Record<string, unknown>) => expect(gitCommitFiles(dir, { ...ok, ...o } as never)).rejects.toMatchObject({ code: "bad_request" });
      await bad({ message: "  " });
      await bad({ message: "a\0b" });
      await bad({ message: 5 });
      await bad({ paths: "a.txt" });
      await bad({ paths: [""] });
      await bad({ amend: "yes" });
      await bad({ push: 1 });
    }
    {
      run(dir, "checkout", "-q", "--detach");
      put(dir, "a.txt", "a1\n");
      const head = run(dir, "rev-parse", "HEAD");
      await expect(gitCommitFiles(dir, { paths: ["a.txt"], message: "m", push: true, allowed: inside })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("detached") });
      expect(run(dir, "rev-parse", "HEAD")).toBe(head);
    }
  });

  it("amend on an unborn branch is bad_request; the first commit works", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gwr-")));
    const inside = (p: string) => p.startsWith(root);
    run(root, "init", "-q", "-b", "main");
    put(root, "a.txt", "a\n");
    put(root, "b.txt", "b\n");
    await expect(gitCommitFiles(root, { paths: ["a.txt"], message: "m", amend: true, allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
    await gitCommitFiles(root, { paths: ["a.txt"], message: "first", allowed: inside });
    expect(names(root, "show", "--name-only", "--format=", "HEAD")).toEqual(["a.txt"]);
    expect(run(root, "status", "--porcelain")).toBe("?? b.txt");
  });

  it.skipIf(!posix)("a failing pre-commit hook: git_failed with its output, nothing changed, no temp index left", async () => {
    const { dir, inside } = repo();
    hook(dir, "pre-commit", "echo lint failed; exit 1");
    put(dir, "a.txt", "a1\n");
    put(dir, "c.txt", "c1\n");
    run(dir, "add", "c.txt");
    const head = run(dir, "rev-parse", "HEAD");
    const index = readFileSync(join(dir, ".git", "index"));
    await expect(gitCommitFiles(dir, { paths: ["a.txt"], message: "m", allowed: inside })).rejects.toMatchObject({ code: "git_failed", message: expect.stringContaining("lint failed") });
    expect(run(dir, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(dir, ".git", "index")).equals(index)).toBe(true);
    expect(readdirSync(join(dir, ".git")).filter((f) => f.includes("claude-ui-commit"))).toEqual([]);
  });

  it.skipIf(!posix)("the commit-msg hook sees the message; the hook runs with the temp index", async () => {
    const { dir, inside } = repo();
    hook(dir, "commit-msg", `cp "$1" "${dir}/seen.msg"`);
    put(dir, "a.txt", "a1\n");
    await gitCommitFiles(dir, { paths: ["a.txt"], message: "hello msg", allowed: inside });
    expect(readFileSync(join(dir, "seen.msg"), "utf8")).toContain("hello msg");
  });

  it("refuses a repository outside the allowed roots", async () => {
    const { dir } = repo();
    put(dir, "a.txt", "a1\n");
    const head = run(dir, "rev-parse", "HEAD");
    await expect(gitCommitFiles(dir, { paths: ["a.txt"], message: "m", allowed: () => false })).rejects.toMatchObject({ code: "cwd_not_allowed" });
    expect(run(dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("refuses a config that includes a file outside the roots", async () => {
    const { dir, root } = repo();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "gwo-")));
    put(outside, "inc", "[user]\n\tname = x\n");
    run(dir, "config", "include.path", join(outside, "inc"));
    put(dir, "a.txt", "a1\n");
    const head = run(dir, "rev-parse", "HEAD");
    await expect(gitCommitFiles(dir, { paths: ["a.txt"], message: "m", allowed: (p) => p.startsWith(root) })).rejects.toMatchObject({ code: "cwd_not_allowed" });
    expect(run(dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("returns null outside a work tree", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gwn-")));
    await expect(gitCommitFiles(root, { paths: ["a"], message: "m", allowed: () => true })).resolves.toBeNull();
  });

  it("a nested repository commits in itself only; push: true returns the dialog data of HEAD's branch, equal to gitBranch", async () => {
    const { dir, root, inside } = repo();
    {
      const sub = join(dir, "sub");
      mkdirSync(sub);
      run(sub, "init", "-q", "-b", "main");
      put(sub, "s.txt", "s\n");
      run(sub, "add", "-A");
      run(sub, "commit", "-q", "-m", "sub init");
      put(sub, "s.txt", "s1\n");
      const head = run(dir, "rev-parse", "HEAD");
      await gitCommitFiles(sub, { paths: ["s.txt"], message: "in sub", allowed: inside });
      expect(run(sub, "log", "-1", "--format=%s")).toBe("in sub");
      expect(run(dir, "rev-parse", "HEAD")).toBe(head);
    }
    {
      run(root, "init", "-q", "--bare", "-b", "main", "o.git");
      run(dir, "remote", "add", "origin", join(root, "o.git"));
      run(dir, "push", "-q", "-u", "origin", "main");
      put(dir, "a.txt", "a1\n");
      const r = await gitCommitFiles(dir, { paths: ["a.txt"], message: "m", push: true, allowed: inside });
      const info = await gitBranch(dir, "refs/heads/main", { allowed: inside });
      expect(r?.push).toEqual(info);
      expect(r?.push?.push).toBeTruthy();
      expect(r?.push?.local).toBe(r?.hash);
    }
  });




  it("a second write while one runs is busy", async () => {
    const { dir, inside } = repo();
    put(dir, "a.txt", "a1\n");
    setGitRunner((o) => (o.args.includes("read-tree") ? new Promise((r) => setTimeout(r, 400)).then(() => threadRunner(o)) : threadRunner(o)));
    try {
      const first = gitCommitFiles(dir, { paths: ["a.txt"], message: "m", allowed: inside });
      await new Promise((r) => setTimeout(r, 100));
      await expect(gitCommitFiles(dir, { paths: ["a.txt"], message: "m2", allowed: inside })).rejects.toMatchObject({ code: "busy" });
      await expect(first).resolves.toBeTruthy();
    } finally {
      setGitRunner(undefined);
    }
  });
});

describe("gitCommitDiff", () => {
  const tmpIndexes = (dir: string) => readdirSync(join(dir, ".git")).filter((f) => f.includes("claude-ui-commit"));
  it("describes only the checked paths (changed, untracked), leaves the real index and no temporary file", async () => {
    const { dir, inside } = repo();
    put(dir, "a.txt", "a1\n");
    put(dir, "b.txt", "b1\n");
    put(dir, "n.txt", "new\n");
    put(dir, "s.txt", "staged\n");
    run(dir, "add", "s.txt");
    const before = run(dir, "diff", "--cached", "--name-only");
    const r = await gitCommitDiff(dir, { paths: ["a.txt", "n.txt"], allowed: inside });
    expect(r?.diff).toContain("+a1");
    expect(r?.diff).toContain("+new");
    expect(r?.diff).not.toContain("b1");
    expect(r?.diff).not.toContain("staged");
    expect(r?.cut).toBeUndefined();
    expect(run(dir, "diff", "--cached", "--name-only")).toBe(before);
    expect(tmpIndexes(dir)).toEqual([]);
  });
  it("shows a rename with both sides checked and a deletion; refuses an empty or bad path list; null outside a work tree", async () => {
    const { dir, root, inside } = repo();
    {
      renameSync(join(dir, "a.txt"), join(dir, "z.txt"));
      rmSync(join(dir, "b.txt"));
      const r = await gitCommitDiff(dir, { paths: ["a.txt", "z.txt", "b.txt"], allowed: inside });
      expect(r?.diff).toContain("rename from a.txt");
      expect(r?.diff).toContain("rename to z.txt");
      expect(r?.diff).toContain("deleted file mode");
    }
    {
      await expect(gitCommitDiff(dir, { paths: [], allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
      const plain = mkdtempSync(join(root, "plain-"));
      expect(await gitCommitDiff(plain, { paths: ["a"], allowed: inside })).toBeNull();
    }
  });
  it("gitCommitDiff refuses a path that escapes the repository (../x)", async () => {
    const { dir, inside } = repo();
    await expect(gitCommitDiff(dir, { paths: ["../x"], allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("works before the first commit", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "gwr-")));
    run(root, "init", "-q", "-b", "main");
    put(root, "f.txt", "first\n");
    const r = await gitCommitDiff(root, { paths: ["f.txt"], allowed: (p) => p.startsWith(root) });
    expect(r?.diff).toContain("+first");
    expect(tmpIndexes(root)).toEqual([]);
  });
  it("cuts a long patch at a line end and keeps the file list; a patch over the buffer gives the list only", async () => {
    const { dir, inside } = repo();
    put(dir, "a.txt", `${"line of text\n".repeat(200)}`);
    put(dir, "b.txt", "b1\n");
    const keep = { ...diffConfig };
    try {
      diffConfig.maxChars = 400;
      const r = await gitCommitDiff(dir, { paths: ["a.txt", "b.txt"], allowed: inside });
      expect(r?.cut).toBe("chars");
      expect(r!.diff.length).toBeLessThanOrEqual(400);
      expect(r!.diff.endsWith("\n")).toBe(true);
      expect(r!.total).toBeGreaterThan(400);
      expect(r!.diff).toContain("a.txt");
      expect(r!.diff).toContain("b.txt");
      diffConfig.maxChars = keep.maxChars;
      diffConfig.maxBuffer = 300;
      const s = await gitCommitDiff(dir, { paths: ["a.txt", "b.txt"], allowed: inside });
      expect(s?.cut).toBe("patch");
      expect(s?.diff).toContain("a.txt");
      expect(s?.diff).not.toContain("line of text");
    } finally {
      Object.assign(diffConfig, keep);
    }
  });
});
