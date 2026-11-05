import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { gitLog } from "../src/git.ts";
import { gitStash, gitStashList, gitStashPush } from "../src/git-write.ts";

vi.setConfig({ testTimeout: process.platform === "win32" ? 120_000 : 60_000 });
const run = (cwd: string, ...args: string[]) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.editor=true", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
};
const put = (dir: string, f: string, text: string) => writeFileSync(join(dir, f), text);
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
/** main: a.txt "base". */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gst-")));
  const dir = join(root, "r");
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  put(dir, "a.txt", "base\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "init");
  return { root, dir, o: { allowed: (p: string) => p.startsWith(root) } };
}
type R = ReturnType<typeof repo>;
const count = (r: R) => run(r.dir, "stash", "list").split("\n").filter(Boolean).length;
/** Two entries: stash@{1} has "one", stash@{0} has "two". */
async function two(r: R) {
  put(r.dir, "a.txt", "one\n");
  await gitStashPush(r.dir, { ...r.o, message: "first" });
  put(r.dir, "a.txt", "two\n");
  await gitStashPush(r.dir, { ...r.o, message: "second" });
  return (await gitStashList(r.dir, r.o))!;
}
const entry = (e: { index: number; hash: string }) => ({ index: e.index, hash: e.hash });

describe("gitStashPush", () => {
  it("stashes a tracked change with a message and leaves a clean work tree", async () => {
    const r = repo();
    put(r.dir, "a.txt", "edit\n");
    const w = await gitStashPush(r.dir, { ...r.o, message: "  wip  " });
    expect(w?.refs).toBeTruthy();
    expect(run(r.dir, "stash", "list")).toMatch(/^stash@\{0\}: On main: wip$/);
    expect(run(r.dir, "status", "--porcelain")).toBe("");
  });
  it("takes untracked files only with includeUntracked", async () => {
    const r = repo();
    put(r.dir, "a.txt", "edit\n");
    put(r.dir, "u.txt", "u\n");
    await gitStashPush(r.dir, r.o);
    expect(existsSync(join(r.dir, "u.txt"))).toBe(true);
    put(r.dir, "a.txt", "edit2\n");
    await gitStashPush(r.dir, { ...r.o, includeUntracked: true });
    expect(existsSync(join(r.dir, "u.txt"))).toBe(false);
    const [top] = (await gitStashList(r.dir, r.o))!;
    await gitStash(r.dir, "pop", { ...r.o, ...entry(top) });
    expect(read(r.dir, "u.txt")).toBe("u\n");
  });
  it("refuses nothing to save and bad arguments", async () => {
    const r = repo();
    await expect(gitStashPush(r.dir, r.o)).rejects.toMatchObject({ code: "bad_request", message: "No local changes to save" });
    expect(count(r)).toBe(0);
    for (const message of ["a\0b", 5, "x".repeat(4097)]) await expect(gitStashPush(r.dir, { ...r.o, message }), String(message).slice(0, 5)).rejects.toMatchObject({ code: "bad_request" });
    await expect(gitStashPush(r.dir, { ...r.o, includeUntracked: "yes" })).rejects.toMatchObject({ code: "bad_request" });
  });
  it("takes a message that starts with a dash as the message", async () => {
    const r = repo();
    put(r.dir, "a.txt", "edit\n");
    await gitStashPush(r.dir, { ...r.o, message: "--keep-index" });
    expect(run(r.dir, "stash", "list")).toMatch(/On main: --keep-index$/);
  });
});

describe("gitStashList", () => {
  it("lists newest first with index, hash, message and time", async () => {
    const r = repo();
    const list = await two(r);
    expect(list.map((s) => s.index)).toEqual([0, 1]);
    expect(list[0].hash).toBe(run(r.dir, "rev-parse", "stash@{0}"));
    expect(list[1].hash).toBe(run(r.dir, "rev-parse", "stash@{1}"));
    expect(list.map((s) => s.message)).toEqual(["On main: second", "On main: first"]);
    expect(list[0].time).toBeGreaterThan(1_600_000_000);
  });
  it("is empty without entries and null outside a work tree", async () => {
    const r = repo();
    expect(await gitStashList(r.dir, r.o)).toEqual([]);
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "gst-plain-")));
    expect(await gitStashList(plain, { allowed: () => true })).toBeNull();
  });
});

describe("gitStash", () => {
  it("applies keeps the entries, pops removes one, drops removes one without touching the work tree", async () => {
    const r = repo();
    const [s0, s1] = await two(r);
    await gitStash(r.dir, "apply", { ...r.o, ...entry(s1) });
    expect(read(r.dir, "a.txt")).toBe("one\n");
    expect(count(r)).toBe(2);
    run(r.dir, "checkout", "--", "a.txt");
    await gitStash(r.dir, "pop", { ...r.o, ...entry(s0) });
    expect(read(r.dir, "a.txt")).toBe("two\n");
    expect(count(r)).toBe(1);
    const [left] = (await gitStashList(r.dir, r.o))!;
    await gitStash(r.dir, "drop", { ...r.o, ...entry(left) });
    expect(count(r)).toBe(0);
    expect(read(r.dir, "a.txt")).toBe("two\n");
  });
  it("is stale when the hash is not the entry at the index, and refuses bad arguments", async () => {
    const r = repo();
    const [s0, s1] = await two(r);
    await expect(gitStash(r.dir, "drop", { ...r.o, index: 0, hash: s1.hash })).rejects.toMatchObject({ code: "stale" });
    await expect(gitStash(r.dir, "pop", { ...r.o, index: 5, hash: s0.hash })).rejects.toMatchObject({ code: "stale" });
    expect(count(r)).toBe(2);
    for (const a of [{ index: -1, hash: s0.hash }, { index: 1.5, hash: s0.hash }, { index: 0, hash: "nope" }, { index: "0", hash: s0.hash }]) await expect(gitStash(r.dir, "drop", { ...r.o, ...a })).rejects.toMatchObject({ code: "bad_request" });
    expect(count(r)).toBe(2);
  });
  it("stops on a conflict with an operation and keeps the entry (pop and apply)", async () => {
    for (const verb of ["pop", "apply"] as const) {
      const r = repo();
      put(r.dir, "a.txt", "stashed\n");
      await gitStashPush(r.dir, r.o);
      put(r.dir, "a.txt", "committed\n");
      run(r.dir, "commit", "-q", "-am", "other");
      const [s] = (await gitStashList(r.dir, r.o))!;
      const w = await gitStash(r.dir, verb, { ...r.o, ...entry(s) });
      expect(w?.operation, verb).toEqual({ kind: "conflict", conflicted: ["a.txt"] });
      expect(count(r), verb).toBe(1);
    }
  });
  it("fails with git's text, no operation, when apply would overwrite a dirty file", async () => {
    const r = repo();
    put(r.dir, "a.txt", "stashed\n");
    await gitStashPush(r.dir, r.o);
    const [s] = (await gitStashList(r.dir, r.o))!;
    put(r.dir, "a.txt", "dirty\n");
    await expect(gitStash(r.dir, "apply", { ...r.o, ...entry(s) })).rejects.toMatchObject({ code: "git_failed", message: expect.stringMatching(/overwritten/) });
    expect(count(r)).toBe(1);
  });
  it("refuses push, apply and pop during an unfinished operation, and drop works", async () => {
    const r = repo();
    put(r.dir, "a.txt", "stashed\n");
    await gitStashPush(r.dir, r.o);
    const [s] = (await gitStashList(r.dir, r.o))!;
    run(r.dir, "checkout", "-q", "-b", "other");
    put(r.dir, "a.txt", "other\n");
    run(r.dir, "commit", "-q", "-am", "other");
    run(r.dir, "checkout", "-q", "main");
    put(r.dir, "a.txt", "main\n");
    run(r.dir, "commit", "-q", "-am", "main");
    try {
      run(r.dir, "merge", "other");
    } catch {
      // a conflict exits 1: expected
    }
    await expect(gitStashPush(r.dir, r.o)).rejects.toMatchObject({ code: "bad_request", message: "Resolve the conflicts first" });
    for (const verb of ["apply", "pop"] as const) await expect(gitStash(r.dir, verb, { ...r.o, ...entry(s) })).rejects.toMatchObject({ code: "bad_request", message: "Resolve the conflicts first" });
    run(r.dir, "add", "a.txt");
    await expect(gitStash(r.dir, "pop", { ...r.o, ...entry(s) })).rejects.toMatchObject({ message: "Finish or abort the merge first" });
    await gitStash(r.dir, "drop", { ...r.o, ...entry(s) });
    expect(count(r)).toBe(0);
  });
});

describe("gitLog", () => {
  it("does not draw the stash commits", async () => {
    const r = repo();
    put(r.dir, "a.txt", "edit\n");
    await gitStashPush(r.dir, r.o);
    const log = await gitLog(r.dir, { allowed: r.o.allowed });
    expect(log?.commits.map((c) => c.subject)).toEqual(["init"]);
  });
});
