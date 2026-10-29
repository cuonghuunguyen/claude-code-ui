// Create worktree modal, daemon side (GH-447): a new branch with `/`, base, checkout of an existing local or remote branch, the branch list.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree, listBranches, pullRequestBranches, removeWorktree } from "../src/git.ts";

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
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "wts-")));
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { code: string }).code);
/** A clone `main` of a bare origin with branches main and remote-only `feat/remote`; `s` pushes more. */
function origin() {
  const dir = tmp();
  run(dir, "init", "-q", "--bare", "-b", "main", "o.git");
  run(dir, "clone", "-q", "o.git", "s");
  const s = join(dir, "s");
  run(s, "checkout", "-q", "-b", "main");
  commit(s, "a.txt");
  commit(s, "b.txt");
  run(s, "push", "-q", "origin", "main");
  run(s, "checkout", "-q", "-b", "feat/remote");
  commit(s, "r.txt");
  run(s, "push", "-q", "origin", "feat/remote");
  run(s, "checkout", "-q", "main");
  run(dir, "clone", "-q", "o.git", "main");
  return { dir, s, main: join(dir, "main"), opts: { allowed: () => true, claudeDir: tmp() } };
}
const marked = (main: string, b: string) => out(main, "config", "--type=bool", "--get", `branch.${b}.claudeUiCreated`) === "true";

describe("createWorktree: a new branch named by the user", () => {
  it("branch feat/x: folder feat-x, marked, from the default base", async () => {
    const { main, opts } = origin();
    const r = await createWorktree(main, { ...opts, branch: "feat/x" });
    expect(r).toEqual({ path: join(main, ".claude", "worktrees", "feat-x"), branch: "feat/x" });
    expect(out(r.path, "branch", "--show-current")).toBe("feat/x");
    expect(marked(main, "feat/x")).toBe(true);
    expect(out(r.path, "rev-parse", "HEAD")).toBe(out(main, "rev-parse", "origin/main"));
  });

  it("an explicit base ref is the start point", async () => {
    const { main, opts } = origin();
    const r = await createWorktree(main, { ...opts, branch: "from-remote", base: "refs/remotes/origin/feat/remote" });
    expect(out(r.path, "rev-parse", "HEAD")).toBe(out(main, "rev-parse", "origin/feat/remote"));
  });

  it("refuses a leading -, an invalid ref, a too long folder; a taken folder or branch is exists", async () => {
    const { main, opts } = origin();
    expect(await code(createWorktree(main, { ...opts, branch: "-x" }))).toBe("bad_name");
    expect(await code(createWorktree(main, { ...opts, branch: "a..b" }))).toBe("bad_name");
    expect(await code(createWorktree(main, { ...opts, branch: `a/${"b".repeat(70)}` }))).toBe("bad_name");
    await createWorktree(main, { ...opts, branch: "feat/x" });
    // feat-x is taken as a folder by feat/x.
    expect(await code(createWorktree(main, { ...opts, branch: "feat-x" }))).toBe("exists");
    expect(await code(createWorktree(main, { ...opts, branch: "main" }))).toBe("exists");
  });
});

describe("createWorktree: checkout of an existing branch", () => {
  it("a remote-only branch becomes a local branch of the same name tracking it; not marked, kept on delete", async () => {
    const { main, opts } = origin();
    const r = await createWorktree(main, { ...opts, checkout: "refs/remotes/origin/feat/remote" });
    expect(r).toEqual({ path: join(main, ".claude", "worktrees", "feat-remote"), branch: "feat/remote" });
    expect(out(r.path, "branch", "--show-current")).toBe("feat/remote");
    expect(out(main, "rev-parse", "--abbrev-ref", "feat/remote@{upstream}")).toBe("origin/feat/remote");
    expect(marked(main, "feat/remote")).toBe(false);
    await removeWorktree(main, r.path, () => true);
    expect(out(main, "rev-parse", "--verify", "-q", "refs/heads/feat/remote")).not.toBe("");
  });

  it("a local branch is checked out as is", async () => {
    const { main, opts } = origin();
    run(main, "branch", "local-one");
    const r = await createWorktree(main, { ...opts, checkout: "refs/heads/local-one" });
    expect(out(r.path, "branch", "--show-current")).toBe("local-one");
    expect(marked(main, "local-one")).toBe(false);
  });

  it("a local branch whose folder name exceeds 64 characters is checked out in a cut folder, the branch name unchanged", async () => {
    const { main, opts } = origin();
    const branch = "feature/PROJ-351-support-repo-with-client/server-folder-structure-like-the-old-monorepo-layout";
    run(main, "branch", branch);
    const r = await createWorktree(main, { ...opts, checkout: `refs/heads/${branch}` });
    expect(r.branch).toBe(branch);
    expect(basename(r.path)).toBe("feature-PROJ-351-support-repo-with-client-server-folder");
    expect(out(r.path, "branch", "--show-current")).toBe(branch);
  });

  it("a branch checked out in another worktree, an unknown ref and a mixed request are refused; nothing is left", async () => {
    const { main, opts } = origin();
    expect(await code(createWorktree(main, { ...opts, checkout: "refs/heads/main" }))).toBe("exists");
    expect(await code(createWorktree(main, { ...opts, checkout: "refs/heads/nope" }))).toBe("bad_request");
    expect(await code(createWorktree(main, { ...opts, checkout: "main" }))).toBe("bad_request");
    expect(await code(createWorktree(main, { ...opts, checkout: "refs/heads/main", branch: "x" }))).toBe("bad_request");
    expect(out(main, "worktree", "list").split("\n")).toHaveLength(1);
  });
});

describe("listBranches", () => {
  it("lists local and remote branches merged by name, the worktree each is checked out in, and the default base", async () => {
    const { main, opts } = origin();
    run(main, "branch", "local-only");
    const wt = await createWorktree(main, { ...opts, branch: "in-wt" });
    const r = await listBranches(main, { allowed: () => true, claudeDir: opts.claudeDir });
    const by = Object.fromEntries(r.branches.map((b) => [b.name, b]));
    expect(by["main"]).toMatchObject({ local: true, remote: "refs/remotes/origin/main", worktree: main });
    expect(by["feat/remote"]).toMatchObject({ local: false, remote: "refs/remotes/origin/feat/remote" });
    expect(by["feat/remote"]!.worktree).toBeUndefined();
    expect(by["local-only"]).toMatchObject({ local: true });
    expect(by["local-only"]!.remote).toBeUndefined();
    expect(by["in-wt"]).toMatchObject({ local: true, worktree: wt.path });
    expect(r.branches.some((b) => b.name === "HEAD" || b.name.endsWith("/HEAD"))).toBe(false);
    expect(r.defaultBase).toBe("origin/main");
    expect(r.fetchError).toBeUndefined();
  });

  it("fetch: a branch pushed meanwhile shows; a deleted remote branch is pruned", async () => {
    const { s, main, opts } = origin();
    run(s, "checkout", "-q", "-b", "later");
    commit(s, "l.txt");
    run(s, "push", "-q", "origin", "later");
    run(s, "push", "-q", "origin", "--delete", "feat/remote");
    const before = await listBranches(main, { allowed: () => true, claudeDir: opts.claudeDir });
    expect(before.branches.map((b) => b.name)).not.toContain("later");
    const after = await listBranches(main, { allowed: () => true, claudeDir: opts.claudeDir, fetch: true });
    expect(after.fetched).toBe(true);
    expect(after.branches.map((b) => b.name)).toContain("later");
    expect(after.branches.map((b) => b.name)).not.toContain("feat/remote");
  });

  it("offline: the fetch fails, local refs are listed with fetchError", async () => {
    const { dir, main, opts } = origin();
    run(main, "remote", "set-url", "origin", join(dir, "gone.git"));
    const r = await listBranches(main, { allowed: () => true, claudeDir: opts.claudeDir, fetch: true });
    expect(r.fetchError).toBeTruthy();
    expect(r.branches.map((b) => b.name)).toContain("feat/remote");
  });

  it("refuses a repository outside the roots", async () => {
    const { main, opts } = origin();
    expect(await code(listBranches(main, { allowed: () => false, claudeDir: opts.claudeDir }))).toBe("cwd_not_allowed");
    expect(existsSync(main)).toBe(true);
  });
});

describe("pullRequestBranches: a pasted pull request link", () => {
  /** origin's configured URL is a GitHub address that `insteadOf` sends to the local bare repo; PR 5 heads at feat/remote. */
  function withPr() {
    const o = origin();
    const sha = out(o.s, "rev-parse", "feat/remote");
    run(join(o.dir, "o.git"), "update-ref", "refs/pull/5/head", sha);
    run(o.main, "remote", "set-url", "origin", "https://github.com/acme/app.git");
    run(o.main, "config", "url." + join(o.dir, "o.git") + ".insteadOf", "https://github.com/acme/app.git");
    return o;
  }
  it("names the origin branches at the pull request's head", async () => {
    const { main } = withPr();
    expect(await pullRequestBranches(main, "https://github.com/Acme/app/pull/5/files", { allowed: () => true })).toEqual({ number: 5, branches: ["feat/remote"] });
  });
  it("another repository, an unknown number, a host without refs, other text", async () => {
    const { main } = withPr();
    const o = { allowed: () => true };
    expect(await code(pullRequestBranches(main, "https://github.com/acme/other/pull/5", o))).toBe("pr_other_repo");
    expect(await code(pullRequestBranches(main, "https://github.com/acme/app/pull/6", o))).toBe("pr_not_found");
    expect(await code(pullRequestBranches(main, "https://github.com/acme/app/issues/5", o))).toBe("bad_request");
  });
});

describe("createWorktree: branch name edge cases", () => {
  it("createWorktree refuses a branch with @{", async () => {
    const { main, opts } = origin();
    expect(await code(createWorktree(main, { ...opts, branch: "a@{1}" }))).toBe("bad_name");
    expect(out(main, "branch", "--list", "a*")).toBe("");
  });

  it("createWorktree returns exists for a D/F conflict both ways", async () => {
    const { main, opts } = origin();
    run(main, "branch", "feat");
    const e = await createWorktree(main, { ...opts, branch: "feat/x" }).catch((x) => x as { code: string; message: string });
    expect(e).toMatchObject({ code: "exists" });
    expect((e as { message: string }).message).toContain("feat");
    run(main, "branch", "a/b");
    expect(await code(createWorktree(main, { ...opts, branch: "a" }))).toBe("exists");
    run(main, "branch", "feat2/y");
    expect(await code(createWorktree(main, { ...opts, branch: "feat2" }))).toBe("exists");
    run(main, "branch", "feat3-y");
    expect(await code(createWorktree(main, { ...opts, branch: "feat3" }))).toBe("ok");
  });

  it("listBranches does not mark a branch named like a detached worktree's short sha as in worktree", async () => {
    const { main, opts } = origin();
    const sha = out(main, "rev-parse", "HEAD");
    run(main, "worktree", "add", "-q", "--detach", join(main, ".claude", "worktrees", "d"), sha);
    run(main, "branch", sha.slice(0, 7));
    const rows = (await listBranches(main, { allowed: () => true, claudeDir: opts.claudeDir })).branches;
    expect(rows.find((r) => r.name === sha.slice(0, 7))?.worktree).toBeUndefined();
  });
});
