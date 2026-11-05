import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setGitRunner, threadRunner } from "../src/git-runner.ts";
import { gitBranch } from "../src/git-remote.ts";
import { gitCommitFiles } from "../src/git-write.ts";

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
  it("commits only the checked paths; unchecked unstaged and staged entries stay", async () => {
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

  it("amend rewrites HEAD with the checked files and the new message", async () => {
    const { dir, inside } = repo();
    const parent = run(dir, "rev-parse", "HEAD~0");
    put(dir, "a.txt", "a1\n");
    await gitCommitFiles(dir, { paths: ["a.txt"], message: "amended", amend: true, allowed: inside });
    expect(run(dir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(run(dir, "log", "-1", "--format=%s")).toBe("amended");
    expect(run(dir, "show", "HEAD:a.txt")).toBe("a1");
    expect(run(dir, "rev-parse", "HEAD")).not.toBe(parent);
  });

  it("amend with no checked file rewrites only the message of HEAD", async () => {
    const { dir, inside } = repo();
    put(dir, "a.txt", "a1\n");
    const tree = run(dir, "rev-parse", "HEAD^{tree}");
    const r = await gitCommitFiles(dir, { paths: [], message: "reworded", amend: true, allowed: inside });
    expect(r?.hash).toBe(run(dir, "rev-parse", "HEAD"));
    expect(run(dir, "log", "-1", "--format=%s")).toBe("reworded");
    expect(run(dir, "rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(run(dir, "status", "--porcelain")).toBe(" M a.txt");
  });

  it("an empty path list without amend is bad_request", async () => {
    const { dir, inside } = repo();
    await expect(gitCommitFiles(dir, { paths: [], message: "m", allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
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

  it("a nested repository commits in itself only", async () => {
    const { dir, inside } = repo();
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
  });

  it("push: true returns the dialog data of HEAD's branch, equal to gitBranch", async () => {
    const { dir, root, inside } = repo();
    run(root, "init", "-q", "--bare", "-b", "main", "o.git");
    run(dir, "remote", "add", "origin", join(root, "o.git"));
    run(dir, "push", "-q", "-u", "origin", "main");
    put(dir, "a.txt", "a1\n");
    const r = await gitCommitFiles(dir, { paths: ["a.txt"], message: "m", push: true, allowed: inside });
    const info = await gitBranch(dir, "refs/heads/main", { allowed: inside });
    expect(r?.push).toEqual(info);
    expect(r?.push?.push).toBeTruthy();
    expect(r?.push?.local).toBe(r?.hash);
  });

  it("push: true on a detached HEAD is bad_request and nothing is committed", async () => {
    const { dir, inside } = repo();
    run(dir, "checkout", "-q", "--detach");
    put(dir, "a.txt", "a1\n");
    const head = run(dir, "rev-parse", "HEAD");
    await expect(gitCommitFiles(dir, { paths: ["a.txt"], message: "m", push: true, allowed: inside })).rejects.toMatchObject({ code: "bad_request", message: expect.stringContaining("detached") });
    expect(run(dir, "rev-parse", "HEAD")).toBe(head);
  });

  it("rejects bad input", async () => {
    const { dir, inside } = repo();
    const ok = { paths: ["a.txt"], message: "m", allowed: inside };
    const bad = (o: Record<string, unknown>) => expect(gitCommitFiles(dir, { ...ok, ...o } as never)).rejects.toMatchObject({ code: "bad_request" });
    await bad({ message: "  " });
    await bad({ message: "a\0b" });
    await bad({ message: 5 });
    await bad({ paths: "a.txt" });
    await bad({ paths: ["../x"] });
    await bad({ paths: ["-x"] });
    await bad({ paths: ["/abs"] });
    await bad({ paths: [""] });
    await bad({ amend: "yes" });
    await bad({ push: 1 });
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

  it("the temp index file is gone after success", async () => {
    const { dir, inside } = repo();
    put(dir, "a.txt", "a1\n");
    await gitCommitFiles(dir, { paths: ["a.txt"], message: "m", allowed: inside });
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false);
    expect(readdirSync(join(dir, ".git")).filter((f) => f.includes("claude-ui-commit"))).toEqual([]);
  });
});
