import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { worktreeNameError } from "@claude-ui/protocol";
import { createWorktree, gitDiff, gitDirsOf, gitEscapes, gitFileAt, gitLog, gitShow, gitStatus, gitRefs, limiter, listWorktrees, refsStamp, removeWorktree, worktreeStatus, classify } from "../src/git.ts";
import { setGitRunner, threadRunner, type GitRunOptions } from "../src/git-runner.ts";
import { wslGitRunner } from "../src/wsl-git.ts";
import { execFile } from "node:child_process";
import { afterEach } from "vitest";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

// Git for Windows takes 0.2-0.6 s per process; the multi-command tests here need far more than the 15 s default there.
if (process.platform === "win32") vi.setConfig({ testTimeout: 120_000 });

describe("gitStatus", () => {
  it("is null outside a git repository", async () => {
    expect(await gitStatus(mkdtempSync(join(tmpdir(), "nogit-")))).toBeNull();
  });

  it("returns the branch and the lines added and removed against HEAD, staged and unstaged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-"));
    run(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n");
    run(dir, "add", ".");
    run(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    expect(await gitStatus(dir)).toEqual({ branch: "main", added: 0, removed: 0, refs: expect.any(String) });
    writeFileSync(join(dir, "a.txt"), "1\nx\ny\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    run(dir, "add", "b.txt");
    expect(await gitStatus(dir)).toEqual({ branch: "main", added: 3, removed: 2, refs: expect.any(String) });
  });

  it("works before the first commit and on a detached HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-"));
    run(dir, "init", "-q", "-b", "dev");
    expect(await gitStatus(dir)).toEqual({ branch: "dev", added: 0, removed: 0, refs: expect.any(String) });
    writeFileSync(join(dir, "a.txt"), "1\n");
    run(dir, "add", ".");
    run(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    run(dir, "checkout", "-q", "--detach");
    expect((await gitStatus(dir))?.branch).toMatch(/^[0-9a-f]{7,}$/);
  });
});

describe("listWorktrees", () => {
  /** A repo on main with one commit and linked worktrees on branches a and b; real paths (tmpdir may be a symlink). */
  function repo() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-")));
    const main = join(dir, "main");
    run(dir, "init", "-q", "-b", "main", "main");
    writeFileSync(join(main, "a.txt"), "1\n");
    run(main, "add", ".");
    run(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    run(main, "worktree", "add", "-q", "-b", "b", join(dir, "wt-b"));
    run(main, "worktree", "add", "-q", "-b", "a", join(dir, "wt-a"));
    return { dir, main };
  }

  it("lists the main worktree first, then the linked ones, from the main and from a linked cwd", async () => {
    const { dir, main } = repo();
    const expected = [
      { path: main, branch: "main", main: true },
      { path: join(dir, "wt-a"), branch: "a", main: false },
      { path: join(dir, "wt-b"), branch: "b", main: false },
    ];
    expect(await listWorktrees(main)).toEqual(expected);
    expect(await listWorktrees(join(dir, "wt-a"))).toEqual(expected);
  });

  it("labels a detached HEAD by its short hash and leaves out a worktree whose directory was deleted", async () => {
    const { dir, main } = repo();
    run(join(dir, "wt-a"), "checkout", "-q", "--detach");
    rmSync(join(dir, "wt-b"), { recursive: true });
    const list = await listWorktrees(main);
    expect(list?.map((w) => w.path)).toEqual([main, join(dir, "wt-a")]);
    expect(list?.[1].branch).toMatch(/^[0-9a-f]{7}$/);
  });

  it.runIf(process.platform !== "win32")("reads a worktree path that holds a newline", async () => {
    const { dir, main } = repo();
    const odd = join(dir, "line\nbreak");
    run(main, "worktree", "add", "-q", "-b", "odd", odd);
    expect((await listWorktrees(main))?.find((w) => w.branch === "odd")?.path).toBe(odd);
  });

  it.runIf(process.platform !== "win32")("falls back to the newline format on a git without worktree list -z (before 2.36)", async () => {
    const { dir, main } = repo();
    // A git that rejects -z like git 2.35 does and runs the real one otherwise.
    const bin = mkdtempSync(join(tmpdir(), "oldgit-"));
    const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = -z ] && { echo "error: unknown switch \\\`z'" >&2; exit 129; }; done\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      expect(await listWorktrees(main)).toEqual([
        { path: main, branch: "main", main: true },
        { path: join(dir, "wt-a"), branch: "a", main: false },
        { path: join(dir, "wt-b"), branch: "b", main: false },
      ]);
      expect(await listWorktrees(mkdtempSync(join(tmpdir(), "nogit-")))).toBeNull();
    } finally {
      process.env.PATH = path;
    }
  });

  it("is null outside a git repository", async () => {
    expect(await listWorktrees(mkdtempSync(join(tmpdir(), "nogit-")))).toBeNull();
  });
});

describe("createWorktree / removeWorktree / worktreeStatus", () => {
  const C = ["-c", "user.name=t", "-c", "user.email=t@t"];
  const out = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    run(cwd, "add", ".");
    run(cwd, ...C, "commit", "-qm", file);
  };
  const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "wtc-")));
  /** A clone `main` of a bare origin (origin/HEAD known), the seed clone `s` to push more commits from. */
  function origin() {
    const dir = tmp();
    run(dir, "init", "-q", "--bare", "-b", "main", "o.git");
    run(dir, "clone", "-q", "o.git", "s");
    const s = join(dir, "s");
    run(s, "checkout", "-q", "-b", "main");
    commit(s, "a.txt");
    run(s, "push", "-q", "origin", "main");
    run(dir, "clone", "-q", "o.git", "main");
    return { dir, s, main: join(dir, "main"), opts: { allowed: () => true, claudeDir: tmp() } };
  }
  const plain = () => {
    const dir = tmp();
    run(dir, "init", "-q", "-b", "main", "r");
    commit(join(dir, "r"), "a.txt");
    commit(join(dir, "r"), "b.txt");
    return { main: join(dir, "r"), opts: { allowed: () => true, claudeDir: tmp() } };
  };
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { code: string }).code);

  it("creates <repo>/.claude/worktrees/<name> on worktree-<name> from origin/<default> after a fetch", async () => {
    const { s, main, opts } = origin();
    commit(s, "second.txt");
    run(s, "push", "-q", "origin", "main");
    const r = await createWorktree(main, { ...opts, name: "feat" });
    expect(r).toEqual({ path: join(main, ".claude", "worktrees", "feat"), branch: "worktree-feat" });
    expect(out(r.path, "rev-parse", "HEAD")).toBe(out(s, "rev-parse", "HEAD"));
    expect(() => out(main, "config", "branch.worktree-feat.remote")).toThrow();
    await createWorktree(main, { ...opts, name: "two" });
    const lines = readFileSync(join(main, ".git", "info", "exclude"), "utf8").split("\n").filter((l) => l === "/.claude/worktrees/");
    expect(lines).toHaveLength(1);
    expect(out(main, "status", "--porcelain")).toBe("");
  });

  it("without a name generates <adjective>-<noun>", async () => {
    const { main, opts } = plain();
    const r = await createWorktree(main, opts);
    expect(r.path).toMatch(/\.claude[\\/]worktrees[\\/][a-z]+-[a-z]+$/);
    expect(r.branch).toBe(`worktree-${r.path.split(/[\\/]/).pop()}`);
  });

  it("branches from HEAD without origin and when worktree.baseRef is head", async () => {
    const p = plain();
    const r = await createWorktree(p.main, { ...p.opts, name: "x" });
    expect(out(r.path, "rev-parse", "HEAD")).toBe(out(p.main, "rev-parse", "HEAD"));
    const o = origin();
    mkdirSync(join(o.main, ".claude"));
    writeFileSync(join(o.main, ".claude", "settings.json"), JSON.stringify({ worktree: { baseRef: "head" } }));
    commit(o.main, "local.txt");
    const r2 = await createWorktree(o.main, { ...o.opts, name: "h" });
    expect(out(r2.path, "rev-parse", "HEAD")).toBe(out(o.main, "rev-parse", "HEAD"));
  });

  it("falls back to the local origin/<default> when the fetch fails", async () => {
    const o = origin();
    const before = out(o.main, "rev-parse", "origin/main");
    commit(o.main, "local.txt");
    rmSync(join(o.dir, "o.git"), { recursive: true });
    const r = await createWorktree(o.main, { ...o.opts, name: "off" });
    expect(out(r.path, "rev-parse", "HEAD")).toBe(before);
  });

  it("refuses bad names with the CLI rule and an existing name or branch with exists", async () => {
    const { main, opts } = plain();
    for (const name of ["a b", "../x", ".", ".git", "x".repeat(65), "x.lock", ""]) expect(await code(createWorktree(main, { ...opts, name })), name).toBe("bad_name");
    await createWorktree(main, { ...opts, name: "feat" });
    expect(await code(createWorktree(main, { ...opts, name: "feat" }))).toBe("exists");
    run(main, "branch", "worktree-other");
    expect(await code(createWorktree(main, { ...opts, name: "other" }))).toBe("exists");
    expect(await code(createWorktree(main, { ...opts, name: "x", base: "nope" }))).toBe("bad_base");
    expect(out(main, "worktree", "list").split("\n")).toHaveLength(2);
  });

  it("an explicit branch and base: <repo>/.claude/worktrees/<name> on that branch at that commit", async () => {
    const { main, opts } = plain();
    const r = await createWorktree(main, { ...opts, name: "feat-1", branch: "feat-1", base: "main~1" });
    expect(r).toEqual({ path: join(main, ".claude", "worktrees", "feat-1"), branch: "feat-1" });
    expect(out(r.path, "rev-parse", "HEAD")).toBe(out(main, "rev-parse", "main~1"));
    expect(await code(createWorktree(main, { ...opts, name: "feat-1", branch: "feat-1" }))).toBe("exists");
    expect(await code(createWorktree(main, { ...opts, name: "feat-2", branch: "feat-2", base: "nope" }))).toBe("bad_base");
    expect(out(main, "worktree", "list").split("\n")).toHaveLength(2);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a failed git worktree add leaves no branch behind", async () => {
    const { main, opts } = plain();
    const dir = join(main, ".claude", "worktrees");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o555);
    try {
      expect(await code(createWorktree(main, { ...opts, name: "x", branch: "x" }))).toBe("git_failed");
      expect(out(main, "branch", "--list", "x")).toBe("");
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  /** Runs `hook` (sh, with $GIT = the real git) before every git call whose arguments match `pattern`; returns the restore function. */
  const wrapGit = (pattern: string, hook: string) => {
    const bin = mkdtempSync(join(tmpdir(), "wrapgit-"));
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\nGIT=${realGit}\ncase "$*" in *"${pattern}"*) ${hook};; esac\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    return () => void (process.env.PATH = path);
  };

  it.skipIf(process.platform === "win32")("a branch a user creates after the checks survives: exists, nothing deleted", async () => {
    const { main, opts } = plain();
    const restore = wrapGit("branch --no-track", `$GIT -C ${main} branch userbr main~1`);
    try {
      expect(await code(createWorktree(main, { ...opts, name: "userbr", branch: "userbr" }))).toBe("exists");
    } finally {
      restore();
    }
    expect(out(main, "rev-parse", "userbr")).toBe(out(main, "rev-parse", "main~1"));
    expect(existsSync(join(main, ".claude", "worktrees", "userbr"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("a failed add keeps the branch when another worktree has it checked out", async () => {
    const { main, opts } = plain();
    const other = join(tmp(), "other");
    const restore = wrapGit("worktree add", `$GIT -C ${main} worktree add -q ${other} chk`);
    try {
      expect(await code(createWorktree(main, { ...opts, name: "chk", branch: "chk" }))).not.toBe("ok");
    } finally {
      restore();
    }
    expect(out(main, "branch", "--list", "chk")).toContain("chk");
    expect(existsSync(join(main, ".claude", "worktrees", "chk"))).toBe(false);
  });

  it("onCreated gets the path and branch of the ready worktree; when it throws, the worktree and branch are removed and the error reaches the caller", async () => {
    const { main, opts } = plain();
    let seen: { path: string; branch: string; dir: boolean } | undefined;
    const r = await createWorktree(main, { ...opts, name: "z", branch: "z", onCreated: (x) => (seen = { ...x, dir: existsSync(x.path) }) });
    expect(seen).toEqual({ ...r, dir: true });
    await expect(createWorktree(main, { ...opts, name: "y", branch: "y", onCreated: () => { throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(existsSync(join(main, ".claude", "worktrees", "y"))).toBe(false);
    expect(out(main, "branch", "--list", "y")).toBe("");
    expect(out(main, "worktree", "list").split("\n")).toHaveLength(2);
  });

  it("two concurrent creates with the same name: one succeeds, the other gets exists", async () => {
    const { main, opts } = origin();
    const r = await Promise.allSettled([createWorktree(main, { ...opts, name: "dup" }), createWorktree(main, { ...opts, name: "dup" })]);
    expect(r.map((x) => x.status).sort()).toEqual(["fulfilled", "rejected"]);
    const reason = (r.find((x) => x.status === "rejected") as PromiseRejectedResult).reason as { code: string; message: string };
    expect(reason.code).toBe("exists");
    // Serialized: the second create saw the first one's branch before it ran git (unserialized it would fail inside `git worktree add`).
    expect(reason.message).toBe("Branch worktree-dup already exists");
  });

  it.skipIf(process.platform === "win32")("refuses when .claude or .claude/worktrees links outside the repository", async () => {
    const { main, opts } = plain();
    const outside = tmp();
    symlinkSync(outside, join(main, ".claude"));
    expect(await code(createWorktree(main, { ...opts, name: "x" }))).toBe("cwd_not_allowed");
    expect(existsSync(join(outside, "worktrees"))).toBe(false);
    rmSync(join(main, ".claude"));
    mkdirSync(join(main, ".claude"));
    symlinkSync(outside, join(main, ".claude", "worktrees"));
    expect(await code(createWorktree(main, { ...opts, name: "x" }))).toBe("cwd_not_allowed");
    expect(existsSync(join(outside, "x"))).toBe(false);
  });

  it("refuses a repository or a new path the allowed predicate rejects", async () => {
    const { main, opts } = plain();
    expect(await code(createWorktree(main, { ...opts, allowed: () => false, name: "x" }))).toBe("cwd_not_allowed");
    expect(existsSync(join(main, ".claude"))).toBe(false);
    expect(await code(createWorktree(main, { ...opts, allowed: (p) => p === main, name: "x" }))).toBe("cwd_not_allowed");
    expect(out(main, "branch", "--list", "worktree-x")).toBe("");
  });

  it.skipIf(process.platform === "win32")("symlinks worktree.symlinkDirectories inside the repository and skips the rest", async () => {
    const { main, opts } = plain();
    mkdirSync(join(main, "node_modules"));
    writeFileSync(join(main, "node_modules", "x"), "x");
    const outside = tmp();
    symlinkSync(outside, join(main, "sneaky"));
    mkdirSync(join(main, ".claude"));
    writeFileSync(join(main, ".claude", "settings.json"), JSON.stringify({ worktree: { symlinkDirectories: ["node_modules", "../escape", "missing", "/etc", 5, "sneaky"] } }));
    const r = await createWorktree(main, { ...opts, name: "s" });
    expect(lstatSync(join(r.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(r.path, "node_modules"))).toBe(join(main, "node_modules"));
    expect(existsSync(join(r.path, "missing"))).toBe(false);
    // A repository entry that is itself a link out is not followed.
    expect(existsSync(join(r.path, "sneaky"))).toBe(false);
    expect(existsSync(join(r.path, "..", "escape"))).toBe(false);
    // Removing the worktree does not follow the link: the repository's node_modules stays.
    await removeWorktree(main, r.path, () => true);
    expect(existsSync(join(main, "node_modules", "x"))).toBe(true);
  });

  it("removes the directory and its worktree-* branch; a foreign branch stays; main and unknown worktrees are refused", async () => {
    const { main, opts } = plain();
    const r = await createWorktree(main, { ...opts, name: "feat" });
    commit(r.path, "c.txt");
    writeFileSync(join(r.path, "untracked.txt"), "u");
    await removeWorktree(main, r.path, () => true);
    expect(existsSync(r.path)).toBe(false);
    expect(await code(Promise.resolve().then(() => out(main, "rev-parse", "--verify", "refs/heads/worktree-feat")))).not.toBe("ok");
    expect(out(main, "worktree", "list").split("\n")).toHaveLength(1);
    // A foreign branch inside .claude/worktrees: directory gone, branch kept.
    const keep = join(main, ".claude", "worktrees", "keep");
    run(main, "worktree", "add", "-q", "-b", "keep", keep);
    await removeWorktree(main, keep, () => true);
    expect(existsSync(keep)).toBe(false);
    expect(out(main, "rev-parse", "--verify", "refs/heads/keep")).not.toBe("");
    expect(await code(removeWorktree(main, main, () => true))).toBe("not_worktree");
    expect(await code(removeWorktree(main, tmp(), () => true))).toBe("not_worktree");
  });

  it("removes any linked worktree inside the roots (hand-made sibling, nested, another tool's folder) and keeps their branches", async () => {
    const { main, opts } = plain();
    const hand = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "hand", hand);
    const nested = join(main, ".claude", "worktrees", "a", "b");
    run(main, "worktree", "add", "-q", "-b", "nest", nested);
    const other = join(main, ".claude", "other");
    run(main, "worktree", "add", "-q", "-b", "other", other);
    // A worktree outside the roots is refused by the predicate.
    const r = await createWorktree(main, { ...opts, name: "ok" });
    expect(await code(removeWorktree(main, r.path, () => false))).toBe("cwd_not_allowed");
    expect(existsSync(r.path)).toBe(true);
    for (const d of [hand, nested, other]) {
      await removeWorktree(main, d, () => true);
      expect(existsSync(d), d).toBe(false);
    }
    for (const b of ["hand", "nest", "other"]) expect(out(main, "branch", "--list", b)).toContain(b);
  });

  it("listWorktrees and removeWorktree: a locked worktree is listed locked and refused", async () => {
    const { main } = plain();
    const hand = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "hand", hand);
    run(main, "worktree", "lock", "--reason", "usb", hand);
    expect((await listWorktrees(main))!.find((w) => w.path === hand)).toMatchObject({ locked: true });
    expect(await code(removeWorktree(main, hand, () => true))).toBe("not_removable");
    expect(await worktreeStatus(main, hand, () => true)).toMatchObject({ safety: "blocked", blocked: "locked" });
    expect(existsSync(hand)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("refuses to remove through a symlink that points out of .claude/worktrees", async () => {
    const { main, opts } = plain();
    const hand = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "hand", hand);
    const dir = join(main, ".claude", "worktrees");
    mkdirSync(dir, { recursive: true });
    symlinkSync(hand, join(dir, "link"));
    expect(await code(removeWorktree(main, join(dir, "link"), () => true))).toBe("not_removable");
    expect(await worktreeStatus(main, join(dir, "link"), () => true)).toMatchObject({ safety: "blocked", blocked: "symlink" });
    expect(existsSync(hand)).toBe(true);
    void opts;
  });

  it("removeWorktree deletes only worktree-* branches (a managed worktree on a foreign branch keeps it; others stay)", async () => {
    const { main, opts } = plain();
    const a = await createWorktree(main, { ...opts, name: "a" });
    run(main, "branch", "worktree-b");
    await removeWorktree(main, a.path, () => true);
    expect(out(main, "branch", "--list", "worktree-b")).toContain("worktree-b");
    expect(out(main, "branch", "--list", "main")).toContain("main");
    expect(out(main, "branch", "--list", "worktree-a")).toBe("");
  });

  it("worktreeStatus counts uncommitted files and the commits only this branch holds", async () => {
    const { main, opts } = origin();
    const r = await createWorktree(main, { ...opts, name: "feat" });
    const all = () => true;
    expect(await worktreeStatus(main, r.path, all)).toMatchObject({ uncommitted: 0, untracked: 0, commits: 0, ahead: 0, branch: "worktree-feat", safety: "safe" });
    commit(r.path, "1.txt");
    commit(r.path, "2.txt");
    writeFileSync(join(r.path, "a.txt"), "changed");
    writeFileSync(join(r.path, "new.txt"), "n");
    const st = await worktreeStatus(main, r.path, all);
    expect(st).toMatchObject({ uncommitted: 2, untracked: 1, commits: 2, ahead: 2, safety: "has_work" });
    expect(st.headTime).toBeGreaterThan(0);
    const keep = join(main, ".claude", "worktrees", "keep");
    run(main, "worktree", "add", "-q", "-b", "keep", keep);
    commit(keep, "k.txt");
    expect(await worktreeStatus(main, keep, all)).toMatchObject({ uncommitted: 0, commits: 0, ahead: 1, branch: "keep", safety: "has_work" });
  });

  it("worktreeStatus: a kept branch with unpushed commits has work; pushed to its upstream it is safe; merged into base it is branchMerged", async () => {
    const { main } = origin();
    run(main, "remote", "set-head", "origin", "main");
    const ext = join(tmp(), "ext");
    run(main, "worktree", "add", "-q", "-b", "feat", ext);
    commit(ext, "f.txt");
    const all = () => true;
    expect(await worktreeStatus(main, ext, all)).toMatchObject({ ahead: 1, safety: "has_work", branchMerged: false });
    run(ext, "push", "-q", "-u", "origin", "feat");
    expect(await worktreeStatus(main, ext, all)).toMatchObject({ ahead: 0, safety: "safe", branchMerged: true });
    const done = join(tmp(), "done");
    run(main, "worktree", "add", "-q", "-b", "done", done);
    expect(await worktreeStatus(main, done, all)).toMatchObject({ ahead: 0, safety: "safe", branchMerged: true });
  });

  it.skipIf(process.platform === "win32")("worktreeStatus never runs a worktree's fsmonitor program", async () => {
    const { main } = plain();
    const wt = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "fsm", wt);
    run(main, "config", "extensions.worktreeConfig", "true");
    const marker = join(tmp(), "marker");
    const script = join(tmp(), "fsm.sh");
    writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    run(wt, "config", "--worktree", "core.fsmonitor", script);
    expect(await worktreeStatus(main, wt, () => true)).toMatchObject({ safety: "safe" });
    expect(existsSync(marker)).toBe(false);
  });

  it("worktreeStatus of a worktree whose git dirs are outside the roots runs no git and is blocked outside_roots", async () => {
    const { main } = plain();
    const wt = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "far", wt);
    writeFileSync(join(wt, "u.txt"), "u");
    const st = await worktreeStatus(main, wt, (p) => !p.startsWith(main));
    expect(st).toMatchObject({ safety: "blocked", blocked: "outside_roots", uncommitted: 0 });
    expect(await code(removeWorktree(main, wt, (p) => !p.startsWith(main)))).toBe("cwd_not_allowed");
    expect(existsSync(wt)).toBe(true);
  });

  it("a worktree that contains another listed worktree is blocked contains_worktree and refused; the inner work stays", async () => {
    const { main } = plain();
    const outer = join(tmp(), "outer");
    run(main, "worktree", "add", "-q", "-b", "outer", outer);
    const inner = join(outer, "inner");
    run(main, "worktree", "add", "-q", "-b", "inner", inner);
    writeFileSync(join(inner, "work.txt"), "precious");
    expect(await worktreeStatus(main, outer, () => true)).toMatchObject({ safety: "blocked", blocked: "contains_worktree" });
    expect(await code(removeWorktree(main, outer, () => true))).toBe("not_removable");
    expect(readFileSync(join(inner, "work.txt"), "utf8")).toBe("precious");
    // The inner one is removable itself, then the outer one too.
    await removeWorktree(main, inner, () => true);
    expect(await worktreeStatus(main, outer, () => true)).toMatchObject({ safety: "safe" });
  });

  it("worktreeStatus ahead counts a local-only commit of a kept branch when there is no origin/HEAD, main, master or upstream", async () => {
    const dir = tmp();
    run(dir, "init", "-q", "-b", "trunk", "r");
    const main = join(dir, "r");
    commit(main, "a.txt");
    const wt = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "feat", wt);
    expect(await worktreeStatus(main, wt, () => true)).toMatchObject({ ahead: 0, safety: "safe" });
    commit(wt, "f.txt");
    expect(await worktreeStatus(main, wt, () => true)).toMatchObject({ ahead: 1, safety: "has_work" });
  });

  it("worktreeStatus counts ignored files but not ignored directories git reports whole", async () => {
    const { main } = plain();
    writeFileSync(join(main, ".gitignore"), "*.log\nbuild/\n");
    run(main, "add", ".");
    run(main, ...C, "commit", "-qm", "ignore");
    const wt = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "ig", wt);
    mkdirSync(join(wt, "build"));
    writeFileSync(join(wt, "build", "o.js"), "x");
    expect(await worktreeStatus(main, wt, () => true)).toMatchObject({ ignored: 0, uncommitted: 0, safety: "safe" });
    writeFileSync(join(wt, "a.log"), "x");
    expect(await worktreeStatus(main, wt, () => true)).toMatchObject({ ignored: 1, uncommitted: 0, safety: "safe" });
  });

  it("removeWorktree expect refuses stale when more work exists than listed, also after beforeRemove ran", async () => {
    const { main } = plain();
    const wt = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "ex", wt);
    writeFileSync(join(wt, "u.txt"), "u");
    const listed = { uncommitted: 1, ahead: 0, ignored: 0 };
    // Unchanged since the list: removed.
    const wt2 = join(tmp(), "wt2");
    run(main, "worktree", "add", "-q", "-b", "ex2", wt2);
    writeFileSync(join(wt2, "u.txt"), "u");
    await removeWorktree(main, wt2, () => true, { expect: listed });
    expect(existsSync(wt2)).toBe(false);
    // More work than listed.
    writeFileSync(join(wt, "v.txt"), "v");
    const before = vi.fn(async () => {});
    expect(await code(removeWorktree(main, wt, () => true, { expect: listed, beforeRemove: before }))).toBe("stale");
    expect(before).not.toHaveBeenCalled();
    rmSync(join(wt, "v.txt"));
    // A shell writes while the sessions and terminals close.
    expect(await code(removeWorktree(main, wt, () => true, { expect: listed, beforeRemove: async () => void writeFileSync(join(wt, "late.txt"), "l") }))).toBe("stale");
    expect(existsSync(join(wt, "late.txt"))).toBe(true);
  });

  it("classify: blocked beats has_work beats safe", () => {
    const z = { uncommitted: 0, untracked: 0, commits: 0, ahead: 0, ignored: 0, branch: "b", branchMerged: false, running: 0 };
    expect(classify(z).safety).toBe("safe");
    expect(classify({ ...z, ahead: 1 }).safety).toBe("has_work");
    expect(classify({ ...z, uncommitted: 1, blocked: "removing" }).safety).toBe("blocked");
  });

  it("removeWorktree expectSafe refuses with stale once the worktree has work", async () => {
    const { main } = plain();
    const wt = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "st", wt);
    writeFileSync(join(wt, "u.txt"), "u");
    const before = vi.fn(async () => {});
    expect(await code(removeWorktree(main, wt, () => true, { expectSafe: true, beforeRemove: before }))).toBe("stale");
    expect(existsSync(wt)).toBe(true);
    expect(before).not.toHaveBeenCalled();
    rmSync(join(wt, "u.txt"));
    await removeWorktree(main, wt, () => true, { expectSafe: true, beforeRemove: before });
    expect(existsSync(wt)).toBe(false);
  });

  it("removeWorktree deleteBranch deletes a merged kept branch with -d and keeps an unmerged one", async () => {
    const { main } = plain();
    const a = join(tmp(), "a");
    run(main, "worktree", "add", "-q", "-b", "merged", a);
    expect(await removeWorktree(main, a, () => true, { deleteBranch: true })).toEqual({});
    expect(out(main, "branch", "--list", "merged")).toBe("");
    const b = join(tmp(), "b");
    run(main, "worktree", "add", "-q", "-b", "unmerged", b);
    commit(b, "u.txt");
    const r = await removeWorktree(main, b, () => true, { deleteBranch: true });
    expect(existsSync(b)).toBe(false);
    expect(r.branchKept).toContain("not fully merged");
    expect(out(main, "branch", "--list", "unmerged")).toContain("unmerged");
  });

  it("removeWorktree calls mark with the validated worktree before beforeRemove; a refused one never marks", async () => {
    const { main } = plain();
    const wt = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "mk", wt);
    const order: string[] = [];
    await removeWorktree(main, wt, () => true, { mark: (w) => void order.push(`mark:${w.path === wt}`), beforeRemove: async () => void order.push("before") });
    expect(order).toEqual(["mark:true", "before"]);
    const lk = join(tmp(), "lk");
    run(main, "worktree", "add", "-q", "-b", "lk", lk);
    run(main, "worktree", "lock", lk);
    const mark = vi.fn();
    expect(await code(removeWorktree(main, lk, () => true, { mark }))).toBe("not_removable");
    expect(mark).not.toHaveBeenCalled();
  });

  it("worktreeStatus of a detached HEAD counts the commits no branch holds", async () => {
    const { main } = plain();
    const d = join(main, ".claude", "worktrees", "det");
    run(main, "worktree", "add", "-q", "--detach", d);
    expect(await worktreeStatus(main, d, () => true)).toMatchObject({ uncommitted: 0, commits: 0 });
    commit(d, "d1.txt");
    commit(d, "d2.txt");
    expect(await worktreeStatus(main, d, () => true)).toMatchObject({ uncommitted: 0, commits: 2, branch: out(d, "rev-parse", "--short", "HEAD") });
  });

  it("refuses a repository with a separate git dir (git lists the git dir as main)", async () => {
    const dir = tmp();
    run(dir, "init", "-q", "-b", "main", "--separate-git-dir", join(dir, "gitdir"), "work");
    const work = join(dir, "work");
    commit(work, "a.txt");
    expect(await code(createWorktree(work, { allowed: () => true, claudeDir: tmp(), name: "x" }))).toBe("not_git");
    expect(existsSync(join(dir, "gitdir", ".claude"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses .claude or .claude/worktrees that are links, also to a folder inside the repository", async () => {
    const { main, opts } = plain();
    mkdirSync(join(main, "src"));
    symlinkSync(join(main, "src"), join(main, ".claude"));
    expect(await code(createWorktree(main, { ...opts, name: "x" }))).toBe("cwd_not_allowed");
    expect(existsSync(join(main, "src", "worktrees"))).toBe(false);
    rmSync(join(main, ".claude"));
    mkdirSync(join(main, ".claude"));
    symlinkSync(join(main, "src"), join(main, ".claude", "worktrees"));
    expect(await code(createWorktree(main, { ...opts, name: "x" }))).toBe("cwd_not_allowed");
    // A plain linked worktree inside the repository is removable (the links are not the worktree's own path).
    const via = join(main, "src", "y");
    run(main, "worktree", "add", "-q", "-b", "y", via);
    await removeWorktree(main, via, () => true);
    expect(existsSync(via)).toBe(false);
  });

  it("worktreeNameError follows Claude Code's rule", () => {
    expect(worktreeNameError("my-feature")).toBeUndefined();
    expect(worktreeNameError("v1.2_x")).toBeUndefined();
    for (const n of ["", "x".repeat(65), "a/b", "..", "a..b", ".git", ".GIT"]) expect(worktreeNameError(n), n).toBeTruthy();
  });
});

describe("gitLog / gitShow / gitFileAt", () => {
  const all = () => true;
  const sh = (cwd: string, env: Record<string, string>, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();
  /** c1 init (a.txt) -> f: c2 "fix axb" by Bob; main: c3 "fix two" by Ann (edit a.txt, add bin) -> merge c4 -> tag v1 -> c5 (rename a.txt to b.txt, delete bin). */
  function graphRepo() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gg-")));
    let t = 1_700_000_000;
    const commit = (who: "Ann" | "Bob", msg: string) => {
      const d = `${(t += 100)} +0000`;
      const env = { GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who.toLowerCase()}@x.test`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who.toLowerCase()}@x.test`, GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d };
      sh(dir, env, "commit", "-q", "--allow-empty", "-m", msg);
      return { env, hash: sh(dir, env, "rev-parse", "HEAD") };
    };
    run(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "one\n");
    run(dir, "add", ".");
    const c1 = commit("Ann", "init a.b");
    run(dir, "checkout", "-q", "-b", "f");
    writeFileSync(join(dir, "f.txt"), "f\n");
    run(dir, "add", ".");
    const c2 = commit("Bob", "fix axb");
    run(dir, "checkout", "-q", "main");
    writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
    writeFileSync(join(dir, "bin"), Buffer.from([0, 1, 2, 0]));
    run(dir, "add", ".");
    const c3 = commit("Ann", "fix two");
    const d = `${(t += 100)} +0000`;
    execFileSync("git", ["merge", "-q", "--no-ff", "-m", "merge f", "f"], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "Ann", GIT_AUTHOR_EMAIL: "a@x.test", GIT_COMMITTER_NAME: "Ann", GIT_COMMITTER_EMAIL: "a@x.test", GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } });
    const c4 = sh(dir, {}, "rev-parse", "HEAD");
    run(dir, "tag", "v1");
    run(dir, "mv", "a.txt", "b.txt");
    writeFileSync(join(dir, "b.txt"), "one\ntwo\nthree\n");
    run(dir, "rm", "-q", "bin");
    run(dir, "add", ".");
    const c5 = commit("Bob", "rename");
    return { dir, c1: c1.hash, c2: c2.hash, c3: c3.hash, c4, c5: c5.hash };
  }
  const topo = (dir: string) => sh(dir, {}, "log", "--all", "--topo-order", "--format=%H").split("\n");
  const bad = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: "bad_request" });

  it("lists all refs in topo order with parents and full ref names", async () => {
    const r = graphRepo();
    const log = (await gitLog(r.dir, { allowed: all }))!;
    expect(log.commits.map((c) => c.hash)).toEqual(topo(r.dir));
    const byHash = new Map(log.commits.map((c) => [c.hash, c]));
    expect(byHash.get(r.c4)!.parents).toEqual([r.c3, r.c2]);
    expect(byHash.get(r.c5)!.refs).toEqual(["HEAD", "refs/heads/main"]);
    expect(byHash.get(r.c4)!.refs).toEqual(["refs/tags/v1"]);
    expect(byHash.get(r.c2)!.refs).toEqual(["refs/heads/f"]);
    expect(byHash.get(r.c2)).toMatchObject({ author: "Bob", email: "bob@x.test", subject: "fix axb" });
  });

  it("pages with skip and limit, more until the end", async () => {
    const r = graphRepo();
    const full = (await gitLog(r.dir, { allowed: all }))!.commits.map((c) => c.hash);
    const a = (await gitLog(r.dir, { limit: 2, allowed: all }))!;
    expect(a.commits).toHaveLength(2);
    expect(a.more).toBe(true);
    expect(a.branches).toEqual(["refs/heads/f", "refs/heads/main"]);
    const b = (await gitLog(r.dir, { skip: 2, limit: 2, allowed: all }))!;
    const c = (await gitLog(r.dir, { skip: 4, limit: 2, allowed: all }))!;
    expect(c.commits).toHaveLength(1);
    expect(c.more).toBe(false);
    expect(b.branches).toBeUndefined();
    expect([...a.commits, ...b.commits, ...c.commits].map((x) => x.hash)).toEqual(full);
  });

  it("filters by branch, author and text (fixed string, case-insensitive, ANDed)", async () => {
    const r = graphRepo();
    const h = async (o: object) => (await gitLog(r.dir, { ...o, allowed: all }))!.commits.map((c) => c.hash);
    expect(await h({ ref: "refs/heads/f" })).toEqual([r.c2, r.c1]);
    expect(await h({ ref: "HEAD" })).toEqual(sh(r.dir, {}, "rev-list", "--topo-order", "HEAD").split("\n"));
    sh(r.dir, {}, "checkout", "-q", "f");
    expect(await h({ ref: "HEAD" })).toEqual([r.c2, r.c1]);
    expect(await h({ author: "bob" })).toEqual([r.c5, r.c2]);
    expect(await h({ text: "A.B" })).toEqual([r.c1]);
    expect(await h({ author: "ann", text: "FIX" })).toEqual([r.c3]);
  });

  it("text that is a commit hash prefix finds that commit", async () => {
    const r = graphRepo();
    const log = (await gitLog(r.dir, { text: r.c3.slice(0, 7), allowed: all }))!;
    expect(log.commits.map((c) => c.hash)).toEqual([r.c3]);
    expect(log.more).toBe(false);
  });

  it("an empty repository has no commits, also with the HEAD filter", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gg-")));
    run(dir, "init", "-q");
    expect(await gitLog(dir, { allowed: all })).toMatchObject({ commits: [], more: false, branches: [] });
    expect(await gitLog(dir, { ref: "HEAD", allowed: all })).toMatchObject({ commits: [], more: false, branches: [] });
  });

  it("an unborn HEAD (orphan branch) with the HEAD filter has no commits but keeps the branch list", async () => {
    const r = graphRepo();
    sh(r.dir, {}, "checkout", "-q", "--orphan", "x");
    const log = (await gitLog(r.dir, { ref: "HEAD", allowed: all }))!;
    expect(log.commits).toEqual([]);
    expect(log.branches).toEqual(expect.arrayContaining(["refs/heads/main", "refs/heads/f"]));
  });

  it("lists HEAD first when attached (HEAD -> branch) and after the other refs when detached", async () => {
    const r = graphRepo();
    const tip = async () => (await gitLog(r.dir, { allowed: all }))!.commits;
    expect((await tip())[0]!.refs).toEqual(["HEAD", "refs/heads/main"]);
    sh(r.dir, {}, "checkout", "-q", "--detach", "main");
    expect((await tip())[0]!.refs).toEqual(["refs/heads/main", "HEAD"]);
    sh(r.dir, {}, "checkout", "-q", "--detach", "v1");
    const at = (await tip()).find((c) => c.hash === r.c4)!;
    expect(at.refs).toEqual(["refs/tags/v1", "HEAD"]);
  });

  it("refuses bad input", async () => {
    const r = graphRepo();
    for (const h of ["-x", "HEAD", r.c1.slice(0, 39), r.c1.toUpperCase(), `${r.c1}\n`]) await bad(gitShow(r.dir, h, all));
    for (const h of ["-x", "HEAD"]) await bad(gitFileAt(r.dir, h, "a.txt", all, 1000));
    for (const ref of ["--all", "main", "refs/tags/v1", "refs/heads/nope", "head", "HEAD~1", "HEAD^", "refs/heads/../x", "refs/heads/--x"]) await bad(gitLog(r.dir, { ref, allowed: all }));
    await bad(gitLog(r.dir, { text: "a\nb", allowed: all }));
    await bad(gitLog(r.dir, { text: "x".repeat(201), allowed: all }));
    await bad(gitLog(r.dir, { author: "a\0b", allowed: all }));
    for (const p of ["../x", "a/../b", "/etc/passwd", "-p", "a\\b", "", "a\0b"]) await bad(gitFileAt(r.dir, r.c1, p, all, 1000));
    await bad(gitLog(r.dir, { skip: -1, allowed: all }));
    await bad(gitLog(r.dir, { limit: 501, allowed: all }));
    await bad(gitLog(r.dir, { limit: 1.5, allowed: all }));
  });

  it("keeps a filter that looks like an option out of git's option parsing", async () => {
    const r = graphRepo();
    for (const text of ["--all", "--output=/dev/null", "-p"]) expect((await gitLog(r.dir, { text, allowed: all }))!.commits).toEqual([]);
    expect(await gitLog(r.dir, { author: "--exec=x", allowed: all })).toMatchObject({ commits: [] });
    // --end-of-options: a branch named like an option is taken as a ref, never as an option.
    run(r.dir, "update-ref", "refs/heads/--all", r.c1);
    expect((await gitLog(r.dir, { ref: "refs/heads/--all", allowed: all }))!.commits).toHaveLength(1);
  });

  /** The git argv of every call made while `fn` runs (a logging wrapper first on PATH). */
  async function recorded(fn: () => Promise<unknown>): Promise<string[][]> {
    const bin = mkdtempSync(join(tmpdir(), "gitbin-"));
    const log = join(bin, "log");
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, "git"), `#!/bin/sh\nif [ -z "$GIT_WRAP" ]; then\nprintf 'LAZY=%s\\037' "$GIT_NO_LAZY_FETCH" >> '${log}'\nprintf '%s\\037' "$@" >> '${log}'\nprintf '\\n' >> '${log}'\nfi\nexport GIT_WRAP=1\nexec '${real}' "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await fn();
    } finally {
      process.env.PATH = path;
    }
    return (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter(Boolean).map((l) => l.split("\x1f").slice(0, -1));
  }

  // A `git` shell-script wrapper first on PATH: node cannot spawn an extensionless script on Windows (no shell, no .cmd lookup).
  it.skipIf(process.platform === "win32")("passes user text to git only as one value after the option terminators", async () => {
    const r = graphRepo();
    const calls = await recorded(async () => {
      await gitLog(r.dir, { ref: "refs/heads/f", author: "-x y", text: "--all -p", allowed: all });
      await gitLog(r.dir, { text: r.c3.slice(0, 7), allowed: all });
      await gitLog(r.dir, { ref: "HEAD", allowed: all });
      await gitShow(r.dir, r.c3, all);
      await gitFileAt(r.dir, r.c3, "a.txt", all, 1000);
      await gitStatus(r.dir);
      await gitDiff(r.dir, { base: "head", allowed: all });
      await gitDiff(r.dir, { base: "branch", ref: "refs/heads/f", allowed: all });
    });
    // Read-only: no fsmonitor program, no transport (a partial clone's lazy fetch), no lazy fetch, in every call.
    for (const a of calls) {
      expect(a[0]).toBe("LAZY=1");
      expect(a).toEqual(expect.arrayContaining(["core.fsmonitor=false", "protocol.allow=never"]));
    }
    const logs = calls.filter((a) => a.includes("log"));
    const filtered = logs.find((a) => a.includes("--grep=--all -p"))!;
    expect(filtered).toContain("--author=-x y");
    expect(filtered).not.toContain("--author");
    expect(filtered).not.toContain("--grep");
    expect(filtered.slice(-3)).toEqual(["--end-of-options", "refs/heads/f", "--"]);
    expect(filtered).toContain("--fixed-strings");
    expect(logs.find((a) => a.includes("--topo-order") && a.at(-2) === "HEAD")!.slice(-3)).toEqual(["--end-of-options", "HEAD", "--"]);
    // The hash lookup resolves the text behind a terminator, as one commit-peeled value.
    const one = logs.find((a) => a.includes("--no-walk"))!;
    expect(one.slice(-3)).toEqual(["--end-of-options", `${r.c3.slice(0, 7)}^{commit}`, "--"]);
    // Every log names its start point behind the terminator (a ref known from the branch list needs no further check).
    for (const a of logs) expect(a).toContain("--end-of-options");
    for (const a of calls.filter((a) => a.includes("show") && a.includes("-s"))) {
      expect(a.slice(-2)).toEqual(["--end-of-options", `${r.c3}^{commit}`]);
      expect(a).not.toContain("--decorate=full");
    }
    for (const a of calls.filter((a) => a.includes("diff-tree") || a.includes("diff"))) expect(a).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
  });

  it("does not run core.fsmonitor for git.status, git.log, git.commit, git.fileAt or git.diff", async () => {
    const r = graphRepo();
    // The hook is a sh script and git runs it through sh: forward slashes, or Git for Windows mangles the path.
    const fwd = (p: string) => p.replaceAll("\\", "/");
    const marker = fwd(join(r.dir, "..", `fsmon-${Date.now()}`));
    const hook = fwd(join(r.dir, "..", `fsmon-${Date.now()}.sh`));
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nprintf '\\0'\n`, { mode: 0o755 });
    run(r.dir, "config", "core.fsmonitor", hook);
    writeFileSync(join(r.dir, "b.txt"), "dirty\n");
    // Control: plain git runs the program, so the check below can fail.
    execFileSync("git", ["diff", "--numstat", "HEAD"], { cwd: r.dir, stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    await gitStatus(r.dir);
    await gitLog(r.dir, { allowed: all });
    await gitShow(r.dir, r.c5, all);
    await gitFileAt(r.dir, r.c3, "a.txt", all, 1000);
    await gitDiff(r.dir, { base: "head", allowed: all });
    await gitDiff(r.dir, { base: "branch", ref: "refs/heads/f", allowed: all });
    expect(existsSync(marker)).toBe(false);
  });

  it("reports more exactly when commits remain", async () => {
    const r = graphRepo();
    expect((await gitLog(r.dir, { skip: 3, limit: 2, allowed: all }))).toMatchObject({ more: false });
    expect((await gitLog(r.dir, { skip: 3, limit: 1, allowed: all }))).toMatchObject({ more: true });
    expect((await gitLog(r.dir, { limit: 5, allowed: all }))).toMatchObject({ more: false });
  });

  it("leaves the remote HEAD symbolic ref out of the branch list", async () => {
    const r = graphRepo();
    run(r.dir, "update-ref", "refs/remotes/origin/main", r.c1);
    run(r.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect((await gitLog(r.dir, { allowed: all }))!.branches).toEqual(["refs/heads/f", "refs/heads/main", "refs/remotes/origin/main"]);
  });

  it("gitFileAt accepts a file of exactly max bytes, refuses a folder", async () => {
    const r = graphRepo();
    expect((await gitFileAt(r.dir, r.c3, "a.txt", all, 8)).length).toBe(8);
    await expect(gitFileAt(r.dir, r.c3, "a.txt", all, 7)).rejects.toMatchObject({ code: "too_large", size: 8 });
    mkdirSync(join(r.dir, "d"));
    writeFileSync(join(r.dir, "d", "x.txt"), "x");
    run(r.dir, "add", ".");
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x.test", "commit", "-q", "-m", "dir"], { cwd: r.dir });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.dir, encoding: "utf8" }).trim();
    await expect(gitFileAt(r.dir, head, "d", all, 1000)).rejects.toMatchObject({ code: "not_found" });
  });

  it("gitShow lists A/D/M/R with line counts, binary without", async () => {
    const r = graphRepo();
    expect((await gitShow(r.dir, r.c5, all))!.files).toEqual([
      { status: "R", oldPath: "a.txt", path: "b.txt", added: 1, removed: 0 },
      { status: "D", path: "bin" },
    ]);
    const c3 = (await gitShow(r.dir, r.c3, all))!;
    expect(c3.files).toEqual([
      { status: "M", path: "a.txt", added: 1, removed: 0 },
      { status: "A", path: "bin" },
    ]);
    expect(c3).toMatchObject({ message: "fix two", committer: "Ann", subject: "fix two" });
    const c4 = (await gitShow(r.dir, r.c4, all))!;
    expect(c4.parents).toHaveLength(2);
    expect(c4.files.map((f) => f.path).sort()).toEqual(["f.txt"]);
    expect((await gitShow(r.dir, r.c1, all))!.files).toEqual([{ status: "A", path: "a.txt", added: 1, removed: 0 }]);
    await expect(gitShow(r.dir, "0".repeat(40), all)).rejects.toMatchObject({ code: "not_found" });
  });

  it("gitFileAt returns the bytes at a commit; not_found and too_large", async () => {
    const r = graphRepo();
    expect((await gitFileAt(r.dir, r.c3, "a.txt", all, 1000)).toString()).toBe("one\ntwo\n");
    expect((await gitFileAt(r.dir, r.c3, "bin", all, 1000))).toEqual(Buffer.from([0, 1, 2, 0]));
    await expect(gitFileAt(r.dir, r.c1, "bin", all, 1000)).rejects.toMatchObject({ code: "not_found" });
    await expect(gitFileAt(r.dir, r.c3, "a.txt", all, 3)).rejects.toMatchObject({ code: "too_large", size: 8 });
  });

  it("returns null outside a git repository", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gg-")));
    expect(await gitLog(dir, { allowed: all })).toBeNull();
    expect(await gitShow(dir, "a".repeat(40), all)).toBeNull();
  });

  it("refuses a repository whose top is outside the roots", async () => {
    const r = graphRepo();
    const sub = join(r.dir, "sub");
    mkdirSync(sub);
    const inSub = (p: string) => p.startsWith(sub);
    await expect(gitLog(sub, { allowed: inSub })).rejects.toMatchObject({ code: "cwd_not_allowed" });
    await expect(gitShow(sub, r.c1, inSub)).rejects.toMatchObject({ code: "cwd_not_allowed" });
    await expect(gitFileAt(sub, r.c1, "a.txt", inSub, 1000)).rejects.toMatchObject({ code: "cwd_not_allowed" });
  });
  it.skipIf(process.platform === "win32")("git.log page 0, git.commit and a file diff each run at most 2 git processes", async () => {
    const r = graphRepo();
    expect((await recorded(() => gitLog(r.dir, { allowed: all }))).length).toBeLessThanOrEqual(2);
    const r2 = graphRepo();
    expect((await recorded(() => gitLog(r2.dir, { ref: "HEAD", allowed: all }))).length).toBeLessThanOrEqual(2);
    const r3 = graphRepo();
    expect((await recorded(() => gitLog(r3.dir, { ref: "refs/heads/f", allowed: all }))).length).toBeLessThanOrEqual(2);
    const r4 = graphRepo();
    expect((await recorded(() => gitShow(r4.dir, r4.c3, all))).length).toBeLessThanOrEqual(2);
    const r5 = graphRepo();
    expect((await recorded(() => Promise.all([gitFileAt(r5.dir, r5.c1, "a.txt", all, 1000), gitFileAt(r5.dir, r5.c3, "a.txt", all, 1000)]))).length).toBeLessThanOrEqual(2);
  });

  it.skipIf(process.platform === "win32")("a repeated git.log with unchanged refs runs no git process; a commit, branch or tag reads again", async () => {
    const r = graphRepo();
    const first = await gitLog(r.dir, { allowed: all });
    const again = await recorded(() => gitLog(r.dir, { allowed: all }));
    expect(again).toHaveLength(0);
    expect(await gitLog(r.dir, { allowed: all })).toEqual(first);
    // Time moves on between steps: a stamp is file stats, a same-tick update could share one.
    const tick = () => new Promise((res) => setTimeout(res, 30));
    await tick();
    sh(r.dir, { GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x.test", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x.test" }, "commit", "-q", "--allow-empty", "-m", "newest");
    expect((await recorded(() => gitLog(r.dir, { allowed: all }))).length).toBeGreaterThanOrEqual(1);
    expect((await gitLog(r.dir, { allowed: all }))!.commits[0]!.subject).toBe("newest");
    await tick();
    run(r.dir, "branch", "x");
    expect((await recorded(() => gitLog(r.dir, { allowed: all }))).length).toBeGreaterThanOrEqual(1);
    expect((await gitLog(r.dir, { allowed: all }))!.branches).toContain("refs/heads/x");
    await tick();
    run(r.dir, "tag", "t9");
    expect((await recorded(() => gitLog(r.dir, { allowed: all }))).length).toBeGreaterThanOrEqual(1);
    expect((await gitLog(r.dir, { allowed: all }))!.commits[0]!.refs).toContain("refs/tags/t9");
  });

  it.skipIf(process.platform === "win32")("fresh skips the page cache", async () => {
    const r = graphRepo();
    await gitLog(r.dir, { allowed: all });
    expect((await recorded(() => gitLog(r.dir, { allowed: all, fresh: true }))).length).toBeGreaterThanOrEqual(1);
  });

  it("refsStamp changes on commit, branch create and delete, checkout, tag and pack-refs; not on a working-tree edit", async () => {
    const r = graphRepo();
    const tick = () => new Promise((res) => setTimeout(res, 30));
    let last = await refsStamp(r.dir);
    const changed = async (what: string, act: () => void) => {
      await tick();
      act();
      const now = await refsStamp(r.dir);
      expect(now, what).not.toBe(last);
      last = now;
    };
    expect(await refsStamp(r.dir)).toBe(last);
    await tick();
    writeFileSync(join(r.dir, "b.txt"), "edited\n");
    expect(await refsStamp(r.dir)).toBe(last);
    await changed("commit", () => sh(r.dir, { GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x.test", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x.test" }, "commit", "-q", "--allow-empty", "-m", "x"));
    await changed("branch create", () => run(r.dir, "branch", "deep/er/b"));
    await changed("branch delete", () => run(r.dir, "branch", "-D", "deep/er/b"));
    await changed("checkout", () => run(r.dir, "checkout", "-q", "-f", "f"));
    await changed("tag", () => run(r.dir, "tag", "t1"));
    await changed("pack-refs", () => run(r.dir, "pack-refs", "--all"));
    expect(await refsStamp(mkdtempSync(join(tmpdir(), "nogit-")))).toBe("-");
  });

  it("page 0 carries head and refs: head is refs/heads/main attached, absent detached", async () => {
    const r = graphRepo();
    const a = (await gitLog(r.dir, { allowed: all }))!;
    expect(a.head).toBe("refs/heads/main");
    expect(a.refs).toBe(await refsStamp(r.dir));
    const more = (await gitLog(r.dir, { skip: 1, limit: 1, allowed: all }))!;
    expect(more.head).toBeUndefined();
    expect(more.refs).toBeUndefined();
    sh(r.dir, {}, "checkout", "-q", "--detach", "v1");
    const d = (await gitLog(r.dir, { allowed: all }))!;
    expect(d.head).toBeUndefined();
    expect(d.refs).toBeTypeOf("string");
  });

  it.skipIf(process.platform === "win32")("gitShow has no refs and is cached by hash; an unknown or non-commit hash is not_found", async () => {
    const r = graphRepo();
    const c = (await gitShow(r.dir, r.c3, all))!;
    expect(c.refs).toEqual([]);
    expect(c.subject).toBe("fix two");
    expect((await recorded(() => gitShow(r.dir, r.c3, all))).length).toBe(0);
    await expect(gitShow(r.dir, "0123456789abcdef0123456789abcdef01234567", all)).rejects.toMatchObject({ code: "not_found" });
    const tree = sh(r.dir, {}, "rev-parse", "HEAD^{tree}");
    await expect(gitShow(r.dir, tree, all)).rejects.toMatchObject({ code: "not_found" });
  });

  it("gitFileAt reads a file name with a line break", async () => {
    const r = graphRepo();
    const name = "we\nird.txt";
    writeFileSync(join(r.dir, name), "odd\n");
    run(r.dir, "add", ".");
    sh(r.dir, { GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x.test", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x.test" }, "commit", "-q", "-m", "odd");
    const h = sh(r.dir, {}, "rev-parse", "HEAD");
    expect((await gitFileAt(r.dir, h, name, all, 1000)).toString()).toBe("odd\n");
    await expect(gitFileAt(r.dir, h, "we\nnone.txt", all, 1000)).rejects.toMatchObject({ code: "not_found" });
  });

  it("an empty .git folder in a project does not show the repository above the roots", async () => {
    const outer = graphRepo();
    const roots = join(outer.dir, "roots");
    const proj = join(roots, "proj");
    mkdirSync(join(proj, ".git"), { recursive: true });
    const inRoots = (p: string) => p === roots || p.startsWith(`${roots}/`);
    // Without a ceiling, git skips the invalid .git and walks up to `outer`.
    await expect(gitLog(proj, { allowed: inRoots })).rejects.toBeDefined();
    await expect(gitShow(proj, outer.c3, inRoots)).rejects.toBeDefined();
    await expect(gitFileAt(proj, outer.c3, "a.txt", inRoots, 1000)).rejects.toBeDefined();
    await expect(gitDiff(proj, { base: "head", allowed: inRoots })).rejects.toBeDefined();
    expect(await gitStatus(proj)).toBeNull();
  });

  it("gitRefs is the refs stamp without a git process, null outside a repository", async () => {
    const r = graphRepo();
    expect(await gitRefs(r.dir, () => true)).toBe(await refsStamp(r.dir));
    expect(await gitRefs(mkdtempSync(join(tmpdir(), "nogit-")), () => true)).toBeNull();
    expect(await gitRefs(r.dir, () => false)).toBeNull();
  });

  describe("git runs on the repository that was validated (GH-290)", () => {
    const seenEnv = async (fn: () => Promise<unknown>) => {
      const envs: NodeJS.ProcessEnv[] = [];
      setGitRunner(async (o: GitRunOptions) => {
        envs.push(o.env);
        return threadRunner(o);
      });
      try {
        await fn();
      } finally {
        setGitRunner(undefined);
      }
      return envs;
    };
    it("every graph call gets GIT_DIR (real path), GIT_COMMON_DIR, GIT_WORK_TREE and a ceiling above the top", async () => {
      const r = graphRepo();
      const envs = await seenEnv(async () => {
        await gitLog(r.dir, { allowed: all });
        await gitStatus(r.dir);
        await gitDiff(r.dir, { base: "head", allowed: all });
      });
      expect(envs.length).toBeGreaterThan(3);
      for (const e of envs) expect(e).toMatchObject({ GIT_DIR: join(r.dir, ".git"), GIT_COMMON_DIR: join(r.dir, ".git"), GIT_WORK_TREE: r.dir, GIT_CEILING_DIRECTORIES: expect.stringContaining(dirname(r.dir)) });
    });
    it.skipIf(process.platform === "win32")("a .git symlink to a folder inside the roots is pinned to its real path and works", async () => {
      const r = graphRepo();
      const dot = realpathSync(mkdtempSync(join(tmpdir(), "dot-")));
      renameSync(join(r.dir, ".git"), join(dot, "g"));
      symlinkSync(join(dot, "g"), join(r.dir, ".git"));
      const envs = await seenEnv(async () => expect((await gitLog(r.dir, { allowed: all }))!.commits.length).toBeGreaterThan(0));
      for (const e of envs) expect(e.GIT_DIR).toBe(join(dot, "g"));
    });
    it("a linked worktree and a subfolder of a repository keep working; git.diff from a subfolder", async () => {
      const r = graphRepo();
      const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "wtp-"))), "w");
      run(r.dir, "worktree", "add", "-q", "-b", "wb", wt);
      mkdirSync(join(wt, "sub"));
      const envs = await seenEnv(async () => {
        expect((await gitLog(wt, { allowed: all }))!.commits.length).toBeGreaterThan(0);
        expect((await gitStatus(join(wt, "sub")))!.branch).toBe("wb");
        expect(await gitDiff(join(wt, "sub"), { base: "head", allowed: all })).not.toBeNull();
        expect((await listWorktrees(wt))!.map((w) => w.path)).toContain(wt);
      });
      for (const e of envs) expect(e).toMatchObject({ GIT_COMMON_DIR: join(r.dir, ".git"), GIT_WORK_TREE: wt });
    });
    it("a submodule-style gitdir file works, and GIT_WORK_TREE overrides core.worktree", async () => {
      const r = graphRepo();
      const base = realpathSync(mkdtempSync(join(tmpdir(), "sm-")));
      const work = join(base, "work");
      mkdirSync(work);
      const gd = join(base, "modules", "m");
      run(base, "clone", "-q", "--bare", r.dir, gd);
      run(gd, "config", "core.bare", "false");
      run(gd, "config", "core.worktree", "/nonexistent-elsewhere");
      writeFileSync(join(work, ".git"), `gitdir: ${gd}\n`);
      const envs = await seenEnv(async () => expect((await gitLog(work, { allowed: all }))!.commits.length).toBeGreaterThan(0));
      for (const e of envs) expect(e).toMatchObject({ GIT_DIR: gd, GIT_WORK_TREE: work });
    });
    it("a repository whose objects/info/alternates names a folder outside the roots is refused; one inside the roots works", async () => {
      const r = graphRepo();
      const base = realpathSync(mkdtempSync(join(tmpdir(), "alt-")));
      const roots = join(base, "roots");
      mkdirSync(roots);
      const inRoots = (p: string) => p === roots || p.startsWith(roots + sep);
      const clone = join(roots, "c");
      run(roots, "clone", "-q", "--shared", r.dir, clone);
      expect(readFileSync(join(clone, ".git", "objects", "info", "alternates"), "utf8")).toContain(r.dir);
      expect(await gitEscapes(clone, inRoots)).toBe(true);
      await expect(gitLog(clone, { allowed: inRoots })).rejects.toMatchObject({ code: "cwd_not_allowed" });
      writeFileSync(join(clone, ".git", "objects", "info", "alternates"), "# none\n");
      expect(await gitEscapes(clone, inRoots)).toBe(false);
    });
  });

  describe.skipIf(process.platform === "win32")("gitEscapes (GH-290)", () => {
    const mk = () => {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "esc-")));
      const roots = join(base, "roots");
      const outer = join(base, "outer");
      mkdirSync(roots);
      run(base, "init", "-q", "-b", "main", "outer");
      return { roots, outer, inRoots: (p: string) => p === roots || p.startsWith(roots + "/") };
    };
    it("a symlinked .git, a gitdir file (absolute and relative) and a commondir that leave the roots escape", async () => {
      const { roots, outer, inRoots } = mk();
      mkdirSync(join(roots, "a"));
      symlinkSync(join(outer, ".git"), join(roots, "a", ".git"));
      mkdirSync(join(roots, "b"));
      writeFileSync(join(roots, "b", ".git"), `gitdir: ${join(outer, ".git")}\n`);
      mkdirSync(join(roots, "c"));
      writeFileSync(join(roots, "c", ".git"), `gitdir: ../../outer/.git\n`);
      mkdirSync(join(roots, "d", "own"), { recursive: true });
      writeFileSync(join(roots, "d", ".git"), "gitdir: own\n");
      writeFileSync(join(roots, "d", "own", "commondir"), `${join(outer, ".git")}\n`);
      for (const p of ["a", "b", "c", "d"]) expect(await gitEscapes(join(roots, p), inRoots), p).toBe(true);
    });
    it("a normal repository, a subfolder, a linked worktree and a submodule-style gitdir inside the roots do not escape; a worktree of an outer repository does", async () => {
      const { roots, outer, inRoots } = mk();
      const main = join(roots, "main");
      run(roots, "init", "-q", "-b", "main", "main");
      run(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i");
      run(main, "worktree", "add", "-q", "-b", "w", join(main, ".claude", "worktrees", "w"));
      mkdirSync(join(main, "sub"));
      mkdirSync(join(main, ".git", "modules", "m"), { recursive: true });
      mkdirSync(join(main, "mod"));
      writeFileSync(join(main, "mod", ".git"), "gitdir: ../.git/modules/m\n");
      for (const p of [main, join(main, "sub"), join(main, ".claude", "worktrees", "w"), join(main, "mod")]) expect(await gitEscapes(p, inRoots), p).toBe(false);
      run(outer, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i");
      run(outer, "worktree", "add", "-q", "-b", "o", join(roots, "linked"));
      expect(await gitEscapes(join(roots, "linked"), inRoots)).toBe(true);
    });
    it("a folder without .git below a repository outside the roots escapes; outside any repository it does not", async () => {
      const { roots, outer, inRoots } = mk();
      const sub = join(outer, "sub");
      mkdirSync(sub);
      expect(await gitEscapes(sub, inRoots)).toBe(true);
      expect(await gitEscapes(mkdtempSync(join(tmpdir(), "nogit-")), inRoots)).toBe(false);
      void roots;
    });
  });

  describe("a .git that cannot be resolved (GH-282)", () => {
    const proj = () => {
      const d = realpathSync(mkdtempSync(join(tmpdir(), "gh282-")));
      return d;
    };
    it("a .git file without a gitdir line counts as outside the roots (fail closed)", async () => {
      const d = proj();
      writeFileSync(join(d, ".git"), "nonsense\n");
      expect(await gitEscapes(d, () => true)).toBe(true);
    });
    it("a gitdir to another UNC share is not resolved on Windows, and the repository counts as outside", async () => {
      const d = proj();
      writeFileSync(join(d, ".git"), "gitdir: \\\\evil-gh282\\share\\x\n");
      const orig = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        expect(gitDirsOf(d)).toBeUndefined();
        expect(await gitEscapes(d, () => true)).toBe(true);
      } finally {
        Object.defineProperty(process, "platform", orig);
      }
    });
  });

  it("gitStatus during a graph read returns the last status without git, or waits when it has none", async () => {
    const a = graphRepo();
    const b = graphRepo();
    const primed = (await gitStatus(a.dir))!;
    let open!: () => void;
    const gate = new Promise<void>((res) => (open = res));
    const seen: string[][] = [];
    setGitRunner(async (o: GitRunOptions) => {
      seen.push(o.args);
      if (o.args.includes("log")) await gate;
      return threadRunner(o);
    });
    try {
      const log = gitLog(a.dir, { allowed: all });
      await new Promise((res) => setTimeout(res, 20));
      seen.length = 0;
      const during = await gitStatus(a.dir);
      expect(during).toEqual({ ...primed, refs: await refsStamp(a.dir) });
      expect(seen.some((x) => x.includes("diff"))).toBe(false);
      // A folder with no earlier status waits for the graph to finish.
      let done = false;
      const first = gitStatus(b.dir).then((s) => ((done = true), s));
      await new Promise((res) => setTimeout(res, 50));
      expect(done).toBe(false);
      open();
      await log;
      expect((await first)!.branch).toBe("main");
    } finally {
      open();
      setGitRunner(undefined);
    }
  });

});

describe("gitDiff", { timeout: 90_000 }, () => {
  const all = () => true;
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x.test", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "gd-")));
  const put = (dir: string, f: string, text: string) => {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  };
  const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { code: string }).code);
  const msg = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as Error).message);

  /** main: a.txt, sub.txt; feat: + f.txt, g.txt; working tree: a.txt edited, sub.txt moved, f.txt removed, s/u.txt untracked. */
  function diffRepo() {
    const dir = tmp();
    sh(dir, "init", "-q", "-b", "main");
    put(dir, "a.txt", "1\n2\n3\n");
    put(dir, "sub.txt", "same\ncontent\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "init");
    const main = sh(dir, "rev-parse", "HEAD");
    sh(dir, "checkout", "-q", "-b", "feat");
    put(dir, "f.txt", "f\n");
    put(dir, "g.txt", "g\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "feat");
    put(dir, "a.txt", "1\nx\n3\n");
    sh(dir, "mv", "sub.txt", "moved.txt");
    rmSync(join(dir, "f.txt"));
    put(dir, "s/u.txt", "one\ntwo\n");
    return { dir, main, head: sh(dir, "rev-parse", "HEAD") };
  }

  it("is null outside a git repository", async () => {
    expect(await gitDiff(mkdtempSync(join(tmpdir(), "nogit-")), { base: "head", allowed: all })).toBeNull();
  });

  it("head: staged, unstaged and untracked against HEAD, paths relative to the top, prefix of a subdirectory cwd", async () => {
    const r = diffRepo();
    const d = (await gitDiff(join(r.dir, "s"), { base: "head", allowed: all }))!;
    expect(d.prefix).toBe("s/");
    expect(d.base).toBe(r.head);
    expect(d.ref).toBeUndefined();
    expect(d.branches).toBeUndefined();
    expect(d.files).toEqual([
      { status: "M", path: "a.txt", added: 1, removed: 1 },
      { status: "D", path: "f.txt", added: 0, removed: 1 },
      { status: "R", path: "moved.txt", oldPath: "sub.txt", added: 0, removed: 0 },
      { status: "A", path: "s/u.txt", untracked: true, added: 2, removed: 0 },
    ]);
    expect((await gitDiff(r.dir, { base: "head", allowed: all }))!.prefix).toBe("");
  });

  it("head before the first commit: no base, staged and untracked files are A", async () => {
    const dir = tmp();
    sh(dir, "init", "-q", "-b", "main");
    put(dir, "staged.txt", "a\n");
    sh(dir, "add", "staged.txt");
    put(dir, "loose.txt", "b\nc\n");
    const d = (await gitDiff(dir, { base: "head", allowed: all }))!;
    expect(d.base).toBeUndefined();
    expect(d.files).toEqual([
      { status: "A", path: "loose.txt", untracked: true, added: 2, removed: 0 },
      { status: "A", path: "staged.txt", added: 1, removed: 0 },
    ]);
  });

  it("branch: against the merge base with the default branch (origin/HEAD, else main), with the branch list", async () => {
    const r = diffRepo();
    const d = (await gitDiff(r.dir, { base: "branch", allowed: all }))!;
    expect(d.ref).toBe("refs/heads/main");
    expect(d.base).toBe(r.main);
    expect(d.files.map((f) => `${f.status} ${f.path}`)).toEqual(["M a.txt", "A g.txt", "R moved.txt", "A s/u.txt"]);
    expect(d.branches).toEqual(expect.arrayContaining(["refs/heads/main", "refs/heads/feat"]));
    sh(r.dir, "update-ref", "refs/remotes/origin/dev", r.main);
    sh(r.dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
    const o = (await gitDiff(r.dir, { base: "branch", allowed: all }))!;
    expect(o.ref).toBe("refs/remotes/origin/dev");
    expect(o.branches).not.toContain("refs/remotes/origin/HEAD");
  });

  it("branch: an explicit ref; unknown refs and option-like refs are refused", async () => {
    const r = diffRepo();
    expect((await gitDiff(r.dir, { base: "branch", ref: "refs/heads/main", allowed: all }))!.ref).toBe("refs/heads/main");
    for (const ref of ["main", "--output=x", "refs/tags/v1", "refs/heads/nope"]) expect(await code(gitDiff(r.dir, { base: "branch", ref, allowed: all }))).toBe("bad_request");
    expect(await code(gitDiff(r.dir, { base: "branch", ref: 5 as never, allowed: all }))).toBe("bad_request");
  });

  it("branch: bad_base before the first commit, without a default branch, and without common history", async () => {
    const dir = tmp();
    sh(dir, "init", "-q", "-b", "main");
    expect(await msg(gitDiff(dir, { base: "branch", allowed: all }))).toBe("No commits yet");
    const r = diffRepo();
    sh(r.dir, "checkout", "-q", "--orphan", "orph");
    sh(r.dir, "commit", "-qm", "orphan");
    expect(await msg(gitDiff(r.dir, { base: "branch", ref: "refs/heads/main", allowed: all }))).toMatch(/^No common history with main/);
    expect(await code(gitDiff(r.dir, { base: "branch", ref: "refs/heads/main", allowed: all }))).toBe("bad_base");
    const only = tmp();
    sh(only, "init", "-q", "-b", "dev");
    put(only, "a", "1\n");
    sh(only, "add", ".");
    sh(only, "commit", "-qm", "x");
    expect(await code(gitDiff(only, { base: "branch", allowed: all }))).toBe("bad_base");
    expect(await msg(gitDiff(only, { base: "branch", allowed: all }))).toMatch(/No default branch/);
  });

  it("refuses an unknown base and a repository outside the allowed roots", async () => {
    const r = diffRepo();
    expect(await code(gitDiff(r.dir, { base: "x", allowed: all }))).toBe("bad_request");
    expect(await code(gitDiff(r.dir, { base: "head", allowed: () => false }))).toBe("cwd_not_allowed");
  });

  it("untracked stats: none for binary, larger than 1 MiB or symlink", async () => {
    const dir = tmp();
    sh(dir, "init", "-q", "-b", "main");
    put(dir, "a", "1\n");
    sh(dir, "add", ".");
    sh(dir, "commit", "-qm", "x");
    writeFileSync(join(dir, "bin"), Buffer.from([1, 0, 2]));
    writeFileSync(join(dir, "big.txt"), "x\n".repeat(600_000));
    put(dir, "noeol.txt", "a\nb");
    if (process.platform !== "win32") symlinkSync("a", join(dir, "link"));
    const d = (await gitDiff(dir, { base: "head", allowed: all }))!;
    const f = (p: string) => d.files.find((x) => x.path === p)!;
    expect(f("bin")).toEqual({ status: "A", path: "bin", untracked: true });
    expect(f("big.txt")).toEqual({ status: "A", path: "big.txt", untracked: true });
    expect(f("noeol.txt")).toMatchObject({ added: 2, removed: 0 });
    if (process.platform !== "win32") expect(f("link")).toEqual({ status: "A", path: "link", untracked: true });
  });
});

describe("gitDiff truncation", { timeout: 120_000 }, () => {
  it("lists tracked edits first: untracked files are cut before tracked ones", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "gdt-")));
    const sh = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@x.test", ...a], { cwd: dir, stdio: "ignore" });
    sh("init", "-q", "-b", "main");
    writeFileSync(join(dir, "zzz.txt"), "1\n");
    sh("add", ".");
    sh("commit", "-qm", "x");
    writeFileSync(join(dir, "zzz.txt"), "2\n");
    mkdirSync(join(dir, "u"));
    for (let i = 0; i < 3100; i++) writeFileSync(join(dir, "u", `f${i}.txt`), "x\n");
    const d = (await gitDiff(dir, { base: "head", allowed: () => true }))!;
    expect(d.truncated).toBe(true);
    expect(d.files).toHaveLength(3000);
    expect(d.files.find((f) => f.path === "zzz.txt")).toMatchObject({ status: "M", added: 1, removed: 1 });
  });
});

describe("limiter", () => {
  it("an urgent task starts before queued normal ones", async () => {
    const run = limiter(1);
    const order: string[] = [];
    let open!: () => void;
    const hold = run(() => new Promise<void>((r) => (open = r)));
    const t = (n: string, urgent = false) => run(async () => void order.push(n), urgent);
    const rest = Promise.all([t("n1"), t("n2"), t("u1", true), t("u2", true)]);
    open();
    await Promise.all([hold, rest]);
    expect(order).toEqual(["u1", "u2", "n1", "n2"]);
  });

  it("runs at most n tasks at a time, in order; a failed task frees its slot", async () => {
    const run = limiter(2);
    let active = 0;
    let most = 0;
    const order: number[] = [];
    const task = (i: number, fail = false) =>
      run(async () => {
        active++;
        most = Math.max(most, active);
        order.push(i);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (fail) throw new Error(`task ${i}`);
        return i;
      });
    const results = await Promise.allSettled([task(0), task(1, true), task(2), task(3), task(4)]);
    expect(most).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
  });
});

describe("WSL projects opened by their UNC path", () => {
  afterEach(() => (setGitRunner(undefined), vi.restoreAllMocks()));
  const unc = (p: string) => `\\\\wsl.localhost\\X${p.replace(/\//g, "\\")}`;

  it("listWorktrees of a UNC WSL cwd maps the POSIX paths git prints to the same UNC form", async () => {
    const out = "worktree /home/me/repo\0HEAD abcdef1234\0branch refs/heads/main\0\0worktree /mnt/c/wt\0HEAD abcdef1234\0detached\0\0";
    setGitRunner(async () => ({ stdout: Buffer.from(out), stderr: "" }));
    const list = await listWorktrees("\\\\wsl.localhost\\Ubuntu\\home\\me\\repo");
    expect(list).toEqual([
      { path: "\\\\wsl.localhost\\Ubuntu\\home\\me\\repo", branch: "main", main: true },
      { path: "C:\\wt", branch: "abcdef1", main: false },
    ]);
  });

  it("gitStatus of a UNC WSL cwd reads through the WSL runner", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "wslst-")));
    run(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "1\n");
    run(dir, "add", ".");
    run(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    writeFileSync(join(dir, "a.txt"), "1\n2\n");
    const files: (string | undefined)[] = [];
    // Stands for wsl.exe: bash runs the script (cd to the POSIX path, git) like the distro would.
    const local = (o: GitRunOptions) =>
      new Promise<{ stdout: Buffer; stderr: string }>((ok, fail) => {
        files.push(o.file);
        execFile("bash", o.args.slice(4), { encoding: "buffer" }, (err, stdout, stderr) => (err ? fail(Object.assign(err, { stderr: String(stderr) })) : ok({ stdout, stderr: String(stderr) })));
      });
    setGitRunner(wslGitRunner({ local }));
    // On Linux a UNC path is relative: resolved from a cwd outside any repository, so no host repository is pinned (Windows resolves the UNC path itself).
    vi.spyOn(process, "cwd").mockReturnValue(realpathSync(tmpdir()));
    expect(await gitStatus(unc(dir))).toMatchObject({ branch: "main", added: 1, removed: 0 });
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f === "wsl.exe")).toBe(true);
  });
});
