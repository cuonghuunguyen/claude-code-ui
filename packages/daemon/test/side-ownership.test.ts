// GH-279: a side owns a session only when the hub put it there; its own claims never move local or foreign sessions.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "@claude-ui/protocol";
import { createRouter, createSides, dockerSide, type SideProcess } from "../src/sides.ts";

const LOCAL = "11111111-1111-4111-8111-111111111111";
const A1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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
  const proc: SideProcess = { stdin, stdout, stderr: new PassThrough(), kill: () => {}, on: (e, l) => new EventEmitter().on(e, l) };
  return { proc, out, got };
}

async function setup(sideA: ReturnType<typeof fakeSide>, sideB?: ReturnType<typeof fakeSide>) {
  const procs = [sideA, ...(sideB ? [sideB] : [])].map((s) => s.proc);
  const sides = createSides({ targets: [], localLabel: "Linux", posixLocal: true, discoverMs: 0, discover: async () => [dockerSide("a"), ...(sideB ? [dockerSide("b")] : [])], spawn: (id) => procs[id === "docker:a" ? 0 : 1]! });
  await sides.refresh();
  const sent: ServerMessage[] = [];
  const localSeen: ClientMessage[] = [];
  const router = createRouter({
    sides,
    send: (m) => sent.push(m),
    local: async (m) => void localSeen.push(m),
    localCall: async (m) => ({ type: "reply", reqId: m.reqId, result: m.type === "session.list" ? { sessions: [{ id: LOCAL, cwd: "/host", lastActivity: 1 }], projects: ["/host"], recentProjects: [] } : {} }),
    isLocalSession: async (id) => id === LOCAL,
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
  return { sides, router, sent, localSeen, req, settle };
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

  it("a side's list leaves out local and foreign session ids", async () => {
    const a = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: A1, cwd: "/a", lastActivity: 2 }], projects: ["/a"], recentProjects: [] } : null));
    const b = fakeSide((m) => (m.type === "session.list" ? { sessions: [{ id: LOCAL, cwd: "/host", lastActivity: 3 }, { id: A1, cwd: "/b", lastActivity: 3 }, { id: B1, cwd: "/b", lastActivity: 1 }], projects: [], recentProjects: [] } : null));
    const t = await setup(a, b);
    const [r] = (await t.req({ type: "session.list" })) as any[];
    expect(r.result.sessions.map((s: any) => [s.id, s.cwd])).toEqual([[A1, "/a"], [LOCAL, "/host"], [B1, "/b"]]);
    expect(t.sides.sessionSide.get(A1)).toBe("docker:a");
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

    it("a link to an unlisted side session: the subscribe probe claims it", async () => {
      const a = fakeSide((m) => (m.type === "session.subscribe" ? { session: { id: A1, cwd: "/a" } } : null));
      const t = await setup(a);
      await t.req({ type: "session.subscribe", sessionId: A1, sinceSeq: 0 });
      expect(t.sides.sessionSide.get(A1)).toBe("docker:a");
      expect(frames(a, "session.subscribe").length).toBeGreaterThan(0);
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
