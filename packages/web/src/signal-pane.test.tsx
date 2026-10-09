// @vitest-environment jsdom
import type { Part } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { SessionPane } from "./App.tsx";
import { saveSignalOnly, useSignalOnly } from "./signal.ts";
import { applyEvent, emptySession, type SessionView } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const noop = () => {};
const call = (id: string, tool: string, status: "running" | "done" | "error" = "done"): Part => ({ type: "tool_call", id, toolUseId: id, tool, input: { command: "ls", file_path: "/p/a.ts" }, status });
const text = (id: string): Part => ({ type: "assistant_text", id, text: `answer ${id}`, streaming: false });
const permission = (toolUseId: string): Part => ({ type: "permission_request", id: `p-${toolUseId}`, requestId: `p-${toolUseId}`, toolUseId, tool: "Bash", input: { command: "rm x" }, suggestions: [], settled: false });
const view = (parts: Part[]): SessionView => parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s1", seq: i + 1, part }), emptySession());

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

/** Reads the browser-wide setting like App does. */
function Pane({ v }: { v: SessionView }) {
  const on = useSignalOnly();
  return (
    <SessionPane
      scrollKey={0}
      onInserted={noop}
      connected
      session={{ id: "s1", cwd: "/tmp", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: [] }}
      view={v}
      models={[]}
      onModel={noop}
      onMode={noop}
      onEffort={noop}
      onUpload={async () => ""}
      onPrompt={async () => {}}
      onSearch={async () => []}
      onInterrupt={noop}
      onRewindPreview={async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: false })}
      onRewind={async () => {}}
      onRespond={noop}
      onAnswer={noop}
      signalOnly={on}
    />
  );
}
const render = (v: SessionView) => act(async () => root.render(<Pane v={v} />));
const parts = [call("e1", "Edit"), call("e2", "Edit"), text("t1"), call("b1", "Bash", "error"), call("e3", "Edit")];
const folds = () => [...el.querySelectorAll<HTMLElement>('[data-testid="signal-fold"]')];
const cards = () => el.querySelectorAll('[data-testid="tool-card"]');

it("the session pane has no Signal only switch", async () => {
  localStorage.clear();
  await render(view(parts));
  expect(el.querySelector('[data-testid="signal-switch"]')).toBeNull();
  expect(el.textContent).not.toContain("Signal only");
});

it("with the setting on, tool runs fold into one line each, keeping text and errors, and clicking a fold shows its cards in place", async () => {
  localStorage.clear();
  await render(view(parts));
  expect(folds()).toHaveLength(0);
  expect(cards()).toHaveLength(4);
  await act(async () => saveSignalOnly(true));
  expect(folds().map((f) => f.textContent)).toEqual(["2 tool calls · Edit 2", "1 tool call · Edit 1"]);
  // The error card and Claude's text stay expanded.
  expect(cards()).toHaveLength(1);
  expect(el.textContent).toContain("answer t1");
  await act(async () => folds()[0]!.querySelector("button")!.click());
  expect(folds()[0]!.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
  expect(cards()).toHaveLength(3);
  await act(async () => saveSignalOnly(false));
  expect(folds()).toHaveLength(0);
});

it("applies to every session and survives a reload", async () => {
  localStorage.clear();
  saveSignalOnly(true);
  await render(view(parts));
  expect(folds()).toHaveLength(2);
  await act(() => root.render(<></>));
  await render(view([call("x", "Read")]));
  expect(folds()).toHaveLength(1);
  saveSignalOnly(false);
});

it("a call waiting for a permission answer stays expanded in Signal only", async () => {
  localStorage.clear();
  saveSignalOnly(true);
  await render(view([call("x1", "Edit"), call("b2", "Bash", "running"), permission("b2")]));
  expect(folds().map((f) => f.textContent)).toEqual(["1 tool call · Edit 1"]);
  expect(cards()).toHaveLength(1);
  saveSignalOnly(false);
});
