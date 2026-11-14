// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ToolCard } from "./tool-card.tsx";
import { AllowDeniedContext } from "./viewer.ts";
import type { ToolCall } from "./store.ts";

const call = (over: Partial<ToolCall> = {}): ToolCall =>
  ({ type: "tool_call", id: "t1", toolUseId: "t1", tool: "Bash", input: { command: "git push --force" }, status: "denied", denial: { by: "classifier", reason: "[Git Destructive]" }, ...over }) as ToolCall;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

const render = (c: ToolCall, handler?: (id: string) => Promise<unknown>) =>
  act(async () =>
    root.render(
      <AllowDeniedContext value={handler}>
        <ToolCard call={c} />
      </AllowDeniedContext>,
    ),
  );
const button = () => el.querySelector<HTMLButtonElement>('[data-testid="allow-and-retry"]');
const click = () => act(async () => void button()!.click());

it("shows Allow and retry only on a classifier-denied call, with a handler", async () => {
  const h = async () => {};
  await render(call(), h);
  expect(button()?.textContent).toBe("Allow and retry");
  await render(call({ denial: undefined }), h);
  expect(button()).toBeNull();
  await render(call({ denial: undefined, coordinator: { decision: "deny", reason: "no" } }), h);
  expect(button()).toBeNull();
  await render(call({ status: "running" }), h);
  expect(button()).toBeNull();
  await render(call({ status: "error" }), h);
  expect(button()).toBeNull();
  await render(call());
  expect(button()).toBeNull();
});

it("a click sends the call's id, disables the button while the request runs, then waits for the daemon's allowed mark", async () => {
  let done!: () => void;
  const h = vi.fn(() => new Promise<void>((r) => (done = r)));
  await render(call(), h);
  await click();
  expect(h).toHaveBeenCalledWith("t1");
  expect(button()!.disabled).toBe(true);
  await act(async () => done());
  await render(call({ denial: { by: "classifier", reason: "[Git Destructive]", allowed: true } }), h);
  expect(button()!.textContent).toBe("Allowed once");
  expect(button()!.disabled).toBe(true);
});

it("a rejected request shows an alert and re-enables the button", async () => {
  await render(call(), async () => {
    throw new Error("no such call");
  });
  await click();
  expect(el.querySelector('[role="alert"]')?.textContent).toContain("no such call");
  expect(button()!.disabled).toBe(false);
});

it("the body names the auto mode and the reason", async () => {
  await render(call());
  expect(el.querySelector('[data-testid="auto-mode-denial"]')?.textContent).toBe("Denied by auto mode: [Git Destructive]");
  await render(call({ denial: { by: "classifier" } }));
  expect(el.querySelector('[data-testid="auto-mode-denial"]')?.textContent).toBe("Denied by auto mode");
  await render(call({ denial: undefined }));
  expect(el.querySelector('[data-testid="auto-mode-denial"]')).toBeNull();
});

it("the button is at least 44px high below md (touch class) and visibly focusable", async () => {
  await render(call(), async () => {});
  expect(button()!.className).toContain("max-md:min-h-11");
  expect(button()!.className).toContain("focus-visible:outline-2");
});
