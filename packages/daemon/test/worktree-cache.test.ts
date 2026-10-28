// Worktree status cache (GH-463): an unchanged worktree is served without git; changes (fingerprint) and marks (turn end, daemon git writes) recompute.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachedStatuses, markRepoStale, markWorktreeStale, worktreeStatus } from "../src/git.ts";
import { setGitRunner, threadRunner, type GitRunOptions } from "../src/git-runner.ts";

afterEach(() => setGitRunner(undefined));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const allowed = () => true;
const tick = () => new Promise((r) => setTimeout(r, 15));
function repo(n = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wtc-")));
  const main = join(root, "r");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "a.txt"), "one\n");
  git(main, "add", ".");
  git(main, "commit", "-qm", "one");
  const paths = Array.from({ length: n }, (_, i) => {
    const p = join(main, ".claude", "worktrees", `w${i}`);
    git(main, "worktree", "add", "-q", "-b", `w${i}`, p);
    return p;
  });
  return { main, paths };
}
const spy = () => {
  const calls: GitRunOptions[] = [];
  setGitRunner((o) => (calls.push(o), threadRunner(o)));
  return calls;
};
const status = (main: string, p: string) => worktreeStatus(main, p, allowed);

describe("worktree status cache", () => {
  it("an unchanged worktree is served from the cache with no git process", async () => {
    const { main, paths } = repo(1);
    const first = await status(main, paths[0]!);
    const calls = spy();
    await tick();
    const second = await status(main, paths[0]!);
    expect(calls.length).toBe(0);
    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it("an index change recomputes", async () => {
    const { main, paths } = repo(1);
    const first = await status(main, paths[0]!);
    writeFileSync(join(paths[0]!, "n.txt"), "x");
    git(paths[0]!, "add", "n.txt");
    const calls = spy();
    await tick();
    const second = await status(main, paths[0]!);
    expect(calls.length).toBeGreaterThan(0);
    expect(second.checkedAt).toBeGreaterThan(first.checkedAt);
    expect(second.uncommitted).toBe(1);
  });

  it("a ref change in another worktree of the repository recomputes", async () => {
    const { main, paths } = repo(2);
    const first = await status(main, paths[0]!);
    git(paths[1]!, "commit", "-q", "--allow-empty", "-m", "other");
    const calls = spy();
    await tick();
    const second = await status(main, paths[0]!);
    expect(calls.length).toBeGreaterThan(0);
    expect(second.checkedAt).toBeGreaterThan(first.checkedAt);
  });

  it("markWorktreeStale of a subfolder recomputes that worktree only", async () => {
    const { main, paths } = repo(2);
    const [a, b] = [await status(main, paths[0]!), await status(main, paths[1]!)];
    mkdirSync(join(paths[0]!, "sub"));
    markWorktreeStale(join(paths[0]!, "sub"));
    const calls = spy();
    await tick();
    expect((await status(main, paths[1]!)).checkedAt).toBe(b.checkedAt);
    expect(calls.length).toBe(0);
    expect((await status(main, paths[0]!)).checkedAt).toBeGreaterThan(a.checkedAt);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("markRepoStale recomputes every worktree of the repository", async () => {
    const { main, paths } = repo(2);
    const before = [await status(main, paths[0]!), await status(main, paths[1]!)];
    markRepoStale(main);
    await tick();
    expect((await status(main, paths[0]!)).checkedAt).toBeGreaterThan(before[0]!.checkedAt);
    expect((await status(main, paths[1]!)).checkedAt).toBeGreaterThan(before[1]!.checkedAt);
  });

  it("a mark during a read leaves the stored entry stale", async () => {
    const { main, paths } = repo(1);
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    const started: GitRunOptions[] = [];
    setGitRunner(async (o) => (started.push(o), await open, threadRunner(o)));
    const p = status(main, paths[0]!);
    while (!started.length) await tick();
    markWorktreeStale(paths[0]!);
    release();
    const first = await p;
    setGitRunner(undefined);
    await tick();
    expect((await status(main, paths[0]!)).checkedAt).toBeGreaterThan(first.checkedAt);
  });

  it("known gap: a new untracked file alone is served from the cache", async () => {
    const { main, paths } = repo(1);
    const first = await status(main, paths[0]!);
    writeFileSync(join(paths[0]!, "note.txt"), "x");
    const calls = spy();
    const second = await status(main, paths[0]!);
    expect(calls.length).toBe(0);
    expect(second.untracked).toBe(0);
    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it("cachedStatuses returns entries with stale for changed or marked ones, no git", async () => {
    const { main, paths } = repo(3);
    for (const p of paths) await status(main, p);
    git(paths[1]!, "commit", "-q", "--allow-empty", "-m", "x");
    markWorktreeStale(paths[2]!);
    const calls = spy();
    const out = await cachedStatuses([...paths, join(main, "nope")]);
    expect(calls.length).toBe(0);
    // A ref change anywhere changes every worktree's fingerprint of the repository.
    expect(out[paths[1]!]!.stale).toBe(true);
    expect(out[paths[2]!]!.stale).toBe(true);
    expect(out[paths[0]!]!.stale).toBe(true);
    expect(out[join(main, "nope")]).toBeUndefined();
    const fresh = repo(1);
    await status(fresh.main, fresh.paths[0]!);
    expect((await cachedStatuses(fresh.paths))[fresh.paths[0]!]).not.toHaveProperty("stale");
  });
});
