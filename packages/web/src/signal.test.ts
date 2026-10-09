// @vitest-environment jsdom
import type { Part } from "@claude-ui/protocol";
import { describe, expect, it } from "vitest";
import { foldLabel, loadSignalOnly, saveSignalOnly, signalItems, subscribeSignalOnly } from "./signal.ts";
import { timeline, type ToolCall } from "./store.ts";
import { applyEvent, emptySession } from "./store.ts";

const call = (id: string, tool: string, status: ToolCall["status"] = "done"): Part => ({ type: "tool_call", id, toolUseId: id, tool, input: {}, status });
const text = (id: string): Part => ({ type: "assistant_text", id, text: id, streaming: false });
const user = (id: string): Part => ({ type: "user_text", id, text: id, images: [] });
const view = (parts: Part[]) => parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s", seq: i + 1, part }), emptySession());
const fold = (parts: Part[], awaiting: (c: ToolCall) => boolean = () => false) => signalItems(timeline(view(parts)), awaiting);
const shape = (items: ReturnType<typeof fold>) => items.map((i) => (i.kind === "fold" ? foldLabel(i.calls) : i.kind === "context" ? "context" : i.part.id));

describe("signalItems", () => {
  it("folds runs of tool calls into one line, keeping prompts, text and errors", () => {
    const items = fold([user("u"), call("r1", "Read"), call("g1", "Grep"), call("r2", "Read"), call("r3", "Read"), text("t1"), call("e1", "Edit"), call("e2", "Edit"), call("b1", "Bash", "error"), call("e3", "Edit"), text("t2")]);
    expect(shape(items)).toEqual(["u", "4 tool calls · Read 3 · Grep 1", "t1", "2 tool calls · Edit 2", "b1", "1 tool call · Edit 1", "t2"]);
  });

  it("a call awaiting a permission answer breaks the run and stays expanded", () => {
    const items = fold([call("a", "Edit"), call("b", "Bash", "running"), call("c", "Edit")], (c) => c.id === "b");
    expect(shape(items)).toEqual(["1 tool call · Edit 1", "b", "1 tool call · Edit 1"]);
  });

  it("a context group counts its calls and folds with its neighbours", () => {
    const items = fold([call("r1", "Read"), call("r2", "Read"), call("g", "Grep"), call("e", "Edit")]);
    expect(items).toHaveLength(1);
    expect(shape(items)).toEqual(["4 tool calls · Read 2 · Grep 1 · Edit 1"]);
  });

  it("a fold holds the items it hides, id from its first call", () => {
    const [f] = fold([call("r1", "Read"), call("e", "Edit")]);
    expect(f).toMatchObject({ kind: "fold", id: "fold:r1" });
    expect(f!.kind === "fold" && f.items).toHaveLength(2);
  });

  it("denied calls and subagents are not folded", () => {
    const sub: Part = { type: "subagent", id: "s1", toolUseId: "s1", description: "d", status: "running", startedAt: 1 };
    expect(shape(fold([call("d", "Edit", "denied"), sub]))).toEqual(["d", "s1"]);
  });
});

describe("foldLabel", () => {
  it("orders tools by count, then first seen, and names an MCP tool by its last segment", () => {
    const c = (tool: string) => call(tool + Math.random(), tool) as ToolCall;
    expect(foldLabel([c("Grep"), c("Read"), c("Read"), c("mcp__srv__lookup")])).toBe("4 tool calls · Read 2 · Grep 1 · lookup 1");
  });
});

describe("global setting", () => {
  it("is one value for the browser, off by default, and ignores the old per-session list", () => {
    localStorage.clear();
    localStorage.setItem("claude-ui.signal-only", JSON.stringify(["a"]));
    expect(loadSignalOnly()).toBe(false);
    saveSignalOnly(true);
    expect(loadSignalOnly()).toBe(true);
    expect(localStorage.getItem("claude-ui.signalOnly")).toBe("1");
    saveSignalOnly(false);
    expect(loadSignalOnly()).toBe(false);
    expect(localStorage.getItem("claude-ui.signalOnly")).toBeNull();
  });

  it("tells subscribers when it changes", () => {
    localStorage.clear();
    const seen: boolean[] = [];
    const un = subscribeSignalOnly(() => seen.push(loadSignalOnly()));
    saveSignalOnly(true);
    saveSignalOnly(false);
    un();
    saveSignalOnly(true);
    expect(seen).toEqual([true, false]);
    saveSignalOnly(false);
  });
});
