// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ToolCard } from "./tool-card.tsx";
import { BackgroundShellContext } from "./viewer.ts";
import type { ToolCall } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const call = (over: Partial<ToolCall> = {}): ToolCall =>
  ({ type: "tool_call", id: "t1", toolUseId: "t1", tool: "Bash", input: { command: "sleep 60" }, status: "running", shell: "foreground", ...over }) as ToolCall;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => act(() => root.render(<></>)));

const render = (c: ToolCall, handler?: (id: string) => Promise<unknown>) =>
  act(async () =>
    root.render(
      <BackgroundShellContext value={handler}>
        <ToolCard call={c} />
      </BackgroundShellContext>,
    ),
  );
const button = () => el.querySelector<HTMLButtonElement>('[data-testid="run-in-background"]');

it("Run in background shows only on a running Bash call the CLI runs in the foreground", async () => {
  const h = async () => {};
  await render(call(), h);
  expect(button()).not.toBeNull();
  for (const c of [
    call({ status: "done" }),
    call({ shell: "background" }),
    call({ shell: undefined, input: { command: "x", run_in_background: true } }),
    call({ shell: undefined }),
    call({ tool: "Read", input: { file_path: "/a" } }),
  ]) {
    await render(c, h);
    expect(button()).toBeNull();
  }
  await render(call());
  expect(button()).toBeNull();
});

it("Run in background sends the call's toolUseId and waits; a failed request shows its error and enables the button again", async () => {
  let fail!: (e: Error) => void;
  const handler = vi.fn(() => new Promise<unknown>((_, r) => (fail = r)));
  await render(call(), handler);
  await act(async () => button()!.click());
  expect(handler).toHaveBeenCalledWith("t1");
  expect(button()!.disabled).toBe(true);
  await act(async () => fail(new Error("no foreground Bash call with that ID runs")));
  expect(el.querySelector('[role="alert"]')!.textContent).toContain("no foreground Bash call with that ID runs");
  expect(button()!.disabled).toBe(false);
});

it("a failed move's error does not show once the call has ended", async () => {
  await render(call(), async () => Promise.reject(new Error("boom")));
  await act(async () => button()!.click());
  expect(el.querySelector('[role="alert"]')).not.toBeNull();
  await render(call({ status: "done" }), async () => {});
  expect(el.querySelector('[role="alert"]')).toBeNull();
});
