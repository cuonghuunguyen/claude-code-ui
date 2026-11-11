import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HistoryReason } from "@claude-ui/protocol";
import { gitDiff, gitOperation } from "../src/git.ts";
import { gitBranch } from "../src/git-remote.ts";
import { gitAbort, gitContinue, gitMergeRebase } from "../src/git-write.ts";

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
/** main: a.txt "base"; branch `other` and `main` both change it (conflict), b.txt only on other. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gcf-")));
  const dir = join(root, "r");
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  put(dir, "a.txt", "base\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "init");
  run(dir, "checkout", "-q", "-b", "other");
  put(dir, "a.txt", "other\n");
  put(dir, "b.txt", "b\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "other");
  run(dir, "checkout", "-q", "main");
  put(dir, "a.txt", "main\n");
  run(dir, "commit", "-q", "-am", "main");
  const seen: { path: string; reason: HistoryReason; text: string }[] = [];
  return { root, dir, o: { allowed: (p: string) => p.startsWith(root), snapshot: (p: string, reason: HistoryReason, c?: string) => void seen.push({ path: p, reason, text: c ?? readFileSync(p, "utf8") }) }, seen };
}
type R = ReturnType<typeof repo>;
const head = (dir: string) => run(dir, "rev-parse", "HEAD");
/** Menu data, then the write the dialog would send. */
async function start(r: R, verb: "merge" | "rebase", ref = "refs/heads/other") {
  const info = (await gitBranch(r.dir, ref, r.o))!;
  return gitMergeRebase(r.dir, verb, { ...r.o, ref, local: info.local, headRef: info.headRef, headHash: info.headHash, argv: info[verb] });
}
const resolved = (r: R, text = "main+other\n") => put(r.dir, "a.txt", text);

describe("gitOperation", () => {
  it("is undefined in a clean repository", async () => {
    expect(await gitOperation(repo().dir)).toBeUndefined();
  });
  it("names rebase (merge backend and apply backend)", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "other");
    tryRun(r.dir, "rebase", "main");
    expect(await gitOperation(r.dir)).toEqual({ kind: "rebase", conflicted: ["a.txt"] });
    run(r.dir, "rebase", "--abort");
    tryRun(r.dir, "rebase", "--apply", "main");
    expect(await gitOperation(r.dir)).toEqual({ kind: "rebase", conflicted: ["a.txt"] });
  });
  it("names am", async () => {
    const r = repo();
    const patch = run(r.dir, "format-patch", "-1", "--stdout", "other");
    put(r.dir, "p.patch", `${patch}\n`);
    tryRun(r.dir, "am", "-3", "p.patch");
    expect(await gitOperation(r.dir)).toEqual({ kind: "am", conflicted: ["a.txt"] });
  });
  it("names cherry-pick and revert", async () => {
    const r = repo();
    tryRun(r.dir, "cherry-pick", "other");
    expect(await gitOperation(r.dir)).toEqual({ kind: "cherry-pick", conflicted: ["a.txt"] });
    run(r.dir, "cherry-pick", "--abort");
    tryRun(r.dir, "revert", "HEAD~1");
    expect((await gitOperation(r.dir))?.kind).toBe("revert");
  });
  it("names unmerged entries without a state file as conflict (stash pop)", async () => {
    const r = repo();
    put(r.dir, "a.txt", "stashed\n");
    run(r.dir, "stash", "push", "-q");
    put(r.dir, "a.txt", "changed in head\n");
    run(r.dir, "commit", "-q", "-am", "x");
    tryRun(r.dir, "stash", "pop");
    expect(await gitOperation(r.dir)).toEqual({ kind: "conflict", conflicted: ["a.txt"] });
  });
  it("names merge, with the conflicted files; a linked worktree sees only its own operation", async () => {
    const r = repo();
    const wt = join(r.root, "wt");
    run(r.dir, "worktree", "add", "-q", "-b", "wt", wt, "main");
    tryRun(r.dir, "merge", "other");
    expect(await gitOperation(r.dir)).toEqual({ kind: "merge", conflicted: ["a.txt"] });
    expect(await gitOperation(wt)).toBeUndefined();
  });
});

describe("gitDiff", () => {
  it("carries the operation in both bases, an unmerged path listed once", async () => {
    const r = repo();
    tryRun(r.dir, "merge", "other");
    for (const base of ["head", "branch"] as const) {
      const d = (await gitDiff(r.dir, { base, ref: "refs/heads/other", ...r.o }))!;
      expect(d.operation).toEqual({ kind: "merge", conflicted: ["a.txt"] });
      expect(d.files.filter((f) => f.path === "a.txt")).toHaveLength(1);
    }
    run(r.dir, "merge", "--abort");
    expect((await gitDiff(r.dir, { base: "head", ...r.o }))!.operation).toBeUndefined();
  });
});

describe("branch menu data", () => {
  it("offers merge and rebase against another branch", async () => {
    const r = repo();
    const info = (await gitBranch(r.dir, "refs/heads/other", r.o))!;
    expect(info.headRef).toBe("refs/heads/main");
    expect(info.headHash).toBe(head(r.dir));
    expect(info.merge?.slice(-3)).toEqual(["merge", "--no-edit", "other"]);
    run(r.dir, "tag", "other2", "other");
    run(r.dir, "branch", "other2x", "main");
    run(r.dir, "tag", "other2x", "other");
    expect((await gitBranch(r.dir, "refs/heads/other2x", r.o))!.merge?.at(-1)).toBe("refs/heads/other2x");
    expect(info.rebase?.slice(-2)).toEqual(["rebase", "refs/heads/other"]);
  });
  it("says why not: current branch, detached HEAD, operation in progress", async () => {
    const r = repo();
    expect((await gitBranch(r.dir, "refs/heads/main", r.o))!.why?.merge).toBe("This is the current branch");
    run(r.dir, "checkout", "-q", "--detach");
    expect((await gitBranch(r.dir, "refs/heads/other", r.o))!.why?.rebase).toBe("HEAD is detached");
    run(r.dir, "checkout", "-q", "main");
    tryRun(r.dir, "merge", "other");
    expect((await gitBranch(r.dir, "refs/heads/other", r.o))!.why?.merge).toBe("Resolve the conflicts first");
  });
});

describe("merge and rebase", () => {
  it("fast-forwards and merges cleanly", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "other");
    run(r.dir, "checkout", "-q", "-b", "ahead");
    put(r.dir, "c.txt", "c\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "c");
    run(r.dir, "checkout", "-q", "other");
    const res = await start(r, "merge", "refs/heads/ahead");
    expect(res!.operation).toBeUndefined();
    expect(head(r.dir)).toBe(run(r.dir, "rev-parse", "ahead"));
    // a true merge: main and a non-conflicting branch
    run(r.dir, "checkout", "-q", "-b", "side", "main~1");
    put(r.dir, "s.txt", "s\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "s");
    run(r.dir, "checkout", "-q", "main");
    await start(r, "merge", "refs/heads/side");
    expect(run(r.dir, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    expect(run(r.dir, "log", "-1", "--format=%s")).toBe("Merge branch 'side'");
  });
  it("rebases cleanly to a linear history", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "-b", "side", "main~1");
    put(r.dir, "s.txt", "s\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "s");
    await start(r, "rebase", "refs/heads/main");
    expect(run(r.dir, "log", "--format=%P", "main..side").split(" ")).toHaveLength(1);
    expect(run(r.dir, "merge-base", "main", "side")).toBe(run(r.dir, "rev-parse", "main"));
  });
  it("refuses a moved branch, a moved HEAD, a changed command and the current branch", async () => {
    const r = repo();
    const info = (await gitBranch(r.dir, "refs/heads/other", r.o))!;
    const ok = { ...r.o, ref: "refs/heads/other", local: info.local, headRef: info.headRef, headHash: info.headHash, argv: info.merge };
    await expect(gitMergeRebase(r.dir, "merge", { ...ok, local: "0".repeat(40) })).rejects.toMatchObject({ code: "stale", message: "other moved since the menu opened: reopen it" });
    await expect(gitMergeRebase(r.dir, "merge", { ...ok, headHash: "0".repeat(40) })).rejects.toMatchObject({ code: "stale", message: "HEAD moved since the menu opened: reopen it" });
    await expect(gitMergeRebase(r.dir, "merge", { ...ok, argv: info.rebase })).rejects.toMatchObject({ code: "stale", message: "The command changed since the menu opened" });
    const cur = (await gitBranch(r.dir, "refs/heads/main", r.o))!;
    await expect(gitMergeRebase(r.dir, "merge", { ...ok, ref: "refs/heads/main", local: cur.local, argv: [] })).rejects.toMatchObject({ code: "bad_request", message: "This is the current branch" });
    expect(head(r.dir)).toBe(info.headHash);
  });
});

describe("conflicts", () => {
  it("merge stops on a conflict; Continue is refused while markers remain, then merges with two parents", async () => {
    const r = repo();
    const res = await start(r, "merge");
    expect(res!.operation).toEqual({ kind: "merge", conflicted: ["a.txt"] });
    const before = readFileSync(join(r.dir, "a.txt"), "utf8");
    await expect(gitContinue(r.dir, { kind: "merge", ...r.o })).rejects.toMatchObject({ code: "bad_request", message: "Conflict markers remain in a.txt" });
    expect(readFileSync(join(r.dir, "a.txt"), "utf8")).toBe(before);
    expect((await gitOperation(r.dir))?.kind).toBe("merge");
    resolved(r);
    const done = await gitContinue(r.dir, { kind: "merge", ...r.o });
    expect(done!.operation).toBeUndefined();
    expect(run(r.dir, "log", "-1", "--format=%P").split(" ")).toHaveLength(2);
    expect(await gitOperation(r.dir)).toBeUndefined();
  });
  it("rebase with two conflicting commits stops twice", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "other");
    put(r.dir, "a.txt", "other2\n");
    run(r.dir, "commit", "-q", "-am", "other2");
    const info = (await gitBranch(r.dir, "refs/heads/main", r.o))!;
    const first = await gitMergeRebase(r.dir, "rebase", { ...r.o, ref: "refs/heads/main", local: info.local, headRef: info.headRef, headHash: info.headHash, argv: info.rebase });
    expect(first!.operation?.kind).toBe("rebase");
    resolved(r, "step1\n");
    const second = await gitContinue(r.dir, { kind: "rebase", ...r.o });
    expect(second!.operation?.kind).toBe("rebase");
    resolved(r, "step2\n");
    const done = await gitContinue(r.dir, { kind: "rebase", ...r.o });
    expect(done!.operation).toBeUndefined();
    expect(await gitOperation(r.dir)).toBeUndefined();
    expect(run(r.dir, "log", "--format=%s", "main..HEAD")).toBe("other2\nother");
  });
  it("continues a cherry-pick and a revert although GIT_EDITOR fails", async () => {
    const r = repo();
    process.env.GIT_EDITOR = "false";
    try {
      tryRun(r.dir, "cherry-pick", "other");
      resolved(r);
      expect((await gitContinue(r.dir, { kind: "cherry-pick", ...r.o }))!.operation).toBeUndefined();
      expect(run(r.dir, "log", "-1", "--format=%s")).toBe("other");
      tryRun(r.dir, "revert", "HEAD~1");
      resolved(r, "reverted\n");
      expect((await gitContinue(r.dir, { kind: "revert", ...r.o }))!.operation).toBeUndefined();
      expect(await gitOperation(r.dir)).toBeUndefined();
    } finally {
      delete process.env.GIT_EDITOR;
    }
  });
  it("Abort restores HEAD and the status for merge, rebase, cherry-pick and revert", async () => {
    for (const [kind, setup] of [
      ["merge", (r: R) => tryRun(r.dir, "merge", "other")],
      ["rebase", (r: R) => (run(r.dir, "checkout", "-q", "other"), tryRun(r.dir, "rebase", "main"))],
      ["cherry-pick", (r: R) => tryRun(r.dir, "cherry-pick", "other")],
      ["revert", (r: R) => tryRun(r.dir, "revert", "HEAD~1")],
    ] as const) {
      const r = repo();
      if (kind === "rebase") run(r.dir, "checkout", "-q", "other");
      const h = head(r.dir);
      const st = run(r.dir, "status", "--porcelain");
      if (kind === "rebase") run(r.dir, "checkout", "-q", "main");
      setup(r);
      const ref = kind === "rebase" ? head(r.dir) : h;
      await gitAbort(r.dir, { kind, ...r.o });
      expect(await gitOperation(r.dir)).toBeUndefined();
      expect(head(r.dir)).toBe(kind === "rebase" ? run(r.dir, "rev-parse", "other") : ref);
      expect(run(r.dir, "status", "--porcelain")).toBe(st);
    }
  });
  it("kind conflict: Abort goes back to HEAD and keeps the stash; Mark resolved keeps the content and commits nothing", async () => {
    const mk = () => {
      const r = repo();
      put(r.dir, "a.txt", "stashed\n");
      run(r.dir, "stash", "push", "-q");
      put(r.dir, "a.txt", "changed in head\n");
      run(r.dir, "commit", "-q", "-am", "x");
      tryRun(r.dir, "stash", "pop");
      return r;
    };
    const a = mk();
    put(a.dir, "keep.txt", "staged\n");
    run(a.dir, "add", "keep.txt");
    await gitAbort(a.dir, { kind: "conflict", ...a.o });
    expect(readFileSync(join(a.dir, "a.txt"), "utf8")).toBe("changed in head\n");
    expect(run(a.dir, "stash", "list")).not.toBe("");
    expect(run(a.dir, "status", "--porcelain")).toBe("A  keep.txt");
    const b = mk();
    const h = head(b.dir);
    resolved(b, "mine\n");
    await gitContinue(b.dir, { kind: "conflict", ...b.o });
    expect(await gitOperation(b.dir)).toBeUndefined();
    expect(readFileSync(join(b.dir, "a.txt"), "utf8")).toBe("mine\n");
    expect(head(b.dir)).toBe(h);
  });
  it("Abort snapshots the conflict-marker text with reason abort: kind conflict, and a merge together with other tracked edits", async () => {
    const c = repo();
    put(c.dir, "a.txt", "stashed\n");
    run(c.dir, "stash", "push", "-q");
    put(c.dir, "a.txt", "changed in head\n");
    run(c.dir, "commit", "-q", "-am", "x");
    tryRun(c.dir, "stash", "pop");
    const marked = readFileSync(join(c.dir, "a.txt"), "utf8");
    expect(marked).toContain("<<<<<<<");
    await gitAbort(c.dir, { kind: "conflict", ...c.o });
    expect(c.seen).toEqual([{ path: join(c.dir, "a.txt"), reason: "abort", text: marked }]);
    const m = repo();
    tryRun(m.dir, "merge", "other");
    const mergeMarked = readFileSync(join(m.dir, "a.txt"), "utf8");
    await gitAbort(m.dir, { kind: "merge", ...m.o });
    // b.txt came in staged from the merge: a tracked change vs HEAD the abort drops as well.
    expect(m.seen.map((x) => ({ ...x, path: x.path.slice(m.dir.length + 1) })).sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "a.txt", reason: "abort", text: mergeMarked },
      { path: "b.txt", reason: "abort", text: "b\n" },
    ]);
  });
  it("kind conflict: Abort removes a conflicted path that HEAD lacks (deleted by us)", async () => {
    const r = repo();
    put(r.dir, "a.txt", "stashed\n");
    run(r.dir, "stash", "push", "-q");
    run(r.dir, "rm", "-q", "a.txt");
    run(r.dir, "commit", "-q", "-m", "drop a");
    tryRun(r.dir, "stash", "pop");
    expect((await gitOperation(r.dir))?.kind).toBe("conflict");
    await gitAbort(r.dir, { kind: "conflict", ...r.o });
    expect(existsSync(join(r.dir, "a.txt"))).toBe(false);
    expect(run(r.dir, "status", "--porcelain")).toBe("");
    expect(run(r.dir, "stash", "list")).not.toBe("");
  });
  it("Continue and Abort without an operation, or for another kind, are stale", async () => {
    const r = repo();
    await expect(gitContinue(r.dir, { kind: "merge", ...r.o })).rejects.toMatchObject({ code: "stale", message: "No git operation is in progress: reload" });
    await expect(gitAbort(r.dir, { kind: "merge", ...r.o })).rejects.toMatchObject({ code: "stale" });
    tryRun(r.dir, "merge", "other");
    await expect(gitAbort(r.dir, { kind: "rebase", ...r.o })).rejects.toMatchObject({ code: "stale", message: "The repository changed: reload" });
    await expect(gitAbort(r.dir, { kind: "nope" as never, ...r.o })).rejects.toMatchObject({ code: "bad_request" });
    expect(existsSync(join(r.dir, ".git", "MERGE_HEAD"))).toBe(true);
  });
});
