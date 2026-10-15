// GH-279: a side owns a session only when the hub put it there; its own claims never move local or foreign sessions.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ClientMessage, ServerMessage } from "@claude-ui/protocol";
import { createRouter, createSides, dockerSide, type SideProcess } from "../src/sides.ts";

const LOCAL = "11111111-1111-4111-8111-111111111111";
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const Z = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const HEIR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** A side the test drives by hand: `out(m)` writes a message frame, `got` holds what the hub sent it. */
const EMPTY = { sessions: [], projects: [], recentProjects: [] };
function fakeSide(reply: (m: any) => unknown = (m) => (m.type === "session.list" ? EMPTY : null)) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const got: any[] = [];
  let buf = "";
  let c = 1;
  const out = (m: object) => stdout.write(JSON.stringify({ c, m }) + "\n");
  stdin.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop()!;
    for (const l of lines) {
      const f = JSON.parse(l);
      c = f.c;
      if (!f.m) continue;
      got.push(f.m);
      const r = reply(f.m);
      if (r !== undefined) out(r === null ? { type: "reply", reqId: f.m.reqId, result: {} } : { type: "reply", reqId: f.m.reqId, result: r });
    }
  });
  stdout.write('{"ready":true}\n');
  const ee = new EventEmitter();
  const proc: SideProcess = { stdin, stdout, stderr: new PassThrough(), kill: () => ee.emit("exit", 1), on: (e, l) => ee.on(e, l) };
  const push = (p: object) => stdout.write(JSON.stringify({ push: p }) + "\n");
  return { proc, out, got, push };
}

type SetupOpts = { sides?: Partial<Parameters<typeof createSides>[0]>; router?: Partial<Parameters<typeof createRouter>[0]> };
async function setup(sideA: ReturnType<typeof fakeSide>, sideB?: ReturnType<typeof fakeSide>, onPush?: (p: any) => void, o: SetupOpts = {}) {
  const procs = [sideA, ...(sideB ? [sideB] : [])].map((s) => s.proc);
  const sides = createSides({ targets: [], localLabel: "Linux", posixLocal: true, localPathExists: () => false, ...(onPush && { onPush }), discoverMs: 0, discover: async () => [dockerSide("a"), ...(sideB ? [dockerSide("b")] : [])], spawn: (id) => procs[id === "docker:a" ? 0 : 1]!, ...o.sides });
  await sides.refresh();
  const sent: ServerMessage[] = [];
  const localSeen: ClientMessage[] = [];
  const router = createRouter({
    sides,
    send: (m) => sent.push(m),
    local: async (m) => void localSeen.push(m),
    localCall: async (m) => ({ type: "reply", reqId: m.reqId, result: m.type === "session.list" ? { sessions: [{ id: LOCAL, cwd: "/host", lastActivity: 1 }], projects: ["/host"], recentProjects: [] } : m.type === "project.open" ? { cwd: (m as any).cwd } : {} }),
    isLocalSession: async (id) => id === LOCAL,
    ...o.router,
  });
  await router.handle({ type: "side.start", side: "docker:a", reqId: "sa" } as never);
  if (sideB) await router.handle({ type: "side.start", side: "docker:b", reqId: "sb" } as never);
  const settle = () => new Promise((r) => setTimeout(r, 30));
  let n = 0;
  const req = async (msg: object) => {
    const before = sent.length;
    await router.handle({ reqId: `r${++n}`, ...msg } as never);
    await settle();
    return sent.slice(before);
  };
  const reconnect = () => {
    const sent2: ServerMessage[] = [];
    const local2: ClientMessage[] = [];
    const r2 = createRouter({ sides, send: (m) => sent2.push(m), local: async (m) => void local2.push(m), localCall: async (m) => (local2.push(m), { type: "reply", reqId: m.reqId, result: m.type === "session.list" ? { sessions: [{ id: LOCAL, cwd: "/host", lastActivity: 1 }], projects: ["/host"], recentProjects: [] } : { settled: false } }), isLocalSession: async (id) => id === LOCAL });
    return { router: r2, sent: sent2, local: local2 };
  };
  return { sides, router, sent, localSeen, req, settle, reconnect };
}
const event = (sessionId: string, part: object = { type: "assistant_text", id: "p", text: "x" }) => ({ type: "event", sessionId, seq: 1, part });
const frames = (s: ReturnType<typeof fakeSide>, type: string) => s.got.filter((m) => m.type === type);

describe("side session ownership (GH-279)", () => {
  it("an unsolicited event for a local session does not take over its routing and is not shown", async () => {
    const a = fakeSide();
    const t = await setup(a);
    a.out(event(LOCAL));
    await t.settle();
    expect(t.sent.filter((m) => m.type === "event")).toEqual([]);
    expect(t.sides.sessionSide.has(LOCAL)).toBe(false);
    await t.req({ type: "session.prompt", sessionId: LOCAL, text: "secret" });
    expect(t.localSeen.map((m) => m.type)).toEqual(["session.prompt"]);
    expect(frames(a, "session.prompt")).toEqual([]);
  });

  it("an unsolicited event for another side's session is dropped; routing stays", async () => {
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 1 }], projects: ["/a"], recentProjects: [] } : null));
    const b = fakeSide();
    const t = await setup(a, b);
    await t.req({ type: "session.list" });
    expect(t.sides.sessionSide.get(A1)).toBe("docker:a");
    b.out(event(A1));
    await t.settle();
    expect(t.sent.filter((m) => m.type === "event")).toEqual([]);
    await t.req({ type: "session.prompt", sessionId: A1, text: "hi" });
    expect(frames(a, "session.prompt")).toHaveLength(1);
    expect(frames(b, "session.prompt")).toEqual([]);
  });

  it("a reply or error whose reqId was not forwarded to that side is dropped", async () => {
    const a = fakeSide();
    const b = fakeSide();
    const t = await setup(a, b);
    a.out({ type: "reply", reqId: "never", result: { session: { id: LOCAL, cwd: "/x" }, terminal: { id: "t1" } } });
    a.out({ type: "error", reqId: "never", code: "x", message: "forged" });
    a.out({ type: "reply", reqId: "hub:1", result: {} });
    await t.settle();
    expect(t.sent.filter((m) => (m.type === "reply" || m.type === "error") && m.reqId !== "sa" && m.reqId !== "sb")).toEqual([]);
    expect(t.sides.sessionSide.has(LOCAL)).toBe(false);
    expect(t.sides.terminalSide.has("t1")).toBe(false);
  });

  it("a reply to a request forwarded to another side is dropped", async () => {
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 1 }], projects: [], recentProjects: [] } : undefined));
    const b = fakeSide();
    const t = await setup(a, b);
    await t.req({ type: "session.list" });
    await t.router.handle({ type: "session.prompt", sessionId: A1, text: "hi", reqId: "p1" } as never);
    b.out({ type: "reply", reqId: "p1", result: { forged: true } });
    await t.settle();
    expect(t.sent.some((m) => m.type === "reply" && m.reqId === "p1")).toBe(false);
    a.out({ type: "reply", reqId: "p1", result: {} });
    await t.settle();
    expect(t.sent.some((m) => m.type === "reply" && m.reqId === "p1")).toBe(true);
  });

  it("a reply naming a local session id is refused with an error", async () => {
    const a = fakeSide((m) => (m.type === "session.create" ? { session: { id: LOCAL, cwd: "/ct" } } : null));
    const t = await setup(a);
    const r = await t.req({ type: "session.create", cwd: "/ct", side: "docker:a" });
    expect(r).toMatchObject([{ type: "error", code: "side_conflict" }]);
    expect(t.sides.sessionSide.has(LOCAL)).toBe(false);
  });

  it("a side's list leaves out local session ids and ids another side lists too", async () => {
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 2 }], projects: ["/a"], recentProjects: [] } : null));
    const b = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: LOCAL, cwd: "/host", lastActivity: 3 }, { id: A1, cwd: "/b", lastActivity: 3 }, { id: B1, cwd: "/b", lastActivity: 1 }], projects: [], recentProjects: [] } : null));
    const t = await setup(a, b);
    const [r] = (await t.req({ type: "session.list" })) as any[];
    // A1 is listed by both sides while unowned: contested, neither gets it (GH-321).
    expect(r.result.sessions.map((s: any) => [s.id, s.cwd])).toEqual([[LOCAL, "/host"], [B1, "/b"]]);
    expect(t.sides.sessionSide.has(A1)).toBe(false);
    expect(t.sides.sessionSide.get(B1)).toBe("docker:b");
    expect(t.sides.sessionSide.has(LOCAL)).toBe(false);
  });

  it("push.focus goes to the owning side only, and carries only the ids it owns", async () => {
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 1 }], projects: [], recentProjects: [] } : undefined));
    const b = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: B1, cwd: "/b", lastActivity: 1 }], projects: [], recentProjects: [] } : undefined));
    const t = await setup(a, b);
    await t.req({ type: "session.list" });
    await t.router.handle({ type: "push.focus", sessionId: LOCAL, covered: [LOCAL, A1], reqId: "f1" } as never);
    await t.settle();
    const seen = (s: ReturnType<typeof fakeSide>) => JSON.stringify(frames(s, "push.focus"));
    expect(seen(b)).not.toContain(LOCAL);
    expect(seen(b)).not.toContain(A1);
    expect(seen(a)).not.toContain(LOCAL);
    expect(frames(a, "push.focus")[0].covered).toEqual([A1]);
    expect(frames(b, "push.focus")[0].covered).toEqual([]);
    expect(t.localSeen.filter((m) => m.type === "push.focus")).toHaveLength(1);
    await t.router.handle({ type: "push.focus", sessionId: B1, reqId: "f2" } as never);
    await t.settle();
    expect(frames(b, "push.focus")[1].sessionId).toBe(B1);
    expect(frames(a, "push.focus")[1].sessionId).toBeUndefined();
  });

  it("permission.respond and question.respond go only to the side that raised the request", async () => {
    const perm = { type: "permission_request", id: "q1", requestId: "q1", toolUseId: "t", tool: "Bash", input: {}, suggestions: [], settled: false };
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 1 }], projects: [], recentProjects: [] } : m.type === "permission.respond" ? { settled: true } : undefined));
    const b = fakeSide();
    const t = await setup(a, b);
    await t.req({ type: "session.list" });
    a.out(event(A1, perm));
    await t.settle();
    expect(t.sent.some((m) => m.type === "event")).toBe(true);
    const r = await t.req({ type: "permission.respond", requestId: "q1", decision: "allow" });
    expect(r).toMatchObject([{ type: "reply", result: { settled: true } }]);
    expect(frames(a, "permission.respond")).toHaveLength(1);
    expect(frames(b, "permission.respond")).toEqual([]);
    // A request no side raised is the local daemon's: no side sees its ID.
    await t.req({ type: "question.respond", requestId: "local-q", answers: {} });
    expect(frames(a, "question.respond")).toEqual([]);
    expect(frames(b, "question.respond")).toEqual([]);
    expect(t.localSeen.filter((m) => m.type === "question.respond")).toEqual([]);
  });

  it("a side's sessions.changed cannot delete a session it does not own", async () => {
    const a = fakeSide();
    const t = await setup(a);
    a.out({ type: "sessions.changed", deleted: LOCAL });
    await t.settle();
    expect(t.sent.filter((m) => m.type === "sessions.changed" && (m as any).deleted)).toEqual([]);
  });

  it("after a reconnect (a second router on the same sides) a pending side permission card still reaches its side", async () => {
    const perm = { type: "permission_request", id: "q1", requestId: "q1", toolUseId: "t", tool: "Bash", input: {}, suggestions: [], settled: false };
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 1 }], projects: [], recentProjects: [] } : m.type === "permission.respond" ? { settled: true } : null));
    const t = await setup(a);
    await t.req({ type: "session.list" });
    a.out(event(A1, perm));
    await t.settle();
    t.router.close();
    const r2 = t.reconnect();
    await r2.router.handle({ type: "permission.respond", requestId: "q1", decision: "allow", reqId: "pr" } as never);
    await t.settle();
    expect(frames(a, "permission.respond")).toHaveLength(1);
    expect(r2.local.filter((m) => m.type === "permission.respond")).toEqual([]);
    expect(r2.sent.find((m) => (m as any).reqId === "pr")).toMatchObject({ type: "reply", result: { settled: true } });
  });

  it("a side's pending requests are forgotten when it exits", async () => {
    const perm = { type: "permission_request", id: "q2", requestId: "q2", toolUseId: "t", tool: "Bash", input: {}, suggestions: [], settled: false };
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 1 }], projects: [], recentProjects: [] } : null));
    const t = await setup(a);
    await t.req({ type: "session.list" });
    a.out(event(A1, perm));
    await t.settle();
    expect(t.sides.requestSide.get("q2")).toBe("docker:a");
    a.proc.kill();
    await t.settle();
    expect(t.sides.requestSide.has("q2")).toBe(false);
  });

  it("a session id that exists locally too is left out with one log line and a notice in the side's message", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: LOCAL, cwd: "/ct", lastActivity: 1 }, { id: A1, cwd: "/ct", lastActivity: 1 }], projects: [], recentProjects: [] } : null));
      const t = await setup(a);
      await t.req({ type: "session.list" });
      await t.req({ type: "session.list" });
      const logged = err.mock.calls.filter((c) => String(c[0]).includes("exists on this computer"));
      expect(logged).toHaveLength(1);
      expect(logged[0]![0]).toContain("docker:a");
      expect(t.sides.list().find((x) => x.id === "docker:a")).toMatchObject({ state: "ready", message: expect.stringContaining("left out") });
    } finally {
      err.mockRestore();
    }
  });

  it("a hub request is answered by the side it was sent to only", async () => {
    // Side a never answers its list; side b answers with a's hub reqId.
    const a = fakeSide((m) => (m.type === "session.list" || m.type === "session.ids" ? undefined : null));
    const b = fakeSide((m) => (m.type === "session.list" ? undefined : null));
    const t = await setup(a, b);
    const done = t.router.handle({ type: "session.list", reqId: "L" } as never);
    await t.settle();
    const hubA = frames(a, "session.list")[0].reqId;
    const hubB = frames(b, "session.list")[0].reqId;
    b.out({ type: "reply", reqId: hubA, result: { sessions: [{ id: B1, cwd: "/b", lastActivity: 1 }], projects: ["/b"], recentProjects: [] } });
    await t.settle();
    a.out({ type: "reply", reqId: hubA, result: EMPTY });
    b.out({ type: "reply", reqId: hubB, result: EMPTY });
    await done;
    const r = t.sent.find((m) => (m as any).reqId === "L") as any;
    expect(r.result.sessions.map((s: any) => s.id)).toEqual([LOCAL]);
    expect(t.sides.sessionSide.has(B1)).toBe(false);
  });

  it("a push for a session another side owns is dropped; its own and unknown ones pass", async () => {
    const pushed: any[] = [];
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 1 }], projects: [], recentProjects: [] } : null));
    const b = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: B1, cwd: "/b", lastActivity: 1 }], projects: [], recentProjects: [] } : null));
    const t = await setup(a, b, (p) => pushed.push(p));
    await t.req({ type: "session.list" });
    b.push({ sessionId: A1, title: "forged", body: "x" });
    b.push({ sessionId: B1, title: "own", body: "x" });
    b.push({ sessionId: HEIR, title: "unknown", body: "x" });
    await t.settle();
    expect(pushed.map((p) => p.title)).toEqual(["own", "unknown"]);
  });

  it("a side flooding permission requests drops its own oldest at the cap, never another side's", async () => {
    const perm = (id: string, settled = false) => ({ type: "permission_request", id, requestId: id, toolUseId: "t", tool: "Bash", input: {}, suggestions: [], settled });
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 1 }], projects: [], recentProjects: [] } : m.type === "permission.respond" ? { settled: true } : null));
    const b = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: B1, cwd: "/b", lastActivity: 1 }], projects: [], recentProjects: [] } : null));
    const t = await setup(a, b);
    await t.req({ type: "session.list" });
    a.out(event(A1, perm("legit")));
    for (let i = 0; i < 1001; i++) b.out(event(B1, perm("spam" + i)));
    await new Promise((r) => setTimeout(r, 400));
    expect(t.sides.requestSide.get("legit")).toBe("docker:a");
    expect(t.sides.requestSide.has("spam0")).toBe(false);
    expect(t.sides.requestSide.get("spam1000")).toBe("docker:b");
    await t.req({ type: "permission.respond", requestId: "legit", decision: "allow" });
    expect(frames(a, "permission.respond")).toHaveLength(1);
  });

  it("a settled part from a side that does not own the request does not forget it", async () => {
    const perm = (settled: boolean) => ({ type: "permission_request", id: "q9", requestId: "q9", toolUseId: "t", tool: "Bash", input: {}, suggestions: [], settled });
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 1 }], projects: [], recentProjects: [] } : null));
    const b = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: B1, cwd: "/b", lastActivity: 1 }], projects: [], recentProjects: [] } : null));
    const t = await setup(a, b);
    await t.req({ type: "session.list" });
    a.out(event(A1, perm(false)));
    await t.settle();
    b.out(event(B1, perm(true)));
    await t.settle();
    expect(t.sides.requestSide.get("q9")).toBe("docker:a");
    a.out(event(A1, perm(true)));
    await t.settle();
    expect(t.sides.requestSide.has("q9")).toBe(false);
  });

  describe("legitimate flows", () => {
    it("create on a side: the reply records ownership, then events and requests follow", async () => {
      const a = fakeSide((m) => (m.type === "session.create" ? { session: { id: A1, cwd: "/ct" } } : null));
      const t = await setup(a);
      await t.req({ type: "session.create", cwd: "/ct", side: "docker:a" });
      expect(t.sides.sessionSide.get(A1)).toBe("docker:a");
      a.out(event(A1));
      await t.settle();
      expect(t.sent.filter((m) => m.type === "event")).toHaveLength(1);
      await t.req({ type: "session.prompt", sessionId: A1, text: "hi" });
      expect(frames(a, "session.prompt")).toHaveLength(1);
    });

    it("restored at side start: its sessions arrive with the list, then its events show", async () => {
      const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 1 }], projects: ["/a"], recentProjects: [] } : null));
      const t = await setup(a);
      a.out(event(A1)); // before any list: not known yet
      await t.settle();
      expect(t.sent.filter((m) => m.type === "event")).toEqual([]);
      await t.req({ type: "session.list" });
      a.out(event(A1));
      await t.settle();
      expect(t.sent.filter((m) => m.type === "event")).toHaveLength(1);
    });

    it("a link to an unlisted side session: the lookup claims it", async () => {
      const a = fakeSide((m) => (m.type === "session.subscribe" ? { session: { id: A1, cwd: "/a" } } : lists(A1)(m)));
      const t = await setup(a);
      await t.req({ type: "session.subscribe", sessionId: A1, sinceSeq: 0 });
      expect(t.sides.sessionSide.get(A1)).toBe("docker:a");
      expect(frames(a, "session.ids")).toHaveLength(1);
      expect(frames(a, "session.subscribe")).toHaveLength(1);
    });

    it("/clear on a side: the heir announced on the owned session joins that side", async () => {
      const a = fakeSide((m) => (m.type === "session.create" ? { session: { id: A1, cwd: "/ct" } } : null));
      const t = await setup(a);
      await t.req({ type: "session.create", cwd: "/ct", side: "docker:a" });
      a.out(event(A1, { type: "session_cleared", id: "x", sessionId: HEIR }));
      await t.settle();
      expect(t.sides.sessionSide.get(HEIR)).toBe("docker:a");
      a.out(event(HEIR));
      await t.settle();
      expect(t.sent.filter((m) => m.type === "event")).toHaveLength(2);
    });

    it("a side cannot announce a local or foreign session as its heir", async () => {
      const a = fakeSide((m) => (m.type === "session.create" ? { session: { id: A1, cwd: "/ct" } } : null));
      const t = await setup(a);
      await t.req({ type: "session.create", cwd: "/ct", side: "docker:a" });
      a.out(event(A1, { type: "session_cleared", id: "x", sessionId: LOCAL }));
      await t.settle();
      expect(t.sides.sessionSide.has(LOCAL)).toBe(false);
      expect(t.sent.filter((m) => m.type === "event")).toEqual([]);
    });

    it("a fork or any new session a side names in a reply to a forwarded request is claimed", async () => {
      const a = fakeSide((m) => (m.type === "session.open" ? { session: { id: HEIR, cwd: "/ct" } } : null));
      const t = await setup(a);
      await t.req({ type: "session.open", side: "docker:a", cwd: "/ct" });
      expect(t.sides.sessionSide.get(HEIR)).toBe("docker:a");
    });
  });
});

describe("cwd claims (GH-320)", () => {
  const own = { sides: { localDirs: ["/home/hub"] } };
  const list = (r: object) => (m: any) => (m.type === "session.list" ? { sessions: [], projects: [], recentProjects: [], ...r } : null);
  const listOf = (sent: any[]) => sent.find((m) => m.result?.cwdSides)?.result;

  it("a side reply naming / does not route a new session in an unlisted local folder to the side", async () => {
    const a = fakeSide((m) => (m.type === "project.open" ? { cwd: "/" } : m.type === "session.list" ? EMPTY : null));
    const t = await setup(a, undefined, undefined, own);
    await t.req({ type: "project.open", cwd: "/ct", side: "docker:a" });
    await t.req({ type: "session.list" });
    expect(t.sides.cwdSide.get("/")).toBeUndefined();
    await t.req({ type: "session.create", cwd: "/home/hub/newproj" });
    expect(frames(a, "session.create")).toHaveLength(0);
    expect(t.localSeen.filter((m) => m.type === "session.create")).toHaveLength(1);
  });

  it("a side list cannot claim the home folder, a root, a parent of either, or a local project's parent or sub-folder", async () => {
    const a = fakeSide(list({ projects: ["/host/sub", "/home/hub", "/home", "/", "/ct"], recentProjects: [{ cwd: "/host/sub/deeper", lastActivity: 1 }], worktrees: { "/ct": [{ path: "/ct-wt" }] } }));
    const t = await setup(a, undefined, undefined, own);
    const [r] = (await t.req({ type: "session.list" })) as any[];
    expect(r.result.cwdSides).toEqual({ "/ct": "docker:a", "/ct-wt": "docker:a" });
    expect(t.sides.pathSide("/host/sub/x")).toBe("local");
    await t.req({ type: "fs.write", path: "/host/sub/f", content: "x" });
    expect(t.localSeen.filter((m) => m.type === "fs.write")).toHaveLength(1);
    expect(frames(a, "fs.write")).toHaveLength(0);
  });

  it("GH-360: file operations go to the side that owns the path; a host path stays local", async () => {
    const a = fakeSide(list({ projects: ["/ct"] }));
    const t = await setup(a, undefined, undefined, own);
    await t.req({ type: "session.list" });
    for (const m of [{ type: "fs.create", path: "/ct/x" }, { type: "fs.rename", path: "/ct/x", name: "y" }, { type: "fs.delete", path: "/ct/x" }, { type: "fs.duplicate", path: "/ct/x" }])
      await t.req(m);
    for (const type of ["fs.create", "fs.rename", "fs.delete", "fs.duplicate"]) expect(frames(a, type)).toHaveLength(1);
    await t.req({ type: "fs.delete", path: "/host/sub/f" });
    expect(t.localSeen.filter((m) => m.type === "fs.delete")).toHaveLength(1);
    expect(frames(a, "fs.delete")).toHaveLength(1);
  });

  it("a cwd in a reply counts only for project.open sent to that side or the side's own session", async () => {
    const a = fakeSide((m) => (m.type === "fs.list" ? { cwd: "/ct2" } : m.type === "session.open" ? { session: { cwd: "/ct3" } } : m.type === "project.open" ? { cwd: "/ct4" } : null));
    const t = await setup(a, undefined, undefined, own);
    await t.req({ type: "fs.list", path: "/ct", side: "docker:a" });
    await t.req({ type: "session.open", cwd: "/ct", side: "docker:a" });
    await t.req({ type: "project.open", cwd: "/ct4", side: "docker:a" });
    expect(t.sides.cwdSide.get("/ct2")).toBeUndefined();
    expect(t.sides.cwdSide.get("/ct3")).toBeUndefined();
    expect(t.sides.cwdSide.get("/ct4")).toBe("docker:a");
  });

  it("a path that is not normalized is not claimed", async () => {
    const a = fakeSide(list({ projects: ["/home/hub/", "//home/hub", "/srv/../home/hub", "rel"] }));
    const t = await setup(a, undefined, undefined, own);
    await t.req({ type: "session.list" });
    expect([...t.sides.cwdSide.entries()].filter(([, s]) => s === "docker:a")).toEqual([]);
    expect(t.sides.pathSide("/home/hub/x")).not.toBe("docker:a");
  });

  it("a folder a side claimed before it became local goes back to local", async () => {
    const a = fakeSide(list({ projects: ["/srv", "/home/hub/guess"] }));
    const t = await setup(a, undefined, undefined, own);
    await t.req({ type: "session.list" });
    expect(t.sides.pathSide("/srv/q")).toBe("docker:a");
    await t.req({ type: "project.open", cwd: "/srv/p", side: "local" });
    await t.req({ type: "session.create", cwd: "/srv/p" });
    expect(t.sides.pathSide("/srv/q")).not.toBe("docker:a");
    expect(t.sides.cwdSide.get("/srv")).toBeUndefined();
    expect(frames(a, "session.create")).toHaveLength(0);
    await t.req({ type: "project.open", cwd: "/home/hub/guess", side: "local" });
    expect(t.sides.pathSide("/home/hub/guess")).toBe("local");
  });

  it("a Windows hub keeps every Windows path local whatever a side claims", async () => {
    const a = fakeSide(list({ projects: ["/"] }));
    const t = await setup(a, undefined, undefined, { sides: { posixLocal: false } });
    await t.req({ type: "session.list" });
    await t.req({ type: "session.create", cwd: "C:\\work\\p" });
    expect(t.localSeen.filter((m) => m.type === "session.create")).toHaveLength(1);
    expect(frames(a, "session.create")).toHaveLength(0);
    expect(t.sides.pathSide("C:\\work\\p")).toBeUndefined();
  });

  it("a Docker side's own list paths, opened projects and created sessions still route to it", async () => {
    const a = fakeSide((m) =>
      m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/workspace/app", lastActivity: 1 }], projects: ["/workspace/app"], recentProjects: [{ cwd: "/root/old", lastActivity: 1 }] }
      : m.type === "project.open" ? { cwd: "/root/new" }
      : m.type === "session.create" && m.cwd === "/workspace/app" ? { session: { id: HEIR, cwd: "/workspace/app" } }
      : null);
    const t = await setup(a, undefined, undefined, own);
    const [l] = (await t.req({ type: "session.list" })) as any[];
    expect(l.result.cwdSides).toMatchObject({ "/workspace/app": "docker:a", "/root/old": "docker:a" });
    await t.req({ type: "project.open", cwd: "/root/new", side: "docker:a" });
    await t.req({ type: "session.create", cwd: "/workspace/app", side: "docker:a" });
    expect(t.sides.sessionSide.get(HEIR)).toBe("docker:a");
    await t.req({ type: "session.create", cwd: "/root/new" });
    await t.req({ type: "fs.read", path: "/workspace/app/x" });
    expect(frames(a, "session.create")).toHaveLength(2);
    expect(frames(a, "fs.read")).toHaveLength(1);
  });
});

/** Hostile side: answers every lookup "mine" and lists every id it was ever sent (rv-attack.test.ts GH-320). */
function hostile() {
  const seen = new Set<string>();
  return fakeSide((m) => {
    if (typeof m.sessionId === "string") seen.add(m.sessionId);
    if (m.type === "session.subscribe") return { session: { id: m.sessionId, cwd: "/ct" } };
    if (m.type === "session.ids") return { ids: [...seen] };
    if (m.type === "session.list") return { sessions: [...seen].map((id) => ({ id, cwd: "/ct", lastActivity: 9 })), projects: [], recentProjects: [] };
    return null;
  });
}
const seenId = (s: ReturnType<typeof fakeSide>, id: string) => s.got.some((m) => JSON.stringify(m).includes(id));
const lists = (...ids: string[]) => (m: any) => (m.type === "session.ids" ? { ids } : m.type === "session.list" ? { sessions: ids.map((id) => ({ id, cwd: "/ct", lastActivity: 1 })), projects: [], recentProjects: [] } : null);

describe("session lookup (GH-321, GH-328)", () => {
  const contested = async () => {
    const a = fakeSide(lists(B1));
    const b = fakeSide(lists(B1));
    const t = await setup(a, b);
    const r = await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    return { a, b, t, r };
  };

  it("a link to an unlisted id sends it to no side; the side that lists it gets it", async () => {
    const a = hostile();
    const b = fakeSide(lists(B1));
    const t = await setup(a, b);
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    expect(t.sides.sessionSide.get(B1)).toBe("docker:b");
    expect(seenId(a, B1)).toBe(false);
    expect(frames(b, "session.subscribe").filter((m) => m.sessionId === B1)).toHaveLength(1);
    expect(t.sides.cwdSide.get("/ct")).toBeUndefined();
  });

  it("owner side not running: no side is sent the id and none gets it", async () => {
    const a = hostile();
    const t = await setup(a);
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    expect(seenId(a, B1)).toBe(false);
    expect(t.sides.sessionSide.get(B1)).toBeUndefined();
    expect(t.localSeen.some((m) => m.type === "session.subscribe")).toBe(true);
  });

  it("owner side slower than the lookup timeout: no side is sent the id and none gets it", async () => {
    const a = hostile();
    const b = fakeSide(() => undefined);
    const t = await setup(a, b, undefined, { router: { lookupTimeoutMs: 50 } as never });
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(seenId(a, B1)).toBe(false);
    expect(t.sides.sessionSide.get(B1)).toBeUndefined();
  });

  it("an unlisted id that two sides list goes to neither; the browser gets side_conflict", async () => {
    const { a, b, t, r } = await contested();
    expect(r).toMatchObject([{ type: "error", code: "side_conflict" }]);
    expect(t.sides.sessionSide.get(B1)).toBeUndefined();
    const p = await t.req({ type: "session.prompt", sessionId: B1, text: "secret" });
    expect(p).toMatchObject([{ type: "error", code: "side_conflict" }]);
    expect(frames(a, "session.prompt")).toEqual([]);
    expect(frames(b, "session.prompt")).toEqual([]);
    a.out(event(B1));
    await t.settle();
    expect(t.sent.filter((m) => m.type === "event")).toEqual([]);
  });

  it("a contested id cannot be claimed later by a reply or a list", async () => {
    const a = fakeSide((m) => (m.type === "session.create" ? { session: { id: B1, cwd: "/ct" } } : lists(B1)(m)));
    const b = fakeSide(lists(B1));
    const t = await setup(a, b);
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    const r = await t.req({ type: "session.create", cwd: "/ct", side: "docker:a" });
    expect(r).toMatchObject([{ type: "error", code: "side_conflict" }]);
    const [l] = (await t.req({ type: "session.list" })) as any[];
    expect(l.result.sessions.map((s: any) => s.id)).not.toContain(B1);
    expect(t.sides.sessionSide.get(B1)).toBeUndefined();
  });

  it("a side whose list never answers does not hold the link", async () => {
    const a = fakeSide((m) => (m.type === "session.list" || m.type === "session.ids" ? undefined : null));
    const b = fakeSide(lists(B1));
    const t = await setup(a, b, undefined, { router: { lookupTimeoutMs: 50 } });
    const r = await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    expect(t.sides.sessionSide.get(B1)).toBe("docker:b");
    expect(r.some((m) => m.type === "reply")).toBe(true);
  });

  it("concurrent lookups share one session.ids round per side", async () => {
    const a = fakeSide(lists(A1, B1));
    const t = await setup(a);
    await Promise.all([t.req({ type: "session.subscribe", sessionId: A1, sinceSeq: 0 }), t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 })]);
    expect(frames(a, "session.ids")).toHaveLength(1);
  });

  it("two sides listing the same unowned id in one list: neither gets it, with one notice per side", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = fakeSide(lists(B1));
      const b = fakeSide(lists(B1));
      const t = await setup(a, b);
      const [r] = (await t.req({ type: "session.list" })) as any[];
      await t.req({ type: "session.list" });
      expect(r.result.sessions.map((s: any) => s.id)).not.toContain(B1);
      expect(t.sides.sessionSide.get(B1)).toBeUndefined();
      const logged = err.mock.calls.filter((c) => String(c[0]).includes("another side"));
      expect(logged).toHaveLength(2);
      for (const id of ["docker:a", "docker:b"]) expect(t.sides.list().find((x) => x.id === id)?.message).toMatch(/another side/);
    } finally {
      err.mockRestore();
    }
  });

  it("a side with a local-id clash also shows the other-side notice", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = fakeSide(lists(LOCAL, B1));
      const b = fakeSide(lists(B1));
      const t = await setup(a, b);
      await t.req({ type: "session.list" });
      const ofA = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("docker:a"));
      expect(ofA.some((l) => l.includes("exists on this computer"))).toBe(true);
      expect(ofA.some((l) => l.includes("another side"))).toBe(true);
      const msg = t.sides.list().find((x) => x.id === "docker:a")?.message;
      expect(msg).toMatch(/this computer/);
      expect(msg).toMatch(/another side/);
    } finally {
      err.mockRestore();
    }
  });

  it("two sides list a local id (shared ~/.claude): a lookup of another id does not lock the local user out of it", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = fakeSide(lists(LOCAL));
      const b = fakeSide(lists(LOCAL));
      const t = await setup(a, b);
      await t.req({ type: "session.subscribe", sessionId: Z, sinceSeq: 0 });
      const r = await t.req({ type: "session.subscribe", sessionId: LOCAL, sinceSeq: 0 });
      expect(t.sides.contested.has(LOCAL)).toBe(false);
      expect(r).not.toMatchObject([{ type: "error", code: "side_conflict" }]);
      expect(t.localSeen.filter((m: any) => m.type === "session.subscribe" && m.sessionId === LOCAL)).toHaveLength(1);
    } finally {
      err.mockRestore();
    }
  });

  it("an id the owner side claimed stays its after the owner exits: another side listing it does not get it", async () => {
    const b = fakeSide(lists(B1));
    let aLists = false;
    const a = fakeSide((m) => (m.type === "session.list" && aLists ? lists(B1)(m) : m.type === "session.list" ? EMPTY : null));
    const t = await setup(a, b);
    await t.req({ type: "session.list" });
    expect(t.sides.sessionSide.get(B1)).toBe("docker:b");
    b.proc.kill();
    await t.settle();
    aLists = true;
    await t.req({ type: "session.list" });
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    expect(t.sides.sessionSide.get(B1)).toBe("docker:b");
    expect(frames(a, "session.subscribe")).toEqual([]);
  });

  it("a contest entry for a local id never blocks the local user", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const a = fakeSide();
      const b = fakeSide();
      const t = await setup(a, b);
      t.sides.contest(LOCAL, ["docker:a", "docker:b"]);
      const r = await t.req({ type: "session.delete", sessionId: LOCAL });
      expect(r).not.toMatchObject([{ type: "error", code: "side_conflict" }]);
      expect(t.localSeen.some((m: any) => m.type === "session.delete")).toBe(true);
      expect(seenId(a, LOCAL) || seenId(b, LOCAL)).toBe(false);
    } finally {
      err.mockRestore();
    }
  });

  it("a contest stays when one contender exits; the remaining side never gets the id", async () => {
    const a = fakeSide(lists(B1));
    const b = fakeSide(lists(B1));
    const t = await setup(a, b);
    await t.req({ type: "session.list" });
    b.proc.kill();
    await t.settle();
    const [l] = (await t.req({ type: "session.list" })) as any[];
    expect(l.result.sessions.map((s: any) => s.id)).not.toContain(B1);
    const r = await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    expect(r).toMatchObject([{ type: "error", code: "side_conflict" }]);
    expect(t.sides.sessionSide.get(B1)).toBeUndefined();
    expect(frames(a, "session.subscribe")).toEqual([]);
  });

  it("the owner side exits after the lookup: the other side still never gets the id", async () => {
    const a = hostile();
    const b = fakeSide((m) => (m.type === "session.subscribe" ? { session: { id: B1, cwd: "/b" } } : lists(B1)(m)));
    const t = await setup(a, b);
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    b.proc.kill();
    await t.settle();
    await t.req({ type: "session.list" });
    expect(t.sides.sessionSide.get(B1)).not.toBe("docker:a");
  });
});

describe("existing sub-folders of a local dir (GH-328)", () => {
  it("a side cannot claim a folder under home that exists on the hub; a container-only one stays the side's", async () => {
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [], projects: ["/home/hub/notes", "/home/hub/ctonly"], recentProjects: [] } : null));
    const t = await setup(a, undefined, undefined, { sides: { localDirs: ["/home/hub"], localPathExists: (p: string) => p === "/home/hub" || p === "/home/hub/notes" } });
    await t.req({ type: "session.list" });
    await t.req({ type: "fs.write", path: "/home/hub/notes/todo.md", content: "secret" });
    expect(frames(a, "fs.write")).toEqual([]);
    expect(t.localSeen.some((m) => m.type === "fs.write")).toBe(true);
    expect(t.sides.pathSide("/home/hub/ctonly/x")).toBe("docker:a");
  });
});

describe("existing sub-folders: the default file system check (GH-328)", () => {
  /** A real host folder `home` with `notes/` in it; `localPathExists` is left to its default. */
  async function withHome(run: (home: string) => Promise<void>) {
    const root = mkdtempSync(join(tmpdir(), "gh328-"));
    const home = join(root, "home");
    mkdirSync(join(home, "notes"), { recursive: true });
    try {
      await run(home);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const projectsOf = (...p: string[]) => (m: any) => (m.type === "session.list" ? { sessions: [], projects: p, recentProjects: [] } : null);
  const real = (home: string, extra: object = {}) => ({ sides: { localDirs: [home], localPathExists: undefined, ...extra } as never });

  it("POSIX hub: an existing sub-folder of a local dir is refused, a container-only one is claimed", async () => {
    await withHome(async (home) => {
      const a = fakeSide(projectsOf(join(home, "notes"), join(home, "ctonly")));
      const t = await setup(a, undefined, undefined, real(home));
      await t.req({ type: "session.list" });
      expect(t.sides.cwdSide.get(join(home, "notes"))).toBeUndefined();
      expect(t.sides.pathSide(join(home, "ctonly", "x"))).toBe("docker:a");
      await t.req({ type: "fs.write", path: join(home, "notes", "todo.md"), content: "secret" });
      expect(frames(a, "fs.write")).toEqual([]);
    });
  });

  it("not a POSIX hub: the file system is not checked, an existing sub-folder stays claimable", async () => {
    await withHome(async (home) => {
      const a = fakeSide(projectsOf(join(home, "notes")));
      const t = await setup(a, undefined, undefined, real(home, { posixLocal: false, localLabel: "Windows" }));
      await t.req({ type: "session.list" });
      expect(t.sides.cwdSide.get(join(home, "notes"))).toBe("docker:a");
    });
  });
});

/** A side with B1 on disk in a project that is not added: its list does not name B1, `session.ids` does. `old`: a build without `session.ids`. */
function unadded(old = false) {
  const s: ReturnType<typeof fakeSide> = fakeSide((m) => {
    if (m.type === "session.list") return EMPTY;
    if (m.type === "session.ids") return old ? (setTimeout(() => s.out({ type: "error", reqId: m.reqId, code: "unknown_type", message: "unknown message type session.ids" })), undefined) : { ids: [B1] };
    return null;
  });
  return s;
}

describe("lookup of a session in a project not added on its side (GH-328 F1)", () => {
  it("a link to a side session of a non-added project reaches that side; no other side sees the id", async () => {
    const a = hostile();
    const b = unadded();
    const t = await setup(a, b);
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0, addProject: true });
    expect(t.sides.sessionSide.get(B1)).toBe("docker:b");
    expect(frames(b, "session.subscribe").filter((m) => m.sessionId === B1 && m.addProject === true)).toHaveLength(1);
    expect(frames(b, "session.ids")).toHaveLength(1);
    expect(seenId(a, B1)).toBe(false);
    expect(t.localSeen.some((m) => m.type === "session.subscribe")).toBe(false);
  });

  it("two sides having the id on disk: neither gets it (side_conflict)", async () => {
    const a = unadded();
    const b = unadded();
    const t = await setup(a, b);
    const r = await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    expect(r).toMatchObject([{ type: "error", code: "side_conflict" }]);
    expect(t.sides.sessionSide.get(B1)).toBeUndefined();
  });

  it("an older side without session.ids falls back to its list; the id is still sent to no side", async () => {
    const a = unadded(true);
    const b = fakeSide(lists(B1));
    const t = await setup(a, b);
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    expect(t.sides.sessionSide.get(B1)).toBe("docker:b");
    expect(seenId(a, B1)).toBe(false);
  });

  it("an older side without session.ids that lists the id gets the link through its list", async () => {
    const a = fakeSide((m) => {
      if (m.type === "session.ids") return void setTimeout(() => a.out({ type: "error", reqId: m.reqId, code: "unknown_type", message: "unknown message type session.ids" }));
      return lists(B1)(m);
    });
    const t = await setup(a);
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    expect(t.sides.sessionSide.get(B1)).toBe("docker:a");
    expect(frames(a, "session.list").length).toBeGreaterThanOrEqual(1);
  });

  it("the lookup claims only the id looked up, not every id a side has on disk", async () => {
    const b = fakeSide((m) => (m.type === "session.ids" ? { ids: [B1, A1] } : m.type === "session.list" ? EMPTY : null));
    const t = await setup(b);
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    expect(t.sides.sessionSide.get(B1)).toBe("docker:a");
    expect(t.sides.sessionSide.get(A1)).toBeUndefined();
  });
});

describe("session.ids fallback and malformed answers (GH-328 F1)", () => {
  const owner = () => fakeSide((m) => (m.type === "session.ids" ? { ids: [B1] } : m.type === "session.list" ? EMPTY : null));
  /** A side that claims not to know session.ids and answers session.list with `list` (raw result). */
  const oldSide = (list: unknown) => {
    const s: ReturnType<typeof fakeSide> = fakeSide((m) => {
      if (m.type === "session.ids") return void setTimeout(() => s.out({ type: "error", reqId: m.reqId, code: "unknown_type", message: "x" }));
      if (m.type === "session.list") return void setTimeout(() => s.out({ type: "reply", reqId: m.reqId, result: list }));
      return null;
    });
    return s;
  };
  for (const [name, list] of [["null result", null], ["sessions not an array", { sessions: "x" }], ["sessions [null]", { sessions: [null] }], ["sessions [1]", { sessions: [1] }]] as const) {
    it(`a malformed fallback list (${name}) is no error; the owner still gets the link`, async () => {
      const a = oldSide(list);
      const b = owner();
      const t = await setup(a, b);
      const r = await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
      expect(r.filter((m) => m.type === "error")).toEqual([]);
      expect(t.sides.sessionSide.get(B1)).toBe("docker:b");
    });
  }

  it("a session.ids that times out does not fall back to the list", async () => {
    const a = fakeSide((m) => (m.type === "session.ids" ? undefined : lists(B1)(m)));
    const t = await setup(a, undefined, undefined, { router: { lookupTimeoutMs: 50 } });
    await t.req({ type: "session.subscribe", sessionId: B1, sinceSeq: 0 });
    await new Promise((r) => setTimeout(r, 100));
    expect(frames(a, "session.list")).toEqual([]);
    expect(t.sides.sessionSide.get(B1)).toBeUndefined();
  });
});
