import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HistoryReason } from "@claude-ui/protocol";
import { gitCommitAction, gitCommitMenu } from "../src/git-write.ts";

vi.setConfig({ testTimeout: process.platform === "win32" ? 120_000 : 60_000 });
const run = (cwd: string, ...args: string[]) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.editor=true", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
};
const put = (dir: string, f: string, text: string) => writeFileSync(join(dir, f), text);
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const head = (dir: string, rev = "HEAD") => run(dir, "rev-parse", rev);
/** main: a.txt "1", then "2", then "3" (commits c1..c3); branch `other` from c1 adds b.txt. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gca-")));
  const dir = join(root, "r");
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  for (const n of ["1", "2", "3"]) {
    put(dir, "a.txt", `${n}\n`);
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", `c${n}`);
  }
  run(dir, "branch", "other", "HEAD~2");
  const seen: { path: string; reason: HistoryReason; text: string }[] = [];
  return { root, dir, o: { allowed: (p: string) => p.startsWith(root), snapshot: (p: string, reason: HistoryReason, c?: string) => void seen.push({ path: p, reason, text: c ?? readFileSync(p, "utf8") }) }, seen };
}
type R = ReturnType<typeof repo>;
const menu = async (r: R, hash: string, hard = false) => (await gitCommitMenu(r.dir, { ...r.o, hash, hard: hard || undefined }))!;
/** The menu, then the write the UI would send. */
async function act(r: R, action: "undo" | "revert" | "cherryPick" | "reset", hash: string, mode?: "soft" | "mixed" | "hard", over: Record<string, unknown> = {}) {
  const m = await menu(r, hash, mode === "hard");
  const argv = action === "reset" ? m.reset![mode!] : m[action];
  return gitCommitAction(r.dir, action, { ...r.o, hash, headRef: m.headRef, headHash: m.headHash, argv, mode, dirty: m.dirty, ...over });
}
const other = (r: R) => head(r.dir, "other");

describe("undo", () => {
  it("moves HEAD to the parent and keeps the changes staged", async () => {
    const r = repo();
    const parent = head(r.dir, "HEAD~1");
    await act(r, "undo", head(r.dir));
    expect(head(r.dir)).toBe(parent);
    expect(run(r.dir, "diff", "--cached", "--name-only")).toBe("a.txt");
    expect(read(r.dir, "a.txt")).toBe("3\n");
  });
  it("is available without an upstream, refused for another commit, and refused once pushed", async () => {
    const r = repo();
    expect((await menu(r, head(r.dir))).undo).toBeDefined();
    expect((await menu(r, head(r.dir, "HEAD~1"))).why?.undo).toBe("Only the current commit");
    const bare = join(r.root, "o.git");
    run(r.root, "init", "-q", "--bare", bare);
    run(r.dir, "remote", "add", "origin", bare);
    run(r.dir, "push", "-q", "-u", "origin", "main");
    expect((await menu(r, head(r.dir))).why?.undo).toBe("Already pushed to origin/main");
    await expect(act(r, "undo", head(r.dir))).rejects.toMatchObject({ code: "bad_request" });
  });
  it("is refused for the first commit", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "--orphan", "x");
    put(r.dir, "z", "z");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "z");
    expect((await menu(r, head(r.dir))).why?.undo).toBe("This is the first commit");
  });
});

describe("revert", () => {
  it("adds a commit that undoes the change", async () => {
    const r = repo();
    await act(r, "revert", head(r.dir));
    expect(read(r.dir, "a.txt")).toBe("2\n");
    expect(run(r.dir, "log", "-1", "--format=%s")).toMatch(/^Revert "c3"/);
  });
  it("refuses a merge commit and a commit not on the branch", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "other");
    put(r.dir, "b.txt", "b");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "b");
    run(r.dir, "checkout", "-q", "main");
    run(r.dir, "merge", "-q", "--no-ff", "-m", "m", "other");
    const m = head(r.dir);
    expect((await menu(r, m)).why?.revert).toMatch(/^Merge commit/);
    expect((await menu(r, m)).why?.cherryPick).toMatch(/^Merge commit/);
    await expect(act(r, "revert", m, undefined, { argv: ["revert", m] })).rejects.toMatchObject({ code: "bad_request" });
    run(r.dir, "branch", "side", "HEAD~1");
    run(r.dir, "checkout", "-q", "side");
    run(r.dir, "commit", "-q", "--allow-empty", "-m", "s");
    run(r.dir, "checkout", "-q", "main");
    expect((await menu(r, head(r.dir, "side"))).why?.revert).toBe("Not on main");
  });
});

describe("cherry-pick", () => {
  it("applies a commit of another branch, also one checked out in a linked worktree", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "other");
    put(r.dir, "b.txt", "b\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "b");
    run(r.dir, "checkout", "-q", "main");
    const wt = join(r.root, "wt");
    run(r.dir, "worktree", "add", "-q", wt, "other");
    await act(r, "cherryPick", other(r));
    expect(read(r.dir, "b.txt")).toBe("b\n");
  });
  it("is refused for a commit already on HEAD", async () => {
    const r = repo();
    expect((await menu(r, head(r.dir))).why?.cherryPick).toBe("Already on main");
    expect((await menu(r, head(r.dir, "HEAD~1"))).why?.cherryPick).toBe("Already on main");
  });
});

describe("conflicts", () => {
  it("a conflicting revert and cherry-pick stop with the operation", async () => {
    const r = repo();
    const rev = await act(r, "revert", head(r.dir, "HEAD~1"));
    expect(rev!.operation).toEqual({ kind: "revert", conflicted: ["a.txt"] });
    run(r.dir, "revert", "--abort");
    run(r.dir, "checkout", "-q", "other");
    put(r.dir, "a.txt", "x\n");
    run(r.dir, "commit", "-qam", "x");
    run(r.dir, "checkout", "-q", "main");
    const cp = await act(r, "cherryPick", other(r));
    expect(cp!.operation).toEqual({ kind: "cherry-pick", conflicted: ["a.txt"] });
    expect((await menu(r, head(r.dir))).why?.reset).toBe("Resolve the conflicts first");
  });
});

describe("reset", () => {
  it("soft keeps the index, mixed unstages, hard cleans", async () => {
    const r = repo();
    const c1 = head(r.dir, "HEAD~2");
    await act(r, "reset", c1, "soft");
    expect(head(r.dir)).toBe(c1);
    expect(run(r.dir, "diff", "--cached", "--name-only")).toBe("a.txt");
    await act(r, "reset", c1, "mixed");
    expect(run(r.dir, "diff", "--cached", "--name-only")).toBe("");
    expect(run(r.dir, "diff", "--name-only")).toBe("a.txt");
    await act(r, "reset", c1, "hard");
    expect(read(r.dir, "a.txt")).toBe("1\n");
    expect(run(r.dir, "status", "--porcelain")).toBe("");
  });
  it("hard previews and snapshots each lost file (modified tracked and overwritten untracked) with reason reset; soft and mixed snapshot nothing", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "other");
    put(r.dir, "n.txt", "n\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "n");
    run(r.dir, "checkout", "-q", "main");
    put(r.dir, "a.txt", "dirty\n");
    put(r.dir, "n.txt", "mine\n");
    await act(r, "reset", head(r.dir, "HEAD~1"), "soft");
    await act(r, "reset", head(r.dir, "HEAD"), "mixed");
    expect(r.seen).toEqual([]);
    const m = await menu(r, other(r), true);
    expect(m.lose).toEqual(["a.txt", "n.txt"]);
    expect(m.loseCount).toBe(2);
    await act(r, "reset", other(r), "hard");
    expect(read(r.dir, "n.txt")).toBe("n\n");
    expect(r.seen.map((s) => ({ ...s, path: s.path.slice(r.dir.length + 1) })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "a.txt", reason: "reset", text: "dirty\n" },
      { path: "n.txt", reason: "reset", text: "mine\n" },
    ]);
  });
  it("hard is stale after a lost file changes, after HEAD moved, and for another command", async () => {
    const r = repo();
    put(r.dir, "a.txt", "dirty\n");
    const c1 = head(r.dir, "HEAD~2");
    const m = await menu(r, c1, true);
    const send = (over: Record<string, unknown>) => gitCommitAction(r.dir, "reset", { ...r.o, hash: c1, headRef: m.headRef, headHash: m.headHash, argv: m.reset!.hard, mode: "hard", dirty: m.dirty, ...over });
    await expect(send({ headHash: c1 })).rejects.toMatchObject({ code: "stale" });
    await expect(send({ argv: m.reset!.mixed })).rejects.toMatchObject({ code: "stale" });
    await expect(send({ dirty: undefined })).rejects.toMatchObject({ code: "bad_request" });
    put(r.dir, "a.txt", "dirty again\n");
    utimesSync(join(r.dir, "a.txt"), new Date(), new Date(Date.now() + 5000));
    await expect(send({})).rejects.toMatchObject({ code: "stale", message: expect.stringContaining("Files changed since the dialog opened") });
    expect(read(r.dir, "a.txt")).toBe("dirty again\n");
  });
});

describe("reset hard preview size", () => {
  it("lists every lost file when the names total more than 8000 characters, and a late edit of the first is stale", async () => {
    const r = repo();
    const names = Array.from({ length: 300 }, (_, i) => `${"d".repeat(40)}${String(i).padStart(3, "0")}.txt`);
    for (const n of names) put(r.dir, n, "x\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "many");
    for (const n of names) put(r.dir, n, "y\n");
    const c1 = head(r.dir, "HEAD~1");
    const m = await menu(r, c1, true);
    expect(m.loseCount).toBe(300);
    expect(m.lose![0]).toBe(names[0]);
    put(r.dir, names[0]!, "edited after the preview\n");
    await expect(gitCommitAction(r.dir, "reset", { ...r.o, hash: c1, headRef: m.headRef, headHash: m.headHash, argv: m.reset!.hard, mode: "hard", dirty: m.dirty })).rejects.toMatchObject({ code: "stale" });
  });
});

describe("blocked states", () => {
  it("detached HEAD", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "--detach");
    const m = await menu(r, head(r.dir));
    expect(m.why).toEqual({ undo: "HEAD is detached", revert: "HEAD is detached", cherryPick: "HEAD is detached", reset: "HEAD is detached", reword: "HEAD is detached" });
    expect(m.reset).toBeUndefined();
  });
  it("an operation in progress without conflicts", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "other");
    put(r.dir, "b.txt", "b\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "b");
    run(r.dir, "checkout", "-q", "main");
    run(r.dir, "merge", "-q", "--no-commit", "--no-ff", "other");
    expect((await menu(r, head(r.dir))).why?.reset).toBe("Finish or abort the merge first");
  });
  it("an unknown or bad hash", async () => {
    const r = repo();
    await expect(gitCommitMenu(r.dir, { ...r.o, hash: "x" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitCommitMenu(r.dir, { ...r.o, hash: "0".repeat(40) })).rejects.toMatchObject({ code: "bad_request" });
  });
});
