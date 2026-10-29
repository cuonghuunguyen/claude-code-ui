// Clean up scan over the wire (GH-461): worktree.status with a scan id queues behind the status bar, worktree.cancel drops it, git.fetch defaultRemote.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ServerMessage } from "@claude-ui/protocol";
import { createSecrets } from "../src/secrets.ts";
import { createSettings } from "../src/settings.ts";
import { createProjects } from "../src/projects.ts";
import { createDaemon } from "../src/server.ts";
import { fakeQuery } from "./fake-query.ts";
import { setGitRunner, threadRunner, type GitRunOptions } from "../src/git-runner.ts";
import { gitSub } from "../src/perf.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const webRoot = mkdtempSync(join(tmpdir(), "web-"));

function client(p: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${p}` });
  const inbox: ServerMessage[] = [];
  const raw: string[] = [];
  ws.on("message", (d) => (raw.push(String(d)), inbox.push(JSON.parse(String(d)))));
  const waitFor = (pred: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((resolve) => {
      const t = setInterval(() => {
        const m = inbox.find(pred);
        if (m) clearInterval(t), resolve(m);
      }, 5);
    });
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return (await waitFor((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId)) as { type: string; code?: string; message?: string; result?: any };
  };
  return new Promise<{ request: typeof request; waitFor: typeof waitFor; raw: string[] }>((resolve, reject) => {
    ws.once("error", reject);
    ws.once("open", () => resolve({ request, waitFor, raw }));
  });
}

let closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
async function daemon(o: { root: string; repo?: string; secretsFile?: string; settingsFile?: string }) {
  const projects = createProjects();
  if (o.repo) projects.open(o.repo);
  const d = createDaemon({
    webRoot,
    token,
    roots: [o.root],
    query: fakeQuery as never,
    projects,
    appSettings: createSettings({ file: o.settingsFile }),
    secrets: createSecrets({ file: o.secretsFile }),
    history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
  });
  await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
  closers.push(() => d.close());
  return (d.address() as AddressInfo).port;
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
function plain(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  return dir;
}
/** root/repo with `n` worktrees, and `others` small repos b0.. for git.status requests. */
function fixture(n: number, others: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wtscan-")));
  const repo = plain(root, "repo");
  const paths = Array.from({ length: n }, (_, i) => {
    const p = join(repo, ".claude", "worktrees", `w${i}`);
    git(repo, "worktree", "add", "-q", "-b", `w${i}`, p);
    return p;
  });
  const bs = Array.from({ length: others }, (_, i) => plain(root, `b${i}`));
  return { root, repo, paths, bs };
}
/** Every git call waits for `release()`; `started` lists the calls that got a slot. */
function gate() {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  const started: GitRunOptions[] = [];
  setGitRunner(async (o) => (started.push(o), await open, threadRunner(o)));
  return { release, started };
}
const until = async (pred: () => boolean) => {
  for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(pred()).toBe(true);
};
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
afterEachGate();
function afterEachGate() {
  afterEach(() => setGitRunner(undefined));
}

describe("worktree.status with a scan id", () => {
  it("worktree.cancel drops queued scan requests: their git never starts and they reply cancelled", async () => {
    const { root, repo, paths, bs } = fixture(3, 4);
    const c = await client(await daemon({ root, repo }));
    const g = gate();
    // The four slots are held by status bar requests.
    const bar = bs.map((b) => c.request({ type: "git.status", cwd: b }));
    await until(() => g.started.length >= 4);
    const scans = paths.map((path) => c.request({ type: "worktree.status", cwd: repo, path, scan: "s1" }));
    await settle();
    expect(await c.request({ type: "worktree.cancel", scan: "s1" })).toMatchObject({ type: "reply", result: {} });
    g.release();
    const replies = await Promise.all(scans);
    expect(replies.map((r) => [r.type, r.code])).toEqual([["error", "cancelled"], ["error", "cancelled"], ["error", "cancelled"]]);
    await Promise.all(bar);
    await settle();
    expect(g.started.filter((o) => paths.includes(o.cwd) && gitSub(o.args) === "status")).toEqual([]);
    // A later scan with another id is served.
    expect(await c.request({ type: "worktree.status", cwd: repo, path: paths[0], scan: "s2" })).toMatchObject({ type: "reply", result: { safety: "safe" } });
    expect(await c.request({ type: "worktree.status", cwd: repo, path: paths[0], scan: 5 })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "worktree.cancel", scan: 5 })).toMatchObject({ code: "bad_request" });
  });

  it("a scan request that arrives after its worktree.cancel is cancelled too: the id is not re-created", async () => {
    const { root, repo, paths } = fixture(1, 0);
    const c = await client(await daemon({ root, repo }));
    const seen: GitRunOptions[] = [];
    setGitRunner((o) => (seen.push(o), threadRunner(o)));
    expect(await c.request({ type: "worktree.cancel", scan: "late" })).toMatchObject({ result: {} });
    expect(await c.request({ type: "worktree.status", cwd: repo, path: paths[0], scan: "late" })).toMatchObject({ type: "error", code: "cancelled" });
    expect(seen.filter((o) => o.cwd === paths[0])).toEqual([]);
  });

  it("the repo-wide facts read of a scan runs in the normal tier: it starts before a later status bar request", async () => {
    const { root, repo, paths, bs } = fixture(1, 5);
    const c = await client(await daemon({ root, repo }));
    const g = gate();
    const bar = bs.slice(0, 4).map((b) => c.request({ type: "git.status", cwd: b }));
    await until(() => g.started.length >= 4);
    const scan = c.request({ type: "worktree.status", cwd: repo, path: paths[0], scan: "s1" });
    await settle();
    const extra = c.request({ type: "git.status", cwd: bs[4] });
    await settle();
    g.release();
    await Promise.all([...bar, scan, extra]);
    expect(g.started[4]!.cwd).toBe(repo);
  });

  it("a Clean up scan of 20 worktrees spawns at most 3 git processes per worktree and the repo-wide reads once", async () => {
    const { root, repo, paths } = fixture(20, 0);
    const c = await client(await daemon({ root, repo }));
    const calls: GitRunOptions[] = [];
    setGitRunner((o) => (calls.push(o), threadRunner(o)));
    const replies = await Promise.all(paths.map((path) => c.request({ type: "worktree.status", cwd: repo, path, scan: "budget" })));
    expect(replies.map((r) => r.type)).toEqual(paths.map(() => "reply"));
    const sub = (cs: GitRunOptions[]) => cs.map((o) => gitSub(o.args));
    for (const p of paths) expect(sub(calls.filter((o) => o.cwd === p)).length, p).toBeLessThanOrEqual(3);
    const rest = calls.filter((o) => !paths.includes(o.cwd));
    for (const s of ["worktree", "config", "for-each-ref"]) expect(sub(rest).filter((x) => x === s), s).toHaveLength(1);
    expect(sub(calls)).not.toContain("log");
    expect(sub(calls)).not.toContain("symbolic-ref");
    expect(calls.length).toBeLessThanOrEqual(3 * paths.length + 3);
  });

  it("a scan's worktree.status waits behind git.status", async () => {
    const { root, repo, paths, bs } = fixture(1, 5);
    const c = await client(await daemon({ root, repo }));
    const g = gate();
    const bar = bs.slice(0, 4).map((b) => c.request({ type: "git.status", cwd: b }));
    await until(() => g.started.length >= 4);
    const scan = c.request({ type: "worktree.status", cwd: repo, path: paths[0], scan: "s" });
    await settle();
    // Sent after the scan, so it is behind it in arrival order.
    const late = c.request({ type: "git.status", cwd: bs[4] });
    await settle();
    g.release();
    expect((await scan).type).toBe("reply");
    await Promise.all([...bar, late]);
    const first = (pred: (o: GitRunOptions) => boolean) => g.started.findIndex(pred);
    expect(first((o) => o.cwd === bs[4])).toBeGreaterThan(-1);
    // The worktree's own git status is low tier (the repo-wide facts read before it is not, see below).
    expect(first((o) => o.cwd === bs[4])).toBeLessThan(first((o) => o.cwd === paths[0] && gitSub(o.args) === "status"));
  });
});

describe("git.fetch defaultRemote", () => {
  it("fetches only the default branch's remote, pruning; a non-boolean is refused", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wtscan-f-")));
    git(root, "init", "-q", "--bare", "-b", "main", "o.git");
    git(root, "clone", "-q", "o.git", "r");
    const repo = join(root, "r");
    git(repo, "commit", "-q", "--allow-empty", "-m", "one");
    git(repo, "push", "-q", "-u", "origin", "HEAD:main");
    const c = await client(await daemon({ root, repo }));
    expect(await c.request({ type: "git.fetch", cwd: repo, defaultRemote: "yes" })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "git.fetch", cwd: repo, defaultRemote: true })).toMatchObject({ type: "reply", result: { remote: { refs: expect.any(String) } } });
    git(repo, "remote", "remove", "origin");
    expect(await c.request({ type: "git.fetch", cwd: repo, defaultRemote: true })).toMatchObject({ code: "bad_request" });
  });
});

describe("worktree.cached and turn-end marks (GH-463)", () => {
  type R = { type: string; code?: string; result?: any };
  it("worktree.cached replies the last statuses with running and blocked merged", async () => {
    const { root, repo, paths } = fixture(2, 0);
    const c = await client(await daemon({ root, repo }));
    expect(((await c.request({ type: "worktree.cached", cwd: repo, paths })) as R).result.statuses).toEqual({});
    await c.request({ type: "worktree.status", cwd: repo, path: paths[0] });
    const calls: GitRunOptions[] = [];
    setGitRunner((o) => (calls.push(o), threadRunner(o)));
    const r = (await c.request({ type: "worktree.cached", cwd: repo, paths: [...paths, "/outside/x", 5 as never] })) as R;
    expect(calls).toEqual([]);
    expect(Object.keys(r.result.statuses)).toEqual([paths[0]]);
    expect(r.result.statuses[paths[0]!]).toMatchObject({ safety: "safe", running: 0, checkedAt: expect.any(Number) });
    expect(r.result.statuses[paths[0]!].stale).toBeUndefined();
    expect(await c.request({ type: "worktree.cached", cwd: repo, paths: "x" })).toMatchObject({ code: "bad_request" });
    expect(await c.request({ type: "worktree.cached", cwd: repo, paths: Array(501).fill(paths[0]) })).toMatchObject({ code: "bad_request" });
  });

  it("a session turn ending in a worktree marks it stale", async () => {
    const { root, repo, paths } = fixture(2, 0);
    const c = await client(await daemon({ root, repo }));
    const created = (await c.request({ type: "session.create", cwd: paths[0] })) as R;
    await c.request({ type: "worktree.status", cwd: repo, path: paths[0] });
    await c.request({ type: "worktree.status", cwd: repo, path: paths[1] });
    const stale = async (p: string) => (((await c.request({ type: "worktree.cached", cwd: repo, paths: [p] })) as R).result.statuses[p] ?? {}).stale;
    expect(await stale(paths[0]!)).toBeUndefined();
    await c.request({ type: "session.prompt", sessionId: created.result.session.id, text: "hi" });
    let s: unknown;
    await until(() => (stale(paths[0]!).then((v) => (s = v)), s === true));
    // Only the worktree of the session.
    expect(await stale(paths[1]!)).toBeUndefined();
  });

  it("a plain tracked-file edit and a new file after a Safe check show in every worktree.status (dialog and scan); the cache is display only; remove with expectSafe refuses the cached Safe", async () => {
    const { root, repo, paths } = fixture(1, 0);
    const c = await client(await daemon({ root, repo }));
    const p = paths[0]!;
    writeFileSync(join(p, ".gitkeep"), "1");
    git(p, "add", ".");
    git(p, "commit", "-qm", "t");
    git(repo, "merge", "-q", "--ff-only", "w0"); // the commit is on the base: nothing is ahead
    expect(await c.request({ type: "worktree.status", cwd: repo, path: p })).toMatchObject({ result: { safety: "safe", uncommitted: 0 } });
    // Later, in the IDE: a tracked file edit and a new untracked file (neither moves a ref, the index or the reflog).
    writeFileSync(join(p, ".gitkeep"), "edited");
    writeFileSync(join(p, "notes.md"), "new work");
    // The cache (display only) still says Safe: no stat of the fingerprint moved.
    expect(((await c.request({ type: "worktree.cached", cwd: repo, paths: [p] })) as { result: any }).result.statuses[p]).toMatchObject({ safety: "safe", uncommitted: 0 });
    // A Clean up scan reads fresh too, and a removal built on the cached Safe is refused.
    expect(await c.request({ type: "worktree.status", cwd: repo, path: p, scan: "s" })).toMatchObject({ result: { safety: "has_work", uncommitted: 2 } });
    expect(await c.request({ type: "worktree.remove", cwd: repo, path: p, expectSafe: true, expect: { uncommitted: 0, ahead: 0 } })).toMatchObject({ type: "error", code: "stale" });
    expect(existsSync(p)).toBe(true);
    expect(await c.request({ type: "worktree.status", cwd: repo, path: p })).toMatchObject({ result: { safety: "has_work", uncommitted: 2 } });
    // Confirm with the counts the dialog showed before the edit: refused, nothing removed.
    expect(await c.request({ type: "worktree.remove", cwd: repo, path: p, expect: { uncommitted: 0, ahead: 0 } })).toMatchObject({ type: "error", code: "stale" });
    expect(existsSync(p)).toBe(true);
  });

  it("a removal through the daemon marks the other worktrees of the repository stale", async () => {
    const { root, repo, paths } = fixture(2, 0);
    const c = await client(await daemon({ root, repo }));
    await c.request({ type: "worktree.status", cwd: repo, path: paths[0] });
    const cached = async () => ((await c.request({ type: "worktree.cached", cwd: repo, paths: [paths[0]] })) as R).result.statuses[paths[0]!];
    expect(await cached()).not.toHaveProperty("stale");
    expect((await c.request({ type: "worktree.remove", cwd: repo, path: paths[1] })).type).toBe("reply");
    expect(await cached()).toHaveProperty("stale", true);
  });
});

describe("worktree removing flag (GH-462)", () => {
  type R = { type: string; code?: string; result?: any };
  const changes = (raw: string[]) => raw.filter((s) => JSON.parse(s).type === "sessions.changed").length;
  const rowOf = async (c: Awaited<ReturnType<typeof client>>, repo: string, path: string) => ((await c.request({ type: "session.list" })) as R).result.worktrees[repo].find((w: { path: string }) => w.path === path);

  it("session.list lists a worktree removing: true while its removal runs and broadcasts sessions.changed at start and end", async () => {
    const { root, repo, paths } = fixture(1, 0);
    const c = await client(await daemon({ root, repo }));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let held = false;
    setGitRunner(async (o) => (o.args.includes("remove") && o.args[0] === "worktree" ? ((held = true), await hold, threadRunner(o)) : threadRunner(o)));
    expect(await rowOf(c, repo, paths[0]!)).not.toHaveProperty("removing");
    const before = changes(c.raw);
    const done = c.request({ type: "worktree.remove", cwd: repo, path: paths[0] });
    await until(() => held);
    await until(() => changes(c.raw) > before);
    expect(await rowOf(c, repo, paths[0]!)).toHaveProperty("removing", true);
    const during = changes(c.raw);
    release();
    expect((await done).type).toBe("reply");
    expect(changes(c.raw)).toBeGreaterThan(during);
    expect(await rowOf(c, repo, paths[0]!)).toBeUndefined();
  });

  it("a failed removal clears the flag and broadcasts again", async () => {
    const { root, repo, paths } = fixture(1, 0);
    const c = await client(await daemon({ root, repo }));
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let held = false;
    setGitRunner(async (o) => (o.args.includes("remove") && o.args[0] === "worktree" ? ((held = true), await hold, Promise.reject(new Error("boom"))) : threadRunner(o)));
    const before = changes(c.raw);
    const done = c.request({ type: "worktree.remove", cwd: repo, path: paths[0] });
    await until(() => held);
    await until(() => changes(c.raw) > before);
    const during = changes(c.raw);
    release();
    expect((await done).type).toBe("error");
    await until(() => changes(c.raw) > during);
    expect(await rowOf(c, repo, paths[0]!)).not.toHaveProperty("removing");
  });
});
