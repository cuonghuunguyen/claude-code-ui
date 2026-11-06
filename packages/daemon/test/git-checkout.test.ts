import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HistoryReason } from "@claude-ui/protocol";
import { gitBranchCreate, gitCheckout } from "../src/git-write.ts";

vi.setConfig({ testTimeout: process.platform === "win32" ? 120_000 : 60_000 });
const run = (cwd: string, ...args: string[]) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.editor=true", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
};
const tryRun = (cwd: string, ...args: string[]) => {
  try {
    run(cwd, ...args);
  } catch {
    // a conflict exits 1: expected
  }
};
const put = (dir: string, f: string, text: string) => writeFileSync(join(dir, f), text);
/** main (a.txt "base" then "main"), branch `other` (a.txt "other", b.txt), bare origin with `feat`. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gco-")));
  const dir = join(root, "r");
  const origin = join(root, "origin.git");
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  put(dir, "a.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "init");
  const first = run(dir, "rev-parse", "HEAD");
  run(dir, "checkout", "-q", "-b", "other");
  put(dir, "a.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nother\n");
  put(dir, "b.txt", "b\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "other");
  run(dir, "checkout", "-q", "main");
  put(dir, "a.txt", "main\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n");
  run(dir, "commit", "-q", "-am", "main");
  run(root, "init", "-q", "--bare", origin);
  run(dir, "remote", "add", "origin", origin);
  run(dir, "branch", "feat", "other");
  run(dir, "push", "-q", "origin", "feat");
  run(dir, "branch", "-q", "-D", "feat");
  run(dir, "fetch", "-q", "origin");
  const seen: { path: string; reason: HistoryReason; text: string }[] = [];
  return { root, dir, first, o: { allowed: (p: string) => p.startsWith(root), snapshot: (p: string, reason: HistoryReason, c?: string) => void seen.push({ path: p, reason, text: c ?? readFileSync(p, "utf8") }) }, seen };
}
const head = (dir: string) => run(dir, "rev-parse", "HEAD");
const cur = (dir: string) => run(dir, "symbolic-ref", "HEAD");
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code?: string }) => e.code);

describe("gitBranchCreate", () => {
  it("creates at HEAD without checkout", async () => {
    const r = repo();
    const w = await gitBranchCreate(r.dir, { ...r.o, name: "x" });
    expect(w?.refs).toBeTruthy();
    expect(run(r.dir, "rev-parse", "x")).toBe(head(r.dir));
    expect(cur(r.dir)).toBe("refs/heads/main");
  });
  it("creates at an older commit with checkout", async () => {
    const r = repo();
    await gitBranchCreate(r.dir, { ...r.o, name: "x", at: r.first, checkout: true });
    expect(cur(r.dir)).toBe("refs/heads/x");
    expect(head(r.dir)).toBe(r.first);
  });
  it("refuses a bad name, a bad commit and an existing name", async () => {
    const r = repo();
    for (const name of ["-x", "a..b", "", "a b", "x\0y", 5]) expect(await code(gitBranchCreate(r.dir, { ...r.o, name: name as string }))).toBe("bad_request");
    expect(await code(gitBranchCreate(r.dir, { ...r.o, name: "x", at: "main" }))).toBe("bad_request");
    expect(await code(gitBranchCreate(r.dir, { ...r.o, name: "x", smart: "yes" as unknown as boolean }))).toBe("bad_request");
    expect(await code(gitBranchCreate(r.dir, { ...r.o, name: "other" }))).toBe("git_failed");
  });
  it("with checkout and a conflicting local change: local_changes, no branch", async () => {
    const r = repo();
    put(r.dir, "a.txt", "mine\n");
    expect(await code(gitBranchCreate(r.dir, { ...r.o, name: "x", at: run(r.dir, "rev-parse", "other"), checkout: true }))).toBe("local_changes");
    expect(tryRevParse(r.dir, "x")).toBe(false);
    expect(cur(r.dir)).toBe("refs/heads/main");
  });
});
const tryRevParse = (dir: string, ref: string) => {
  try {
    run(dir, "rev-parse", "--verify", "-q", ref);
    return true;
  } catch {
    return false;
  }
};

describe("gitCheckout", () => {
  it("checks out a local branch", async () => {
    const r = repo();
    await gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other" });
    expect(cur(r.dir)).toBe("refs/heads/other");
  });
  it("checks out a remote branch as a new tracking local branch", async () => {
    const r = repo();
    await gitCheckout(r.dir, { ...r.o, ref: "refs/remotes/origin/feat" });
    expect(cur(r.dir)).toBe("refs/heads/feat");
    expect(run(r.dir, "rev-parse", "--abbrev-ref", "feat@{upstream}")).toBe("origin/feat");
  });
  it("refuses origin/HEAD, a missing ref, a tag, a bad ref", async () => {
    const r = repo();
    run(r.dir, "remote", "set-head", "origin", "feat");
    expect(await code(gitCheckout(r.dir, { ...r.o, ref: "refs/remotes/origin/HEAD" }))).toBe("bad_request");
    expect(await code(gitCheckout(r.dir, { ...r.o, ref: "refs/remotes/origin/nope" }))).toBe("bad_request");
    expect(await code(gitCheckout(r.dir, { ...r.o, ref: "refs/tags/v1" }))).toBe("bad_request");
    expect(await code(gitCheckout(r.dir, { ...r.o, ref: "-x" }))).toBe("bad_request");
    expect(await code(gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other", smart: 1 as unknown as boolean }))).toBe("bad_request");
  });
  it("a conflicting tracked change: local_changes, nothing moves", async () => {
    const r = repo();
    put(r.dir, "a.txt", "mine\n");
    const before = head(r.dir);
    expect(await code(gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other" }))).toBe("local_changes");
    expect(head(r.dir)).toBe(before);
    expect(readFileSync(join(r.dir, "a.txt"), "utf8")).toBe("mine\n");
  });
  it("smart: stashes, switches, applies; stash list empty", async () => {
    const r = repo();
    // other changes a.txt "base"->"other"; a local edit that merges cleanly onto it
    run(r.dir, "checkout", "-q", "-b", "base", r.first);
    put(r.dir, "a.txt", "mine\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n");
    expect(await code(gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other" }))).toBe("local_changes");
    const w = await gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other", smart: true });
    expect(w?.operation).toBeUndefined();
    expect(cur(r.dir)).toBe("refs/heads/other");
    expect(readFileSync(join(r.dir, "a.txt"), "utf8")).toContain("mine");
    expect(run(r.dir, "stash", "list")).toBe("");
  });
  it("smart snapshots the dirty tracked files before the stash with reason checkout; a plain checkout snapshots nothing", async () => {
    const r = repo();
    await gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other" });
    await gitCheckout(r.dir, { ...r.o, ref: "refs/heads/main" });
    expect(r.seen).toEqual([]);
    put(r.dir, "a.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nmine\n");
    await gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other", smart: true });
    expect(r.seen).toEqual([{ path: join(r.dir, "a.txt"), reason: "checkout", text: "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nmine\n" }]);
  });
  it("smart with a pop conflict: operation conflict, stash kept", async () => {
    const r = repo();
    put(r.dir, "a.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nmine\n");
    const w = await gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other", smart: true });
    expect(cur(r.dir)).toBe("refs/heads/other");
    expect(w?.operation).toEqual({ kind: "conflict", conflicted: ["a.txt"] });
    expect(run(r.dir, "stash", "list").split("\n")).toHaveLength(1);
  });
  it("an untracked file in the way: git_failed, not local_changes", async () => {
    const r = repo();
    put(r.dir, "b.txt", "mine\n");
    expect(await code(gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other", smart: true }))).toBe("git_failed");
    expect(run(r.dir, "stash", "list")).toBe("");
  });
  it("smart whose switch then fails (untracked file in the way too): the stash is popped back, nothing is lost", async () => {
    const r = repo();
    put(r.dir, "a.txt", "mine\n");
    put(r.dir, "b.txt", "untracked\n");
    const before = head(r.dir);
    expect(await code(gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other", smart: true }))).toBe("git_failed");
    expect(head(r.dir)).toBe(before);
    expect(readFileSync(join(r.dir, "a.txt"), "utf8")).toBe("mine\n");
    expect(run(r.dir, "stash", "list")).toBe("");
  });
  it("a branch checked out in another work tree: git_failed naming it", async () => {
    const r = repo();
    const wt = join(r.root, "wt");
    run(r.dir, "worktree", "add", "-q", wt, "other");
    const e = await gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other" }).catch((x: Error & { code: string }) => x);
    expect((e as { code: string }).code).toBe("git_failed");
    expect((e as Error).message).toContain("wt");
  });
  it("is refused during a merge; outside the roots it fails", async () => {
    const r = repo();
    put(r.dir, "a.txt", "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nmain9\n");
    run(r.dir, "commit", "-q", "-am", "m9");
    tryRun(r.dir, "merge", "other");
    expect(await code(gitCheckout(r.dir, { ...r.o, ref: "refs/heads/other" }))).toBe("bad_request");
    expect(await code(gitBranchCreate(r.dir, { ...r.o, name: "x" }))).toBe("bad_request");
    expect(await code(gitCheckout(r.dir, { allowed: () => false, snapshot: () => {}, ref: "refs/heads/other" }))).toBe("cwd_not_allowed");
  });
});
