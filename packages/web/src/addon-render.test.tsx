// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { AddonInfo, Part } from "@claude-ui/protocol";
import { MessageResponse } from "./components/ai-elements/message.tsx";
import { AddonsContext } from "./addons.ts";
import type { ToolCall } from "./store.ts";
import { ToolBody } from "./tool-card.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ToolResult = Extract<Part, { type: "tool_result" }>;
const addon = {
  name: "example",
  source: { kind: "local", path: "/x" },
  approved: [],
  state: "enabled",
  base: "/addon/n/example/",
  manifest: { name: "example", version: "1", description: "", capabilities: [], themes: [], views: [], commands: [], renderers: [{ fence: "example", entry: "render.html" }, { tool: "mcp__example__echo", entry: "render.html" }] },
} as AddonInfo;
const state = { addons: [addon], picks: {}, log: new Map() };

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => (act(() => root?.unmount()), (document.body.innerHTML = "")));
async function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(node));
  return el;
}
const click = (e: Element | null) => act(async () => void (e as HTMLElement).click());

it("a fence claimed by an addon renders AddonBlock with a show-raw button; raw shows the code", async () => {
  const el = await mount(
    <AddonsContext value={state}>
      <MessageResponse mode="static">{"```example\nhello addon\n```"}</MessageResponse>
    </AddonsContext>,
  );
  expect(el.querySelector('[data-testid="addon-block"]')?.getAttribute("data-addon")).toBe("example");
  // Not near the viewport here (no IntersectionObserver): no frame yet.
  expect(el.querySelector("iframe")).toBeNull();
  await click(el.querySelector('[data-testid="addon-show-raw"]'));
  expect(el.textContent).toContain("hello addon");
  await click(el.querySelector('[data-testid="addon-show-raw"]'));
  expect(el.querySelector('[data-testid="addon-block"]')).not.toBeNull();
});

it("a fence nobody claims stays the built-in block", async () => {
  const el = await mount(
    <AddonsContext value={state}>
      <MessageResponse mode="static">{"```other\nplain text\n```"}</MessageResponse>
    </AddonsContext>,
  );
  expect(el.querySelector('[data-testid="addon-block"]')).toBeNull();
});

it("a tool claimed by an addon shows the addon block and the raw body after the toggle", async () => {
  const call = { type: "tool_call", id: "t", toolUseId: "t", tool: "mcp__example__echo", input: { text: "hi" }, status: "done" } as ToolCall;
  const result = { type: "tool_result", id: "r", toolUseId: "t", output: "echoed hi", isError: false } as unknown as ToolResult;
  const el = await mount(
    <AddonsContext value={state}>
      <ToolBody call={call} result={result} />
    </AddonsContext>,
  );
  expect(el.querySelector('[data-testid="addon-block"]')).not.toBeNull();
  await click(el.querySelector('[data-testid="addon-show-raw"]'));
  expect(el.textContent).toContain("echoed hi");
  // Without a result yet the built-in body shows.
  const el2 = await mount(
    <AddonsContext value={state}>
      <ToolBody call={call} />
    </AddonsContext>,
  );
  expect(el2.querySelector('[data-testid="addon-block"]')).toBeNull();
});
