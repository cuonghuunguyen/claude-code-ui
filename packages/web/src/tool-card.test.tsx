import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ToolCall } from "./store.ts";
import { ContextGroup, Thinking, ToolCard } from "./tool-card.tsx";

const call = (status: ToolCall["status"], tool = "Bash"): ToolCall => ({
  type: "tool_call",
  id: "t1",
  toolUseId: "t1",
  tool,
  input: { command: "echo hello", description: "Print hello" },
  status,
});

describe("ToolCard", () => {
  it("header shows tool name, one-line summary and status; body is collapsed", () => {
    const html = renderToStaticMarkup(<ToolCard call={call("running")} />);
    expect(html).toContain("Bash");
    expect(html).toContain("echo hello");
    expect(html).toContain("Running");
    expect(html).toContain('data-status="running"');
    expect(html).not.toContain("Parameters");
  });

  it.each([
    ["pending", "Pending"],
    ["done", "Completed"],
    ["error", "Error"],
    ["denied", "Denied"],
  ] as const)("status %s renders as %s", (status, label) => {
    expect(renderToStaticMarkup(<ToolCard call={call(status)} />)).toContain(label);
  });
});

describe("ContextGroup", () => {
  it("shows the call count and tool names", () => {
    const calls = [call("done", "Read"), { ...call("done", "Grep"), id: "t2" }, { ...call("done", "Read"), id: "t3" }];
    const html = renderToStaticMarkup(<ContextGroup calls={calls} result={() => undefined} />);
    expect(html).toMatch(/Context<\/span><span[^>]*>3<\/span>/);
    expect(html).toContain("Read, Grep");
  });
});

describe("Thinking", () => {
  it("renders collapsed by default, even while streaming", () => {
    for (const streaming of [false, true]) {
      const html = renderToStaticMarkup(<Thinking part={{ type: "thinking", id: "k", text: "secret plan", streaming }} />);
      expect(html).toContain('data-testid="thinking"');
      expect(html).not.toContain("secret plan");
    }
  });
});
