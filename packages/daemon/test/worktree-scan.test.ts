// Clean up scan (GH-461): the preview status in a few git processes, repo-wide facts once, squash/rebase merged worktrees as Safe, full check at removal.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { markWorktreeStale, parseStatusV2, removeWorktree, worktreeStatus } from "../src/git.ts";
import { setGitRunner, threadRunner, type GitRunOptions } from "../src/git-runner.ts";
import { gitSub } from "../src/perf.ts";

afterEach(() => setGitRunner(undefined));

const C = ["-c", "user.name=t", "-c", "user.email=t@t"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...C, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const gitOk = (cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args);
  } catch {
    return "";
  }
};
const commit = (cwd: string, file: string, text = file) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", file);
};
const allowed = () => true;

/** root/o.git (bare), root/r cloned from it with main pushed, origin/HEAD set; `.gitignore` ignores *.log. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wts-")));
  git(root, "init", "-q", "--bare", "-b", "main", "o.git");
  git(root, "clone", "-q", "o.git", "r");
  const main = join(root, "r");
  git(main, "checkout", "-q", "-b", "main");
  commit(main, ".gitignore", "*.log\n");
  commit(main, "a.txt", "one\n");
  git(main, "push", "-q", "-u", "origin", "main");
  git(main, "remote", "set-head", "origin", "main");
  return { root, main };
}
/** `<main>/.claude/worktrees/<name>` on a new branch `name`; `created` marks it a Created branch. */
function wt(main: string, name: string, o: { created?: boolean; detached?: boolean } = {}) {
  const path = join(main, ".claude", "worktrees", name);
  mkdirSync(join(main, ".claude", "worktrees"), { recursive: true });
  if (o.detached) git(main, "worktree", "add", "-q", "--detach", path);
  else git(main, "worktree", "add", "-q", "-b", name, path);
  if (o.created) git(main, "config", `branch.${name}.claudeUiCreated`, "true");
  return path;
}
const has = (main: string, branch: string) => gitOk(main, "rev-parse", "--verify", "-q", `refs/heads/${branch}`) !== "";
/** Squash-merges `branch` into main and pushes. */
function squash(main: string, branch: string) {
  git(main, "merge", "--squash", branch);
  git(main, "commit", "-qm", `squash ${branch}`);
  git(main, "push", "-q", "origin", "main");
}
const spy = () => {
  const calls: GitRunOptions[] = [];
  setGitRunner((o) => (calls.push(o), threadRunner(o)));
  return calls;
};

describe("parseStatusV2", () => {
  it("parseStatusV2: headers, renames with orig path, unmerged, untracked, ignored dirs not counted, cap", () => {
    const hdr = "# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -0\0";
    const out = `${hdr}1 .M N... 100644 100644 100644 h1 h2 a.txt\0` + `2 R. N... 100644 100644 100644 h1 h2 R100 new.txt\0old.txt\0` + `u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt\0` + "? new file\0! x.log\0! build/\0";
    expect(parseStatusV2(out)).toEqual({ detached: false, uncommitted: 4, untracked: 1, ignored: 1 });
    expect(parseStatusV2("# branch.oid abc\0# branch.head (detached)\0")).toEqual({ detached: true, uncommitted: 0, untracked: 0, ignored: 0 });
    // The old name of a rename is a field of its own and is never read as an entry.
    expect(parseStatusV2("2 R. N... 100644 100644 100644 h1 h2 R100 new\0? old\0")).toMatchObject({ uncommitted: 1, untracked: 0 });
    expect(parseStatusV2("")).toEqual({ detached: false, uncommitted: 0, untracked: 0, ignored: 0 });
    const many = parseStatusV2(Array.from({ length: 1500 }, (_, i) => `? f${i}`).join("\0") + "\0" + Array.from({ length: 1500 }, (_, i) => `! g${i}.log`).join("\0"));
    expect(many).toMatchObject({ uncommitted: 1000, untracked: 1000, ignored: 1000 });
  });
});

describe("preview status", () => {
  it("preview runs at most 3 git processes per worktree and the repo-wide reads once", async () => {
    const { main } = repo();
    const created = wt(main, "created-work", { created: true });
    commit(created, "c.txt");
    writeFileSync(join(created, "dirty.txt"), "x"); // uncommitted: no merge-tree
    writeFileSync(join(created, "x.log"), "ignored");
    const kept = wt(main, "kept");
    git(kept, "push", "-q", "-u", "origin", "kept");
    const detached = wt(main, "detached", { detached: true });
    const clean = wt(main, "clean-created", { created: true });
    const paths = [created, kept, detached, clean];

    const calls = spy();
    const first = await Promise.all(paths.map((p) => worktreeStatus(main, p, allowed)));
    const round1 = calls.splice(0);
    const sequential: Awaited<ReturnType<typeof worktreeStatus>>[] = [];
    for (const p of paths) sequential.push(await worktreeStatus(main, p, allowed));
    const round2 = calls.splice(0);
    const subs = (cs: GitRunOptions[], cwd?: string) => cs.filter((c) => !cwd || c.cwd === cwd).map((c) => gitSub(c.args));
    // Repo-wide reads: once for both rounds (the stamp did not change).
    for (const s of ["worktree", "config", "for-each-ref"]) expect(subs([...round1, ...round2]).filter((x) => x === s), s).toHaveLength(1);
    for (const cs of [round1, round2]) {
      expect(subs(cs)).not.toContain("log");
      expect(subs(cs)).not.toContain("symbolic-ref");
      expect(cs.some((c) => c.args.includes("--ignored=matching"))).toBe(false);
      // At most 3 processes per worktree; merge-tree is the only extra and none of these worktrees is clean with commits ahead.
      for (const p of paths) expect(subs(cs, p).length, p).toBeLessThanOrEqual(3);
    }
    expect(first.map((s) => s.branch)).toEqual(["created-work", "kept", expect.any(String), "clean-created"]);
    expect(first[0]).toMatchObject({ uncommitted: 1, untracked: 1, ahead: 1, createdBranch: true, safety: "has_work" });
    expect(first[0]!.ignored).toBeUndefined();
    expect(first[1]).toMatchObject({ safety: "safe", branchMerged: true });
    expect(first[1]!.createdBranch).toBeUndefined();
    expect(first[2]).toMatchObject({ safety: "safe" });
    expect(first[3]).toMatchObject({ safety: "safe", createdBranch: true });
    expect(sequential.map((s) => s.safety)).toEqual(first.map((s) => s.safety));
    // headTime comes from the reflog's file time.
    for (const s of first) expect(Date.now() - s.headTime!).toBeLessThan(120_000);
  });

  it("preview runs at most 3 git processes for one worktree: status, and rev-list for commits and ahead", async () => {
    const { main } = repo();
    const created = wt(main, "one", { created: true });
    commit(created, "c.txt");
    writeFileSync(join(created, "d.txt"), "d");
    await worktreeStatus(main, created, allowed); // facts warm
    markWorktreeStale(created); // a cached result would run no process
    const calls = spy();
    await worktreeStatus(main, created, allowed);
    expect(calls.filter((c) => c.cwd === created).map((c) => gitSub(c.args))).toEqual(["status", "rev-list", "rev-list"]);
    const kept = wt(main, "kept2");
    await worktreeStatus(main, kept, allowed);
    markWorktreeStale(kept);
    calls.length = 0;
    await worktreeStatus(main, kept, allowed);
    expect(calls.filter((c) => c.cwd === kept).map((c) => gitSub(c.args))).toEqual(["status", "rev-list"]);
  });

  it("a changed ref or config is seen by the next status: the repo-wide facts follow their stamp", async () => {
    const { main } = repo();
    const path = wt(main, "late");
    expect((await worktreeStatus(main, path, allowed)).createdBranch).toBeUndefined();
    git(main, "config", "branch.late.claudeUiCreated", "true");
    expect((await worktreeStatus(main, path, allowed)).createdBranch).toBe(true);
  });
});

describe("merged another way", () => {
  it("squash-merged clean worktree is safe with mergedInto; changed base lines keep it has_work; an uncommitted file keeps it has_work", async () => {
    const { main } = repo();
    const path = wt(main, "feat", { created: true });
    commit(path, "f.txt", "x\n");
    expect(await worktreeStatus(main, path, allowed)).toMatchObject({ ahead: 1, safety: "has_work" });
    squash(main, "feat");
    const merged = await worktreeStatus(main, path, allowed);
    expect(merged).toMatchObject({ safety: "safe", ahead: 1, mergedInto: "origin/main", uncommitted: 0 });
    // The same line changed on the base afterwards: the merge no longer equals the base.
    commit(main, "f.txt", "y\n");
    git(main, "push", "-q", "origin", "main");
    const changed = await worktreeStatus(main, path, allowed);
    expect(changed.safety).toBe("has_work");
    expect(changed.mergedInto).toBeUndefined();
    // Back to merged, then an untracked file.
    git(main, "reset", "-q", "--hard", "HEAD~1");
    git(main, "push", "-q", "-f", "origin", "main");
    expect((await worktreeStatus(main, path, allowed)).safety).toBe("safe");
    writeFileSync(join(path, "new.txt"), "n");
    markWorktreeStale(path); // an untracked file is in no fingerprint
    expect(await worktreeStatus(main, path, allowed)).toMatchObject({ safety: "has_work", uncommitted: 1 });
  });

  it("rebase-merged worktree (cherry-picked commits) is safe", async () => {
    const { main } = repo();
    const path = wt(main, "pick");
    commit(path, "p.txt", "p\n");
    commit(main, "m.txt", "m\n"); // another parent: the pick is a new commit, not the same one
    git(main, "cherry-pick", git(path, "rev-parse", "HEAD"));
    git(main, "push", "-q", "origin", "main");
    expect(await worktreeStatus(main, path, allowed)).toMatchObject({ safety: "safe", mergedInto: "origin/main", branchMerged: true });
  });

  it("merge-tree failure counts as not merged", async () => {
    const { main } = repo();
    const path = wt(main, "old");
    commit(path, "o.txt", "o\n");
    commit(main, "m.txt", "m\n"); // another parent: the pick is a new commit, not the same one
    git(main, "cherry-pick", git(path, "rev-parse", "HEAD"));
    git(main, "push", "-q", "origin", "main");
    setGitRunner((o) => (o.args.includes("merge-tree") ? Promise.reject(Object.assign(new Error("usage"), { code: 129, stderr: "usage: git merge-tree", killed: false })) : threadRunner(o)));
    const st = await worktreeStatus(main, path, allowed);
    expect(st.safety).toBe("has_work");
    expect(st.mergedInto).toBeUndefined();
    expect(st.branchMerged).toBe(false);
  });

  it("upstreamGone after the remote branch was deleted and pruned; safety unchanged", async () => {
    const { main } = repo();
    const path = wt(main, "gone");
    git(path, "push", "-q", "-u", "origin", "gone");
    const before = await worktreeStatus(main, path, allowed);
    expect(before.upstreamGone).toBeUndefined();
    git(main, "push", "-q", "origin", "--delete", "gone");
    git(main, "fetch", "-q", "--prune", "origin");
    const after = await worktreeStatus(main, path, allowed);
    expect(after.upstreamGone).toBe(true);
    expect(after.safety).toBe(before.safety);
  });
});

describe("removal", () => {
  it("commits that cancel out (add, then delete) are not merged: has_work, no mergedInto, a Created branch is not Safe, deleteBranch keeps a kept one", async () => {
    const { main } = repo();
    const created = wt(main, "net0", { created: true });
    commit(created, "secret.txt", "work\n");
    git(created, "rm", "-q", "secret.txt");
    git(created, "commit", "-qm", "undo");
    const kept = wt(main, "net0k");
    commit(kept, "secret2.txt", "work\n");
    git(kept, "rm", "-q", "secret2.txt");
    git(kept, "commit", "-qm", "undo");
    for (const p of [created, kept]) {
      const st = await worktreeStatus(main, p, allowed);
      expect(st).toMatchObject({ ahead: 2, safety: "has_work" });
      expect(st.mergedInto).toBeUndefined();
    }
    expect((await removeWorktree(main, kept, allowed, { deleteBranch: true })).branchKept).toBeTruthy();
    expect(has(main, "net0k")).toBe(true);
  });

  it("deleteBranch on a squash-merged kept branch deletes it with -D; an unmerged kept branch keeps it with -d (branchKept)", async () => {
    const { main } = repo();
    const merged = wt(main, "sq");
    commit(merged, "s.txt", "s\n");
    squash(main, "sq");
    const unmerged = wt(main, "um");
    commit(unmerged, "u.txt", "u\n");
    const calls = spy();
    const r1 = await removeWorktree(main, merged, allowed, { deleteBranch: true });
    expect(r1.branchKept).toBeUndefined();
    expect(has(main, "sq")).toBe(false);
    const r2 = await removeWorktree(main, unmerged, allowed, { deleteBranch: true });
    expect(r2.branchKept).toBeTruthy();
    expect(has(main, "um")).toBe(true);
    const del = calls.filter((c) => gitSub(c.args) === "branch").map((c) => c.args.filter((a) => a === "-D" || a === "-d")[0]);
    expect(del).toEqual(["-D", "-d"]);
  });

  it("removal full check counts ignored files, refuses stale only on expect.ignored when given, and reports ignoredDeleted", async () => {
    const { main } = repo();
    const path = wt(main, "ign");
    writeFileSync(join(path, "a.log"), "1");
    writeFileSync(join(path, "b.log"), "2");
    const preview = await worktreeStatus(main, path, allowed);
    expect(preview.ignored).toBeUndefined();
    await expect(removeWorktree(main, path, allowed, { expect: { uncommitted: 0, ahead: 0, ignored: 1 } })).rejects.toMatchObject({ code: "stale" });
    expect(statSync(path).isDirectory()).toBe(true);
    // Without `ignored` in expect the ignored files do not refuse; the count comes back.
    const r = await removeWorktree(main, path, allowed, { expect: { uncommitted: 0, ahead: 0 } });
    expect(r.ignoredDeleted).toBe(2);
    expect(gitOk(main, "worktree", "list")).not.toContain("ign");
  });
});
