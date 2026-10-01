// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelInfo } from "@claude-ui/protocol";
import { NewSession, NewSessionTab, startSession } from "./App.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};

const models: ModelInfo[] = [{ value: "default", displayName: "Default (recommended)", description: "", supportsEffort: true, supportedEffortLevels: ["low", "high"] }];
let unmount = () => {};
afterEach(() => unmount());

async function render(over: Partial<ComponentProps<typeof NewSession>> = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const props: ComponentProps<typeof NewSession> = {
    projects: ["/p/a", "/p/b"],
    cwd: "/p/a",
    onCwd: () => {},
    models,
    onOpenProject: () => {},
    onUpload: async () => "/tmp/u/x.txt",
    onSearch: () => async () => [],
    onStart: async () => {},
    ...over,
  };
  await act(async () => root.render(<NewSession {...props} />));
  unmount = () => (root.unmount(), el.remove());
  return { el, box: el.querySelector("textarea")!, rerender: (p: Partial<ComponentProps<typeof NewSession>>) => act(async () => root.render(<NewSession {...props} {...p} />)) };
}

async function type(box: HTMLTextAreaElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = (box: HTMLElement, init: KeyboardEventInit) => act(async () => void box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));

it("the new-session tab has the session prompt toolbar; the first prompt starts the session with the chosen mode", async () => {
  const onStart = vi.fn(async () => {});
  const { el, box } = await render({ onStart });
  for (const id of ["prompt-toolbar", "attach", "mode-select", "session-model", "effort-select"]) expect(el.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
  await key(box, { key: "Tab", shiftKey: true });
  expect(el.querySelector('[data-testid="mode-select"]')?.textContent).toContain("Edit automatically");
  await type(box, "hello");
  await key(box, { key: "Enter" });
  expect(onStart).toHaveBeenCalledWith("/p/a", { model: "default", mode: "acceptEdits", effort: "default" }, "hello", []);
});

it("a failed start keeps the draft; the error goes away when the project changes", async () => {
  const { el, box, rerender } = await render({ onStart: () => Promise.reject(new Error("outside the allowlisted roots")) });
  await type(box, "hello");
  await key(box, { key: "Enter" });
  expect(box.value).toBe("hello");
  expect(el.querySelector('[data-testid="prompt-error"]')?.textContent).toContain("outside the allowlisted roots");
  await rerender({ cwd: "/p/b" });
  expect(el.querySelector('[data-testid="prompt-error"]')).toBeNull();
  expect(box.value).toBe("hello");
});

it("a first prompt that fails after session.create rejects (the draft stays); the retry reuses that session", async () => {
  const info = { id: "s1", cwd: "/p/a", model: "default", permissionMode: "default", effort: "default" };
  const sent: string[] = [];
  let failPrompt = true;
  const request = vi.fn(async (msg: { type: string; model?: string }) => {
    sent.push(msg.type);
    if (msg.type === "session.prompt" && failPrompt) throw new Error("disconnected");
    return { session: { ...info, model: msg.model ?? info.model } };
  });
  const created: { current?: never } = {};
  const opts = { model: "default", mode: "default", effort: "default" } as const;
  await expect(startSession(request as never, created, "/p/a", opts, "hello", [])).rejects.toThrow("disconnected");
  expect(sent).toEqual(["session.create", "session.prompt"]);
  failPrompt = false;
  sent.length = 0;
  const s = await startSession(request as never, created, "/p/a", { ...opts, model: "opus" }, "hello", []);
  // No second session: the model goes to the one already created.
  expect(sent).toEqual(["session.setModel", "session.prompt"]);
  expect(s).toMatchObject({ id: "s1", model: "opus" });
  expect(created.current).toBeUndefined();
});

it("switching to another tab and back keeps the new-session draft and the chosen mode (each tab keeps its draft prompt)", async () => {
  const props = { projects: ["/p/a"], cwd: "/p/a", onCwd: () => {}, models, onOpenProject: () => {}, onUpload: async () => "", onSearch: () => async () => [], onStart: async () => {} };
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  unmount = () => (root.unmount(), el.remove());
  const show = (active: boolean) => act(async () => root.render(<NewSessionTab active={active} {...props} />));
  await show(true);
  const input = el.querySelector("textarea")!;
  await type(input, "draft text");
  await key(input, { key: "Tab", shiftKey: true });
  await show(false);
  await show(true);
  expect(el.querySelector("textarea")!.value).toBe("draft text");
  expect(el.querySelector('[data-testid="mode-select"]')?.textContent).toContain("Edit automatically");
});
