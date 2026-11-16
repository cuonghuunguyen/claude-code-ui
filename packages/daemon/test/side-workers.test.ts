// GH-575: a Hub's coordinator starts and drives workers that run on a Side. A real Hub daemon and a real Side daemon (in process, no WSL or
// Docker, so it runs on Windows too) joined by createSides; the Side's CLI is a fake. No browser is connected unless a test opens one.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type PushPayload, type ServerMessage } from "@claude-ui/protocol";
import { checkRemoteWorker } from "../src/orchestration.ts";
import { createProjects } from "../src/projects.ts";
import { createDaemon } from "../src/server.ts";
import { createSettings } from "../src/settings.ts";
import { createSides, forwardSidePush, runSide, wslSide, type SideProcess } from "../src/sides.ts";
import { models } from "./fake-query.ts";

const dir = (p: string) => realpathSync(mkdtempSync(join(tmpdir(), p)));
const webRoot = dir("sw-web-");
writeFileSync(join(webRoot, "index.html"), "<h1>app</h1>");
const sideRoot = dir("sw-side-");
const hubRoot = dir("sw-hub-");
const cfg = dir("sw-cfg-");
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";
const history = { listSessions: (async () => []) as never, getSessionInfo: (async () => undefined) as never, getSessionMessages: (async () => []) as never };

const repo = join(sideRoot, "app");
mkdirSync(repo);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
for (const m of ["one", "two"]) execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", m], { cwd: repo });

/** One query() of a worker CLI on the Side. */
type Run = { options: Options; texts: string[] };
const runs: Run[] = [];
/** The Side's fake CLI: "perm" asks a permission request and waits for the answer; "hold" ends its turn with the next prompt; any other text replies "done: <text>". */
function workerQuery({ prompt, options = {} }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  const run: Run = { options, texts: [] };
  runs.push(run);
  const sid = options.sessionId ?? options.resume ?? "x";
  const out: SDKMessage[] = [];
  let wake = () => {};
  const emit = (m: unknown) => (out.push(m as SDKMessage), wake());
  const reply = (text: string) => emit({ type: "assistant", uuid: randomUUID(), session_id: sid, parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, role: "assistant", content: [{ type: "text", text }] } });
  const result = () => emit({ type: "result", subtype: "success", uuid: randomUUID(), session_id: sid, is_error: false, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [], result: "" });
  let held: ((text: string) => void) | undefined;
  const turn = async (text: string) => {
    if (text === "perm") {
      const toolUseID = randomUUID();
      emit({ type: "assistant", uuid: randomUUID(), session_id: sid, parent_tool_use_id: null, message: { id: `msg_${toolUseID}`, role: "assistant", content: [{ type: "tool_use", id: toolUseID, name: "Bash", input: { command: "ls" } }] } });
      const r = await options.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, suggestions: [], toolUseID, requestId: randomUUID() });
      reply(`perm: ${r!.behavior}`);
    } else if (text === "hold") {
      reply("holding");
      reply(`released by ${await new Promise<string>((r) => (held = r))}`);
    } else reply(`done: ${text}`);
    result();
  };
  void (async () => {
    let busy: Promise<void> | undefined;
    for await (const m of prompt) {
      const text = m.message.content as string;
      run.texts.push(text);
      emit({ ...m, session_id: sid, isReplay: true });
      if (held) {
        const h = held;
        held = undefined;
        h(text);
        continue;
      }
      await busy;
      busy = turn(text);
    }
  })();
  const q = (async function* () {
    for (;;) {
      while (out.length) yield out.shift()!;
      await new Promise<void>((r) => (wake = r));
    }
  })();
  return Object.assign(q, {
    supportedCommands: async () => [],
    supportedAgents: async () => ["claude", "orchestration:implementer"].map((name) => ({ name, description: name })),
    supportedModels: async () => models,
    setPermissionMode: async () => {},
    interrupt: async () => {
      const h = held;
      held = undefined;
      h?.("interrupt");
      return { still_queued: [] };
    },
    close: () => void q.return(undefined as never),
  });
}

const sideSettings = createSettings({ file: join(cfg, "side-settings.json") });
sideSettings.set({ orchestration: { enabled: true, closeFinished: true }, terminalAccess: { enabled: false }, inlineTask: { enabled: false }, fork: { enabled: false } });
const sideLinks = join(cfg, "side-sessions.json");
const sideProjects = createProjects();
sideProjects.open(repo);
const makeSide = () =>
  createDaemon({ webRoot, token: "", roots: [sideRoot], appSettings: sideSettings, query: workerQuery as never, projects: sideProjects, settingsFile: sideLinks, history, listCache: false, modelListWaitMs: 0, push: { publicKey: "", subscribe: () => false, send: async (p: PushPayload) => hostPush(p) } });
let side = makeSide();
let hostPush: (p: PushPayload) => void = () => {};
const spawnSide = async (): Promise<SideProcess> => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const exit = new EventEmitter();
  const running = runSide({ ready: { schema: [1, 1], version: "1.0.0" }, input: stdin, output: stdout, accept: side.accept, onEnd: () => exit.emit("exit", 0) });
  hostPush = running.push;
  return { stdin, stdout, stderr: new PassThrough(), kill: () => stdin.end(), on: (e, l) => exit.on(e, l) };
};
const hubPushes: PushPayload[] = [];
const hub = createSides({ targets: [wslSide("Ubuntu")], spawn: spawnSide, onPush: forwardSidePush({ send: async (p) => void hubPushes.push(p) }), posixLocal: true });
const midCoordinator = randomUUID();
// A second Hub coordinator that is itself a worker of a root coordinator (depth 1): its workers on the Side are at depth 2.
writeFileSync(join(cfg, "hub-sessions.json"), JSON.stringify({ [midCoordinator]: { coordinatorId: randomUUID(), name: "mid", cwd: hubRoot, saved: Date.now() } }));
const hubSettings = createSettings({ file: join(cfg, "hub-settings.json") });
hubSettings.set({ orchestration: { enabled: true, closeFinished: true }, terminalAccess: { enabled: false }, inlineTask: { enabled: false }, fork: { enabled: false } });
const hubD = createDaemon({ webRoot, token, roots: [hubRoot], appSettings: hubSettings, query: workerQuery as never, projects: createProjects(), settingsFile: join(cfg, "hub-sessions.json"), history, listCache: false, modelListWaitMs: 0, sides: hub, push: { publicKey: "", subscribe: () => false, send: async () => {} } });
await new Promise<void>((r) => hubD.listen(0, "127.0.0.1", () => r()));
const hubPort = (hubD.address() as AddressInfo).port;
afterAll(() => void (hubD.close(), side.close(), hub.close()));

const LABEL = wslSide("Ubuntu").label;
const coordinator = randomUUID();
const tools = hubD.orchestration.tools(coordinator);
const run = async (name: string, input: object) => {
  const r = (await tools.find((t) => t.name === name)!.handler(input as never, {})) as { content: { text: string }[]; isError?: boolean };
  const text = r.content[0]!.text;
  return r.isError ? { error: text } : JSON.parse(text);
};
const wait = (a: object = {}) => run("worker_wait", { timeoutMs: 8000, ...a }) as Promise<{ events: { name: string; type: string; result?: string; reason?: string; closed?: true }[] }>;

describe("a Hub coordinator drives workers on a Side", () => {
  it("lists the Side's projects, starts a worker there, and follows it: events, read, send, close, remove (no browser connected)", async () => {
    await hub.start("wsl:Ubuntu");
    const targets = await vi.waitFor(async () => {
      const t = await run("worker_targets", {});
      expect(t.targets.some((e: { side?: string }) => e.side === LABEL)).toBe(true);
      return t;
    }, { timeout: 8000, interval: 1500 });
    expect(targets.targets.find((e: { side?: string }) => e.side === LABEL).path).toBe(repo);

    const w = await run("worker_start", { name: "w1", project: repo, prompt: "run tests", side: LABEL });
    expect(w).toMatchObject({ name: "w1", side: LABEL, cwd: repo, engine: "claude" });
    // The worker's CLI runs on the Side, with the mode the Hub chose.
    expect(runs.some((r) => r.options.cwd === repo && r.texts.includes("run tests"))).toBe(true);

    const first = await wait({ names: ["w1"] });
    expect(first.events).toEqual([expect.objectContaining({ name: "w1", type: "turn_end", result: "done: run tests" })]);
    // The Side closes the CLI after the turn; the hub never holds it (background subscription).
    await vi.waitFor(async () => expect((await run("worker_list", {})).workers[0].live).toBe(false), { timeout: 5000 });
    const list = await run("worker_list", {});
    expect(list.workers[0]).toMatchObject({ name: "w1", sessionId: w.sessionId, side: LABEL, state: "idle" });
    expect((await run("worker_read", { name: "w1" })).entries.join("\n")).toContain("reply: done: run tests");

    expect(await run("worker_send", { name: "w1", text: "again" })).toMatchObject({ delivered: "new turn" });
    expect((await wait({ names: ["w1"] })).events[0]).toMatchObject({ type: "turn_end", result: "done: again" });
    expect(await run("worker_keep_open", { name: "w1", keepOpen: true })).toEqual({ name: "w1", keepOpen: true });
    expect(await run("worker_close", { name: "w1" })).toEqual({ name: "w1", closed: true });
    expect(await run("worker_remove", { name: "w1" })).toEqual({ name: "w1", removed: true });
    expect((await run("worker_list", {})).workers).toEqual([]);
  }, 40000);

  it("a new branch gets its worktree on the Side", async () => {
    const w = await run("worker_start", { name: "w2", project: repo, branch: "feat-x", prompt: "hello", side: LABEL });
    expect(w).toMatchObject({ name: "w2", side: LABEL, project: "app", branch: "feat-x" });
    expect(w.cwd).toBe(join(repo, ".claude", "worktrees", "feat-x"));
    expect((await wait({ names: ["w2"] })).events[0]).toMatchObject({ type: "turn_end", result: "done: hello" });
    expect(await run("worker_remove", { name: "w2" })).toEqual({ name: "w2", removed: true });
  }, 40000);

  it("a permission request of a worker goes to the user, not the coordinator: pushed, listed as waiting, answered from a browser through the Hub", async () => {
    hubPushes.length = 0;
    await run("worker_start", { name: "w3", project: repo, prompt: "perm", side: LABEL });
    await vi.waitFor(async () => expect((await run("worker_list", {})).workers.find((x: { name: string }) => x.name === "w3")?.waitingForUser).toHaveLength(1), { timeout: 8000 });
    const list = await run("worker_list", {});
    const w = list.workers.find((x: { name: string }) => x.name === "w3");
    expect(w).toMatchObject({ state: "needs_input", waitingForUser: [expect.objectContaining({ kind: "permission", tool: "Bash" })] });
    await vi.waitFor(() => expect(hubPushes.map((p) => p.body)).toEqual([expect.stringMatching(/^Needs input · /)]), { timeout: 5000 });
    // The coordinator gets no event for it.
    expect((await wait({ names: ["w3"], timeoutMs: 0 })).events).toEqual([]);
    // The user answers in a browser connected to the Hub: the Hub routes it to the Side that owns the session.
    const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${hubPort}` });
    const inbox: ServerMessage[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "permission.respond", reqId: "r1", sessionId: w.sessionId, requestId: w.waitingForUser[0].requestId, decision: "allow" }));
    await vi.waitFor(() => expect(inbox.find((m) => m.type === "reply" && m.reqId === "r1")).toBeTruthy(), { timeout: 5000 });
    ws.close();
    expect((await wait({ names: ["w3"] })).events[0]).toMatchObject({ type: "turn_end", result: "perm: allow" });
    await run("worker_close", { name: "w3" });
    await run("worker_remove", { name: "w3" });
  }, 40000);

  it("a worker of a worker keeps its depth on the Side: the Side's own depth limit counts from the Hub's", async () => {
    const mid = hubD.orchestration.tools(midCoordinator);
    const call = async (name: string, input: object) => JSON.parse(((await mid.find((t) => t.name === name)!.handler(input as never, {})) as { content: { text: string }[] }).content[0]!.text);
    const w = await call("worker_start", { name: "deep", project: repo, prompt: "hi", side: LABEL });
    // On the Side the worker is at depth 2 (limit 2): it may not start workers of its own.
    const onSide = side.orchestration.tools(w.sessionId);
    const r = (await onSide.find((t) => t.name === "worker_start")!.handler({ name: "x", cwd: repo, prompt: "y" } as never, {})) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/depth limit reached: you are a worker at depth 2/);
    await wait({ names: ["deep"] }).catch(() => {});
  }, 40000);
});

/** A Side driven by hand: its hello (with or without caps), its list, and what the Hub sent it. */
function handSide(caps?: string[]) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const got: { type: string }[] = [];
  let buf = "";
  stdin.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines) {
      const f = JSON.parse(l);
      if (f.o) stdout.write(JSON.stringify({ c: f.c, m: { type: "daemon_hello", daemonId: "d", logEpoch: "e", ...(caps && { caps }) } }) + "\n");
      if (!f.m) continue;
      got.push(f.m);
      const result = f.m.type === "session.list" ? { sessions: [], projects: ["/side/p"], recentProjects: [] } : {};
      stdout.write(JSON.stringify({ c: f.c, m: { type: "reply", reqId: f.m.reqId, result } }) + "\n");
    }
  });
  stdout.write('{"ready":true,"schema":[1,1],"version":"1.0.0"}\n');
  const exit = new EventEmitter();
  return { got, proc: { stdin, stdout, stderr: new PassThrough(), kill: () => exit.emit("exit", 1), on: (e: string, l: (...a: any[]) => void) => exit.on(e, l) } as SideProcess };
}

describe("a Side that cannot run workers for this Hub", () => {
  it("an older Side (no remoteWorkers in its hello) is refused before anything is created", async () => {
    const old = handSide();
    const oldHub = createSides({ targets: [wslSide("Old")], spawn: () => old.proc, posixLocal: true });
    const d = createDaemon({ webRoot, token, roots: [hubRoot], appSettings: hubSettings, query: workerQuery as never, projects: createProjects(), settingsFile: join(cfg, "old-sessions.json"), history, listCache: false, modelListWaitMs: 0, sides: oldHub });
    await oldHub.start("wsl:Old");
    const t = d.orchestration.tools(randomUUID());
    const r = (await t.find((x) => x.name === "worker_start")!.handler({ name: "w", cwd: "/side/p", prompt: "hi", side: wslSide("Old").label } as never, {})) as { content: { text: string }[]; isError?: boolean };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("WSL: Old runs an older Claude UI that cannot run workers for this Hub. Update it (Settings > Sides).");
    expect(old.got.map((m) => m.type)).not.toContain("session.create");
    d.close();
    oldHub.close();
  });

  it("the Side refuses a worker with a bad name, or in bypassPermissions (session.create validation)", () => {
    expect(checkRemoteWorker({ coordinatorId: "c1", name: "ok-name" }, "auto")).toBeUndefined();
    expect(checkRemoteWorker({ coordinatorId: "c1", name: "Bad Name" }, "auto")).toMatch(/worker.name must be/);
    expect(checkRemoteWorker({ coordinatorId: "c1", name: "ok" }, "bypassPermissions")).toMatch(/does not run in bypassPermissions/);
    expect(checkRemoteWorker({ coordinatorId: "c1", name: "ok" }, "dontAsk")).toMatch(/does not run in dontAsk/);
    expect(checkRemoteWorker({ coordinatorId: "c1", name: "ok", depth: 0 }, undefined)).toMatch(/worker.depth must be/);
  });
});
