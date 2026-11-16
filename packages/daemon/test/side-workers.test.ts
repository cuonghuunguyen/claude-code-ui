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
    } else if (text === "slow") {
      await new Promise((r) => setTimeout(r, 700));
      reply("done: slow");
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
  return (pipe = { stdin, stdout, stderr: new PassThrough(), kill: () => stdin.end(), on: (e, l) => exit.on(e, l) });
};
/** The pipe of the Side's current process: killing it is a pipe drop (the Side's daemon keeps running, as an SSH Side does). */
let pipe: SideProcess;
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
function handSide(caps?: string[], epoch = "e") {
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
      if (f.o) stdout.write(JSON.stringify({ c: f.c, m: { type: "daemon_hello", daemonId: "d", logEpoch: epoch, ...(caps && { caps }) } }) + "\n");
      if (!f.m) continue;
      got.push(f.m);
      const result = f.m.type === "session.list" ? { sessions: [], projects: ["/side/p"], recentProjects: [] } : f.m.type === "session.subscribe" ? { logEpoch: epoch, seq: 0, session: { state: "idle" } } : {};
      stdout.write(JSON.stringify({ c: f.c, m: { type: "reply", reqId: f.m.reqId, result } }) + "\n");
    }
  });
  stdout.write('{"ready":true,"schema":[1,1],"version":"1.0.0"}\n');
  const exit = new EventEmitter();
  return { got, kill: () => exit.emit("exit", 1), proc: { stdin, stdout, stderr: new PassThrough(), kill: () => exit.emit("exit", 1), on: (e: string, l: (...a: any[]) => void) => exit.on(e, l) } as SideProcess };
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

describe("a Side that goes away and comes back", () => {
  const types = (r: { events: { type: string }[] }) => r.events.map((e) => e.type).sort();
  const start = async (name: string, prompt: string) => run("worker_start", { name, project: repo, prompt, side: LABEL });
  const dropPipe = async () => {
    pipe.kill();
    await vi.waitFor(() => expect(hub.list().find((x) => x.id === "wsl:Ubuntu")!.state).not.toBe("ready"), { timeout: 5000 });
  };

  it("a pipe drop reports unreachable; the turn that ended meanwhile replays as turn_end after back; commands fail with side_not_ready meanwhile", async () => {
    await start("away", "slow");
    await dropPipe();
    expect((await wait({ names: ["away"] })).events).toEqual([expect.objectContaining({ type: "unreachable" })]);
    expect((await run("worker_list", {})).workers.find((x: { name: string }) => x.name === "away")).toMatchObject({ unreachable: true, side: LABEL });
    expect(await run("worker_send", { name: "away", text: "x" })).toEqual({ error: expect.stringMatching(/is not running/) });
    // The turn ends on the Side while it is away (its daemon keeps running, as an SSH Side's does).
    await new Promise((r) => setTimeout(r, 900));
    await hub.start("wsl:Ubuntu");
    const got = await vi.waitFor(async () => {
      const r = await wait({ names: ["away"], timeoutMs: 0 });
      expect(r.events.length).toBeGreaterThan(0);
      return r;
    }, { timeout: 8000 });
    const all = [...got.events, ...(await wait({ names: ["away"], timeoutMs: 500 })).events];
    expect(types({ events: all })).toEqual(["back", "turn_end"]);
    expect(all.find((e) => e.type === "turn_end")!.result).toBe("done: slow");
    expect((await run("worker_list", {})).workers.find((x: { name: string }) => x.name === "away").unreachable).toBeUndefined();
    await run("worker_close", { name: "away" });
    await run("worker_remove", { name: "away" });
  }, 40000);

  it("a request pending while the pipe drops is still answerable from a Hub browser after back", async () => {
    await start("pending", "perm");
    await vi.waitFor(async () => expect((await run("worker_list", {})).workers.find((x: { name: string }) => x.name === "pending")?.waitingForUser).toHaveLength(1), { timeout: 8000 });
    const w = (await run("worker_list", {})).workers.find((x: { name: string }) => x.name === "pending");
    await dropPipe();
    await hub.start("wsl:Ubuntu");
    await vi.waitFor(async () => expect((await wait({ names: ["pending"], types: ["back"], timeoutMs: 0 })).events).toHaveLength(1), { timeout: 8000 });
    const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${hubPort}` });
    const inbox: ServerMessage[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify({ type: "permission.respond", reqId: "r2", sessionId: w.sessionId, requestId: w.waitingForUser[0].requestId, decision: "allow" }));
    await vi.waitFor(() => expect(inbox.find((m) => m.type === "reply" && m.reqId === "r2")).toMatchObject({ result: { settled: true } }), { timeout: 5000 });
    ws.close();
    expect((await wait({ names: ["pending"], types: ["turn_end"] })).events[0]).toMatchObject({ result: "perm: allow" });
  }, 40000);

  it("a Side whose daemon restarted reports ended side_restarted (the link stays)", async () => {
    await start("restarty", "hi");
    expect((await wait({ names: ["restarty"] })).events[0]).toMatchObject({ type: "turn_end" });
    await dropPipe();
    expect((await wait({ names: ["restarty"], types: ["unreachable"] })).events).toHaveLength(1);
    side.close();
    side = makeSide();
    await hub.start("wsl:Ubuntu");
    const ended = await wait({ names: ["restarty"], types: ["ended"] });
    expect(ended.events).toEqual([expect.objectContaining({ type: "ended", reason: "side_restarted" })]);
    expect((await run("worker_list", {})).workers.map((x: { name: string }) => x.name)).toContain("restarty");
  }, 40000);

  it("a Side that stays away past its grace period reports ended side_unreachable", async () => {
    // A second Hub daemon on the same Sides, with a short grace period.
    const g = createDaemon({ webRoot, token, roots: [hubRoot], appSettings: hubSettings, query: workerQuery as never, projects: createProjects(), settingsFile: join(cfg, "grace-sessions.json"), history, listCache: false, modelListWaitMs: 0, sides: hub, sideGraceMs: 400, push: { publicKey: "", subscribe: () => false, send: async () => {} } });
    const gt = g.orchestration.tools(randomUUID());
    const call = async (name: string, input: object) => JSON.parse(((await gt.find((t) => t.name === name)!.handler(input as never, {})) as { content: { text: string }[] }).content[0]!.text);
    await call("worker_start", { name: "gone", project: repo, prompt: "hi", side: LABEL });
    await dropPipe();
    const r = await call("worker_wait", { names: ["gone"], timeoutMs: 8000 });
    const r2 = await call("worker_wait", { names: ["gone"], timeoutMs: 8000 });
    expect([...r.events, ...r2.events].filter((e: { type: string }) => e.type !== "turn_end").map((e: { type: string; reason?: string }) => `${e.type}${e.reason ? `:${e.reason}` : ""}`)).toEqual(["unreachable", "ended:side_unreachable"]);
    // An ended worker no longer holds a cap slot, and its Hub link can be removed while the Side is away.
    expect((await call("worker_list", {})).workers[0]).toMatchObject({ name: "gone", live: false, state: "closed" });
    expect(await call("worker_remove", { name: "gone" })).toEqual({ name: "gone", removed: true });
    g.close();
    await hub.start("wsl:Ubuntu");
  }, 40000);
});

describe("a Side runtime that is not the one a worker was seen on", () => {
  it("a Hub restart adopts the worker without events; a later attach to another Side run reports ended side_restarted", async () => {
    const coordinatorId = randomUUID();
    const sessionId = randomUUID();
    const sessions = join(cfg, "hand-sessions.json");
    writeFileSync(sessions, JSON.stringify({ [sessionId]: { coordinatorId, name: "w", cwd: "/side/p", side: "wsl:Hand", saved: Date.now() } }));
    let hand = handSide(["remoteWorkers"], "run1");
    const handHub = createSides({ targets: [wslSide("Hand")], spawn: () => hand.proc, posixLocal: true });
    const d = createDaemon({ webRoot, token, roots: [hubRoot], appSettings: hubSettings, query: workerQuery as never, projects: createProjects(), settingsFile: sessions, history, listCache: false, modelListWaitMs: 0, sides: handHub, sideGraceMs: 60_000, push: { publicKey: "", subscribe: () => false, send: async () => {} } });
    const t = d.orchestration.tools(coordinatorId);
    const call = async (name: string, input: object) => JSON.parse(((await t.find((x) => x.name === name)!.handler(input as never, {})) as { content: { text: string }[] }).content[0]!.text);
    // Before the Side is up the link is listed, and no command reaches it.
    expect((await call("worker_list", {})).workers).toEqual([expect.objectContaining({ name: "w", state: "idle", live: false })]);
    await handHub.start("wsl:Hand");
    await vi.waitFor(() => expect(hand.got.map((m) => m.type)).toContain("session.subscribe"), { timeout: 5000 });
    expect((await call("worker_wait", { timeoutMs: 0 })).events).toEqual([]);
    // The Side process ends and another run of its daemon (a new epoch) comes up.
    hand.kill();
    await vi.waitFor(() => expect(handHub.list().find((x) => x.id === "wsl:Hand")!.state).not.toBe("ready"), { timeout: 5000 });
    expect((await call("worker_wait", { timeoutMs: 2000 })).events).toEqual([expect.objectContaining({ type: "unreachable" })]);
    hand = handSide(["remoteWorkers"], "run2");
    await handHub.start("wsl:Hand");
    expect((await call("worker_wait", { timeoutMs: 5000 })).events).toEqual([expect.objectContaining({ type: "ended", reason: "side_restarted" })]);
    d.close();
    handHub.close();
  }, 30000);
});
