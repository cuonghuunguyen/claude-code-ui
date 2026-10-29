import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { asideDisallowed, asideForkPoint, portListening } from "../src/aside.ts";

const m = (uuid: string, type: "user" | "assistant", content: unknown): SessionMessage => ({ type, uuid, session_id: "s", parent_tool_use_id: null, message: { role: type, content } }) as SessionMessage;
const text = (t = "x") => [{ type: "text", text: t }];
const use = (id: string) => ({ type: "tool_use", id, name: "Bash", input: {} });
const res = (id: string) => ({ type: "tool_result", tool_use_id: id, content: "ok" });

describe("asideForkPoint", () => {
  it("idle transcript: last assistant text entry", () => {
    expect(asideForkPoint([m("u1", "user", text()), m("a1", "assistant", text()), m("u2", "user", text()), m("a2", "assistant", text())])).toBe("a2");
  });
  it("mid-turn with a pending tool_use: the tool_result before it", () => {
    expect(asideForkPoint([m("u1", "user", text()), m("a1", "assistant", text()), m("a2", "assistant", [use("t1")]), m("r1", "user", [res("t1")]), m("a3", "assistant", [use("t2")])])).toBe("r1");
  });
  it("parallel calls: only after both results", () => {
    expect(asideForkPoint([m("u1", "user", text()), m("a1", "assistant", [use("t1")]), m("a2", "assistant", [use("t2")]), m("r1", "user", [res("t1")]), m("r2", "user", [res("t2")])])).toBe("r2");
    expect(asideForkPoint([m("u1", "user", text()), m("a1", "assistant", [use("t1")]), m("a2", "assistant", [use("t2")]), m("r1", "user", [res("t1")])])).toBeUndefined();
  });
  it("thinking-only and tool_use-only assistant entries are no fork point", () => {
    expect(asideForkPoint([m("u1", "user", text()), m("a1", "assistant", [{ type: "thinking", thinking: "" }]), m("a2", "assistant", [use("t1")])])).toBeUndefined();
  });
  it("no reply yet: undefined", () => {
    expect(asideForkPoint([m("u1", "user", text())])).toBeUndefined();
    expect(asideForkPoint([])).toBeUndefined();
  });
  it("string content and sidechain entries are skipped safely", () => {
    const side = { ...m("s1", "assistant", text()), parent_tool_use_id: "t9" } as SessionMessage;
    expect(asideForkPoint([m("u1", "user", "hi"), m("a1", "assistant", text()), side])).toBe("a1");
  });
});

describe("asideDisallowed", () => {
  it("read-only: no editing tools; an unkept Aside: no orchestration tools", () => {
    expect(asideDisallowed({ ownerId: "o", readOnly: true })).toEqual(["Edit", "Write", "NotebookEdit", "mcp__orchestration"]);
    expect(asideDisallowed({ ownerId: "o" })).toEqual(["mcp__orchestration"]);
    expect(asideDisallowed({ readOnly: true })).toEqual(["Edit", "Write", "NotebookEdit"]);
    expect(asideDisallowed({})).toBeUndefined();
    expect(asideDisallowed(undefined)).toBeUndefined();
  });
});

describe("portListening", () => {
  const listen = () => new Promise<ReturnType<typeof createServer>>((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => r(s)); });
  const portOf = (s: ReturnType<typeof createServer>) => (s.address() as { port: number }).port;
  it("true for a port with a listening server", async () => {
    const s = await listen();
    expect(await portListening(portOf(s))).toBe(true);
    s.close();
  });
  it("false for a closed port", async () => {
    const s = await listen();
    const port = portOf(s);
    await new Promise((r) => s.close(r));
    expect(await portListening(port)).toBe(false);
  });
});
