// GH-334 regression tests (from the PR #348 review). Unit level: createOrchestration with fake deps.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createOrchestration } from "../src/orchestration.ts";
import { createSessionSettings } from "../src/session-settings.ts";

type Fake = { id: string; live: boolean; tier: () => Promise<string>; pending: Set<string> };
function fakeSession(id: string, live = true): any {
  const f: Fake = { id, live, tier: async () => "low", pending: new Set() };
  return Object.assign(f, {
    isLive: () => true,
    liveQuery: () => (f.live ? {} : undefined),
    info: () => ({ state: "idle", permissionMode: "default" }),
    working: () => false,
    permissionTier: () => f.tier(),
    pendingRequest: (r: string) => (f.pending.has(r) ? { type: "permission_request", escalated: false } : undefined),
    subscribe: () => () => {},
  });
}

function setup(links = createSessionSettings()) {
  const sessions = new Map<string, any>();
  const prompts: [string, string][] = [];
  /** A notice's prompt waits here while set (it is "in flight"); stillWanted is checked after, as sendPrompt does after its sync. */
  const flight: { gate?: Promise<void> } = {};
  let worktreeGate: (() => void) | undefined;
  const o = createOrchestration({
    links,
    settings: () => ({ enabled: true, workerCap: 5, coordinatorPermissions: true, workerMode: "coordinator" }) as any,
    sessions,
    find: async (id) => sessions.get(id),
    create: (cwd) => {
      const s = fakeSession(`new-${sessions.size}`);
      sessions.set(s.id, s);
      return s;
    },
    prompt: async (s, t, stillWanted) => {
      await flight.gate;
      if (stillWanted && !stillWanted()) return "cancelled";
      prompts.push([s.id, t]);
      return undefined;
    },
    allowed: (p) => p,
    isProject: () => true,
    createWorktree: (repo, opt) =>
      new Promise((resolve) => {
        worktreeGate = () => {
          opt.onCreated?.({ path: `/wt/${opt.branch}` } as any);
          resolve({ path: `/wt/${opt.branch}`, branch: opt.branch! });
        };
      }),
    port: () => 1,
    heldElsewhere: () => false,
    models: () => [],
    remove: async () => undefined,
  });
  return { o, sessions, prompts, links, flight, gate: () => worktreeGate?.() };
}

const turnEnd = { part: { type: "turn_result", id: "r", durationMs: 1, isError: false } } as any;
const tick = () => new Promise((r) => setTimeout(r, 10));

async function mcp(server: any) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.orchestration.instance.connect(b);
  const c = new Client({ name: "t", version: "1" });
  await c.connect(a);
  return c;
}

describe("orchestration /clear hand-over (GH-334 review)", () => {
  it(" a notice out before /clear does not suppress notices to the new session", async () => {
    const { o, sessions, prompts, links } = setup();
    const C = fakeSession("C"), H = fakeSession("H"), W = fakeSession("W");
    [C, H, W].forEach((s) => sessions.set(s.id, s));
    o.mcpServers("C");
    links.set("W", { coordinatorId: "C", name: "w" });
    o.observe(W, turnEnd); // queued, notice to C, notified has C
    await tick();
    expect(prompts.map((p) => p[0])).toEqual(["C"]);
    // /clear before the coordinator calls worker_wait (e.g. the user stops the notice turn, then /clear).
    C.live = false;
    o.handOver("C", "H");
    o.observe(W, turnEnd);
    await tick();
    // Expected: the new conversation is told of the queued events (spec: "a queued event gets its notice at once").
    expect(prompts.filter((p) => p[0] === "H").length).toBeGreaterThan(0);
  });

  it(" a permission event whose tier read spans the /clear goes to the new session, not the old one", async () => {
    const { o, sessions, prompts, links } = setup();
    const C = fakeSession("C"), H = fakeSession("H"), W = fakeSession("W");
    [C, H, W].forEach((s) => sessions.set(s.id, s));
    o.mcpServers("C");
    links.set("W", { coordinatorId: "C", name: "w" });
    let release!: (t: string) => void;
    W.tier = () => new Promise<string>((r) => (release = r));
    W.pending.add("req1");
    o.observe(W, { part: { type: "permission_request", id: "p", requestId: "req1", tool: "Bash", input: {}, settled: false } } as any);
    await tick();
    C.live = false;
    o.handOver("C", "H");
    release("low");
    await tick();
    // Old session C is idle, live state, no query: a notice to it resumes the old transcript (the GH-334 symptom).
    expect(prompts.filter((p) => p[0] === "C")).toEqual([]);
    expect(prompts.filter((p) => p[0] === "H").length).toBe(1);
  });

  it(" a sessions.json write failure during handOver does not throw into the drive loop", () => {
    const real = createSessionSettings();
    let fail = false;
    const links = { ...real, set: (...a: Parameters<typeof real.set>) => { if (fail) throw new Error("EACCES"); return real.set(...a); } } as typeof real;
    const { o, sessions } = setup(links);
    const C = fakeSession("C"), H = fakeSession("H"), W = fakeSession("W");
    [C, H, W].forEach((s) => sessions.set(s.id, s));
    links.set("W", { coordinatorId: "C", name: "w" });
    fail = true;
    expect(() => o.handOver("C", "H")).not.toThrow();
  });

  it(" two /clear while worker_start creates a worktree: the worker links to the last session, no reservation leak", async () => {
    const { o, sessions, links, gate } = setup();
    const A = fakeSession("A");
    sessions.set("A", A);
    const c = await mcp(o.mcpServers("A"));
    const p = c.callTool({ name: "worker_start", arguments: { name: "wt", repo: "/repo", branch: "b1", prompt: "go" } });
    await tick();
    sessions.set("B", fakeSession("B"));
    o.handOver("A", "B");
    sessions.set("Cc", fakeSession("Cc"));
    o.handOver("B", "Cc");
    gate();
    const r = (await p) as any;
    expect(r.isError).toBeFalsy();
    const id = JSON.parse(r.content[0].text).sessionId;
    expect(links.get(id)?.coordinatorId).toBe("Cc");
    // Same name again from the same query: refused because the worker exists, not because of a stale reservation; a new name passes the reservation check.
    const again = (await c.callTool({ name: "worker_start", arguments: { name: "wt", cwd: "/", prompt: "go" } })) as any;
    expect(again.content[0].text).toContain("exists already");
    await c.close();
  });

  it(" worker /clear: name stays unique, old worker is plain, coordinator sees the new id", async () => {
    const { o, sessions, links } = setup();
    const C = fakeSession("C"), W = fakeSession("W"), W2 = fakeSession("W2");
    [C, W, W2].forEach((s) => sessions.set(s.id, s));
    links.set("W", { coordinatorId: "C", name: "w", cwd: "/x", port: 1 });
    o.handOver("W", "W2");
    expect(links.get("W")?.coordinatorId).toBeUndefined();
    expect(links.get("W2")).toEqual(expect.objectContaining({ coordinatorId: "C", name: "w" }));
    const c = await mcp(o.mcpServers("C"));
    const list = JSON.parse(((await c.callTool({ name: "worker_list", arguments: {} })) as any).content[0].text);
    expect(list.workers.map((x: any) => x.sessionId)).toEqual(["W2"]);
    // The old worker session, as a plain session, may get the coordinator server now.
    expect(o.mcpServers("W")).toBeDefined();
    await c.close();
  });

  it(" a coordinator's own blocked worker_wait, /clear, then event: the waiter takes it (no queue, no notice)", async () => {
    const { o, sessions, prompts, links } = setup();
    const C = fakeSession("C"), H = fakeSession("H"), W = fakeSession("W");
    [C, H, W].forEach((s) => sessions.set(s.id, s));
    links.set("W", { coordinatorId: "C", name: "w" });
    const c = await mcp(o.mcpServers("C"));
    const p = c.callTool({ name: "worker_wait", arguments: { timeoutMs: 3000 } });
    await tick();
    C.live = false;
    o.handOver("C", "H");
    o.observe(W, turnEnd);
    const r = JSON.parse(((await p) as any).content[0].text);
    expect(r.events).toEqual([expect.objectContaining({ name: "w", type: "turn_end" })]);
    expect(prompts).toEqual([]);
    await c.close();
  });

  it("a notice already in flight when the coordinator is cleared is not sent to the old session; the new session gets one", async () => {
    const { o, sessions, prompts, links, flight } = setup();
    const C = fakeSession("C"), H = fakeSession("H"), W = fakeSession("W");
    [C, H, W].forEach((s) => sessions.set(s.id, s));
    o.mcpServers("C");
    links.set("W", { coordinatorId: "C", name: "w" });
    let open!: () => void;
    flight.gate = new Promise<void>((r) => (open = r));
    o.observe(W, turnEnd); // notice to C starts, waits in the sync
    await tick();
    o.handOver("C", "H"); // /clear lands in that window
    open();
    await tick();
    expect(prompts.filter((p) => p[0] === "C")).toEqual([]);
    expect(prompts.filter((p) => p[0] === "H").length).toBe(1);
  });

  it("a worker_start card approved under the old ID after the /clear approves the new session's call", async () => {
    const { o, sessions, links } = setup();
    const C = fakeSession("C"), H = fakeSession("H");
    [C, H].forEach((s) => sessions.set(s.id, s));
    o.mcpServers("C");
    const sdk = { name: "orchestration", source: "sdk" };
    const input = { name: "cw", cwd: "/", prompt: "p", mode: "acceptEdits" };
    const card = o.permissionCard("C", "mcp__orchestration__worker_start", input, sdk)!;
    o.handOver("C", "H");
    card.onAllow!();
    const c = await mcp(o.mcpServers("H"));
    const r = (await c.callTool({ name: "worker_start", arguments: input })) as any;
    expect(r.isError).toBeFalsy();
    expect(links.get(JSON.parse(r.content[0].text).sessionId)?.coordinatorId).toBe("H");
    await c.close();
  });

  it("forget drops the state of a deleted coordinator: no queued events or binding stay", async () => {
    const { o, sessions, links } = setup();
    const C = fakeSession("C"), W = fakeSession("W");
    [C, W].forEach((s) => sessions.set(s.id, s));
    o.mcpServers("C");
    links.set("W", { coordinatorId: "C", name: "w" });
    o.observe(W, turnEnd);
    o.forget("C");
    const c = await mcp(o.mcpServers("C"));
    const r = JSON.parse(((await c.callTool({ name: "worker_wait", arguments: { timeoutMs: 0 } })) as any).content[0].text);
    expect(r.events).toEqual([]);
    await c.close();
  });
});
