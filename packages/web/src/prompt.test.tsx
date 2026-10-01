// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelInfo } from "@claude-ui/protocol";
import { SessionPane } from "./App.tsx";
import { emptySession, type SessionView } from "./store.ts";
import { effortOptions, nextMode } from "./toolbar.tsx";
import { QuestionPanel } from "./question.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};

const models: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", description: "", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "max"] },
  { value: "haiku", displayName: "Haiku 4.5", description: "" },
];
const noop = () => {};
let unmount = noop;
afterEach(() => unmount());

async function render(over: Partial<ComponentProps<typeof SessionPane>> = {}, view: SessionView = emptySession()) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const props: ComponentProps<typeof SessionPane> = {
    scrollKey: 0,
    onInserted: noop,
    session: { id: "s1", cwd: "/tmp", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default", "acceptEdits", "plan"] },
    view,
    models,
    onModel: noop,
    onMode: noop,
    onEffort: noop,
    onUpload: async () => "/tmp/u/x.txt",
    onPrompt: async () => {},
    onSearch: async () => [],
    onInterrupt: noop,
    onRewindPreview: async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: false }),
    onRewind: async () => {},
    onRespond: noop,
    onAnswer: noop,
    connected: true,
    ...over,
  };
  await act(async () => root.render(<SessionPane {...props} />));
  unmount = () => (root.unmount(), el.remove());
  const $ = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { el, $, box: el.querySelector("textarea")!, rerender: (p: Partial<ComponentProps<typeof SessionPane>>) => act(async () => root.render(<SessionPane {...props} {...p} />)) };
}

async function type(box: HTMLTextAreaElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(box, text);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const key = (box: HTMLElement, init: KeyboardEventInit) => act(async () => void box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));

it("a failed prompt goes back into the prompt box and shows the error in the pane", async () => {
  const onPrompt = vi.fn(() => Promise.reject(new Error("no session s1")));
  const { el, box } = await render({ onPrompt });
  await type(box, "hello sandbox2");
  await key(box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("hello sandbox2", []);
  expect(box.value).toBe("hello sandbox2");
  expect(el.querySelector('[data-testid="prompt-error"]')?.textContent).toContain("no session s1");
});

it("the header holds no model chooser; the prompt toolbar shows model, effort and permission mode", async () => {
  const view = { ...emptySession(), permissionMode: "plan" as const, effort: "high" as const };
  const { el, $ } = await render({}, view);
  expect(el.querySelector("header [data-testid=session-model]")).toBeNull();
  expect($("prompt-toolbar")!.contains($("session-model"))).toBe(true);
  expect($("session-model")!.textContent).toContain("Default (recommended)");
  expect($("mode-select")!.textContent).toContain("Plan mode");
  expect($("effort-select")!.textContent).toContain("High");
});

it("narrow screen: the toolbar choosers wrap to a second row instead of shrinking the model name away", async () => {
  // jsdom has no layout; flex-wrap breaks lines at each item's content width, so a chooser never shrinks while others share its row.
  const { $ } = await render();
  const choosers = $("session-model")!.parentElement!;
  expect(choosers.className.split(" ")).toContain("flex-wrap");
  expect(choosers.contains($("mode-select")) && choosers.contains($("effort-select"))).toBe(true);
  expect($("prompt-toolbar")!.className).not.toMatch(/(^| )h-\d/);
});

it("hides the effort chooser for a model without effort support", async () => {
  const { $ } = await render({ session: { id: "s1", cwd: "/tmp", state: "idle", model: "haiku", permissionMode: "default", effort: "default", permissionModes: ["default"] } });
  expect($("session-model")!.textContent).toContain("Haiku 4.5");
  expect($("effort-select")).toBeNull();
});

it("Shift+Tab cycles the permission mode like Claude Code, also while the picker is open", async () => {
  const onMode = vi.fn();
  const { box, rerender } = await render({ onMode });
  await key(box, { key: "Tab", shiftKey: true });
  expect(onMode).toHaveBeenLastCalledWith("acceptEdits");
  await rerender({ view: { ...emptySession(), permissionMode: "plan", commands: [{ name: "review", description: "", argumentHint: "" }] } });
  await type(box, "/");
  expect(box.getAttribute("aria-expanded")).toBe("true");
  await key(box, { key: "Tab", shiftKey: true });
  expect(onMode).toHaveBeenLastCalledWith("default");
});

it("Shift+Tab sends nothing when no other mode is known", async () => {
  const onMode = vi.fn();
  const { box } = await render({ onMode, session: { id: "s1", cwd: "/tmp", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: [] } });
  await key(box, { key: "Tab", shiftKey: true });
  expect(onMode).not.toHaveBeenCalled();
});

it("choosing in a toolbar chooser reports the new value", async () => {
  const onEffort = vi.fn();
  const { $ } = await render({ onEffort });
  await act(async () => $("effort-select")!.click());
  const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent === "Max");
  expect(option).toBeDefined();
  await act(async () => option!.click());
  expect(onEffort).toHaveBeenCalledWith("max");
});

it("attach: an image goes into the image strip, another file is uploaded and becomes an @path mention", async () => {
  const onUpload = vi.fn(async (f: File) => `/tmp/claude-ui-uploads/u-1/${f.name}`);
  const { $, box } = await render({ onUpload });
  await type(box, "look at");
  const input = $("attach-input") as HTMLInputElement;
  const png = new File([Uint8Array.from(atob("iVBORw0KGgo="), (c) => c.charCodeAt(0))], "a.png", { type: "image/png" });
  const txt = new File(["hi"], "my notes.txt", { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [png, txt], configurable: true });
  await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await vi.waitFor(() => expect(box.value).toBe('look at @"/tmp/claude-ui-uploads/u-1/my notes.txt" '));
  expect(onUpload).toHaveBeenCalledTimes(1);
  expect($("image-strip")!.querySelectorAll("img")).toHaveLength(1);
});

it("attach: an image type the API does not take (svg, bmp, heic) is uploaded as @path, not dropped", async () => {
  const onUpload = vi.fn(async (f: File) => `/u/${f.name}`);
  const { $, box } = await render({ onUpload });
  const input = $("attach-input") as HTMLInputElement;
  const files = [
    new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
    new File(["BM"], "scan.bmp", { type: "image/bmp" }),
    new File(["x"], "photo.heic", { type: "image/heic" }),
  ];
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await vi.waitFor(() => expect(box.value).toBe("@/u/logo.svg @/u/scan.bmp @/u/photo.heic "));
  expect($("image-strip")).toBeNull();
});

it("attach: a file above the upload limit is refused before it is read or uploaded", async () => {
  const onUpload = vi.fn(async () => "/x");
  const { $ } = await render({ onUpload });
  const input = $("attach-input") as HTMLInputElement;
  const big = new File(["x"], "big.bin");
  Object.defineProperty(big, "size", { value: 20 * 1024 * 1024 + 1 });
  Object.defineProperty(input, "files", { value: [big], configurable: true });
  await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await vi.waitFor(() => expect($("prompt-error")!.textContent).toBe("Attach failed: big.bin is larger than 20 MB"));
  expect(onUpload).not.toHaveBeenCalled();
});

it("send button sends; while a turn runs with nothing typed it is a stop button", async () => {
  const onPrompt = vi.fn(async () => {});
  const onInterrupt = vi.fn();
  const { $, box } = await render({ onPrompt, onInterrupt }, { ...emptySession(), state: "running" });
  await act(async () => $("toolbar-stop")!.click());
  expect(onInterrupt).toHaveBeenCalled();
  await type(box, "steer");
  expect($("toolbar-stop")).toBeNull();
  await act(async () => $("send")!.click());
  expect(onPrompt).toHaveBeenCalledWith("steer", []);
});

it("send button follows the session state: label, tooltip, spinner, needs input, disconnected", async () => {
  const onInterrupt = vi.fn();
  const { $, box, rerender } = await render({ onInterrupt });
  const button = () => $("prompt-toolbar")!.querySelector<HTMLButtonElement>("button[data-state]")!;
  expect(button().dataset.state).toBe("idle");
  expect(button().getAttribute("aria-label")).toBe("Send");
  expect(button().disabled).toBe(true);
  expect(button().querySelector(".animate-spin")).toBeNull();

  await rerender({ view: { ...emptySession(), state: "running" } });
  expect(button().dataset.state).toBe("running");
  expect(button().getAttribute("aria-label")).toBe("Claude is working. Stop");
  expect(button().title).toBe("Claude is working. Stop (Esc)");
  const spin = button().querySelector("svg.animate-spin")!;
  expect(spin.getAttribute("class")).toContain("motion-reduce:animate-none");
  await type(box, "steer");
  expect(button().getAttribute("aria-label")).toBe("Claude is working. Steer");
  expect(button().querySelector("svg.animate-spin")).not.toBeNull();
  await type(box, "");

  await rerender({ view: { ...emptySession(), state: "needs_input" } });
  expect(button().dataset.state).toBe("needs_input");
  expect(button().getAttribute("aria-label")).toBe("Claude needs your input. Stop");
  expect(button().className).toContain("bg-warning");
  expect(button().className).toContain("motion-safe:animate-pulse");
  await act(async () => button().click());
  expect(onInterrupt).toHaveBeenCalledTimes(1);

  await rerender({ connected: false, view: { ...emptySession(), state: "running" } });
  await type(box, "hi");
  expect(button().dataset.state).toBe("disconnected");
  expect(button().getAttribute("aria-label")).toBe("Disconnected from the daemon");
  expect(button().disabled).toBe(true);

  await rerender({ connected: true, view: { ...emptySession(), state: "idle" } });
  expect(button().dataset.state).toBe("idle");
  expect(button().disabled).toBe(false);
});

it("nextMode wraps around; effortOptions lists the model's levels after default", () => {
  expect(nextMode(["default", "acceptEdits", "plan"], "plan")).toBe("default");
  expect(nextMode(["default", "acceptEdits", "plan", "bypassPermissions"], "plan")).toBe("bypassPermissions");
  expect(effortOptions(models, "default")).toEqual(["default", "low", "medium", "high", "max"]);
  expect(effortOptions(models, "haiku")).toEqual([]);
});

it("question dock pages through the questions: Next, Back, Submit sends every answer", async () => {
  const onAnswer = vi.fn();
  const q = { header: "H", options: [{ label: "npm", description: "" }, { label: "pnpm", description: "" }], multiSelect: false };
  const part = { type: "question" as const, id: "q1", requestId: "q1", toolUseId: "t1", settled: false, questions: [{ ...q, question: "A?" }, { ...q, question: "B?", multiSelect: true }] };
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<QuestionPanel part={part} onAnswer={onAnswer} />));
  unmount = () => (root.unmount(), el.remove());
  const button = (t: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === t)!;
  const option = (t: string) => [...el.querySelectorAll("label")].find((l) => l.textContent?.startsWith(t))!.querySelector("input")!;
  await act(async () => option("pnpm").click());
  await act(async () => button("Next").click());
  expect(el.textContent).toContain("2 of 2 questions");
  await act(async () => button("Back").click());
  expect(option("pnpm").checked).toBe(true);
  await act(async () => button("Next").click());
  await act(async () => option("npm").click());
  await act(async () => button("Submit").click());
  expect(onAnswer).toHaveBeenCalledWith({ "A?": "pnpm", "B?": "npm" });
});
