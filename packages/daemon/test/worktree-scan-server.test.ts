// Clean up scan over the wire (GH-461): worktree.status with a scan id queues behind the status bar, worktree.cancel drops it, git.fetch defaultRemote.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
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
    expect(first((o) => o.cwd === bs[4])).toBeLessThan(first((o) => o.cwd === repo && gitSub(o.args) === "worktree"));
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
