import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tagCreateArgv, tagDeleteArgv, tagDeleteRemoteArgv } from "@claude-ui/protocol";
import { setGitRunner, threadRunner } from "../src/git-runner.ts";
import { gitTagDelete, gitTagRemote } from "../src/git-remote.ts";
import { gitTag, gitTagCreate } from "../src/git-write.ts";

vi.setConfig({ testTimeout: process.platform === "win32" ? 120_000 : 60_000 });
const run = (cwd: string, ...args: string[]) => {
  const env = { ...process.env };
  delete env.GIT_DIR;
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
};
const tryRun = (cwd: string, ...args: string[]) => {
  try {
    return run(cwd, ...args);
  } catch {
    return "";
  }
};
vi.stubEnv("GIT_COMMITTER_NAME", "t");
vi.stubEnv("GIT_COMMITTER_EMAIL", "t@t");
vi.stubEnv("GIT_AUTHOR_NAME", "t");
vi.stubEnv("GIT_AUTHOR_EMAIL", "t@t");
afterEach(() => setGitRunner(undefined));

/** A repo `a` with two commits, a bare origin inside the roots, and `outside.git` beside the roots. */
function repo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gtag-")));
  const root = join(base, "root");
  const outside = join(base, "outside.git");
  run(base, "init", "-q", "--bare", outside);
  run(base, "init", "-q", "-b", "main", root);
  run(root, "init", "-q", "--bare", "-b", "main", "o.git");
  const a = join(root, "a");
  run(root, "init", "-q", "-b", "main", a);
  run(a, "commit", "-q", "--allow-empty", "-m", "c1");
  run(a, "commit", "-q", "--allow-empty", "-m", "c2");
  run(a, "remote", "add", "origin", join(root, "o.git"));
  const allowed = (p: string) => p.startsWith(root);
  return { a, root, outside, o: { allowed }, c1: run(a, "rev-parse", "HEAD~1"), c2: run(a, "rev-parse", "HEAD") };
}
type R = ReturnType<typeof repo>;
const create = (r: R, name: string, hash = r.c2, message?: string, over: Record<string, unknown> = {}) =>
  gitTagCreate(r.a, { hash, name, message, argv: tagCreateArgv(name, hash, message), ...r.o, ...over });
/** Pushes tag `name` to origin and returns the delete request the dialog would send. */
function remoteTag(r: R, name: string) {
  run(r.a, "tag", name, r.c1);
  run(r.a, "push", "-q", "origin", `refs/tags/${name}`);
  const hash = run(r.a, "rev-parse", `refs/tags/${name}`);
  return { hash, req: { name, hash, argv: tagDeleteArgv(name), remotes: [{ remote: "origin", hash, argv: tagDeleteRemoteArgv("origin", name, hash) }], ...r.o } };
}

describe("gitTagCreate", () => {
  it("creates a lightweight tag", async () => {
    const r = repo();
    const w = await create(r, "v1");
    expect(w?.refs).toBeTruthy();
    expect(run(r.a, "cat-file", "-t", "refs/tags/v1")).toBe("commit");
    expect(run(r.a, "rev-parse", "v1")).toBe(r.c2);
  });
  it("creates an annotated tag with the message", async () => {
    const r = repo();
    await create(r, "v2", r.c1, "release two\n\nbody");
    expect(run(r.a, "cat-file", "-t", "refs/tags/v2")).toBe("tag");
    expect(run(r.a, "tag", "-n9", "-l", "v2")).toContain("release two");
    expect(run(r.a, "rev-parse", "v2^{commit}")).toBe(r.c1);
  });
  it("refuses an invalid name, an existing name and an unknown commit", async () => {
    const r = repo();
    for (const name of ["", "-x", "a b", "a..b", "x\0y", "x".repeat(256), "x.lock", 5]) await expect(create(r, name as string)).rejects.toMatchObject({ code: "bad_request", message: "Not a valid tag name" });
    await create(r, "v1");
    await expect(create(r, "v1")).rejects.toMatchObject({ code: "bad_request", message: "Tag v1 already exists" });
    await expect(create(r, "v3", "0".repeat(40))).rejects.toMatchObject({ code: "bad_request", message: "Unknown commit" });
    await expect(create(r, "v3", "HEAD")).rejects.toMatchObject({ code: "bad_request", message: "Unknown commit" });
    await expect(create(r, "v3", r.c2, "x".repeat(10_001))).rejects.toMatchObject({ code: "bad_request" });
    expect(run(r.a, "tag", "-l")).toBe("v1");
  });
  it("answers stale when the argv differs from the builder", async () => {
    const r = repo();
    await expect(create(r, "v1", r.c2, undefined, { argv: ["tag", "-f", "v1", r.c2] })).rejects.toMatchObject({ code: "stale", message: "The command changed since the dialog opened" });
    await expect(create(r, "v1", r.c2, "m", { argv: tagCreateArgv("v1", r.c2) })).rejects.toMatchObject({ code: "stale" });
    expect(run(r.a, "tag", "-l")).toBe("");
  });
  it("is busy while another write runs, and works during an unfinished merge", async () => {
    const r = repo();
    setGitRunner((o) => (o.args.includes("tag") ? new Promise((x) => setTimeout(x, 400)).then(() => threadRunner(o)) : threadRunner(o)));
    const first = create(r, "v1");
    await new Promise((x) => setTimeout(x, 100));
    await expect(create(r, "v2")).rejects.toMatchObject({ code: "busy" });
    await first;
    setGitRunner(undefined);
    run(r.a, "checkout", "-q", "-b", "side", r.c1);
    run(r.a, "commit", "-q", "--allow-empty", "-m", "side");
    run(r.a, "checkout", "-q", "main");
    run(r.a, "merge", "-q", "--no-commit", "--no-ff", "side");
    await create(r, "v3");
    expect(run(r.a, "tag", "-l", "v3")).toBe("v3");
  });
});

describe("gitTag", () => {
  it("reads a lightweight and an annotated tag and the remotes", async () => {
    const r = repo();
    await create(r, "light");
    await create(r, "note", r.c1, "m");
    run(r.a, "remote", "add", "second", join(r.root, "o.git"));
    const light = await gitTag(r.a, { name: "light", ...r.o });
    expect(light).toEqual({ name: "light", hash: r.c2, commit: r.c2, annotated: false, remotes: expect.arrayContaining(["origin", "second"]) });
    const note = await gitTag(r.a, { name: "note", ...r.o });
    expect(note).toMatchObject({ annotated: true, commit: r.c1, hash: run(r.a, "rev-parse", "refs/tags/note") });
    expect(note!.hash).not.toBe(r.c1);
    expect(note!.remotes).toHaveLength(2);
  });
  it("refuses an unknown tag", async () => {
    const r = repo();
    await expect(gitTag(r.a, { name: "nope", ...r.o })).rejects.toMatchObject({ code: "bad_request", message: "Unknown tag" });
  });
});

describe("gitTagRemote", () => {
  it("reports the remote's hash of a present tag, and none for an absent one", async () => {
    const r = repo();
    const { hash } = remoteTag(r, "v1");
    expect(await gitTagRemote(r.a, { name: "v1", remote: "origin", ...r.o })).toEqual({ remote: "origin", hash });
    run(r.a, "tag", "local-only", r.c2);
    expect(await gitTagRemote(r.a, { name: "local-only", remote: "origin", ...r.o })).toEqual({ remote: "origin" });
  });
  it("refuses a remote outside the roots and a remote that is not configured", async () => {
    const r = repo();
    run(r.a, "remote", "add", "out", r.outside);
    await expect(gitTagRemote(r.a, { name: "v1", remote: "out", ...r.o })).rejects.toMatchObject({ code: "remote_not_allowed" });
    await expect(gitTagRemote(r.a, { name: "v1", remote: "ghost", ...r.o })).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("gitTagDelete", () => {
  const localOnly = (r: R, name: string) => {
    run(r.a, "tag", name, r.c1);
    return { name, hash: run(r.a, "rev-parse", `refs/tags/${name}`), argv: tagDeleteArgv(name), ...r.o };
  };
  it("deletes a local tag only", async () => {
    const r = repo();
    const { hash } = remoteTag(r, "v1");
    const w = await gitTagDelete(r.a, { name: "v1", hash, argv: tagDeleteArgv("v1"), ...r.o });
    expect(w?.refs).toBeTruthy();
    expect(tryRun(r.a, "tag", "-l", "v1")).toBe("");
    expect(run(join(r.root, "o.git"), "tag", "-l", "v1")).toBe("v1");
  });
  it("deletes on the remote first, then locally", async () => {
    const r = repo();
    const { req } = remoteTag(r, "v1");
    const w = await gitTagDelete(r.a, req);
    expect(w?.output).toContain("v1");
    expect(run(join(r.root, "o.git"), "tag", "-l")).toBe("");
    expect(run(r.a, "tag", "-l")).toBe("");
  });
  it("answers stale and keeps the local tag when the remote tag moved", async () => {
    const r = repo();
    const { req } = remoteTag(r, "v1");
    run(r.a, "push", "-q", "--force", "origin", `${r.c2}:refs/tags/v1`);
    await expect(gitTagDelete(r.a, req)).rejects.toMatchObject({ code: "stale", message: expect.stringContaining("origin changed the tag since the dialog opened; reopen it") });
    expect(run(r.a, "tag", "-l", "v1")).toBe("v1");
    expect(run(join(r.root, "o.git"), "tag", "-l", "v1")).toBe("v1");
  });
  it("answers stale when the local tag moved", async () => {
    const r = repo();
    const t = localOnly(r, "v1");
    run(r.a, "tag", "-f", "v1", r.c2);
    await expect(gitTagDelete(r.a, t)).rejects.toMatchObject({ code: "stale", message: "Tag v1 moved since the dialog opened: reopen it" });
    expect(run(r.a, "rev-parse", "v1")).toBe(r.c2);
  });
  it("answers stale when an argv differs from the builder", async () => {
    const r = repo();
    const t = localOnly(r, "v1");
    await expect(gitTagDelete(r.a, { ...t, argv: ["tag", "-D", "v1"] })).rejects.toMatchObject({ code: "stale" });
    const { req } = remoteTag(r, "v2");
    await expect(gitTagDelete(r.a, { ...req, remotes: [{ ...req.remotes[0]!, argv: ["push", "origin", "--delete", "refs/tags/v2"] }] })).rejects.toMatchObject({ code: "stale" });
    expect(run(r.a, "tag", "-l").split("\n").sort()).toEqual(["v1", "v2"]);
    expect(run(join(r.root, "o.git"), "tag", "-l", "v2")).toBe("v2");
  });
  it("refuses a remote outside the roots before deleting anything", async () => {
    const r = repo();
    const { req } = remoteTag(r, "v1");
    run(r.a, "remote", "add", "out", r.outside);
    const hash = req.hash;
    const remotes = [...req.remotes, { remote: "out", hash, argv: tagDeleteRemoteArgv("out", "v1", hash) }];
    await expect(gitTagDelete(r.a, { ...req, remotes })).rejects.toMatchObject({ code: "remote_not_allowed" });
    expect(run(join(r.root, "o.git"), "tag", "-l", "v1")).toBe("v1");
    expect(run(r.a, "tag", "-l", "v1")).toBe("v1");
  });
  it("is busy while another write runs", async () => {
    const r = repo();
    const t = localOnly(r, "v1");
    setGitRunner((o) => (o.args.includes("tag") && o.args.includes("-d") ? new Promise((x) => setTimeout(x, 400)).then(() => threadRunner(o)) : threadRunner(o)));
    const first = gitTagDelete(r.a, t);
    await new Promise((x) => setTimeout(x, 100));
    await expect(create(r, "v2")).rejects.toMatchObject({ code: "busy" });
    await first;
  });
});
