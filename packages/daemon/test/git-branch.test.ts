import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const HARD = ["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
const PUSH = [...HARD, "push", "--no-recurse-submodules", "--no-follow-tags"];
const pushes = () => {
  const calls: string[][] = [];
  setGitRunner((o) => (calls.push(o.args), threadRunner(o)));
  return calls;
};
afterEach(() => setGitRunner(undefined));
/**
 * Every test here runs dozens of git processes (submodules spawn more): ~15 s on Windows under a full suite, where a process start
 * is slow. A timed-out test also leaves its git calls running into the next test's `pushes()`, so the whole file gets the long timeout.
 */
const SPAWN_HEAVY = 120_000;
vi.setConfig({ testTimeout: SPAWN_HEAVY });

describe("gitBranch", () => {
  it("shows upstream, tracking, ahead/behind and the exact argv", async () => {
    const { a, inside } = diverged();
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    const tracking = sha(a, "origin/main");
    expect(i).toMatchObject({ ref: MAIN, local: sha(a), checkedOut: "here", remote: "origin", remoteRef: MAIN, tracking: "refs/remotes/origin/main", trackingHash: tracking, upstream: "origin/main", ahead: 1, behind: 1 });
    expect(i.push).toEqual([...PUSH, "origin", "refs/heads/main:refs/heads/main"]);
    expect(i.forcePush).toEqual([...PUSH, `--force-with-lease=refs/heads/main:${tracking}`, "origin", "refs/heads/main:refs/heads/main"]);
    expect(i.pull).toEqual([...HARD, "pull", "--no-recurse-submodules", "--no-rebase", "--ff-only", "origin", "refs/heads/main"]);
    expect(i.why).toBeUndefined();
  });

  it("a branch without upstream pushes with --set-upstream to origin; no pull, no force push", async () => {
    const { a, inside } = repos();
    run(a, "checkout", "-q", "-b", "feat");
    commit(a, "f1");
    const i = (await gitBranch(a, "refs/heads/feat", { allowed: inside }))!;
    expect(i.push).toEqual([...PUSH, "--set-upstream", "origin", "refs/heads/feat:refs/heads/feat"]);
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
    const r = await gitPush(a, { ref: MAIN, local: i.local, argv: i.push!, allowed: inside });
    expect(sha(bare, "main")).toBe(sha(a));
    expect(r?.refs).toBeTruthy();
  });

  it("a rejected push shows git's message", async () => {
    const { a, inside } = diverged();
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    const e = await gitPush(a, { ref: MAIN, local: i.local, argv: i.push!, allowed: inside }).then(() => undefined, (x: Error & { code?: string }) => x);
    expect(e).toMatchObject({ code: "git_failed" });
    expect(e!.message).toContain("[rejected]");
    expect(e!.message).toContain("non-fast-forward");
  });

  it("force push uses the lease: a wrong lease is refused before git runs, a stale one by git, the right one replaces the remote branch", async () => {
    const { a, b, bare, inside } = diverged();
    const calls = pushes();
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    await expect(gitPush(a, { ref: MAIN, local: i.local, argv: i.forcePush!, lease: sha(a, "HEAD~1"), allowed: inside })).rejects.toMatchObject({ code: "stale" });
    expect(calls.filter((c) => c.includes("push"))).toEqual([]);
    // The remote moves again and `a` has not fetched: its tracking ref is stale.
    commit(b, "b3");
    run(b, "push", "-q", "origin", "main");
    const e = await gitPush(a, { ref: MAIN, local: i.local, argv: i.forcePush!, lease: i.trackingHash, allowed: inside }).then(() => undefined, (x: Error) => x);
    expect(e).toMatchObject({ code: "stale", message: "The remote branch changed since the menu opened; fetch and retry" });
    expect(e!.message).not.toMatch(/stale info/);
    await gitFetch(a, { allowed: inside });
    const j = (await gitBranch(a, MAIN, { allowed: inside }))!;
    await gitPush(a, { ref: MAIN, local: j.local, argv: j.forcePush!, lease: j.trackingHash, allowed: inside });
    expect(sha(bare, "main")).toBe(sha(a));
  }, SPAWN_HEAVY);

  it("refuses a push when the local branch moved since the menu opened", async () => {
    const { a, inside } = repos();
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    commit(a, "a2");
    const calls = pushes();
    await expect(gitPush(a, { ref: MAIN, local: i.local, argv: i.push!, allowed: inside })).rejects.toMatchObject({ code: "stale" });
    await expect(gitPull(a, { ref: MAIN, local: i.local, argv: i.pull!, allowed: inside })).rejects.toMatchObject({ code: "stale" });
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
    await expect(gitPush(a, { ref: MAIN, local: i.local, argv: i.push!, allowed: (p) => p.startsWith(root) && inside(p) })).rejects.toMatchObject({ code: "remote_not_allowed" });
    expect(calls.filter((c) => c.includes("push"))).toEqual([]);
  });

  it("bad arguments are bad_request", async () => {
    const { a, inside } = repos();
    await expect(gitPush(a, { ref: "HEAD", local: sha(a), argv: [], allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitPush(a, { ref: MAIN, local: "nope", argv: [], allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitPush(a, { ref: MAIN, local: sha(a), argv: [], lease: "x", allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("gitPull", () => {
  it("fast-forwards the checked-out branch", async () => {
    const { a, b, inside } = repos();
    commit(b, "b2");
    run(b, "push", "-q", "origin", "main");
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    await gitPull(a, { ref: MAIN, local: i.local, argv: i.pull!, allowed: inside });
    expect(sha(a)).toBe(sha(b));
  });

  it("a diverged pull fails with git's message and leaves HEAD (pull.rebase is ignored)", async () => {
    const { a, inside } = diverged();
    run(a, "config", "pull.rebase", "true");
    const before = sha(a);
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    const e = await gitPull(a, { ref: MAIN, local: i.local, argv: i.pull!, allowed: inside }).then(() => undefined, (x: Error) => x);
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
    expect(i.pull).toEqual([...HARD, "fetch", "--no-recurse-submodules", "origin", "refs/heads/feat:refs/heads/feat"]);
    await gitPull(a, { ref: "refs/heads/feat", local: i.local, argv: i.pull!, allowed: inside });
    expect(sha(a, "feat")).toBe(sha(b));
    const wt = join(root, "wt");
    run(a, "worktree", "add", "-q", wt, "feat");
    const j = (await gitBranch(a, "refs/heads/feat", { allowed: inside }))!;
    expect(j.checkedOut).toBe(wt);
    expect(j.pull).toBeUndefined();
    expect(j.why?.pull).toContain(wt);
    await expect(gitPull(a, { ref: "refs/heads/feat", local: j.local, argv: [], allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
    // From the other worktree the same branch is "here".
    expect((await gitBranch(wt, "refs/heads/feat", { allowed: inside }))!.checkedOut).toBe("here");
  });
});

// ---- Review 4: submodules, the shown command, tags, hardening ----
const runF = (cwd: string, ...args: string[]) => run(cwd, "-c", "protocol.file.allow=always", ...args);
const tryRun = (cwd: string, ...args: string[]) => {
  try {
    return run(cwd, ...args);
  } catch (e) {
    return `ERR ${String(e)}`;
  }
};
/** A bare repository `sub.git` outside the roots with one commit, and a clone `s` of it. */
function outsideSub() {
  const out = realpathSync(mkdtempSync(join(tmpdir(), "gbr-out-")));
  run(out, "init", "-q", "--bare", "-b", "main", "sub.git");
  run(out, "clone", "-q", "sub.git", "s");
  const s = join(out, "s");
  commit(s, "s1");
  run(s, "push", "-q", "origin", "main");
  return { out, s, subGit: join(out, "sub.git") };
}
/** `a` has the submodule `sub` (remote outside the roots), and `b` bumped it on the remote: a pull would fetch the submodule from outside. */
function bumpedSubmodule() {
  const o = outsideSub();
  const r = repos();
  runF(r.b, "pull", "-q");
  runF(r.b, "submodule", "add", "-q", o.subGit, "sub");
  run(r.b, "commit", "-q", "-m", "add sub");
  run(r.b, "push", "-q", "origin", "main");
  runF(r.a, "pull", "-q");
  runF(r.a, "submodule", "update", "--init", "-q");
  commit(o.s, "s2");
  run(o.s, "push", "-q", "origin", "main");
  const s2 = sha(o.s);
  runF(join(r.b, "sub"), "pull", "-q", "origin", "main");
  run(r.b, "add", "sub");
  run(r.b, "commit", "-q", "-m", "bump");
  run(r.b, "push", "-q", "origin", "main");
  run(r.a, "fetch", "-q", "--no-recurse-submodules");
  return { ...r, ...o, s2 };
}

describe("remote operations never follow submodules (their remotes are outside the roots check)", () => {
  it("push with push.recurseSubmodules=on-demand does not push into a submodule remote outside the roots", async () => {
    const o = outsideSub();
    const { a, inside } = repos();
    runF(a, "submodule", "add", "-q", o.subGit, "sub");
    run(a, "commit", "-q", "-m", "add sub");
    run(a, "push", "-q", "origin", "main");
    commit(join(a, "sub"), "s2-local");
    const s2 = sha(join(a, "sub"));
    run(join(a, "sub"), "checkout", "-q", "--detach");
    run(a, "add", "sub");
    run(a, "commit", "-q", "-m", "bump sub");
    run(a, "config", "push.recurseSubmodules", "on-demand");
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    await gitPush(a, { ref: MAIN, local: i.local, argv: i.push!, allowed: inside }).catch(() => undefined);
    expect(tryRun(o.subGit, "cat-file", "-t", s2)).toMatch(/^ERR/);
  }, SPAWN_HEAVY);

  it("pull with submodule.recurse=true does not fetch a submodule from a folder outside the roots", async () => {
    const x = bumpedSubmodule();
    run(x.a, "config", "submodule.recurse", "true");
    const i = (await gitBranch(x.a, MAIN, { allowed: x.inside }))!;
    await gitPull(x.a, { ref: MAIN, local: i.local, argv: i.pull!, allowed: x.inside }).catch(() => undefined);
    expect(tryRun(join(x.a, "sub"), "cat-file", "-t", x.s2)).toMatch(/^ERR/);
  }, SPAWN_HEAVY);

  it("the fetch variant of pull (branch checked out nowhere) does not fetch submodules either", async () => {
    const x = bumpedSubmodule();
    run(x.a, "checkout", "-q", "--detach");
    // Without the switch these settings make `git fetch` follow the submodule.
    run(x.a, "config", "submodule.recurse", "true");
    run(x.a, "config", "fetch.recurseSubmodules", "yes");
    const i = (await gitBranch(x.a, MAIN, { allowed: x.inside }))!;
    expect(i.pull?.[4]).toBe("fetch");
    await gitPull(x.a, { ref: MAIN, local: i.local, argv: i.pull!, allowed: x.inside }).catch(() => undefined);
    expect(tryRun(join(x.a, "sub"), "cat-file", "-t", x.s2)).toMatch(/^ERR/);
  }, SPAWN_HEAVY);
});

describe("the command run is the command shown", () => {
  it("a changed push remote, --set-upstream or pull variant since the menu opened is refused as stale, nothing runs", async () => {
    const { root, a, inside } = repos();
    run(root, "init", "-q", "--bare", "-b", "main", "fork.git");
    run(a, "remote", "add", "fork", join(root, "fork.git"));
    run(a, "checkout", "-q", "-b", "feat");
    commit(a, "f1");
    const i = (await gitBranch(a, "refs/heads/feat", { allowed: inside }))!;
    const calls = pushes();
    run(a, "config", "remote.pushDefault", "fork");
    const stale = { code: "stale", message: "The command changed since the menu opened" };
    await expect(gitPush(a, { ref: "refs/heads/feat", local: i.local, argv: i.push!, allowed: inside })).rejects.toMatchObject(stale);
    run(a, "config", "--unset", "remote.pushDefault");
    // --set-upstream is dropped once an upstream exists.
    run(a, "config", "branch.feat.remote", "origin");
    run(a, "config", "branch.feat.merge", "refs/heads/feat");
    await expect(gitPush(a, { ref: "refs/heads/feat", local: i.local, argv: i.push!, allowed: inside })).rejects.toMatchObject(stale);
    // A pull shown as `pull` while the branch is no longer checked out here.
    const m = (await gitBranch(a, "refs/heads/feat", { allowed: inside }))!;
    run(a, "checkout", "-q", "main");
    await expect(gitPull(a, { ref: "refs/heads/feat", local: m.local, argv: m.pull!, allowed: inside })).rejects.toMatchObject(stale);
    expect(calls.filter((c) => c.includes("push") || c.includes("pull") || c.includes("fetch"))).toEqual([]);
  });

  it("a request without the shown command is bad_request", async () => {
    const { a, inside } = repos();
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    // @ts-expect-error argv is required
    await expect(gitPush(a, { ref: MAIN, local: i.local, allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
    // @ts-expect-error argv is required
    await expect(gitPull(a, { ref: MAIN, local: i.local, argv: "x", allowed: inside })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("what a push sends and runs", () => {
  it("push.followTags=true does not send tags the dialog did not show", async () => {
    const { a, bare, inside } = repos();
    commit(a, "c2");
    run(a, "tag", "-a", "-m", "t", "v9");
    run(a, "config", "push.followTags", "true");
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    await gitPush(a, { ref: MAIN, local: i.local, argv: i.push!, allowed: inside });
    expect(sha(bare, "main")).toBe(sha(a));
    expect(tryRun(bare, "rev-parse", "--verify", "-q", "refs/tags/v9")).toMatch(/^ERR/);
  });

  it("every argv carries Fetch's hardening prefix and the no-submodule, no-tags switches", async () => {
    const { a, b, inside } = diverged();
    void b;
    const i = (await gitBranch(a, MAIN, { allowed: inside }))!;
    const hard = HARD;
    expect(i.push).toEqual([...hard, "push", "--no-recurse-submodules", "--no-follow-tags", "origin", MAIN + ":" + MAIN]);
    expect(i.forcePush!.slice(0, 7)).toEqual([...hard, "push", "--no-recurse-submodules", "--no-follow-tags"]);
    expect(i.pull).toEqual([...hard, "pull", "--no-recurse-submodules", "--no-rebase", "--ff-only", "origin", MAIN]);
    const calls = pushes();
    await gitPull(a, { ref: MAIN, local: i.local, argv: i.pull!, allowed: inside }).catch(() => undefined);
    expect(calls.find((c) => c.includes("pull"))?.slice(0, 4)).toEqual(hard);
  });
});
