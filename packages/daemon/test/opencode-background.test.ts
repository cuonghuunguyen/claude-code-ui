// OpenCode background subagent (GH-1014, docs/spec.md "Background subagents"): the live card and `working()` against a scripted OpenCode server, no process.
import { describe, expect, it, vi } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { createOpenCodeEngine } from "../src/opencode-engine.ts";
import type { Session, SessionOpts } from "../src/session.ts";
import type { OpenCodeServer } from "../src/opencode-server.ts";

type Payload = { type: string; properties: Record<string, any> };

function rig() {
  const handlers = new Set<{ event: (d: string | undefined, p: Payload) => void; resync: () => void }>();
  const emit = (p: Payload) => handlers.forEach((h) => h.event("/p", p));
  const server = {
    request: vi.fn(async (path: string) => (path === "/agent" || path === "/command" || path.endsWith("/message") ? [] : path === "/config" ? {} : undefined)),
    events: (h: never) => (handlers.add(h), () => handlers.delete(h)),
    streamReady: async () => {},
  } as unknown as OpenCodeServer;
  const emitted: Part[] = [];
  const states: string[] = [];
  const asks: Record<string, any>[] = [];
  const cancelled: string[] = [];
  const session = { id: "ses_parent", cwd: "/p", emit: (p: Part) => emitted.push(p), currentState: () => "idle", setState: (s: string) => states.push(s), request: (a: { part: Record<string, any> }) => asks.push(a.part), pendingRequest: (id: string) => asks.find((a) => a.id === id && !cancelled.includes(id)), cancel: (id: string) => cancelled.push(id) } as unknown as Session;
  const run = createOpenCodeEngine(server, {}).open(session, { permissionMode: "default" } as SessionOpts);
  run.begin();
  const call = (status: string, extra: Record<string, unknown> = {}) =>
    emit({ type: "message.part.updated", properties: { part: { id: "prt_t", type: "tool", sessionID: "ses_parent", messageID: "msg_p", callID: "call_bg", tool: "task", state: { status, input: { description: "dig" }, metadata: { sessionId: "ses_kid", ...extra }, time: { start: 1, ...(status === "completed" && { end: 2 }) } } } } });
  const cards = () => emitted.filter((p) => p.type === "subagent").map((p) => (p as { status: string }).status);
  return { run, emit, call, cards, states, asks, cancelled, server };
}

describe("OpenCode background subagent", () => {
  it("the card runs and the session is working after the call returns; the child's idle ends the card and clears working", () => {
    const t = rig();
    t.call("running");
    t.call("completed", { background: true });
    expect(t.cards().at(-1)).toBe("running");
    expect(t.run.working()).toBe(true);
    t.emit({ type: "session.idle", properties: { sessionID: "ses_kid" } });
    expect(t.cards().at(-1)).toBe("done");
    expect(t.run.working()).toBe(false);
    expect(t.states).toEqual(["idle"]); // the clients drop `working`
  });

  it("an aborted child ends the card stopped, a failed child error; a foreground task's child changes nothing", () => {
    const stopped = rig();
    stopped.call("completed", { background: true });
    stopped.emit({ type: "session.error", properties: { sessionID: "ses_kid", error: { name: "MessageAbortedError" } } });
    expect(stopped.cards().at(-1)).toBe("stopped");
    const failed = rig();
    failed.call("completed", { background: true });
    failed.emit({ type: "session.error", properties: { sessionID: "ses_kid", error: { name: "APIError", data: { message: "x" } } } });
    expect(failed.cards().at(-1)).toBe("error");
    const fg = rig();
    fg.call("completed");
    fg.emit({ type: "session.idle", properties: { sessionID: "ses_kid" } });
    expect(fg.cards()).toEqual(["done"]);
    expect(fg.run.working()).toBe(false);
    expect(fg.states).toEqual([]);
  });

  it("a permission ask of a background child names the subagent; it is cancelled when the child ends, and a leftover ask of an ended child is not asked again", () => {
    const t = rig();
    t.call("completed", { background: true });
    const ask = (id: string) => t.emit({ type: "permission.asked", properties: { id, sessionID: "ses_kid", permission: "bash", patterns: ["ls"], always: [], metadata: { command: "ls" } } });
    ask("per_1");
    expect(t.asks).toHaveLength(1);
    expect(t.asks[0]!.title).toBe('Background subagent "dig" asks to use Bash');
    t.emit({ type: "session.error", properties: { sessionID: "ses_kid", error: { name: "MessageAbortedError" } } });
    expect(t.cancelled).toEqual(["per_1"]);
    ask("per_2"); // OpenCode keeps listing the aborted child's ask
    expect(t.asks).toHaveLength(1);
  });

  it("Stop on the idle session aborts OpenCode's session while a background subagent runs, and does nothing otherwise", async () => {
    const t = rig();
    await t.run.interrupt();
    const aborts = () => (t.server.request as ReturnType<typeof vi.fn>).mock.calls.filter(([path]) => path === "/session/ses_parent/abort");
    expect(aborts()).toHaveLength(0);
    t.call("completed", { background: true });
    await t.run.interrupt();
    expect(aborts()).toHaveLength(1);
  });
});
