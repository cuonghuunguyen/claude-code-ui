import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import type { ListResult, SessionListItem } from "@claude-ui/protocol";
import { parseCli, type Cli } from "../src/cli.ts";
import { claimDaemonFile, daemonFile, readDaemonFile, removeDaemonFile, writeDaemonFile } from "../src/ctl/daemon-file.ts";
import { resolvePort } from "../src/ctl/connect.ts";
import { runClient, runOpener, type ClientIo } from "../src/ctl/commands.ts";
import { createProjects } from "../src/projects.ts";
import { createDaemon } from "../src/server.ts";
import { fakeQuery } from "./fake-query.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const token = "t0ken-for-ctl-tests_abcdefghijklmnopqrstuvwxyz";

describe("daemon.json", () => {
  it("is written 0600 without the token, read back, and removed only by its own pid", () => {
    const dir = tmp("cu-df-");
    writeDaemonFile(dir, { port: 5000, pid: process.pid, version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z" });
    const file = daemonFile(dir);
    expect(readFileSync(file, "utf8")).not.toContain(token);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readDaemonFile(dir)).toEqual({ port: 5000, pid: process.pid, version: "1.2.3", startedAt: "2026-01-01T00:00:00.000Z" });
    removeDaemonFile(dir, process.pid + 1);
    expect(existsSync(file)).toBe(true);
    removeDaemonFile(dir, process.pid);
    expect(existsSync(file)).toBe(false);
    expect(readDaemonFile(dir)).toBeUndefined();
  });
  it("garbage reads as absent", () => {
    const dir = tmp("cu-df-");
    writeFileSync(daemonFile(dir), "{nope");
    expect(readDaemonFile(dir)).toBeUndefined();
    writeFileSync(daemonFile(dir), JSON.stringify({ port: "x" }));
    expect(readDaemonFile(dir)).toBeUndefined();
  });
});

describe("resolvePort: --port, PORT, live daemon.json, 4280", () => {
  const dir = tmp("cu-port-");
  const alive = () => true;
  it("order", () => {
    writeDaemonFile(dir, { port: 7000, pid: 1, version: "x", startedAt: "" });
    expect(resolvePort({ flag: 6000, env: { PORT: "5000" }, dir, alive })).toBe(6000);
    expect(resolvePort({ env: { PORT: "5000" }, dir, alive })).toBe(5000);
    expect(resolvePort({ env: {}, dir, alive })).toBe(7000);
    expect(resolvePort({ env: {}, dir, alive: () => false })).toBe(4280);
    expect(resolvePort({ env: {}, dir: tmp("cu-port-"), alive })).toBe(4280);
  });
});

/** A real daemon on a random port, a project dir, a config dir with the token file. */
const projectDir = tmp("cu-proj-");
const other = tmp("cu-other-");
const webRoot = tmp("cu-web-");
const dir = tmp("cu-cfg-");
writeFileSync(join(dir, "token"), token + "\n", { mode: 0o600 });
const sessionIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const listed = [
  { sessionId: sessionIds[0], summary: "Alpha", cwd: projectDir, lastModified: 3000 },
  { sessionId: sessionIds[1], summary: "Beta", cwd: projectDir, lastModified: 2000 },
  { sessionId: sessionIds[2], summary: "Gamma", cwd: other, lastModified: 1000 },
];
const projects = createProjects({ file: join(dir, "projects.json") });
projects.open(projectDir);
projects.open(other);
const daemon = createDaemon({ webRoot, roots: [projectDir, other, webRoot], query: fakeQuery as never, token, uploadDir: join(tmp("cu-up-"), "u"), projects, history: { listSessions: (async () => listed) as never, getSessionInfo: (async () => undefined) as never } as never });
await new Promise<void>((r) => daemon.listen(0, "127.0.0.1", r));
const port = (daemon.address() as AddressInfo).port;
afterAll(() => void daemon.close());

function run(argv: string[], over: Partial<ClientIo> = {}) {
  const cli = parseCli(argv, {}, "/h") as Extract<Cli, { kind: "client" }>;
  expect(cli.kind).toBe("client");
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const io: ClientIo = { env: { PORT: String(port) }, dir, stdout: (s) => out.push(s), stderr: (s) => err.push(s), openUrl: async (u) => void opened.push(u), ...over };
  return runClient(cli, io).then((code) => ({ code, out: out.join(""), err: err.join(""), opened }));
}

describe("client against a real daemon", () => {
  it("status: text and json", async () => {
    const t = await run(["status"]);
    expect(t.code).toBe(0);
    expect(t.out).toContain(`127.0.0.1:${port}`);
    expect(t.out).toMatch(/sessions: 3/);
    const j = await run(["status", "--json"]);
    const v = JSON.parse(j.out);
    expect(v).toMatchObject({ running: true, port, sessions: { total: 3 } });
  });
  it("status uses daemon.json for version and pid", async () => {
    writeDaemonFile(dir, { port, pid: process.pid, version: "9.9.9", startedAt: "2026-02-02T00:00:00.000Z" });
    const v = JSON.parse((await run(["status", "--json"])).out);
    expect(v).toMatchObject({ version: "9.9.9", pid: process.pid, startedAt: "2026-02-02T00:00:00.000Z" });
    removeDaemonFile(dir, process.pid);
  });
  it("sessions: json equals the daemon list after filters; --project; --state; text", async () => {
    const all = JSON.parse((await run(["sessions", "--json"])).out) as SessionListItem[];
    expect(all.map((s) => s.id)).toEqual(sessionIds);
    expect(JSON.parse((await run(["ls", "--json", "--project", projectDir])).out).map((s: SessionListItem) => s.id)).toEqual(sessionIds.slice(0, 2));
    expect(JSON.parse((await run(["sessions", "--json", "--state", "needs_input"])).out)).toEqual([]);
    const text = (await run(["sessions"])).out;
    expect(text).toContain("Alpha");
    expect(text).toContain(sessionIds[0]);
  });
  it("projects and workers", async () => {
    const p = JSON.parse((await run(["projects", "--json"])).out);
    expect(p.projects.sort()).toEqual([other, projectDir].sort());
    expect((await run(["projects"])).out).toContain(projectDir);
    const w = await run(["workers"]);
    expect(w).toMatchObject({ code: 0, out: "No workers.\n" });
    expect(JSON.parse((await run(["workers", "--json"])).out)).toEqual([]);
  });
  it("open: browser by default, token only with --print", async () => {
    const o = await run(["open"]);
    expect(o.code).toBe(0);
    expect(o.opened).toEqual([`http://127.0.0.1:${port}/#token=${token}`]);
    expect(o.out + o.err).not.toContain(token);
    const p = await run(["open", "--print"]);
    expect(p.out.trim()).toBe(`http://127.0.0.1:${port}/#token=${token}`);
    expect(p.opened).toEqual([]);
  });
  it("open <sessionId>: deep link without the token; unknown id is exit 1", async () => {
    const o = await run(["open", sessionIds[1]!, "--print"]);
    expect(o.out.trim()).toBe(`http://127.0.0.1:${port}/#${sessionIds[1]}`);
    expect(o.out).not.toContain(token);
    expect((await run(["open", "44444444-4444-4444-8444-444444444444"])).code).toBe(1);
  });
  it("no output of any command holds the token, except open --print", async () => {
    for (const argv of [["status"], ["status", "--json"], ["sessions"], ["sessions", "--json"], ["projects"], ["projects", "--json"], ["workers"], ["workers", "--json"], ["open"], ["open", sessionIds[0]!]]) {
      const r = await run(argv);
      expect(r.out + r.err, argv.join(" ")).not.toContain(token);
    }
    const bad = await run(["status"], { dir: tmp("cu-nodir-") });
    expect(bad.out + bad.err).not.toContain(token);
  });
  it("wrong token: exit 3 token rejected; --token-file works; missing file: exit 3 and no file created", async () => {
    const wrongDir = tmp("cu-wrong-");
    writeFileSync(join(wrongDir, "token"), "wrong-token-wrong-token-wrong-token\n");
    const w = await run(["status"], { dir: wrongDir });
    expect(w.code).toBe(3);
    expect(w.err).toContain("token rejected");
    const viaFile = await run(["status", "--token-file", join(dir, "token")], { dir: wrongDir });
    expect(viaFile.code).toBe(0);
    const empty = tmp("cu-empty-");
    const m = await run(["status"], { dir: empty });
    expect(m.code).toBe(3);
    expect(m.err).toContain("never started");
    expect(existsSync(join(empty, "token"))).toBe(false);
    expect(readdirSync(empty)).toEqual([]);
    const noFile = await run(["status", "--token-file", join(empty, "nope")]);
    expect(noFile.code).toBe(3);
    expect(noFile.err).toContain(`token file not found: ${join(empty, "nope")}`);
    const viaEnv = await run(["status"], { env: { PORT: String(port), CLAUDE_UI_TOKEN_FILE: join(empty, "envnope") } });
    expect(viaEnv.err).toContain(`token file not found: ${join(empty, "envnope")}`);
  });
  it("no daemon: exit 3 not running; --json error on stderr", async () => {
    const r = await run(["status"], { env: { PORT: "1" } });
    expect(r.code).toBe(3);
    expect(r.err).toContain("not running");
    const j = await run(["status", "--json"], { env: { PORT: "1" } });
    expect(JSON.parse(j.err)).toMatchObject({ error: { code: "not_running" } });
    expect(j.out).toBe("");
  });
  it("no command exits 75", async () => {
    for (const argv of [["status"], ["sessions"], ["open", "x-bad"], ["projects"]]) expect((await run(argv)).code).not.toBe(75);
  });
});

describe("workers grouping", () => {
  const item = (o: Partial<SessionListItem>): SessionListItem => ({ id: "i", cwd: "/p", state: "idle", model: "m", permissionMode: "default", effort: "high", permissionModes: [], title: "t", lastActivity: 0, archived: false, transcript: true, ...o });
  const list: ListResult = {
    sessions: [item({ id: "c1", coordinator: true, title: "Coord" }), item({ id: "w1", coordinatorId: "c1", workerName: "fix-a", state: "running" }), item({ id: "w2", coordinatorId: "c1", workerName: "fix-b" }), item({ id: "x" })],
    projects: [],
    recentProjects: [],
    permissionModes: [],
  };
  it("groups by coordinator id", async () => {
    const t = await run(["workers"], { request: async () => list });
    expect(t.out).toContain("c1");
    expect(t.out).toContain("fix-a");
    expect(t.out).toContain("running");
    expect(t.out).not.toContain("x ");
    const j = JSON.parse((await run(["workers", "--json"], { request: async () => list })).out);
    expect(j.map((w: SessionListItem) => w.workerName)).toEqual(["fix-a", "fix-b"]);
    const one = JSON.parse((await run(["workers", "--json"], { request: async () => ({ ...list, sessions: [item({ id: "w9", coordinatorId: "c9", workerName: "z" })] }) })).out);
    expect(one).toHaveLength(1);
  });
});

describe("opener failure", () => {
  it("runOpener rejects on a non-zero exit and on a missing command, resolves on 0", async () => {
    await expect(runOpener(process.execPath, ["-e", "process.exit(3)"])).rejects.toThrow(/exited with code 3/);
    await expect(runOpener("claude-ui-no-such-opener", [])).rejects.toThrow();
    await expect(runOpener(process.execPath, ["-e", "0"])).resolves.toBeUndefined();
  });
  it("open prints an error and exits 1; nothing says Opened", async () => {
    const r = await run(["open"], { openUrl: () => Promise.reject(new Error("xdg-open exited with code 3")) });
    expect(r.code).toBe(1);
    expect(r.err).toContain("cannot open a browser");
    expect(r.out).not.toContain("Opened");
    expect(r.out + r.err).not.toContain(token);
  });
});

describe("daemon.json of two daemons on one config dir", () => {
  it("the later writer wins; an earlier daemon's exit does not remove the later one's file", () => {
    const d = tmp("cu-two-");
    const releaseA = claimDaemonFile(d, { port: 5001, pid: 111, version: "x", startedAt: "a" });
    const releaseB = claimDaemonFile(d, { port: 5002, pid: 222, version: "x", startedAt: "b" });
    expect(readDaemonFile(d)?.pid).toBe(222);
    releaseA();
    expect(readDaemonFile(d)?.pid).toBe(222);
    releaseB();
    expect(existsSync(daemonFile(d))).toBe(false);
  });
});

describe("usage error of the real entry point", () => {
  it("short hint, exit 2, no daemon exit line", async () => {
    const main = join(import.meta.dirname, "../src/main.ts");
    const r = await new Promise<{ code: number; err: string }>((done) => execFile(process.execPath, ["--import", "tsx", main, "bogus"], { env: { ...process.env, XDG_CONFIG_HOME: tmp("cu-xdg-") } }, (e, _o, err) => done({ code: (e as { code?: number } | null)?.code ?? 0, err })));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command 'bogus'");
    expect(r.err).toContain("claude-ui --help");
    expect(r.err).not.toContain("exit, code");
    expect(r.err).not.toContain("Commands:");
  });
});
