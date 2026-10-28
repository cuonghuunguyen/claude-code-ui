// Create worktree modal over the wire (GH-447): worktree.create per Branch source, worktree.branches, Jira settings, token and search.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
import { fakeJira, type FakeJira } from "./fake-jira.ts";

const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const JIRA_TOKEN = "jira-PAT-do-not-leak-0123456789";
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

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
/** root/o.git (bare, branches main and feat/remote), root/repo cloned from it. */
function repoWithOrigin() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wtm-")));
  git(root, "init", "-q", "--bare", "-b", "main", "o.git");
  git(root, "clone", "-q", "o.git", "seed");
  const seed = join(root, "seed");
  git(seed, "checkout", "-q", "-b", "main");
  git(seed, "commit", "-q", "--allow-empty", "-m", "one");
  git(seed, "commit", "-q", "--allow-empty", "-m", "two");
  git(seed, "push", "-q", "origin", "main");
  git(seed, "checkout", "-q", "-b", "feat/remote");
  git(seed, "commit", "-q", "--allow-empty", "-m", "r");
  git(seed, "push", "-q", "origin", "feat/remote");
  git(root, "clone", "-q", "o.git", "repo");
  return { root, repo: join(root, "repo") };
}

let closers: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
async function daemon(o: { root: string; repo?: string; secretsFile?: string; settingsFile?: string; jiraFetch?: typeof fetch }) {
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
    ...(o.jiraFetch && { jiraFetch: o.jiraFetch }),
    history: { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never },
  });
  await new Promise<void>((r) => d.listen(0, "127.0.0.1", r));
  closers.push(() => d.close());
  return (d.address() as AddressInfo).port;
}

describe("worktree.create per Branch source", () => {
  it("Name: branch fix-login-u in folder fix-login-u; feat/x in folder feat-x; both marked", async () => {
    const { root, repo } = repoWithOrigin();
    const c = await client(await daemon({ root, repo }));
    expect(await c.request({ type: "worktree.create", cwd: repo, branch: "fix-login-u" })).toMatchObject({ result: { path: join(repo, ".claude", "worktrees", "fix-login-u"), branch: "fix-login-u" } });
    expect(await c.request({ type: "worktree.create", cwd: repo, branch: "feat/x" })).toMatchObject({ result: { path: join(repo, ".claude", "worktrees", "feat-x"), branch: "feat/x" } });
    expect(git(repo, "config", "--get", "branch.feat/x.claudeUiCreated")).toBe("true");
    expect(await c.request({ type: "worktree.create", cwd: repo, branch: "feat/x" })).toMatchObject({ code: "exists" });
    expect(await c.request({ type: "worktree.create", cwd: repo, branch: "-x" })).toMatchObject({ code: "bad_name" });
    expect(await c.request({ type: "worktree.create", cwd: repo, branch: 5 })).toMatchObject({ code: "bad_name" });
  });

  it("Base picker: the start point is the chosen ref", async () => {
    const { root, repo } = repoWithOrigin();
    const c = await client(await daemon({ root, repo }));
    const r = await c.request({ type: "worktree.create", cwd: repo, branch: "on-remote", base: "refs/remotes/origin/feat/remote" });
    expect(git(r.result.path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "origin/feat/remote"));
    const d = await c.request({ type: "worktree.create", cwd: repo, branch: "on-main-1", base: "refs/remotes/origin/main~1" });
    expect(git(d.result.path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "origin/main~1"));
  });

  it("Branch: a remote-only branch checks out as a local tracking branch, a branch checked out elsewhere is refused; delete keeps the branch", async () => {
    const { root, repo } = repoWithOrigin();
    const c = await client(await daemon({ root, repo }));
    const r = await c.request({ type: "worktree.create", cwd: repo, checkout: "refs/remotes/origin/feat/remote" });
    expect(r.result).toEqual({ path: join(repo, ".claude", "worktrees", "feat-remote"), branch: "feat/remote" });
    expect(git(repo, "rev-parse", "--abbrev-ref", "feat/remote@{upstream}")).toBe("origin/feat/remote");
    expect(await c.request({ type: "worktree.create", cwd: repo, checkout: "refs/heads/main" })).toMatchObject({ code: "exists" });
    expect(await c.request({ type: "worktree.remove", cwd: repo, path: r.result.path })).toMatchObject({ type: "reply" });
    expect(git(repo, "rev-parse", "--verify", "refs/heads/feat/remote")).not.toBe("");
  });

  it("deleting a worktree deletes its Created branch after the status listed its commits", async () => {
    const { root, repo } = repoWithOrigin();
    const c = await client(await daemon({ root, repo }));
    const r = await c.request({ type: "worktree.create", cwd: repo, branch: "work/1" });
    git(r.result.path, "commit", "-q", "--allow-empty", "-m", "mine");
    expect(await c.request({ type: "worktree.status", cwd: repo, path: r.result.path })).toMatchObject({ result: { commits: 1, branch: "work/1" } });
    await c.request({ type: "worktree.remove", cwd: repo, path: r.result.path });
    expect(() => git(repo, "rev-parse", "--verify", "refs/heads/work/1")).toThrow();
  });

  it("worktree.branches: local and remote rows, the worktree a branch is in, the default base; fetch and offline", async () => {
    const { root, repo } = repoWithOrigin();
    const c = await client(await daemon({ root, repo }));
    const r = await c.request({ type: "worktree.branches", cwd: repo });
    const by = Object.fromEntries((r.result.branches as { name: string }[]).map((b) => [b.name, b]));
    expect(by["main"]).toMatchObject({ local: true, worktree: repo });
    expect(by["feat/remote"]).toMatchObject({ local: false, remote: "refs/remotes/origin/feat/remote" });
    expect(r.result.defaultBase).toBe("origin/main");
    expect(await c.request({ type: "worktree.branches", cwd: repo, fetch: true })).toMatchObject({ result: { fetched: true } });
    git(repo, "remote", "set-url", "origin", join(root, "gone.git"));
    const off = await c.request({ type: "worktree.branches", cwd: repo, fetch: true });
    expect(off.result.fetchError).toBeTruthy();
    expect(off.result.branches.length).toBeGreaterThan(1);
    expect(await c.request({ type: "worktree.branches", cwd: tmpdir() })).toMatchObject({ code: "cwd_not_allowed" });
  });
});

describe("Jira over the wire", () => {
  let fake: FakeJira | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("settings jira fields, write-only token in secrets.json (0600), Test connection and search; the token is in no reply, broadcast or log", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wtj-")));
    mkdirSync(join(root, "cfg"));
    const secretsFile = join(root, "cfg", "secrets.json");
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
    closers.push(() => spies.forEach((s) => s.mockRestore()));
    fake = await fakeJira({ auth: `Bearer ${JIRA_TOKEN}`, user: "Dana Center", issues: [{ key: "PRJ-7", type: "Bug", summary: "Crash on save", status: "Open", mine: true }] });
    const port = await daemon({ root, secretsFile, settingsFile: join(root, "cfg", "settings.json") });
    const c = await client(port);
    const other = await client(port);
    expect(await c.request({ type: "jira.search" })).toMatchObject({ code: "jira_not_configured" });
    expect(await c.request({ type: "settings.get" })).toMatchObject({ result: { settings: { jira: { url: "", email: "", template: "{type}/{key}-{summary}" } }, jiraToken: false } });
    expect(await c.request({ type: "settings.set", patch: { jira: { url: "ftp://x" } } })).toMatchObject({ code: "bad_settings" });
    expect(await c.request({ type: "settings.set", patch: { jira: { url: "https://u:p@jira.example.com" } } })).toMatchObject({ code: "bad_settings" });
    expect(await c.request({ type: "settings.set", patch: { jira: { url: fake.url } } })).toMatchObject({ result: { settings: { jira: { url: fake.url } } } });
    expect(await c.request({ type: "jira.test" })).toMatchObject({ code: "jira_not_configured" });
    expect(await c.request({ type: "jira.token", token: "has space" })).toMatchObject({ code: "bad_settings" });
    expect(await c.request({ type: "jira.token", token: JIRA_TOKEN })).toMatchObject({ result: { jiraToken: true } });
    await other.waitFor((m) => m.type === "settings_changed" && m.jiraToken === true);
    if (process.platform !== "win32") expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(secretsFile, "utf8")).toContain(JIRA_TOKEN);
    expect(readFileSync(join(root, "cfg", "settings.json"), "utf8")).not.toContain(JIRA_TOKEN);
    expect(await c.request({ type: "jira.test" })).toMatchObject({ result: { user: "Dana Center" } });
    expect(await c.request({ type: "jira.search" })).toMatchObject({ result: { tickets: [{ key: "PRJ-7", type: "Bug", summary: "Crash on save", status: "Open" }] } });
    expect(await c.request({ type: "jira.search", text: `${fake.url}/browse/PRJ-7` })).toMatchObject({ result: { tickets: [{ key: "PRJ-7" }] } });
    expect(await c.request({ type: "settings.get" })).toMatchObject({ result: { jiraToken: true } });
    // Wrong token: the error names the problem, not the token.
    expect(await c.request({ type: "jira.token", token: "wrong-one" })).toMatchObject({ result: { jiraToken: true } });
    expect(await c.request({ type: "jira.search" })).toMatchObject({ code: "jira_auth" });
    expect(await c.request({ type: "jira.token", token: null })).toMatchObject({ result: { jiraToken: false } });
    expect(readFileSync(secretsFile, "utf8")).not.toContain("wrong-one");
    for (const text of [...c.raw, ...other.raw, ...logs]) {
      expect(text).not.toContain(JIRA_TOKEN);
      expect(text).not.toContain("wrong-one");
    }
  });

  it("a new Jira origin clears the token, a path change keeps it, an http address is refused (GH-451)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wtj-")));
    mkdirSync(join(root, "cfg"));
    const secretsFile = join(root, "cfg", "secrets.json");
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" "))));
    closers.push(() => spies.forEach((s) => s.mockRestore()));
    fake = await fakeJira({ auth: `Bearer ${JIRA_TOKEN}`, user: "Dana Center", issues: [] });
    const port = await daemon({ root, secretsFile, settingsFile: join(root, "cfg", "settings.json") });
    const c = await client(port);
    const other = await client(port);
    const setUrl = (url: string) => c.request({ type: "settings.set", patch: { jira: { url } } });
    // Token before any URL: kept when the first URL is set.
    expect(await c.request({ type: "jira.token", token: JIRA_TOKEN })).toMatchObject({ result: { jiraToken: true } });
    expect(await setUrl(fake.url)).toMatchObject({ result: { jiraToken: true } });
    // A non-local http address is refused and changes nothing.
    expect(await setUrl("http://jira.example.com")).toMatchObject({ code: "bad_settings", message: expect.stringContaining("https") });
    expect(await c.request({ type: "settings.get" })).toMatchObject({ result: { settings: { jira: { url: fake.url } }, jiraToken: true } });
    // Same origin, other path: kept.
    expect(await setUrl(`${fake.url}/jira`)).toMatchObject({ result: { jiraToken: true } });
    // Other origin: cleared, in the reply, the broadcast and the file.
    expect(await setUrl("https://jira.example.com")).toMatchObject({ result: { jiraToken: false } });
    await other.waitFor((m) => m.type === "settings_changed" && m.jiraToken === false);
    expect(readFileSync(secretsFile, "utf8")).not.toContain(JIRA_TOKEN);
    expect(await c.request({ type: "jira.test" })).toMatchObject({ code: "jira_not_configured" });
    // Same hostname, other port: another origin.
    expect(await setUrl(fake.url)).toMatchObject({ result: { jiraToken: false } });
    await c.request({ type: "jira.token", token: JIRA_TOKEN });
    expect(await setUrl(`http://127.0.0.1:${Number(new URL(fake.url).port) + 1}`)).toMatchObject({ result: { jiraToken: false } });
    // No URL: cleared too, so URL A -> "" -> URL B never sends A's token to B.
    expect(await setUrl(fake.url)).toMatchObject({ result: { jiraToken: false } });
    await c.request({ type: "jira.token", token: JIRA_TOKEN });
    expect(await setUrl("")).toMatchObject({ result: { jiraToken: false } });
    expect(fake.requests).toEqual([]);
    for (const text of [...c.raw, ...other.raw, ...logs]) expect(text).not.toContain(JIRA_TOKEN);
  });

  it("a stored non-local http Jira URL stays, is never sent the token and says why (GH-451)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wtj-")));
    mkdirSync(join(root, "cfg"));
    const settingsFile = join(root, "cfg", "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ jira: { url: "http://jira.example.com" } }));
    const jiraFetch = vi.fn(async () => new Response("{}"));
    const c = await client(await daemon({ root, secretsFile: join(root, "cfg", "secrets.json"), settingsFile, jiraFetch: jiraFetch as never }));
    expect(await c.request({ type: "jira.token", token: JIRA_TOKEN })).toMatchObject({ result: { jiraToken: true, settings: { jira: { url: "http://jira.example.com" } } } });
    for (const req of [{ type: "jira.test" }, { type: "jira.search" }] as const) expect(await c.request(req)).toMatchObject({ code: "jira_not_configured", message: expect.stringContaining("https") });
    expect(jiraFetch).not.toHaveBeenCalled();
  });
});
