import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rewordArgv } from "@claude-ui/protocol";
import { gitCommitMenu, gitReword, writeConfig } from "../src/git-write.ts";
import { gitDiff } from "../src/git.ts";

vi.setConfig({ testTimeout: process.platform === "win32" ? 120_000 : 60_000 });
const run = (cwd: string, ...args: string[]) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.editor=true", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
};
const put = (dir: string, f: string, text: string) => writeFileSync(join(dir, f), text);
const head = (dir: string, rev = "HEAD") => run(dir, "rev-parse", rev);
const signTimeout = writeConfig.signTimeout;
afterEach(() => {
  writeConfig.signTimeout = signTimeout;
  delete process.env.GIT_SEQUENCE_EDITOR;
});

/** main: c1 adds a.txt, c2 adds b.txt, c3 adds c.txt. */
function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grw-")));
  const dir = join(root, "r");
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  for (const [f, n] of [["a.txt", "c1"], ["b.txt", "c2"], ["c.txt", "c3"]] as const) {
    put(dir, f, `${n}\n`);
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", n);
  }
  return { root, dir, o: { allowed: (p: string) => p.startsWith(root) } };
}
type R = ReturnType<typeof repo>;
const menu = async (r: R, hash: string) => (await gitCommitMenu(r.dir, { ...r.o, hash }))!;
/** The menu, then the write the dialog would send. */
async function reword(r: R, hash: string, message: string, over: Record<string, unknown> = {}) {
  const m = await menu(r, hash);
  const argv = rewordArgv(m.reword ?? "amend", hash, message, m.parent);
  return gitReword(r.dir, { ...r.o, hash, message, headRef: m.headRef, headHash: m.headHash, argv, ...over });
}
const subjects = (dir: string) => run(dir, "log", "--format=%s", "--reverse").split("\n");
/** Git state a failed reword must leave as it was. */
const state = (dir: string) => ({ head: head(dir), index: run(dir, "write-tree"), status: run(dir, "status", "--porcelain=v2", "--branch"), log: run(dir, "log", "--format=%H %s") });
const noOperation = (dir: string) => {
  expect(() => execFileSync("test", ["-e", join(dir, ".git", "rebase-merge")])).toThrow();
  expect(() => execFileSync("test", ["-e", join(dir, ".git", "rebase-apply")])).toThrow();
};

describe("commitMenu reword", () => {
  it("HEAD amends, an older commit rebases with its parent, a root commit rebases without parent", async () => {
    const r = repo();
    const m3 = await menu(r, head(r.dir));
    expect(m3).toMatchObject({ reword: "amend", parent: head(r.dir, "HEAD~1") });
    expect(m3.why?.reword).toBeUndefined();
    expect(await menu(r, head(r.dir, "HEAD~1"))).toMatchObject({ reword: "rebase", parent: head(r.dir, "HEAD~2") });
    const root = await menu(r, head(r.dir, "HEAD~2"));
    expect(root.reword).toBe("rebase");
    expect(root.parent).toBeUndefined();
  });
  it("a merge commit is refused", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "-b", "side", "HEAD~2");
    put(r.dir, "s.txt", "s\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "s");
    run(r.dir, "checkout", "-q", "main");
    run(r.dir, "merge", "-q", "--no-ff", "-m", "merge", "side");
    expect(await menu(r, head(r.dir))).toMatchObject({ why: { reword: "Merge commit: edit its message in a terminal" } });
  });
  it("a pushed commit is refused (any remote-tracking ref)", async () => {
    const r = repo();
    const bare = join(r.root, "o.git");
    run(r.root, "init", "-q", "--bare", bare);
    run(r.dir, "remote", "add", "origin", bare);
    run(r.dir, "push", "-q", "origin", "main");
    expect((await menu(r, head(r.dir, "HEAD~1"))).why?.reword).toBe("Already pushed to origin/main");
    expect((await menu(r, head(r.dir))).why?.reword).toBe("Already pushed to origin/main");
    put(r.dir, "d.txt", "d\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "c4");
    expect((await menu(r, head(r.dir))).reword).toBe("amend");
  });
  it("a merge commit after it is refused", async () => {
    const r = repo();
    const first = head(r.dir, "HEAD~2");
    run(r.dir, "checkout", "-q", "-b", "side", "HEAD");
    put(r.dir, "s.txt", "s\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "s");
    run(r.dir, "checkout", "-q", "main");
    put(r.dir, "m.txt", "m\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "m");
    run(r.dir, "merge", "-q", "--no-ff", "-m", "merge", "side");
    expect((await menu(r, first)).why?.reword).toBe("A merge commit follows it: edit its message in a terminal");
  });
  it("a fixup!, squash! or amend! commit after it is refused", async () => {
    for (const prefix of ["fixup!", "squash!", "amend!"]) {
      const r = repo();
      const first = head(r.dir, "HEAD~2");
      run(r.dir, "commit", "-q", "--allow-empty", "-m", `${prefix} c1`);
      expect((await menu(r, first)).why?.reword).toBe("A fixup!/squash!/amend! commit follows it: edit its message in a terminal");
    }
  });
  it("a commit that is not on the current branch is refused", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "-b", "side", "HEAD~1");
    expect((await menu(r, head(r.dir, "main"))).why?.reword).toBe("Not on side");
  });
  it("a detached HEAD is blocked", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "--detach");
    expect((await menu(r, head(r.dir))).why?.reword).toBe("HEAD is detached");
  });
  it("signs follows commit.gpgSign", async () => {
    const r = repo();
    expect((await menu(r, head(r.dir))).signs).toBeUndefined();
    run(r.dir, "config", "commit.gpgSign", "true");
    expect((await menu(r, head(r.dir))).signs).toBe(true);
  });
});

describe("gitReword amend", () => {
  it("changes the message, keeps staged changes staged and the author", async () => {
    const r = repo();
    const before = head(r.dir);
    put(r.dir, "staged.txt", "s\n");
    run(r.dir, "add", "staged.txt");
    const w = await reword(r, before, "new subject\n\nbody # kept");
    expect(w?.refs).toBeTruthy();
    expect(run(r.dir, "log", "-1", "--format=%B")).toBe("new subject\n\nbody # kept");
    expect(head(r.dir)).not.toBe(before);
    expect(run(r.dir, "diff", "--cached", "--name-only")).toBe("staged.txt");
    expect(run(r.dir, "show", "-s", "--format=%an %ae", "HEAD")).toBe("t t@t");
    expect(run(r.dir, "rev-parse", "HEAD^{tree}")).toBe(run(r.dir, "rev-parse", `${before}^{tree}`));
  });
  it("works for an empty HEAD commit", async () => {
    const r = repo();
    run(r.dir, "commit", "-q", "--allow-empty", "-m", "empty");
    await reword(r, head(r.dir), "still empty");
    expect(run(r.dir, "log", "-1", "--format=%s")).toBe("still empty");
  });
});

describe("gitReword rebase", () => {
  it("rewords an older commit, keeps later messages, trees and author dates", async () => {
    const r = repo();
    const trees = run(r.dir, "log", "--format=%T", "--reverse").split("\n");
    const dates = run(r.dir, "log", "--format=%aI", "--reverse").split("\n");
    await reword(r, head(r.dir, "HEAD~1"), "c2 renamed");
    expect(subjects(r.dir)).toEqual(["c1", "c2 renamed", "c3"]);
    expect(run(r.dir, "log", "--format=%T", "--reverse").split("\n")).toEqual(trees);
    expect(run(r.dir, "log", "--format=%aI", "--reverse").split("\n")).toEqual(dates);
    noOperation(r.dir);
  });
  it("rewords the root commit", async () => {
    const r = repo();
    await reword(r, head(r.dir, "HEAD~2"), "first!");
    expect(subjects(r.dir)).toEqual(["first!", "c2", "c3"]);
  });
  it("keeps an empty older commit", async () => {
    const r = repo();
    run(r.dir, "commit", "-q", "--allow-empty", "-m", "empty");
    put(r.dir, "e.txt", "e\n");
    run(r.dir, "add", "-A");
    run(r.dir, "commit", "-q", "-m", "after");
    await reword(r, head(r.dir, "HEAD~1"), "empty renamed");
    expect(subjects(r.dir)).toEqual(["c1", "c2", "c3", "empty renamed", "after"]);
  });
  it("local changes survive (a staged change comes back unstaged)", async () => {
    const r = repo();
    put(r.dir, "a.txt", "edited\n");
    put(r.dir, "n.txt", "n\n");
    run(r.dir, "add", "n.txt");
    await reword(r, head(r.dir, "HEAD~1"), "c2 renamed");
    expect(readFileSync(join(r.dir, "a.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(r.dir, "n.txt"), "utf8")).toBe("n\n");
    expect(run(r.dir, "status", "--porcelain")).toContain("a.txt");
    expect(run(r.dir, "status", "--porcelain")).toContain("n.txt");
  });
  it("GIT_SEQUENCE_EDITOR=false in the daemon env does not break it", async () => {
    const r = repo();
    process.env.GIT_SEQUENCE_EDITOR = "false";
    await reword(r, head(r.dir, "HEAD~1"), "c2 renamed");
    expect(subjects(r.dir)).toEqual(["c1", "c2 renamed", "c3"]);
  });
  it("a rebase that fails to start leaves the repository as before (temporary commit dropped)", async () => {
    const r = repo();
    put(r.dir, "staged.txt", "s\n");
    run(r.dir, "add", "staged.txt");
    const hook = join(r.dir, ".git", "hooks", "pre-rebase");
    writeFileSync(hook, "#!/bin/sh\necho no rebase today >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const before = state(r.dir);
    await expect(reword(r, head(r.dir, "HEAD~1"), "c2 renamed")).rejects.toMatchObject({ code: "git_failed", message: expect.stringContaining("no rebase today") });
    expect(state(r.dir)).toEqual(before);
    expect(run(r.dir, "log", "--format=%s")).not.toContain("amend!");
    noOperation(r.dir);
  });
});

describe("gitReword refusals", () => {
  it("HEAD moved: stale", async () => {
    const r = repo();
    const m = await menu(r, head(r.dir, "HEAD~1"));
    run(r.dir, "commit", "-q", "--allow-empty", "-m", "c4");
    const message = "x";
    await expect(gitReword(r.dir, { ...r.o, hash: head(r.dir, "HEAD~2"), message, headRef: m.headRef, headHash: m.headHash, argv: rewordArgv("rebase", head(r.dir, "HEAD~2"), message, m.parent) })).rejects.toMatchObject({ code: "stale", message: "HEAD moved since the menu opened: reopen it" });
  });
  it("argv mismatch: stale", async () => {
    const r = repo();
    await expect(reword(r, head(r.dir), "x", { argv: rewordArgv("amend", head(r.dir), "other") })).rejects.toMatchObject({ code: "stale", message: "The command changed since the dialog opened" });
    await expect(reword(r, head(r.dir), "x", { argv: [["commit", "--amend", "-m", "x"]] })).rejects.toMatchObject({ code: "stale" });
  });
  it("blank, too long, NUL, bad shape: bad_request", async () => {
    const r = repo();
    for (const message of ["", "  \n", "x".repeat(10_001), "a\0b", 5]) await expect(reword(r, head(r.dir), message as string)).rejects.toMatchObject({ code: "bad_request" });
    await expect(reword(r, head(r.dir), "x", { argv: "no" })).rejects.toMatchObject({ code: "bad_request" });
    await expect(reword(r, head(r.dir), "x", { argv: [[], [], []] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(reword(r, "nothash", "x")).rejects.toMatchObject({ code: "bad_request" });
  });
  it("a refused commit gives bad_request with the reason", async () => {
    const r = repo();
    run(r.dir, "checkout", "-q", "-b", "side", "HEAD~1");
    const m = await menu(r, head(r.dir, "main"));
    await expect(gitReword(r.dir, { ...r.o, hash: head(r.dir, "main"), message: "x", headRef: m.headRef, headHash: m.headHash, argv: rewordArgv("amend", head(r.dir, "main"), "x") })).rejects.toMatchObject({ code: "bad_request", message: "Not on side" });
  });
  it("outside the roots: cwd_not_allowed; not a repository: null", async () => {
    const r = repo();
    const req = { hash: head(r.dir), message: "x", headRef: "refs/heads/main", headHash: head(r.dir), argv: [["x"]] };
    await expect(gitReword(r.dir, { ...req, allowed: () => false })).rejects.toMatchObject({ code: "cwd_not_allowed" });
    expect(await gitReword(r.root, { ...req, allowed: () => true })).toBeNull();
  });
});

describe("gitDiff base commit", () => {
  it("lists modified, untracked, deleted and renamed files against an older commit", async () => {
    const r = repo();
    const first = head(r.dir, "HEAD~2");
    put(r.dir, "a.txt", "changed\n");
    run(r.dir, "rm", "-q", "b.txt");
    run(r.dir, "mv", "c.txt", "d.txt");
    put(r.dir, "new.txt", "new\n");
    const d = (await gitDiff(r.dir, { base: "commit", ref: first, ...r.o }))!;
    expect(d.base).toBe(first);
    expect(d.ref).toBeUndefined();
    expect(d.branches).toBeUndefined();
    const by = Object.fromEntries(d.files.map((f) => [f.path, f]));
    expect(by["a.txt"]).toMatchObject({ status: "M" });
    expect(by["b.txt"]).toBeUndefined();
    expect(by["d.txt"]).toMatchObject({ status: "A" });
    expect(by["new.txt"]).toMatchObject({ status: "A", untracked: true });
  });
  it("shows a rename against an older commit and not a file that commit lacked", async () => {
    const r = repo();
    run(r.dir, "mv", "a.txt", "z.txt");
    run(r.dir, "rm", "-q", "-f", "b.txt");
    const d = (await gitDiff(r.dir, { base: "commit", ref: head(r.dir, "HEAD~2"), ...r.o }))!;
    expect(d.files.map((f) => [f.status, f.path])).toEqual(expect.arrayContaining([["R", "z.txt"]]));
    expect(d.files.some((f) => f.path === "b.txt")).toBe(false);
  });
  it("a bad hash and an unknown commit are bad_request", async () => {
    const r = repo();
    for (const ref of [undefined, "main", "abc", "x".repeat(40)]) await expect(gitDiff(r.dir, { base: "commit", ref, ...r.o })).rejects.toMatchObject({ code: "bad_request", message: "Invalid commit hash" });
    await expect(gitDiff(r.dir, { base: "commit", ref: "0".repeat(40), ...r.o })).rejects.toMatchObject({ code: "bad_request", message: "Unknown commit" });
  });
});

// ---- Signing: a signer that waits for a passphrase never leaves the edit hanging ----

function signer(r: R, body: string) {
  const prog = join(r.root, "fake-gpg.sh");
  writeFileSync(prog, `#!/bin/sh\n${body}\n`);
  chmodSync(prog, 0o755);
  run(r.dir, "config", "gpg.program", prog);
  run(r.dir, "config", "user.signingKey", "ABCD1234");
  run(r.dir, "config", "commit.gpgSign", "true");
}
const HANG = "exec sleep 600";
const lockFree = (dir: string) => expect(() => execFileSync("test", ["-e", join(dir, ".git", "index.lock")])).toThrow();
const SIGNING = "signing did not finish: gpg passphrase prompt?";

describe.skipIf(process.platform === "win32")("gitReword signing", () => {
  it("amend: a hanging signer ends at the signing timeout, the repository is as before", async () => {
    const r = repo();
    signer(r, HANG);
    put(r.dir, "staged.txt", "s\n");
    run(r.dir, "add", "staged.txt");
    const before = state(r.dir);
    writeConfig.signTimeout = 400;
    await expect(reword(r, head(r.dir), "new")).rejects.toMatchObject({ code: "git_failed", message: SIGNING });
    expect(state(r.dir)).toEqual(before);
    lockFree(r.dir);
  });
  it("rebase: a hanging signer in the temporary commit ends at the timeout, nothing left", async () => {
    const r = repo();
    signer(r, HANG);
    const before = state(r.dir);
    writeConfig.signTimeout = 400;
    await expect(reword(r, head(r.dir, "HEAD~1"), "new")).rejects.toMatchObject({ code: "git_failed", message: SIGNING });
    expect(state(r.dir)).toEqual(before);
    noOperation(r.dir);
  });
  it("rebase: a signer that works for the temporary commit and hangs in the rebase leaves the repository as before", async () => {
    const r = repo();
    const flag = join(r.root, "signed-once");
    // First call signs (writes a fake signature), later calls hang.
    signer(r, `if [ -e "${flag}" ]; then exec sleep 600; fi\ntouch "${flag}"\necho '[GNUPG:] SIG_CREATED ' >&2\necho fake-signature`);
    const before = state(r.dir);
    writeConfig.signTimeout = 1500;
    await expect(reword(r, head(r.dir, "HEAD~1"), "new")).rejects.toMatchObject({ code: "git_failed" });
    expect(state(r.dir)).toEqual(before);
    expect(run(r.dir, "log", "--format=%s")).not.toContain("amend!");
    noOperation(r.dir);
    lockFree(r.dir);
  });
  it("an abort signal cancels: code cancelled, repository as before, lock free", async () => {
    const r = repo();
    signer(r, HANG);
    const before = state(r.dir);
    const ctl = new AbortController();
    const p = reword(r, head(r.dir, "HEAD~1"), "new", { signal: ctl.signal });
    const seen = expect(p).rejects.toMatchObject({ code: "cancelled" });
    await new Promise((x) => setTimeout(x, 500));
    ctl.abort();
    await seen;
    expect(state(r.dir)).toEqual(before);
    noOperation(r.dir);
    // The lock is free again.
    run(r.dir, "config", "commit.gpgSign", "false");
    await reword(r, head(r.dir), "after cancel");
  });
  it("a signer that fails gets the signing error with git's output, repository as before", async () => {
    const r = repo();
    signer(r, 'echo "gpg: signing failed: No pinentry" >&2\nexit 2');
    const before = state(r.dir);
    await expect(reword(r, head(r.dir), "new")).rejects.toMatchObject({ code: "git_failed", message: expect.stringMatching(/^signing did not finish: gpg passphrase prompt\?\n[\s\S]*No pinentry/) });
    await expect(reword(r, head(r.dir, "HEAD~1"), "new")).rejects.toMatchObject({ code: "git_failed", message: expect.stringMatching(/^signing did not finish/) });
    expect(state(r.dir)).toEqual(before);
    noOperation(r.dir);
  });
  it("gpg.format=ssh names the ssh key", async () => {
    const r = repo();
    signer(r, HANG);
    run(r.dir, "config", "gpg.format", "ssh");
    run(r.dir, "config", "gpg.ssh.program", join(r.root, "fake-gpg.sh"));
    writeConfig.signTimeout = 400;
    await expect(reword(r, head(r.dir), "new")).rejects.toMatchObject({ message: "signing did not finish: ssh key passphrase prompt?" });
  });
});
