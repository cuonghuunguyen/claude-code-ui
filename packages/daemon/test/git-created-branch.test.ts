// Created branch (GH-447, ADR 0005): every branch claude-ui creates is marked `branch.<name>.claudeUiCreated = true`; removal deletes a marked branch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktree, removeWorktree, worktreeStatus } from "../src/git.ts";
import { setGitRunner, threadRunner } from "../src/git-runner.ts";

afterEach(() => setGitRunner(undefined));
/** Fails the first `n` `config` writes of a key with git's lock message. */
const lockConfig = (n: number) => {
  let left = n;
  setGitRunner((o) => {
    if (left > 0 && o.args.includes("config") && o.args.some((a) => a.endsWith(".claudeUiCreated"))) {
      left--;
      return Promise.reject(Object.assign(new Error("Command failed"), { stderr: "error: could not lock config file .git/config: File exists", code: 255, killed: false }));
    }
    return threadRunner(o);
  });
};

const C = ["-c", "user.name=t", "-c", "user.email=t@t"];
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
const out = (cwd: string, ...args: string[]) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
const commit = (cwd: string, file: string) => {
  writeFileSync(join(cwd, file), file);
  run(cwd, "add", ".");
  run(cwd, ...C, "commit", "-qm", file);
};
const plain = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wtcb-")));
  run(dir, "init", "-q", "-b", "main", "r");
  const main = join(dir, "r");
  commit(main, "a.txt");
  return { main, opts: { allowed: () => true, claudeDir: realpathSync(mkdtempSync(join(tmpdir(), "wtcb-c-"))) } };
};
const marked = (main: string, branch: string) => out(main, "config", "--type=bool", "--get", `branch.${branch}.claudeUiCreated`) === "true";
const has = (main: string, branch: string) => out(main, "rev-parse", "--verify", "-q", `refs/heads/${branch}`) !== "";

describe("Created branch marker", () => {
  it("marks the branch of every create: a generated name and an explicit branch", async () => {
    const { main, opts } = plain();
    const gen = await createWorktree(main, opts);
    const named = await createWorktree(main, { ...opts, name: "feat-1", branch: "feat-1" });
    expect(marked(main, gen.branch)).toBe(true);
    expect(marked(main, named.branch)).toBe(true);
    expect(marked(main, "main")).toBe(false);
  });

  it("remove deletes a marked branch even with commits no other branch holds; a branch made outside claude-ui stays", async () => {
    const { main, opts } = plain();
    const r = await createWorktree(main, { ...opts, name: "fix", branch: "fix" });
    commit(r.path, "f.txt");
    await removeWorktree(main, r.path, () => true);
    expect(has(main, "fix")).toBe(false);
    // Its config section went with it.
    expect(out(main, "config", "--get-regexp", "^branch\\.fix\\.")).toBe("");
    const keep = join(main, ".claude", "worktrees", "keep");
    run(main, "worktree", "add", "-q", "-b", "keep", keep);
    await removeWorktree(main, keep, () => true);
    expect(has(main, "keep")).toBe(true);
  });

  it("status counts the commits of a marked branch (what removal loses) and does not call it merged", async () => {
    const { main, opts } = plain();
    const r = await createWorktree(main, { ...opts, name: "w", branch: "w" });
    commit(r.path, "1.txt");
    commit(r.path, "2.txt");
    expect(await worktreeStatus(main, r.path, () => true)).toMatchObject({ commits: 2, branchMerged: false, branch: "w", createdBranch: true });
    const keep = join(main, ".claude", "worktrees", "keep");
    run(main, "worktree", "add", "-q", "-b", "keep", keep);
    expect((await worktreeStatus(main, keep, () => true)).createdBranch).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("a held config.lock: retried; still held, the create succeeds without the marker and warns", async () => {
    const { main, opts } = plain();
    const lock = join(main, ".git", "config.lock");
    writeFileSync(lock, "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await createWorktree(main, { ...opts, name: "held", branch: "held" });
      expect(has(main, r.branch)).toBe(true);
      expect(marked(main, "held")).toBe(false);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("claudeUiCreated"))).toBe(true);
      // Released during the retries: marked.
      setTimeout(() => rmSync(lock, { force: true }), 120);
      writeFileSync(lock, "");
      await createWorktree(main, { ...opts, name: "later", branch: "later" });
      expect(marked(main, "later")).toBe(true);
    } finally {
      warn.mockRestore();
      rmSync(lock, { force: true });
    }
  });

  it("marker write retries a held config.lock and succeeds", async () => {
    const { main, opts } = plain();
    lockConfig(2);
    await createWorktree(main, { ...opts, name: "retry", branch: "retry" });
    expect(marked(main, "retry")).toBe(true);
  });

  it("marker write failing 5 times: create succeeds, warning logged, the branch is kept on remove", async () => {
    const { main, opts } = plain();
    lockConfig(5);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await createWorktree(main, { ...opts, name: "nomark", branch: "nomark" });
      expect(warn).toHaveBeenCalled();
      setGitRunner(undefined);
      await removeWorktree(main, r.path, () => true);
      expect(has(main, "nomark")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("rollback when onCreated throws on a remote checkout deletes the new tracking branch and the worktree, keeps the remote ref", async () => {
    const { main, opts } = plain();
    const o = join(realpathSync(mkdtempSync(join(tmpdir(), "wtcb-o-"))), "o.git");
    run(main, "init", "-q", "--bare", "-b", "main", o);
    run(main, "remote", "add", "origin", o);
    run(main, "push", "-q", "origin", "main");
    run(main, "branch", "x");
    run(main, "push", "-q", "origin", "x");
    run(main, "branch", "-D", "x");
    run(main, "fetch", "-q", "origin");
    await expect(
      createWorktree(main, {
        ...opts,
        checkout: "refs/remotes/origin/x",
        onCreated: () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
    expect(has(main, "x")).toBe(false);
    expect(out(main, "rev-parse", "--verify", "-q", "refs/remotes/origin/x")).not.toBe("");
    expect(out(main, "worktree", "list", "--porcelain").includes("worktrees")).toBe(false);
  });

  it("a worktree-* branch checked out through the Branch tab is marked false and survives removal", async () => {
    const { main, opts } = plain();
    run(main, "branch", "worktree-mine");
    const r = await createWorktree(main, { ...opts, checkout: "refs/heads/worktree-mine" });
    expect(out(main, "config", "--type=bool", "--get", "branch.worktree-mine.claudeUiCreated")).toBe("false");
    await removeWorktree(main, r.path, () => true);
    expect(has(main, "worktree-mine")).toBe(true);
    // A legacy worktree-* branch without a mark is still deleted.
    run(main, "worktree", "add", "-q", "-b", "worktree-old", join(main, ".claude", "worktrees", "old"));
    await removeWorktree(main, join(main, ".claude", "worktrees", "old"), () => true);
    expect(has(main, "worktree-old")).toBe(false);
  });
});
