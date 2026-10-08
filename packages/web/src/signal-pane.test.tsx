// @vitest-environment jsdom
import type { Part } from "@claude-ui/protocol";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { SessionPane } from "./App.tsx";
import { loadSignalOnly, saveSignalOnly } from "./signal.ts";
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

/** Keeps the setting like App does: per session id, in localStorage. */
function Pane({ id, v }: { id: string; v: SessionView }) {
  const [on, setOn] = useState(() => loadSignalOnly(id));
  return (
    <SessionPane
      scrollKey={0}
      onInserted={noop}
      connected
      session={{ id, cwd: "/tmp", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: [] }}
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
      onSignalOnly={(next) => (saveSignalOnly(id, next), setOn(next))}
    />
  );
}
const render = (id: string, v: SessionView) => act(async () => root.render(<Pane id={id} v={v} />));
const parts = [call("e1", "Edit"), call("e2", "Edit"), text("t1"), call("b1", "Bash", "error"), call("e3", "Edit")];
const sw = () => el.querySelector<HTMLElement>('[data-testid="signal-switch"]')!;
const folds = () => [...el.querySelectorAll<HTMLElement>('[data-testid="signal-fold"]')];
const cards = () => el.querySelectorAll('[data-testid="tool-card"]');

it("the switch folds tool runs into one line each, keeping text and errors, and clicking a fold shows its cards in place", async () => {
  localStorage.clear();
  await render("s1", view(parts));
  expect(sw().getAttribute("aria-checked")).toBe("false");
  expect(folds()).toHaveLength(0);
  expect(cards()).toHaveLength(4);
  await act(async () => sw().click());
  expect(sw().getAttribute("aria-checked")).toBe("true");
  expect(folds().map((f) => f.textContent)).toEqual(["2 tool calls · Edit 2", "1 tool call · Edit 1"]);
  // The error card and Claude's text stay expanded.
  expect(cards()).toHaveLength(1);
  expect(el.textContent).toContain("answer t1");
  await act(async () => folds()[0]!.querySelector("button")!.click());
  expect(folds()[0]!.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
  expect(cards()).toHaveLength(3);
});

it("is remembered per session: a reload keeps it on for that session and off for another", async () => {
  localStorage.clear();
  await render("s1", view(parts));
  await act(async () => sw().click());
  await act(() => root.render(<></>));
  await render("s1", view(parts));
  expect(sw().getAttribute("aria-checked")).toBe("true");
  expect(folds()).toHaveLength(2);
  await act(() => root.render(<></>));
  await render("s2", view(parts));
  expect(sw().getAttribute("aria-checked")).toBe("false");
  expect(folds()).toHaveLength(0);
});

it("a call waiting for a permission answer stays expanded in Signal only", async () => {
  localStorage.clear();
  saveSignalOnly("s1", true);
  await render("s1", view([call("x1", "Edit"), call("b2", "Bash", "running"), permission("b2")]));
  expect(folds().map((f) => f.textContent)).toEqual(["1 tool call · Edit 1"]);
  expect(cards()).toHaveLength(1);
});
