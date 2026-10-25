// GH-454: worker trees. Unit level: createOrchestration with fake deps (a worker may start workers, depth and children limits).
import { describe, expect, it } from "vitest";
import { createOrchestration } from "../src/orchestration.ts";
import { createSessionSettings } from "../src/session-settings.ts";

type Fake = { id: string; live: boolean; state: string; mode: string; works: boolean; pending: Set<string> };
function fakeSession(id: string, live = true): any {
  const f: Fake = { id, live, state: "idle", mode: "default", works: false, pending: new Set() };
  return Object.assign(f, {
    cwd: "/tmp",
    isLive: () => true,
    liveQuery: () => (f.live ? {} : undefined),
    info: () => ({ state: f.state, permissionMode: f.mode }),
    working: () => f.works,
    permissionTier: async () => "low",
    pendingRequest: (r: string) => (f.pending.has(r) ? { type: "permission_request", escalated: false } : undefined),
    subscribe: () => () => {},
    interrupt: async () => {},
    restartQuery: () => {
      f.live = false;
    },
    close: async () => {},
  });
}

type Cfg = { enabled: boolean; workerCap: number; maxDepth: number; maxChildren: number; coordinatorPermissions: boolean; workerMode: string; workerNotifications: boolean };

function setup(links = createSessionSettings(), cfg: Partial<Cfg> = {}) {
  const sessions = new Map<string, any>();
  const prompts: [string, string][] = [];
  const created: { cwd: string; s: any; init: any }[] = [];
  const agentCalls: string[] = [];
  const agentBox: { list: string[]; fail?: string } = { list: ["claude", "Explore", "orchestration:implementer", "orchestration:reviewer", "a:dup", "b:dup", "local-x"] };
  const settings: Cfg = { enabled: true, workerCap: 10, maxDepth: 2, maxChildren: 4, coordinatorPermissions: true, workerMode: "coordinator", workerNotifications: true, ...cfg };
  const removed: string[] = [];
  const o = createOrchestration({
    links,
    settings: () => settings as any,
    sessions,
    find: async (id) => sessions.get(id),
    create: (cwd, init) => {
      const s = fakeSession(`new-${created.length}`);
      sessions.set(s.id, s);
      created.push({ cwd, s, init });
      return s;
    },
    agents: async (cwd) => {
      agentCalls.push(cwd);
      if (agentBox.fail) throw new Error(agentBox.fail);
      return agentBox.list;
    },
    prompt: async (s, t) => {
      prompts.push([s.id, t]);
      return undefined;
    },
    allowed: (p) => p,
    projects: () => ["/repo"],
    worktrees: async () => undefined,
    removing: () => false,
    createWorktree: async (repo, opt) => ({ path: `/wt/${opt.branch}`, branch: opt.branch! }),
    port: () => 1,
    heldElsewhere: () => false,
    models: () => [],
    remove: async (id) => {
      removed.push(id);
      sessions.delete(id);
      links.delete([id]);
      return undefined;
    },
    stopWaitMs: 50,
  });
  return { o, sessions, prompts, links, created, settings, removed, agentCalls, agentBox };
}

const turnEnd = { part: { type: "turn_result", id: "r", durationMs: 1, isError: false } } as any;
const tick = () => new Promise((r) => setTimeout(r, 10));

/** A tool call as the SDK would make it; the parsed JSON, or `{error}` for a tool error. */
async function call(o: ReturnType<typeof setup>["o"], coord: string, name: string, args: object = {}) {
  const t = o.tools(coord).find((x) => x.name === name)!;
  const r = (await t.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean };
  return r.isError ? { error: r.content[0]!.text } : JSON.parse(r.content[0]!.text);
}

/** C <- W1 (impl) <- W2 (rev) [<- W3 (w3)], all live. */
function tree(o: ReturnType<typeof setup>, depth = 2) {
  const ids = ["C", "W1", "W2", "W3"].slice(0, depth + 1);
  for (const id of ids) o.sessions.set(id, fakeSession(id));
  const names = ["", "impl", "rev", "w3"];
  ids.slice(1).forEach((id, i) => o.links.set(id, { coordinatorId: ids[i]!, name: names[i + 1]!, cwd: "/tmp", port: 1 }));
  return ids.map((id) => o.sessions.get(id));
}

const start = (name: string, extra: object = {}) => ({ name, cwd: "/tmp", prompt: "go", ...extra });

describe("worker tree: orchestration for workers", () => {
  it("a worker's query start gets the orchestration server while orchestration is on", () => {
    const { o, links, settings } = setup();
    links.set("W1", { coordinatorId: "C", name: "impl", cwd: "/tmp", port: 1 });
    expect(o.mcpServers("W1")).toHaveProperty("orchestration");
    settings.enabled = false;
    expect(o.mcpServers("W1")).toBeUndefined();
  });

  it("worker_start from a worker at the depth limit is a tool error naming the limit", async () => {
    const t = setup();
    tree(t);
    expect(await call(t.o, "W1", "worker_start", start("a"))).toMatchObject({ name: "a" });
    const before = t.created.length;
    const r = await call(t.o, "W2", "worker_start", start("b"));
    expect(r.error).toMatch(/Maximum tree depth/);
    expect(r.error).toMatch(/depth 2/);
    expect(t.created.length).toBe(before);
  });

  it("depth is recomputed from the links after a restart", async () => {
    const t = setup();
    tree(t);
    const again = setup(t.links);
    for (const [id, s] of t.sessions) again.sessions.set(id, s);
    expect((await call(again.o, "W2", "worker_start", start("b"))).error).toMatch(/Maximum tree depth/);
  });

  it("maxDepth 1 keeps workers from starting workers", async () => {
    const t = setup(undefined, { maxDepth: 1 });
    tree(t, 1);
    expect((await call(t.o, "W1", "worker_start", start("a"))).error).toMatch(/Maximum tree depth/);
    expect(await call(t.o, "C", "worker_start", start("a"))).toMatchObject({ name: "a" });
  });

  it("worker_start beyond maxChildren is a tool error; closed workers do not count", async () => {
    const t = setup(undefined, { maxChildren: 2 });
    const [C] = tree(t, 1);
    expect(await call(t.o, "C", "worker_start", start("a"))).toMatchObject({ name: "a" });
    // W1 (impl) is live as well: two live workers of C.
    expect((await call(t.o, "C", "worker_start", start("b"))).error).toMatch(/Maximum workers per coordinator/);
    t.sessions.get("new-0").live = false;
    expect(await call(t.o, "C", "worker_start", start("b"))).toMatchObject({ name: "b" });
    expect(C).toBeDefined();
  });

  it("parallel worker_start at the children limit: exactly one passes", async () => {
    const t = setup(undefined, { maxChildren: 1 });
    t.sessions.set("C", fakeSession("C"));
    const rs = await Promise.all([call(t.o, "C", "worker_start", start("a")), call(t.o, "C", "worker_start", start("b"))]);
    expect(rs.filter((r) => r.error).length).toBe(1);
    expect(rs.filter((r) => r.name).length).toBe(1);
  });

  it("the worker cap counts workers at every depth", async () => {
    const t = setup(undefined, { workerCap: 2 });
    tree(t); // W1, W2 live
    expect((await call(t.o, "C", "worker_start", start("a"))).error).toMatch(/Maximum workers\)/);
  });

  it("worker_send to a closed worker checks the children limit", async () => {
    const t = setup(undefined, { maxChildren: 1 });
    t.sessions.set("C", fakeSession("C"));
    t.sessions.set("A", fakeSession("A"));
    t.sessions.set("B", fakeSession("B", false));
    t.links.set("A", { coordinatorId: "C", name: "a", cwd: "/tmp", port: 1 });
    t.links.set("B", { coordinatorId: "C", name: "b", cwd: "/tmp", port: 1 });
    expect((await call(t.o, "C", "worker_send", { name: "b", text: "hi" })).error).toMatch(/Maximum workers per coordinator/);
    expect(await call(t.o, "C", "worker_send", { name: "a", text: "hi" })).toMatchObject({ name: "a" });
  });

  it("a worker coordinator above its own mode needs the user's card; the card passes it once", async () => {
    const t = setup();
    tree(t, 1);
    const sdk = { name: "orchestration", source: "sdk" };
    const r = await call(t.o, "W1", "worker_start", start("a", { mode: "acceptEdits" }));
    expect(r.error).toMatch(/needs the user's worker_start card/);
    const card = await t.o.permissionCard("W1", "mcp__orchestration__worker_start", start("a", { mode: "acceptEdits" }), sdk);
    card!.onAllow!();
    expect(await call(t.o, "W1", "worker_start", start("a", { mode: "acceptEdits" }))).toMatchObject({ name: "a", mode: "acceptEdits" });
    expect((await call(t.o, "W1", "worker_start", start("a2", { mode: "acceptEdits" }))).error).toMatch(/needs the user's worker_start card/);
  });

  it("the worker_start card of a worker coordinator names its chain", async () => {
    const t = setup(undefined, { maxDepth: 3 });
    tree(t, 2);
    const sdk = { name: "orchestration", source: "sdk" };
    const at = (id: string) => t.o.permissionCard(id, "mcp__orchestration__worker_start", start("x"), sdk);
    expect((await at("W1"))!.title).toMatch(/^Start worker x in default mode.*, started by worker impl$/);
    expect((await at("W2"))!.title).toMatch(/, started by worker impl › rev$/);
    expect((await at("C"))!.title).not.toMatch(/started by/);
  });

  it("events of a worker's worker go to that worker only", async () => {
    const t = setup();
    const [, , W2] = tree(t);
    t.o.observe(W2, turnEnd);
    expect((await call(t.o, "W1", "worker_wait", { timeoutMs: 0 })).events).toHaveLength(1);
    expect((await call(t.o, "C", "worker_wait", { timeoutMs: 0 })).events).toEqual([]);
  });

  it("worker_close of a worker with a running or waiting worker is a tool error naming it", async () => {
    const t = setup();
    const [, , W2] = tree(t);
    W2.state = "running";
    expect((await call(t.o, "C", "worker_close", { name: "impl" })).error).toMatch(/rev/);
    expect(await t.o.userOp("close", "W1")).toMatchObject({ code: "has_workers" });
    W2.state = "idle";
    expect(await call(t.o, "C", "worker_close", { name: "impl" })).toEqual({ name: "impl", closed: true });
  });

  it("worker_remove of a worker with a descendant at depth 2 is a tool error naming its path", async () => {
    const t = setup(undefined, { maxDepth: 3 });
    const [, , , W3] = tree(t, 3);
    W3.live = false;
    t.sessions.get("W2").live = false;
    const r = await call(t.o, "C", "worker_remove", { name: "impl" });
    expect(r.error).toMatch(/rev\/w3/);
    expect(r.error).toMatch(/Remove them first/);
  });

  it("the idle close keeps a worker coordinator whose worker works", () => {
    const t = setup();
    const [, , W2] = tree(t);
    W2.works = true;
    expect(t.o.waitingOnWorkers("W1")).toBe(true);
    W2.works = false;
    expect(t.o.waitingOnWorkers("W1")).toBe(false);
  });

  it("a notice to a worker coordinator without a CLI waits while the cap is reached", async () => {
    const t = setup(undefined, { workerCap: 2 });
    const [, W1, W2] = tree(t);
    W1.live = false; // impl has no CLI; rev runs: 1 of 2
    t.sessions.set("X", fakeSession("X"));
    t.links.set("X", { coordinatorId: "C", name: "x", cwd: "/tmp", port: 1 }); // cap reached
    t.o.observe(W2, turnEnd);
    await tick();
    expect(t.prompts).toEqual([]);
    t.sessions.get("X").live = false; // cap freed
    t.o.observe(W2, turnEnd);
    await tick();
    expect(t.prompts.map((p) => p[0])).toEqual(["W1"]);
  });

  it("/clear of a worker coordinator moves its workers and its own link", () => {
    const t = setup();
    tree(t);
    t.sessions.set("W1b", fakeSession("W1b"));
    t.o.handOver("W1", "W1b");
    expect(t.links.get("W2")?.coordinatorId).toBe("W1b");
    expect(t.links.get("W1b")).toMatchObject({ coordinatorId: "C", name: "impl" });
    expect(t.links.get("W1")?.coordinatorId).toBeUndefined();
  });
});

describe("worker tree: agent types", () => {
  it("agent is resolved, saved in the link and listed", async () => {
    const t = setup();
    t.sessions.set("C", fakeSession("C"));
    const r = await call(t.o, "C", "worker_start", start("impl", { agent: "implementer" }));
    expect(r).toMatchObject({ name: "impl", agent: "orchestration:implementer" });
    expect(t.links.get(r.sessionId)?.agent).toBe("orchestration:implementer");
    const list = await call(t.o, "C", "worker_list");
    expect(list.workers[0]).toMatchObject({ name: "impl", agent: "orchestration:implementer" });
  });

  it("an exact agent name wins over a suffix match", async () => {
    const t = setup();
    t.sessions.set("C", fakeSession("C"));
    expect(await call(t.o, "C", "worker_start", start("e", { agent: "Explore" }))).toMatchObject({ agent: "Explore" });
  });

  it("an unknown agent type is a tool error listing the agent types; nothing starts", async () => {
    const t = setup();
    t.sessions.set("C", fakeSession("C"));
    const r = await call(t.o, "C", "worker_start", start("x", { agent: "nope" }));
    expect(r.error).toMatch(/Unknown agent type nope/);
    expect(r.error).toMatch(/orchestration:reviewer/);
    expect(t.created).toEqual([]);
    expect(t.links.entries()).toEqual([]);
  });

  it("an ambiguous bare agent name is a tool error naming the candidates", async () => {
    const t = setup();
    t.sessions.set("C", fakeSession("C"));
    const r = await call(t.o, "C", "worker_start", start("x", { agent: "dup" }));
    expect(r.error).toMatch(/ambiguous/);
    expect(r.error).toMatch(/a:dup/);
    expect(r.error).toMatch(/b:dup/);
    expect(t.created).toEqual([]);
  });

  it("a failed agent lookup is a tool error and starts nothing", async () => {
    const t = setup();
    t.sessions.set("C", fakeSession("C"));
    t.agentBox.fail = "timeout";
    expect((await call(t.o, "C", "worker_start", start("x", { agent: "implementer" }))).error).toMatch(/could not be read/);
    expect(t.created).toEqual([]);
  });

  it("an invalid agent name is refused before any lookup", async () => {
    const t = setup();
    t.sessions.set("C", fakeSession("C"));
    expect((await call(t.o, "C", "worker_start", start("x", { agent: "a b;c" }))).error).toMatch(/agent must be an agent type name/);
    expect(t.agentCalls).toEqual([]);
  });

  it("an explicit model wins over the agent type; without model the worker gets none", async () => {
    const t = setup();
    t.sessions.set("C", fakeSession("C"));
    await call(t.o, "C", "worker_start", start("a", { agent: "implementer", model: "sonnet" }));
    await call(t.o, "C", "worker_start", start("b", { agent: "implementer" }));
    expect(t.created[0]!.init.model).toBe("sonnet");
    expect(t.created[1]!.init.model).toBeUndefined();
  });

  it("agent lookup runs in the target folder; a new branch looks in the project", async () => {
    const t = setup();
    t.sessions.set("C", fakeSession("C"));
    await call(t.o, "C", "worker_start", start("a", { agent: "implementer" }));
    await call(t.o, "C", "worker_start", { name: "b", project: "/repo", branch: "feat", prompt: "go", agent: "implementer" });
    expect(t.agentCalls).toEqual(["/tmp", "/repo"]);
  });

  it("an agent check failure does not count a worker; limits are checked after it", async () => {
    const t = setup(undefined, { maxChildren: 1 });
    t.sessions.set("C", fakeSession("C"));
    expect(await call(t.o, "C", "worker_start", start("a", { agent: "implementer" }))).toMatchObject({ name: "a" });
    expect((await call(t.o, "C", "worker_start", start("b", { agent: "implementer" }))).error).toMatch(/Maximum workers per coordinator/);
  });

  it("the card names the agent type; /clear keeps the agent in the moved link", async () => {
    const t = setup();
    tree(t, 1);
    t.links.set("W1", { agent: "orchestration:reviewer" });
    const sdk = { name: "orchestration", source: "sdk" };
    const card = await t.o.permissionCard("C", "mcp__orchestration__worker_start", start("rev", { agent: "orchestration:reviewer" }), sdk);
    expect(card!.title).toMatch(/^Start worker rev as orchestration:reviewer in default mode/);
    t.sessions.set("W1b", fakeSession("W1b"));
    t.o.handOver("W1", "W1b");
    expect(t.links.get("W1b")?.agent).toBe("orchestration:reviewer");
    expect(t.links.get("W1")?.agent).toBeUndefined();
  });
});

describe("worker tree: list and read", () => {
  it("worker_list tree lists every descendant with its coordinator and depth", async () => {
    const t = setup();
    tree(t);
    const flat = await call(t.o, "C", "worker_list");
    expect(flat.workers.map((w: any) => w.name)).toEqual(["impl"]);
    const all = await call(t.o, "C", "worker_list", { tree: true });
    expect(all.workers.map((w: any) => [w.name, w.path, w.coordinator, w.depth])).toEqual([
      ["impl", "impl", undefined, 1],
      ["rev", "impl/rev", "impl", 2],
    ]);
  });

  it("worker_read takes a descendant path; an unknown segment names it", async () => {
    const t = setup();
    tree(t);
    expect(await call(t.o, "C", "worker_read", { name: "impl/rev" })).toMatchObject({ name: "impl/rev", state: "idle" });
    expect((await call(t.o, "C", "worker_read", { name: "impl/zz" })).error).toMatch(/zz is not a worker of impl/);
    expect((await call(t.o, "C", "worker_read", { name: "nope/rev" })).error).toMatch(/nope is not a worker of you/);
  });

  it("the other worker tools refuse a path", async () => {
    const t = setup();
    tree(t);
    const args = { name: "impl/rev", text: "x", id: "r", allow: true, reason: "r", answer: "a" };
    for (const tool of ["worker_send", "worker_answer", "worker_permission", "worker_escalate", "worker_stop", "worker_close", "worker_remove"]) {
      const r = await call(t.o, "C", tool, args);
      expect(r.error, tool).toMatch(/Invalid input/);
    }
  });

  it("a worker's worker_start reaches its coordinator as a high permission event", async () => {
    const t = setup();
    const [, W1] = tree(t, 1);
    W1.pending.add("q1");
    W1.permissionTier = async () => "high";
    t.o.observe(W1, { part: { type: "permission_request", id: "p", requestId: "q1", tool: "mcp__orchestration__worker_start", input: { name: "x" }, settled: false } } as any);
    await tick();
    const ev = (await call(t.o, "C", "worker_wait", { timeoutMs: 0 })).events[0];
    expect(ev).toMatchObject({ name: "impl", type: "permission", tier: "high", mayAnswer: false });
  });
});

describe("worker tree: limits are refused before the card", () => {
  const sdk = { name: "orchestration", source: "sdk" };
  const pre = (t: ReturnType<typeof setup>, id: string, input: object = start("x"), tool = "mcp__orchestration__worker_start") => t.o.preflight(id, tool, input as never, sdk);

  it("preflight names the depth limit, the children limit and the worker cap; none when under them", () => {
    const t = setup(undefined, { maxChildren: 1, workerCap: 10 });
    tree(t); // C <- W1 <- W2, maxDepth 2
    expect(pre(t, "W2")).toMatch(/Maximum tree depth/);
    expect(pre(t, "C")).toMatch(/Maximum workers per coordinator/); // W1 is C's live child
    t.settings.workerCap = 2;
    t.settings.maxChildren = 4;
    expect(pre(t, "C")).toMatch(/Maximum workers\)/); // W1 and W2 run
    t.settings.workerCap = 10;
    expect(pre(t, "C")).toBeUndefined();
    expect(pre(t, "W1")).toBeUndefined();
  });

  it("preflight ignores other tools and other servers", () => {
    const t = setup(undefined, { maxDepth: 1 });
    tree(t, 1);
    expect(pre(t, "W1", start("x"), "mcp__orchestration__worker_list")).toBeUndefined();
    expect(t.o.preflight("W1", "mcp__orchestration__worker_start", start("x") as never, { name: "other", source: "stdio" })).toBeUndefined();
  });

  it("the handler repeats the refusal for a call that preflight refused, even if the limit lifted meanwhile", async () => {
    const t = setup(undefined, { maxDepth: 1 });
    tree(t, 1);
    const msg = pre(t, "W1", start("x"));
    expect(msg).toMatch(/Maximum tree depth/);
    t.settings.maxDepth = 3; // lifted between the refusal and the call
    expect((await call(t.o, "W1", "worker_start", start("x"))).error).toBe(msg);
    expect(await call(t.o, "W1", "worker_start", start("x"))).toMatchObject({ name: "x" }); // one-shot
  });

  it("the cheap limits are checked before the agent lookup starts a CLI", async () => {
    const t = setup(undefined, { maxDepth: 1 });
    tree(t, 1);
    expect((await call(t.o, "W1", "worker_start", start("x", { agent: "implementer" }))).error).toMatch(/Maximum tree depth/);
    expect(t.agentCalls).toEqual([]);
    const full = setup(undefined, { maxChildren: 1 });
    full.sessions.set("C", fakeSession("C"));
    await call(full.o, "C", "worker_start", start("a"));
    expect((await call(full.o, "C", "worker_start", start("b", { agent: "implementer" }))).error).toMatch(/Maximum workers per coordinator/);
    expect(full.agentCalls).toEqual([]);
  });
});

describe("worker tree: remove of a parent", () => {
  it("worker_remove of a worker with any worker below it, live or not, is refused until they are removed", async () => {
    const t = setup(undefined, { maxDepth: 3 });
    const [, , W2] = tree(t, 2);
    W2.live = false;
    const r = await call(t.o, "C", "worker_remove", { name: "impl" });
    expect(r.error).toMatch(/has workers below it: rev/);
    expect(await t.o.userOp("remove", "W1")).toMatchObject({ code: "has_workers" });
    expect(await call(t.o, "W1", "worker_remove", { name: "rev" })).toEqual({ name: "rev", removed: true });
    expect(await call(t.o, "C", "worker_remove", { name: "impl" })).toEqual({ name: "impl", removed: true });
  });
});
