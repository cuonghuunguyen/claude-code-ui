import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setGitRunner, threadRunner } from "../src/git-runner.ts";
import { gitBranch, gitFetch, gitPull, gitPush } from "../src/git-remote.ts";

const run = (cwd: string, ...args: string[]) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
};
const commit = (dir: string, m: string) => run(dir, "commit", "-q", "--allow-empty", "-m", m);
const sha = (dir: string, rev = "HEAD") => run(dir, "rev-parse", rev);

/** A bare remote r.git (local file path) and two clones a and b, all in one folder. */
function repos() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gbr-")));
  run(root, "init", "-q", "--bare", "-b", "main", "r.git");
  run(root, "clone", "-q", "r.git", "a");
  const a = join(root, "a");
  commit(a, "c1");
  run(a, "push", "-q", "-u", "origin", "main");
  run(root, "clone", "-q", "r.git", "b");
  const b = join(root, "b");
  const bare = join(root, "r.git");
  const inside = (p: string) => p.startsWith(root);
  return { root, a, b, bare, inside };
}
/** a has one local commit, the remote one from b, and a knows both: ahead 1, behind 1. */
function diverged() {
  const r = repos();
  commit(r.a, "a2");
  commit(r.b, "b2");
  run(r.b, "push", "-q", "origin", "main");
  run(r.a, "fetch", "-q", "origin");
  return r;
}
const MAIN = "refs/heads/main";
const pushes = () => {
  const calls: string[][] = [];
  setGitRunner((o) => (calls.push(o.args), threadRunner(o)));
  return calls;
};
afterEach(() => setGitRunner(undefined));

describe("gitBranch", () => {
  it("shows upstream, tracking, ahead/behind and the exact argv", async () => {
    const { a, inside } = diverged();
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    const tracking = sha(a, "origin/main");
    expect(i).toMatchObject({ ref: MAIN, local: sha(a), checkedOut: "here", remote: "origin", remoteRef: MAIN, tracking: "refs/remotes/origin/main", trackingHash: tracking, upstream: "origin/main", ahead: 1, behind: 1 });
    expect(i.push).toEqual(["push", "origin", "refs/heads/main:refs/heads/main"]);
    expect(i.forcePush).toEqual(["push", `--force-with-lease=refs/heads/main:${tracking}`, "origin", "refs/heads/main:refs/heads/main"]);
    expect(i.pull).toEqual(["pull", "--no-rebase", "--ff-only", "origin", "refs/heads/main"]);
    expect(i.why).toBeUndefined();
  });

  it("a branch without upstream pushes with --set-upstream to origin; no pull, no force push", async () => {
    const { a, inside } = repos();
    run(a, "checkout", "-q", "-b", "feat");
    commit(a, "f1");
    const i = (await gitBranch(a, "refs/heads/feat", { allowed: inside }))!;
    expect(i.push).toEqual(["push", "--set-upstream", "origin", "refs/heads/feat:refs/heads/feat"]);
    expect(i.pull).toBeUndefined();
    expect(i.why?.pull).toBe("No upstream branch");
    expect(i.forcePush).toBeUndefined();
    expect(i.why?.forcePush).toMatch(/fetch first/);
  });

  it("only local branches: HEAD, a sha, a tag, a remote branch and an unknown name are bad_request", async () => {
    const { a, inside } = repos();
    run(a, "tag", "t1");
    for (const ref of ["HEAD", sha(a), "refs/tags/t1", "refs/remotes/origin/main", "refs/heads/nope", "refs/heads/../x", "main", ""]) {
      await expect(gitBranch(a, ref, { allowed: inside }), ref).rejects.toMatchObject({ code: "bad_request" });
    }
  });

  it("is null outside a repository, refused outside the roots and for WSL paths", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "nogit-")));
    expect(await gitBranch(dir, MAIN, { allowed: () => true })).toBeNull();
    const { a } = repos();
    await expect(gitBranch(a, MAIN, { allowed: () => false })).rejects.toMatchObject({ code: "cwd_not_allowed" });
    await expect(gitBranch("\\\\wsl$\\Ubuntu\\home\\x", MAIN, { allowed: () => true })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("gitPush", () => {
  it("pushes a fast-forward", async () => {
    const { a, bare, inside } = repos();
    commit(a, "a2");
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    const r = await gitPush(a, { ref: MAIN, local: i.local, allowed: inside });
    expect(sha(bare, "main")).toBe(sha(a));
    expect(r?.refs).toBeTruthy();
  });

  it("a rejected push shows git's message", async () => {
    const { a, inside } = diverged();
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    const e = await gitPush(a, { ref: MAIN, local: i.local, allowed: inside }).then(() => undefined, (x: Error & { code?: string }) => x);
    expect(e).toMatchObject({ code: "git_failed" });
    expect(e!.message).toContain("[rejected]");
    expect(e!.message).toContain("non-fast-forward");
  });

  it("force push uses the lease: a wrong lease is refused before git runs, a stale one by git, the right one replaces the remote branch", async () => {
    const { a, b, bare, inside } = diverged();
    const calls = pushes();
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    await expect(gitPush(a, { ref: MAIN, local: i.local, lease: sha(a, "HEAD~1"), allowed: inside })).rejects.toMatchObject({ code: "stale" });
    expect(calls.filter((c) => c.includes("push"))).toEqual([]);
    // The remote moves again and `a` has not fetched: its tracking ref is stale.
    commit(b, "b3");
    run(b, "push", "-q", "origin", "main");
    const e = await gitPush(a, { ref: MAIN, local: i.local, lease: i.trackingHash, allowed: inside }).then(() => undefined, (x: Error) => x);
    expect(e).toMatchObject({ code: "git_failed" });
    expect(e!.message).toMatch(/stale info/);
    await gitFetch(a, { allowed: inside });
    const j = (await gitBranch(a, MAIN, { allowed: inside }))!;
    await gitPush(a, { ref: MAIN, local: j.local, lease: j.trackingHash, allowed: inside });
    expect(sha(bare, "main")).toBe(sha(a));
  });

  it("refuses a push when the local branch moved since the menu opened", async () => {
    const { a, inside } = repos();
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    commit(a, "a2");
    const calls = pushes();
    await expect(gitPush(a, { ref: MAIN, local: i.local, allowed: inside })).rejects.toMatchObject({ code: "stale" });
    await expect(gitPull(a, { ref: MAIN, local: i.local, allowed: inside })).rejects.toMatchObject({ code: "stale" });
    expect(calls.filter((c) => c.includes("push") || c.includes("pull"))).toEqual([]);
  });

  it("refuses a push to a folder remote outside the roots", async () => {
    const { a, root, inside } = repos();
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "outer-")));
    run(outer, "init", "-q", "--bare", "o.git");
    run(a, "config", "remote.origin.pushurl", join(outer, "o.git"));
    commit(a, "a2");
    const calls = pushes();
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    await expect(gitPush(a, { ref: MAIN, local: i.local, allowed: (p) => p.startsWith(root) && inside(p) })).rejects.toMatchObject({ code: "remote_not_allowed" });
    expect(calls.filter((c) => c.includes("push"))).toEqual([]);
  });

  it("bad arguments are bad_request", async () => {
    const { a, inside } = repos();
    await expect(gitPush(a, { ref: "HEAD", local: sha(a), allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitPush(a, { ref: MAIN, local: "nope", allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitPush(a, { ref: MAIN, local: sha(a), lease: "x", allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("gitPull", () => {
  it("fast-forwards the checked-out branch", async () => {
    const { a, b, inside } = repos();
    commit(b, "b2");
    run(b, "push", "-q", "origin", "main");
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    await gitPull(a, { ref: MAIN, local: i.local, allowed: inside });
    expect(sha(a)).toBe(sha(b));
  });

  it("a diverged pull fails with git's message and leaves HEAD (pull.rebase is ignored)", async () => {
    const { a, inside } = diverged();
    run(a, "config", "pull.rebase", "true");
    const before = sha(a);
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    const e = await gitPull(a, { ref: MAIN, local: i.local, allowed: inside }).then(() => undefined, (x: Error) => x);
    expect(e).toMatchObject({ code: "git_failed" });
    expect(e!.message).toMatch(/fast-forward/);
    expect(sha(a)).toBe(before);
  });

  it("a branch checked out nowhere is fast-forwarded by fetch; one checked out in another worktree is refused", async () => {
    const { root, a, b, inside } = repos();
    run(b, "checkout", "-q", "-b", "feat");
    commit(b, "f1");
    run(b, "push", "-q", "origin", "feat");
    run(a, "fetch", "-q", "origin");
    run(a, "branch", "-q", "--track", "feat", "origin/feat");
    commit(b, "f2");
    run(b, "push", "-q", "origin", "feat");
    const i = (await gitBranch(a, "refs/heads/feat", { allowed: inside }))!;
    expect(i.checkedOut).toBeUndefined();
    expect(i.pull).toEqual(["fetch", "origin", "refs/heads/feat:refs/heads/feat"]);
    await gitPull(a, { ref: "refs/heads/feat", local: i.local, allowed: inside });
    expect(sha(a, "feat")).toBe(sha(b));
    const wt = join(root, "wt");
    run(a, "worktree", "add", "-q", wt, "feat");
    const j = (await gitBranch(a, "refs/heads/feat", { allowed: inside }))!;
    expect(j.checkedOut).toBe(wt);
    expect(j.pull).toBeUndefined();
    expect(j.why?.pull).toContain(wt);
    await expect(gitPull(a, { ref: "refs/heads/feat", local: j.local, allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
    // From the other worktree the same branch is "here".
    expect((await gitBranch(wt, "refs/heads/feat", { allowed: inside }))!.checkedOut).toBe("here");
  });
});
