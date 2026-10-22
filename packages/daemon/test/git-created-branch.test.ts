// Created branch (GH-447, ADR 0005): every branch claude-ui creates is marked `branch.<name>.claudeUiCreated = true`; removal deletes a marked branch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorktree, removeWorktree, worktreeStatus } from "../src/git.ts";

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
});
