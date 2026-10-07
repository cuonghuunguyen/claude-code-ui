// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelInfo } from "@claude-ui/protocol";
import { SessionPane } from "./App.tsx";
import { applyEvent, emptySession, type SessionView } from "./store.ts";
import { effortOptions, nextMode, shortModel } from "./toolbar.tsx";
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
  { value: "sonnet", displayName: "Sonnet 5.5", description: "", supportsAutoMode: true },
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

it("a command with arguments picked in the dialog goes to the start of the prompt, before the draft", async () => {
  const d = await render();
  await type(d.box, "hello");
  await d.rerender({ insert: "/name" });
  expect(d.box.value).toBe("/name hello");
});

it("a failed prompt goes back into the prompt box and shows the error in the pane", async () => {
  const onPrompt = vi.fn(() => Promise.reject(new Error("no session s1")));
  const { el, box } = await render({ onPrompt });
  await type(box, "hello sandbox2");
  await key(box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("hello sandbox2", []);
  expect(box.value).toBe("hello sandbox2");
  expect(el.querySelector('[data-testid="prompt-error"]')?.textContent).toContain("no session s1");
});

it("while a terminal CLI turn runs the prompt box says so and keeps the prompt; it sends once the turn ended", async () => {
  const ev = (seq: number, running: boolean) => ({ type: "event" as const, sessionId: "s1", seq, part: { type: "external_turn" as const, id: "external_turn" as const, running } });
  const busy = applyEvent(emptySession(), ev(1, true));
  const onPrompt = vi.fn(async () => {});
  const { box, $, rerender } = await render({ onPrompt }, busy);
  expect($("external-turn")!.textContent).toBe("A terminal CLI turn is running in this session");
  expect($("external-turn")!.getAttribute("role")).toBe("status");
  await type(box, "after the CLI");
  await key(box, { key: "Enter" });
  expect(onPrompt).not.toHaveBeenCalled();
  expect(box.value).toBe("after the CLI");
  expect(($("send") as HTMLButtonElement).disabled).toBe(true);
  await rerender({ view: applyEvent(busy, ev(2, false)) });
  expect($("external-turn")).toBeNull();
  await key(box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("after the CLI", []);
});

it("a send error sits between the todo dock and the prompt box, so the prompt box drops its lift and stays outside the dock", async () => {
  const running = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "session_state", id: "st", state: "running" } });
  const view = applyEvent(running, { type: "event", sessionId: "s1", seq: 2, part: { type: "todo_update", id: "t:todos", items: [{ content: "Fix", status: "pending" }] } });
  const onPrompt = vi.fn(() => Promise.reject(new Error("no session s1")));
  const { box, $ } = await render({ onPrompt }, view);
  expect($("prompt-box")!.className).toContain("-mt-11");
  await type(box, "hello");
  await key(box, { key: "Enter" });
  expect($("todo-dock")!.nextElementSibling).toBe($("prompt-error"));
  expect($("todo-dock")!.className).not.toContain("pb-9");
  expect($("prompt-box")!.className).not.toContain("-mt-11");
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

it("a model name without a note shows as is", async () => {
  const { $ } = await render({ session: { id: "s1", cwd: "/tmp", state: "idle", model: "haiku", permissionMode: "default", effort: "default", permissionModes: ["default"] } }, { ...emptySession(), model: "haiku" });
  expect($("session-model")!.textContent).toContain("Haiku 4.5");
});

it("narrow screen: the toolbar choosers wrap to a second row instead of shrinking the model name away", async () => {
  // jsdom has no layout; flex-wrap breaks lines at each item's content width, so a chooser never shrinks while others share its row.
  const { $ } = await render();
  const choosers = $("session-model")!.parentElement!;
  expect(choosers.className.split(" ")).toContain("flex-wrap");
  expect(choosers.contains($("mode-select")) && choosers.contains($("effort-select"))).toBe(true);
  expect($("prompt-toolbar")!.className).not.toMatch(/(^| )h-\d/);
});

it("phone: the model picker drops the parenthesised note, the choosers wrap in the toolbar's own row and ring + send sit in a right group", async () => {
  expect(["Default (recommended)", "Sonnet 5.5", "Opus 5.5 (1M context)", "(x)"].map(shortModel)).toEqual(["Default model", "Sonnet 5.5", "Opus 5.5 (1M context)", "(x)"]);
  const view = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "context_usage", id: "context_usage", usage: { totalTokens: 100, maxTokens: 1000, percentage: 10, categories: [] } } });
  const { $ } = await render({}, view);
  // jsdom shows both labels (CSS picks one by the toolbar width); the full name stays the accessible name.
  expect($("session-model")!.textContent).toContain("Default modelDefault (recommended)");
  expect($("session-model")!.getAttribute("aria-label")).toBe("Default (recommended), Model");
  expect($("session-model")!.parentElement!.className).toContain("max-sm:contents");
  expect($("prompt-toolbar")!.className).toContain("max-sm:flex-wrap");
  const right = $("send")!.parentElement!;
  expect(right.className).toContain("max-sm:ml-auto");
  expect(right.contains($("context-meter"))).toBe(true);
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

it("attach: a successful attach clears the error of an earlier failed attach", async () => {
  const { $ } = await render({ onUpload: async (f: File) => `/tmp/claude-ui-x/u-abc123/${f.name}` });
  const input = $("attach-input") as HTMLInputElement;
  const big = new File(["x"], "big.bin");
  Object.defineProperty(big, "size", { value: 20 * 1024 * 1024 + 1 });
  Object.defineProperty(input, "files", { value: [big], configurable: true });
  await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await vi.waitFor(() => expect($("prompt-error")).not.toBeNull());
  Object.defineProperty(input, "files", { value: [new File(["hi"], "notes.txt")], configurable: true });
  await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await vi.waitFor(() => expect($("prompt-error")).toBeNull());
});

it("attach: a successful attach keeps a send error, which only a send clears", async () => {
  const { $, box } = await render({ onPrompt: () => Promise.reject(new Error("no session s1")), onUpload: async (f: File) => `/u/${f.name}` });
  await type(box, "hello");
  await key(box, { key: "Enter" });
  await vi.waitFor(() => expect($("prompt-error")).not.toBeNull());
  const input = $("attach-input") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [new File(["hi"], "notes.txt")], configurable: true });
  await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await vi.waitFor(() => expect(box.value).toContain("@/u/notes.txt"));
  expect($("prompt-error")!.textContent).toContain("no session s1");
});

it("user bubble: an attached file shows as a file name chip, not its upload path", async () => {
  const text = 'read @/tmp/claude-ui-Ab12Cd/u-Xy34Ef/notes.txt and @"/tmp/claude-ui-Ab12Cd/u-Zz99Qq/my notes.md" @src/a.ts';
  const view = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "user_text", id: "u1", text, images: [] } });
  const { $ } = await render({}, view);
  const msg = $("user-message")!;
  expect([...msg.querySelectorAll('[data-testid="attachment"]')].map((c) => c.textContent)).toEqual(["notes.txtTXT", "my notes.mdMD"]);
  expect(msg.textContent).not.toContain("/tmp/claude-ui");
  expect(msg.textContent).toContain("read and @src/a.ts");
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

it("focus moves from the send button to the prompt box when the button becomes disabled (keyboard stop, send)", async () => {
  const { $, box, rerender } = await render({}, { ...emptySession(), state: "running" });
  $("toolbar-stop")!.focus();
  await rerender({ view: { ...emptySession(), state: "idle" } });
  expect(document.activeElement).toBe(box);
  await type(box, "hi");
  $("send")!.focus();
  await rerender({ connected: false });
  expect(document.activeElement).toBe(box);
  // Chrome blurs the button as soon as it is disabled, before React's effects run.
  await rerender({ connected: true });
  const send = $("send") as HTMLButtonElement;
  send.focus();
  send.disabled = true;
  await act(async () => void send.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(document.activeElement).toBe(box);
});

it("send button: OpenCode contrast gradient and elevation; disconnected shows an offline icon", async () => {
  const { $, rerender } = await render();
  const button = () => $("prompt-toolbar")!.querySelector<HTMLButtonElement>("button[data-state]")!;
  expect(button().className).toContain("shadow-button-contrast");
  expect(button().className).toContain("bg-linear-to-b");
  // --send: --primary in light; lighter in dark, so the button edge reaches 3:1 on the prompt box (theme.test.ts).
  expect(button().className).toContain("bg-send");
  expect(button().querySelector(".lucide-wifi-off")).toBeNull();
  await rerender({ connected: false });
  expect(button().querySelector(".lucide-wifi-off")).not.toBeNull();
  expect(button().querySelector(".lucide-arrow-up")).toBeNull();
});

const ALL_MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"] as const;
const openModes = async ($: (id: string) => HTMLElement | null) => {
  await act(async () => $("mode-select")!.click());
  return [...document.querySelectorAll<HTMLElement>("[role=option]")].map((o) => o.textContent);
};

it("the permission mode picker lists Auto mode and Don't ask (deny unapproved) next to the other modes", async () => {
  const { $ } = await render({ session: { id: "s1", cwd: "/tmp", state: "idle", model: "sonnet", permissionMode: "default", effort: "default", permissionModes: [...ALL_MODES] } });
  expect(await openModes($)).toEqual(["Ask before edits", "Edit automatically", "Plan mode", "Auto mode", "Don't ask (deny unapproved)", "Bypass permissions"]);
});

it("the picker has no Auto mode when the model does not offer it", async () => {
  const { $ } = await render({ session: { id: "s1", cwd: "/tmp", state: "idle", model: "haiku", permissionMode: "default", effort: "default", permissionModes: ["default", "acceptEdits", "plan", "dontAsk"] } });
  expect(await openModes($)).not.toContain("Auto mode");
});

it("Shift+Tab goes Plan, Auto mode, Bypass and never stops at Don't ask", async () => {
  const onMode = vi.fn();
  const session = { id: "s1", cwd: "/tmp", state: "idle" as const, model: "sonnet", permissionMode: "plan" as const, effort: "default" as const, permissionModes: [...ALL_MODES] };
  const { box, rerender } = await render({ onMode, session });
  await key(box, { key: "Tab", shiftKey: true });
  expect(onMode).toHaveBeenLastCalledWith("auto");
  await rerender({ session: { ...session, permissionMode: "auto" } });
  await key(box, { key: "Tab", shiftKey: true });
  expect(onMode).toHaveBeenLastCalledWith("bypassPermissions");
  // From Don't ask the cycle restarts at Ask.
  await rerender({ session: { ...session, permissionMode: "dontAsk" } });
  await key(box, { key: "Tab", shiftKey: true });
  expect(onMode).toHaveBeenLastCalledWith("default");
});

it("nextMode wraps around; effortOptions lists the model's levels after default", () => {
  expect(nextMode(["default", "acceptEdits", "plan"], "plan")).toBe("default");
  expect(nextMode(["default", "acceptEdits", "plan", "bypassPermissions"], "plan")).toBe("bypassPermissions");
  expect(nextMode([...ALL_MODES], "auto")).toBe("bypassPermissions");
  expect(nextMode(["default", "acceptEdits", "plan", "auto", "dontAsk"], "auto")).toBe("default");
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

it("the context meter sits in the prompt box toolbar once the session reports its usage", async () => {
  const { $ } = await render({}, emptySession());
  expect($("context-meter")).toBeNull();
  const view = { ...emptySession(), contextUsage: { totalTokens: 1000, maxTokens: 200000, percentage: 1, categories: [] } };
  unmount();
  const { $: $2 } = await render({}, view);
  expect($2("prompt-toolbar")!.contains($2("context-meter"))).toBe(true);
});

it("the rewind panel opened from the palette stays open while typing in the prompt box", async () => {
  const view = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "user_text", id: "u1", text: "hello", images: [] } });
  const { $, box } = await render({ rewindTo: "u1" }, view);
  expect($("rewind-panel")).not.toBeNull();
  await type(box, "a");
  await type(box, "ab");
  expect($("rewind-panel")).not.toBeNull();
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => (errors.push(e.error), e.preventDefault());
  window.addEventListener("error", onError);
  unmount();
  unmount = noop;
  window.removeEventListener("error", onError);
  expect(errors).toEqual([]);
});

it("the @-mention picker searches again once the daemon reconnects", async () => {
  let online = false;
  const onSearch = vi.fn(async () => (online ? ["docs/spec.md"] : Promise.reject(new Error("the daemon is reconnecting"))));
  const { el, box, rerender } = await render({ connected: false, onSearch });
  await type(box, "@sp");
  expect(el.querySelector('[data-testid="mention-picker"]')).toBeNull();
  online = true;
  await rerender({ connected: true });
  expect(el.querySelector('[data-testid="mention-picker"]')?.textContent).toContain("spec.md");
});

it("on a touch screen a stop does not move focus to the prompt box (no soft keyboard)", async () => {
  const mm = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: q.includes("pointer: coarse"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  try {
    const { $, box, rerender } = await render({}, { ...emptySession(), state: "running" });
    $("toolbar-stop")!.focus();
    await rerender({ view: { ...emptySession(), state: "idle" } });
    expect(document.activeElement).not.toBe(box);
  } finally {
    window.matchMedia = mm;
  }
});

it("/skills is the CLI's own command when the session's list has one; /help alone still opens the dialog", async () => {
  const onPrompt = vi.fn(async () => {});
  const onDialog = vi.fn();
  const { box } = await render({ onPrompt, onDialog }, { ...emptySession(), commands: [{ name: "skills", description: "CLI skills", argumentHint: "" }] });
  await type(box, "/skills");
  await key(box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("/skills", []);
  expect(onDialog).not.toHaveBeenCalled();
  await type(box, "/help");
  await key(box, { key: "Enter" });
  expect(onDialog).toHaveBeenCalledWith("skills");
});

it("/plugins alone opens Manage Plugins; a session command of that name is sent instead", async () => {
  const onPrompt = vi.fn(async () => {});
  const onDialog = vi.fn();
  const { box, rerender } = await render({ onPrompt, onDialog });
  await type(box, "/marketplace");
  await key(box, { key: "Enter" });
  expect(onDialog).toHaveBeenCalledWith("plugins");
  expect(onPrompt).not.toHaveBeenCalled();
  const view = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "commands", id: "commands", commands: [{ name: "plugin", description: "CLI plugin", argumentHint: "" }] } });
  await rerender({ view });
  await type(box, "/plugin");
  await key(box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("/plugin", []);
  expect(onDialog).toHaveBeenCalledTimes(1);
});

it("a slash command picked mid-message replaces only the token, sends nothing, and dialog commands are not listed", async () => {
  const onPrompt = vi.fn(async () => {});
  const { el, box } = await render({ onPrompt, onDialog: noop }, { ...emptySession(), commands: [{ name: "review", description: "", argumentHint: "<pr>" }] });
  await type(box, "fix the bug, then /");
  const rows = [...el.querySelectorAll('[role="listbox"] [role=option]')].map((o) => o.textContent);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("/review");
  await key(box, { key: "Enter" });
  expect(box.value).toBe("fix the bug, then /review ");
  expect(box.selectionStart).toBe(box.value.length);
  expect(onPrompt).not.toHaveBeenCalled();
  expect(box.getAttribute("aria-expanded")).toBe("false");
});

it("Tab on a mid-message slash token and Esc", async () => {
  const { box } = await render({}, { ...emptySession(), commands: [{ name: "review", description: "", argumentHint: "" }] });
  await type(box, "go /re");
  await key(box, { key: "Escape" });
  expect(box.getAttribute("aria-expanded")).toBe("false");
  await type(box, "go /rev");
  await key(box, { key: "Tab" });
  expect(box.value).toBe("go /review ");
});

it("a pick that leaves the text as it was still moves the caret out of the token", async () => {
  const { box } = await render({}, { ...emptySession(), commands: [{ name: "rv-skill", description: "", argumentHint: "" }] });
  await type(box, "run /rv-skill now");
  await act(async () => {
    box.focus();
    box.setSelectionRange(7, 7);
    box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "ArrowLeft" }));
  });
  await key(box, { key: "Enter" });
  expect(box.value).toBe("run /rv-skill now");
  expect(box.selectionStart).toBe(14);
});

it('user bubble: "> " lines render as a markdown blockquote, the rest as a paragraph', async () => {
  const user = (text: string) => applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "user_text", id: "u1", text, images: [] } });
  const d = await render({}, user("> first\n> second\n\nmy reply"));
  expect(d.el.querySelector("blockquote")?.textContent?.trim()).toBe("first\nsecond");
  expect([...d.el.querySelectorAll("p")].some((p) => p.textContent === "my reply")).toBe(true);
  await d.rerender({ view: user("no quote") });
  expect(d.el.querySelector("blockquote")).toBeNull();
});

it('an insert starting with ">" is appended at the end of the draft, not at the caret; a second one stacks below', async () => {
  const d = await render();
  await type(d.box, "draft");
  d.box.setSelectionRange(0, 0);
  await d.rerender({ insert: "> a\n\n" });
  expect(d.box.value).toBe("draft\n\n> a\n\n");
  expect(d.box.selectionStart).toBe(d.box.value.length);
  expect(document.activeElement).toBe(d.box);
  await d.rerender({ insert: undefined });
  await d.rerender({ insert: "> b\n\n" });
  expect(d.box.value).toBe("draft\n\n> a\n\n> b\n\n");
});

const bashPart = (over: object = {}) => ({ type: "event" as const, sessionId: "s1", seq: 1, part: { type: "bash" as const, id: "b1", command: "ls", stdout: "", stderr: "", status: "running" as const, ...over } });

it('bash mode: "!" at caret 0 enters it (mono, "!" badge, placeholder), is not inserted', async () => {
  const { box, $ } = await render({ onBash: async () => {} });
  await key(box, { key: "!" });
  expect($("bash-mode")!.textContent).toBe("!");
  expect(box.className).toContain("font-mono");
  expect(box.placeholder).toContain("Run a shell command");
  expect(box.getAttribute("aria-label")).toBe("Shell command");
  expect(box.value).toBe("");
});

it('bash mode: "!" not at caret 0 is plain text; no bash mode without onBash (no project yet)', async () => {
  const a = await render({ onBash: async () => {} });
  await type(a.box, "echo ");
  await key(a.box, { key: "!" });
  expect(a.$("bash-mode")).toBeNull();
  unmount();
  const b = await render();
  await key(b.box, { key: "!" });
  expect(b.$("bash-mode")).toBeNull();
});

it("bash mode: Esc and Backspace on an empty box leave it; Esc stops nothing while idle", async () => {
  const onInterrupt = vi.fn();
  const { box, $ } = await render({ onBash: async () => {}, onInterrupt });
  await key(box, { key: "!" });
  await key(box, { key: "Escape" });
  expect($("bash-mode")).toBeNull();
  await key(box, { key: "!" });
  await key(box, { key: "Backspace" });
  expect($("bash-mode")).toBeNull();
  expect(onInterrupt).not.toHaveBeenCalled();
});

it("bash mode: no slash or mention picker", async () => {
  const { el, box } = await render({ onBash: async () => {}, onSearch: async () => ["a.ts"] });
  await key(box, { key: "!" });
  await type(box, "/");
  await type(box, "ls @a");
  expect(el.querySelector('[role="listbox"]')).toBeNull();
});

it('bash mode: Enter runs the trimmed command via onBash, clears the box, back to prompt mode; a rejected run puts the text back in bash mode with "Command not run"', async () => {
  const onBash = vi.fn(async () => {});
  const onPrompt = vi.fn(async () => {});
  const d = await render({ onBash, onPrompt });
  await key(d.box, { key: "!" });
  await type(d.box, "  ls -la ");
  await key(d.box, { key: "Enter" });
  expect(onBash).toHaveBeenCalledWith("ls -la");
  expect(onPrompt).not.toHaveBeenCalled();
  expect(d.box.value).toBe("");
  expect(d.$("bash-mode")).toBeNull();
  unmount();
  const fail = await render({ onBash: () => Promise.reject(new Error("busy")) });
  await key(fail.box, { key: "!" });
  await type(fail.box, "ls");
  await key(fail.box, { key: "Enter" });
  expect(fail.box.value).toBe("ls");
  expect(fail.$("bash-mode")).not.toBeNull();
  expect(fail.$("prompt-error")!.textContent).toBe("Command not run: busy");
});

it("while a bash part runs the box shows Stop and Esc calls onInterrupt", async () => {
  const onInterrupt = vi.fn();
  const { $ } = await render({ onInterrupt }, applyEvent(emptySession(), bashPart()));
  expect($("toolbar-stop")).not.toBeNull();
  await act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(onInterrupt).toHaveBeenCalled();
});

it("renders a bash part as a bash card: $ command, output, exit code line; stopped label", async () => {
  const done = applyEvent(emptySession(), bashPart({ command: "ls /x", stdout: "out", stderr: "no such file", status: "error", exitCode: 2 }));
  const a = await render({}, done);
  expect(a.$("bash-card")!.textContent).toContain("$ ls /x");
  expect(a.$("bash-card")!.textContent).toContain("out");
  expect(a.$("bash-card")!.textContent).toContain("Exit code 2");
  unmount();
  const b = await render({}, applyEvent(emptySession(), bashPart({ status: "stopped" })));
  expect(b.$("bash-card")!.textContent).toContain("Stopped");
});

it("bash mode: an inserted quote leaves bash mode first, so it is never run as a command", async () => {
  const { $, rerender } = await render({ onBash: async () => {} });
  await key(document.querySelector("textarea")!, { key: "!" });
  expect($("bash-mode")).not.toBeNull();
  await rerender({ insert: "> quoted" });
  expect($("bash-mode")).toBeNull();
});

it("without CSS field-sizing the prompt box height follows its content and returns to the default after send", async () => {
  vi.stubGlobal("CSS", { supports: () => false });
  const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "scrollHeight");
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get() { return 20 * (this.value.split("\n").length + 1); } });
  try {
    const { box } = await render();
    expect(box.style.height).toBe("40px");
    await type(box, "a\nb\nc\nd\ne\nf");
    expect(box.style.height).toBe("140px");
    await key(box, { key: "Enter" });
    expect(box.value).toBe("");
    expect(box.style.height).toBe("40px");
  } finally {
    vi.unstubAllGlobals();
    if (desc) Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", desc);
    else delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
});
