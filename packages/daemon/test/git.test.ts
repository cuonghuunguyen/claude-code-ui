import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { worktreeNameError } from "@claude-ui/protocol";
import { createWorktree, gitFileAt, gitLog, gitShow, gitStatus, listWorktrees, removeWorktree, worktreeStatus } from "../src/git.ts";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

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
    expect(await gitStatus(dir)).toEqual({ branch: "main", added: 0, removed: 0 });
    writeFileSync(join(dir, "a.txt"), "1\nx\ny\n");
    writeFileSync(join(dir, "b.txt"), "new\n");
    run(dir, "add", "b.txt");
    expect(await gitStatus(dir)).toEqual({ branch: "main", added: 3, removed: 2 });
  });

  it("works before the first commit and on a detached HEAD", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-"));
    run(dir, "init", "-q", "-b", "dev");
    expect(await gitStatus(dir)).toEqual({ branch: "dev", added: 0, removed: 0 });
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

  it("removes the directory and its worktree-* branch; a foreign branch stays; main, unknown and hand-made worktrees are refused", async () => {
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

  it("refuses to remove worktrees outside <repo>/.claude/worktrees (hand-made, sibling dir, symlinked)", async () => {
    const { main, opts } = plain();
    const hand = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "hand", hand);
    expect(await code(removeWorktree(main, hand, () => true))).toBe("not_removable");
    expect(await code(worktreeStatus(main, hand))).toBe("not_removable");
    // Nested below .claude/worktrees: not a direct child.
    const nested = join(main, ".claude", "worktrees", "a", "b");
    run(main, "worktree", "add", "-q", "-b", "nest", nested);
    expect(await code(removeWorktree(main, nested, () => true))).toBe("not_removable");
    // Another tool's folder next to it.
    const other = join(main, ".claude", "other");
    run(main, "worktree", "add", "-q", "-b", "other", other);
    expect(await code(removeWorktree(main, other, () => true))).toBe("not_removable");
    // A managed worktree outside the roots is refused by the predicate.
    const r = await createWorktree(main, { ...opts, name: "ok" });
    expect(await code(removeWorktree(main, r.path, () => false))).toBe("cwd_not_allowed");
    for (const d of [hand, nested, other, r.path]) expect(existsSync(d), d).toBe(true);
    expect(out(main, "branch", "--list", "hand")).toContain("hand");
  });

  it.skipIf(process.platform === "win32")("refuses to remove through a symlink that points out of .claude/worktrees", async () => {
    const { main, opts } = plain();
    const hand = join(tmp(), "wt");
    run(main, "worktree", "add", "-q", "-b", "hand", hand);
    const dir = join(main, ".claude", "worktrees");
    mkdirSync(dir, { recursive: true });
    symlinkSync(hand, join(dir, "link"));
    expect(await code(removeWorktree(main, join(dir, "link"), () => true))).toBe("not_removable");
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
    expect(await worktreeStatus(main, r.path)).toEqual({ uncommitted: 0, commits: 0, branch: "worktree-feat" });
    commit(r.path, "1.txt");
    commit(r.path, "2.txt");
    writeFileSync(join(r.path, "a.txt"), "changed");
    writeFileSync(join(r.path, "new.txt"), "n");
    expect(await worktreeStatus(main, r.path)).toEqual({ uncommitted: 2, commits: 2, branch: "worktree-feat" });
    const keep = join(main, ".claude", "worktrees", "keep");
    run(main, "worktree", "add", "-q", "-b", "keep", keep);
    commit(keep, "k.txt");
    expect(await worktreeStatus(main, keep)).toEqual({ uncommitted: 0, commits: 0, branch: "keep" });
  });

  it("worktreeStatus of a detached HEAD counts the commits no branch holds", async () => {
    const { main } = plain();
    const d = join(main, ".claude", "worktrees", "det");
    run(main, "worktree", "add", "-q", "--detach", d);
    expect(await worktreeStatus(main, d)).toMatchObject({ uncommitted: 0, commits: 0 });
    commit(d, "d1.txt");
    commit(d, "d2.txt");
    expect(await worktreeStatus(main, d)).toMatchObject({ uncommitted: 0, commits: 2, branch: out(d, "rev-parse", "--short", "HEAD") });
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
    // A worktree reached through such a link is not removable either.
    const via = join(main, "src", "y");
    run(main, "worktree", "add", "-q", "-b", "y", via);
    expect(await code(removeWorktree(main, via, () => true))).toBe("not_removable");
    expect(existsSync(via)).toBe(true);
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
    expect(await gitLog(dir, { allowed: all })).toEqual({ commits: [], more: false, branches: [] });
    expect(await gitLog(dir, { ref: "HEAD", allowed: all })).toEqual({ commits: [], more: false, branches: [] });
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
    return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\x1f").slice(0, -1));
  }

  it("passes user text to git only as one value after the option terminators", async () => {
    const r = graphRepo();
    const calls = await recorded(async () => {
      await gitLog(r.dir, { ref: "refs/heads/f", author: "-x y", text: "--all -p", allowed: all });
      await gitLog(r.dir, { text: r.c3.slice(0, 7), allowed: all });
      await gitLog(r.dir, { ref: "HEAD", allowed: all });
      await gitShow(r.dir, r.c3, all);
      await gitFileAt(r.dir, r.c3, "a.txt", all, 1000);
      await gitStatus(r.dir);
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
    // The hash lookup resolves the text behind a terminator and logs only the full hash behind one.
    expect(calls.find((a) => a.includes("rev-parse") && a.includes(`${r.c3.slice(0, 7)}^{commit}`))).toContain("--end-of-options");
    const one = logs.find((a) => a.includes("--no-walk"))!;
    expect(one.slice(-3)).toEqual(["--end-of-options", r.c3, "--"]);
    expect(calls.some((a) => a.includes("check-ref-format") && a.includes("refs/heads/f"))).toBe(true);
    for (const a of calls.filter((a) => a.includes("show") && a.includes("-s"))) expect(a.slice(-2)).toEqual(["--end-of-options", r.c3]);
    for (const a of calls.filter((a) => a.includes("diff-tree"))) expect(a).toEqual(expect.arrayContaining(["--no-ext-diff", "--no-textconv"]));
  });

  it("does not run core.fsmonitor for git.status, git.log, git.commit or git.fileAt", async () => {
    const r = graphRepo();
    const marker = join(r.dir, "..", `fsmon-${Date.now()}`);
    const hook = join(r.dir, "..", `fsmon-${Date.now()}.sh`);
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
});
