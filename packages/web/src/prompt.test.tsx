// @vitest-environment jsdom
import { Activity, act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelInfo } from "@claude-ui/protocol";
import { SessionPane } from "./App.tsx";
import { applyEvent, emptySession, type SessionView } from "./store.ts";
import { effortOptions, nextMode, shortModel } from "./toolbar.tsx";
import { loadSendMode, saveSendMode } from "./send-mode.ts";
import { QuestionPanel } from "./question.tsx";
import { saveDraft } from "./drafts.ts";
import { announceDraft, flushDrafts } from "./use-draft.ts";
import { collapsePasted, pasteTagId, splitPasted } from "./pasted-text.ts";

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
let activity: "visible" | "hidden" = "visible";
afterEach(() => (unmount(), localStorage.clear(), (activity = "visible")));

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
  await act(async () => root.render(<Activity mode={activity}><SessionPane {...props} /></Activity>));
  unmount = () => (root.unmount(), el.remove());
  const $ = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { el, $, box: el.querySelector("textarea")!, rerender: (p: Partial<ComponentProps<typeof SessionPane>>) => act(async () => root.render(<Activity mode={activity}><SessionPane {...props} {...p} /></Activity>)) };
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

it("the model picker drops the parenthesised note where short, and ring + send sit in a right group", async () => {
  expect(["Default (recommended)", "Sonnet 5.5", "Opus 5.5 (1M context)", "(x)"].map(shortModel)).toEqual(["Default model", "Sonnet 5.5", "Opus 5.5 (1M context)", "(x)"]);
  const view = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "context_usage", id: "context_usage", usage: { totalTokens: 100, maxTokens: 1000, percentage: 10, categories: [] } } });
  const { $ } = await render({}, view);
  // jsdom shows both labels (CSS picks one by the toolbar width); the full name stays the accessible name.
  expect($("session-model")!.textContent).toContain("Default modelDefault (recommended)");
  expect($("session-model")!.getAttribute("aria-label")).toBe("Default (recommended), Model");
  const right = $("send")!.parentElement!;
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
  expect($("toolbar-stop")).not.toBeNull();
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

it("a running ! card shows Run in background and sends its part id; a moved one shows Running in background, no button, and the box is free (GH-485)", async () => {
  const onBackgroundShell = vi.fn(async () => ({}));
  const running = await render({ onBackgroundShell }, applyEvent(emptySession(), bashPart()));
  const button = () => running.$("bash-card")!.querySelector<HTMLButtonElement>('[data-testid="run-in-background"]');
  expect(button()).not.toBeNull();
  await act(async () => button()!.click());
  expect(onBackgroundShell).toHaveBeenCalledWith("b1");
  unmount();
  const moved = await render({ onBackgroundShell }, applyEvent(emptySession(), bashPart({ shell: "background" })));
  expect(moved.$("bash-card")!.querySelector('[data-testid="run-in-background"]')).toBeNull();
  expect(moved.$("bash-card")!.textContent).toContain("Running in background");
  expect(moved.$("bash-card")!.getAttribute("data-shell")).toBe("background");
  expect(moved.$("toolbar-stop")).toBeNull();
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

// GH-165: one Stop (the prompt box's), no running chip in the session header, no header row on a phone.
const phone = (on: boolean) => {
  const mm = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: on && q.includes("40rem"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  return () => void (window.matchMedia = mm);
};

it("GH-165: a running turn has exactly one Stop, in the prompt box; the header has none and no state chip", async () => {
  const onInterrupt = vi.fn();
  const { el, $ } = await render({ onInterrupt }, { ...emptySession(), state: "running" });
  expect($("stop")).toBeNull();
  expect($("session-state")).toBeNull();
  expect([...el.querySelectorAll("button")].filter((b) => /^Stop\b/.test(b.textContent ?? "") || /Stop/.test(b.title))).toHaveLength(1);
  expect(el.querySelectorAll('[data-testid="toolbar-stop"]')).toHaveLength(1);
  expect($("session-header")).not.toBeNull();
});

it("GH-165: no state chip for idle, running or needs_input; error and closed keep theirs", async () => {
  for (const state of ["idle", "running", "needs_input"] as const) {
    const d = await render({}, { ...emptySession(), state });
    expect(d.$("session-state"), state).toBeNull();
    unmount();
  }
  for (const state of ["error", "closed"] as const) {
    const d = await render({}, { ...emptySession(), state });
    expect(d.$("session-state")!.textContent).toBe(state);
    unmount();
  }
});

it("GH-165: below sm there is no session header row", async () => {
  const back = phone(true);
  try {
    const { $ } = await render({}, { ...emptySession(), state: "error" });
    expect($("session-header")).toBeNull();
    expect($("session-project")).toBeNull();
    expect($("session-state")).toBeNull();
  } finally {
    back();
  }
});

it("GH-165: while steering (running, text typed) a separate Stop sits beside Steer and stops without sending", async () => {
  const onPrompt = vi.fn(async () => {});
  const onInterrupt = vi.fn();
  const { $, box } = await render({ onPrompt, onInterrupt }, { ...emptySession(), state: "running" });
  await type(box, "also do X");
  expect($("send")).not.toBeNull();
  expect($("toolbar-stop")).not.toBeNull();
  expect($("toolbar-stop")!.getAttribute("aria-label")).toBe("Stop");
  await act(async () => $("toolbar-stop")!.click());
  expect(onInterrupt).toHaveBeenCalledTimes(1);
  expect(onPrompt).not.toHaveBeenCalled();
});

it("GH-165: a permission request has its own Stop that interrupts the turn", async () => {
  const onInterrupt = vi.fn();
  const view = applyEvent({ ...emptySession(), state: "needs_input" }, { type: "event", sessionId: "s1", seq: 1, part: { type: "permission_request", id: "r1", requestId: "r1", toolUseId: "t1", tool: "Bash", input: { command: "ls" }, suggestions: [], settled: false } });
  const { $ } = await render({ onInterrupt }, view);
  expect($("permission-stop")).not.toBeNull();
  await act(async () => $("permission-stop")!.click());
  expect(onInterrupt).toHaveBeenCalledTimes(1);
});

// GH-166: phone (below sm) prompt box on one line, settings chip, short status line.
it("GH-166: phone: the idle prompt box is one line with a short placeholder; desktop keeps two lines and the hints", async () => {
  const back = phone(true);
  try {
    const idle = await render();
    expect(idle.box.rows).toBe(1);
    expect(idle.box.placeholder).toBe("Ask Claude…");
    unmount();
    const busy = await render({}, { ...emptySession(), state: "running" });
    expect(busy.box.placeholder).toBe("Claude is working…");
    unmount();
  } finally {
    back();
  }
  const wide = await render();
  expect(wide.box.rows).toBe(2);
  expect(wide.box.placeholder).toContain("Enter to send");
});

it("GH-166: phone: mode, model and effort sit behind one settings chip; the toolbar is one row", async () => {
  const onModel = vi.fn();
  const back = phone(true);
  try {
    const view = { ...emptySession(), permissionMode: "plan" as const, effort: "high" as const };
    const { $ } = await render({ onModel }, view);
    expect($("session-model")).toBeNull();
    expect($("mode-select")).toBeNull();
    expect($("effort-select")).toBeNull();
    const chip = $("session-settings")!;
    expect($("prompt-toolbar")!.contains(chip)).toBe(true);
    expect(chip.textContent).toContain("Plan");
    expect(chip.textContent).toContain("Default model");
    const name = chip.getAttribute("aria-label")!;
    expect(name.startsWith(chip.textContent!)).toBe(true);
    expect(name).toContain("Plan mode");
    expect(name).toContain("Default (recommended)");
    expect(name).toContain("High");
    expect($("prompt-toolbar")!.className).not.toContain("flex-wrap");
    await act(async () => chip.click());
    const popup = document.querySelector<HTMLElement>('[data-testid="session-settings-popup"]')!;
    expect(popup.querySelector('[data-testid="mode-select"]')).not.toBeNull();
    expect(popup.querySelector('[data-testid="session-model"]')).not.toBeNull();
    expect(popup.querySelector('[data-testid="effort-select"]')).not.toBeNull();
    await act(async () => popup.querySelector<HTMLElement>('[data-testid="session-model"]')!.click());
    const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((o) => o.textContent === "Haiku 4.5");
    expect(option).toBeDefined();
    await act(async () => option!.click());
    expect(onModel).toHaveBeenCalledWith("haiku");
  } finally {
    back();
  }
});

it("GH-166: phone: without effort support the chip has no effort in its name or popup; agents, ring and send stay in the row", async () => {
  const back = phone(true);
  try {
    const { $ } = await render({ session: { id: "s1", cwd: "/tmp", state: "idle", model: "haiku", permissionMode: "default", effort: "default", permissionModes: ["default"] } }, { ...emptySession(), model: "haiku" });
    expect($("session-settings")!.getAttribute("aria-label")).not.toMatch(/effort/i);
    await act(async () => $("session-settings")!.click());
    expect(document.querySelector('[data-testid="effort-select"]')).toBeNull();
    expect($("attach")).not.toBeNull();
    expect($("send")).not.toBeNull();
  } finally {
    back();
  }
});

it("GH-166: desktop: the choosers stay in the toolbar and there is no settings chip", async () => {
  const { $ } = await render();
  expect($("session-settings")).toBeNull();
  expect($("prompt-toolbar")!.contains($("mode-select"))).toBe(true);
});

// GH-166: hide-on-scroll (phone fallback for reading space).
async function scrollLog(el: HTMLElement, top: number, toEnd = 1000) {
  const log = el.querySelector<HTMLElement>('[role="log"]')!;
  Object.defineProperty(log, "scrollTop", { value: top, configurable: true, writable: true });
  Object.defineProperty(log, "clientHeight", { value: 500, configurable: true, writable: true });
  Object.defineProperty(log, "scrollHeight", { value: top + 500 + toEnd, configurable: true, writable: true });
  await act(async () => void log.dispatchEvent(new Event("scroll")));
}

it("GH-166: phone: scrolling up through an idle transcript hides the prompt dock, scrolling down shows it again", async () => {
  const back = phone(true);
  try {
    const { el, $ } = await render();
    const dock = () => $("prompt-box")!.parentElement!.parentElement!;
    await scrollLog(el, 1000);
    expect(dock().hasAttribute("data-hidden")).toBe(false);
    await scrollLog(el, 900);
    expect(dock().hasAttribute("data-hidden")).toBe(true);
    expect(dock().className).toContain("hidden");
    expect($("prompt-box")).not.toBeNull();
    await scrollLog(el, 1000);
    expect(dock().hasAttribute("data-hidden")).toBe(false);
  } finally {
    back();
  }
});

it("GH-166: the dock stays while a turn runs (Stop), and on desktop", async () => {
  const back = phone(true);
  try {
    const { el, $ } = await render({}, { ...emptySession(), state: "running" });
    await scrollLog(el, 1000);
    await scrollLog(el, 800);
    expect($("prompt-box")!.parentElement!.parentElement!.hasAttribute("data-hidden")).toBe(false);
  } finally {
    back();
  }
  unmount();
  const wide = await render();
  await scrollLog(wide.el, 1000);
  await scrollLog(wide.el, 800);
  expect(wide.$("prompt-box")!.parentElement!.parentElement!.hasAttribute("data-hidden")).toBe(false);
});

it("/resume is never sent, even when the CLI lists its own; text after it goes to the session search (GH-100)", async () => {
  const onPrompt = vi.fn(async () => {});
  const onDialog = vi.fn();
  const { box } = await render({ onPrompt, onDialog }, { ...emptySession(), commands: [{ name: "resume", description: "CLI resume", argumentHint: "[conversation]" }] });
  await type(box, "/resume");
  await key(box, { key: "Enter" });
  expect(onDialog).toHaveBeenLastCalledWith("resume");
  await type(box, "/resume deploy");
  await key(box, { key: "Enter" });
  expect(onDialog).toHaveBeenLastCalledWith("resume", "deploy");
  expect(onPrompt).not.toHaveBeenCalled();
});

it("/resume with an image attached still opens the session search and keeps the image (GH-100)", async () => {
  const onPrompt = vi.fn(async () => {});
  const onDialog = vi.fn();
  const { $, box } = await render({ onPrompt, onDialog });
  const input = $("attach-input") as HTMLInputElement;
  const png = new File([Uint8Array.from(atob("iVBORw0KGgo="), (c) => c.charCodeAt(0))], "a.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [png], configurable: true });
  await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await vi.waitFor(() => expect($("image-strip")!.querySelectorAll("img")).toHaveLength(1));
  await type(box, "/resume");
  await key(box, { key: "Enter" });
  expect(onDialog).toHaveBeenLastCalledWith("resume");
  expect(onPrompt).not.toHaveBeenCalled();
  expect($("image-strip")!.querySelectorAll("img")).toHaveLength(1);
});

it("an unsent prompt comes back after a reload of the page (a remount) and is gone once sent", async () => {
  localStorage.clear();
  const first = await render();
  await type(first.box, "half a thought");
  unmount(); // the page goes away: the draft is flushed on the way out
  expect(localStorage.getItem("claude-ui.draft.s1")).toBe("half a thought");
  const second = await render();
  expect(second.box.value).toBe("half a thought");
  await key(second.box, { key: "Enter" });
  expect(second.box.value).toBe("");
  expect(localStorage.getItem("claude-ui.draft.s1")).toBeNull();
  unmount();
  expect((await render()).box.value).toBe("");
});

it("a draft belongs to its session", async () => {
  localStorage.setItem("claude-ui.draft.other", "not mine");
  localStorage.setItem("claude-ui.draft.s1", "stored");
  expect((await render()).box.value).toBe("stored");
});

it("sending drops the stored draft even when the box unmounts before it renders the emptied text (the new-session card)", async () => {
  const { box } = await render();
  await type(box, "Reply with just the word alpha.");
  await act(async () => void (await new Promise((r) => setTimeout(r, 500)))); // past the debounce: the draft is stored
  expect(localStorage.getItem("claude-ui.draft.s1")).toBe("Reply with just the word alpha.");
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    unmount();
  });
  expect(localStorage.getItem("claude-ui.draft.s1")).toBeNull();
});


// GH-77: queued messages.
const queueView = (items: { id: string; text: string; imageCount: number; bash?: true }[], state: "idle" | "running" = "running") =>
  applyEvent({ ...emptySession(), state }, { type: "event", sessionId: "s1", seq: 1, part: { type: "prompt_queue", id: "prompt_queue", items } });

it("GH-77: Alt+Enter while a turn runs queues the text, clears the box and sends nothing", async () => {
  const onPrompt = vi.fn(async () => {});
  const onQueue = vi.fn(async () => {});
  const { box } = await render({ onPrompt, onQueue }, { ...emptySession(), state: "running" });
  await type(box, "later");
  await key(box, { key: "Enter", altKey: true });
  expect(onQueue).toHaveBeenCalledWith("later", []);
  expect(onPrompt).not.toHaveBeenCalled();
  expect(box.value).toBe("");
});

it("GH-77: Enter still steers while a turn runs", async () => {
  const onPrompt = vi.fn(async () => {});
  const onQueue = vi.fn(async () => {});
  const { box } = await render({ onPrompt, onQueue }, { ...emptySession(), state: "running" });
  await type(box, "now");
  await key(box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("now", []);
  expect(onQueue).not.toHaveBeenCalled();
});

it("GH-77: Alt+Enter during an IME composition does nothing", async () => {
  const onQueue = vi.fn(async () => {});
  const { box } = await render({ onQueue }, { ...emptySession(), state: "running" });
  await type(box, "ime");
  await key(box, { key: "Enter", altKey: true, isComposing: true });
  await key(box, { key: "Process", keyCode: 229, altKey: true });
  expect(onQueue).not.toHaveBeenCalled();
  expect(box.value).toBe("ime");
});

it("GH-77: Alt+Enter in bash mode runs the command like Enter", async () => {
  const onBash = vi.fn(async () => {});
  const onQueue = vi.fn(async () => {});
  const { box } = await render({ onBash, onQueue });
  await key(box, { key: "!" });
  await type(box, "ls");
  await key(box, { key: "Enter", altKey: true });
  expect(onBash).toHaveBeenCalledWith("ls");
  expect(onQueue).not.toHaveBeenCalled();
});

it("GH-77: a rejected queue puts the text back and shows Not queued", async () => {
  const onQueue = vi.fn(() => Promise.reject(new Error("queue_full")));
  const { box, el } = await render({ onQueue }, { ...emptySession(), state: "running" });
  await type(box, "later");
  await key(box, { key: "Enter", altKey: true });
  await act(async () => {});
  expect(box.value).toBe("later");
  expect(el.querySelector('[data-testid="prompt-error"]')!.textContent).toBe("Not queued: queue_full");
});

it("GH-77: Edit takes the message back before the typed text; the chip button dequeues it", async () => {
  const onDequeue = vi.fn(async () => ({ text: "old text", images: ["data:image/png;base64,AA=="] }));
  const { box, el } = await render({ onDequeue }, queueView([{ id: "q1", text: "old text", imageCount: 1 }]));
  await type(box, "typed");
  await act(async () => void (el.querySelector('[aria-label="Edit: old text"]') as HTMLElement).click());
  expect(onDequeue).toHaveBeenCalledWith("q1");
  expect(box.value).toBe("old text\ntyped");
  expect(el.querySelectorAll('[data-testid="image-strip"] img, img[alt]').length).toBeGreaterThan(0);
});

it("GH-77: Edit of an item already sent shows Already sent", async () => {
  const onDequeue = vi.fn(() => Promise.reject(Object.assign(new Error("gone"), { code: "unknown_item" })));
  const { el } = await render({ onDequeue }, queueView([{ id: "q1", text: "gone", imageCount: 0 }]));
  await act(async () => void (el.querySelector('[aria-label="Edit: gone"]') as HTMLElement).click());
  expect(el.querySelector('[data-testid="prompt-error"]')!.textContent).toBe("Already sent");
});

it("GH-77: Delete and Send now call the daemon; chips show above the prompt box", async () => {
  const onDequeue = vi.fn(async () => ({ text: "x", images: [] }));
  const onSendQueued = vi.fn(async () => {});
  const { el } = await render({ onDequeue, onSendQueued }, queueView([{ id: "q1", text: "one", imageCount: 0 }]));
  const chips = el.querySelector('section[aria-label="Queued messages"]')!;
  expect(chips.compareDocumentPosition(el.querySelector('[data-testid="prompt-box"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => void (el.querySelector('[aria-label="Send now: one"]') as HTMLElement).click());
  expect(onSendQueued).toHaveBeenCalledWith("q1");
  await act(async () => void (el.querySelector('[aria-label="Delete: one"]') as HTMLElement).click());
  expect(onDequeue).toHaveBeenCalledWith("q1");
});

it("GH-77: chips also show above a permission request", async () => {
  const view = applyEvent(queueView([{ id: "q1", text: "one", imageCount: 0 }]), { type: "event", sessionId: "s1", seq: 2, part: { type: "permission_request", id: "r1", requestId: "r1", toolUseId: "t1", tool: "Bash", input: { command: "ls" }, suggestions: [], settled: false } });
  const { el } = await render({}, { ...view, state: "needs_input" });
  expect(el.querySelector('section[aria-label="Queued messages"]')).not.toBeNull();
});

it("the send menu is gone: the toolbar has Stop and the send button only, with a hint on the send button", async () => {
  const { $, el, box } = await render({ onQueue: async () => {} }, { ...emptySession(), state: "running" });
  await type(box, "hello");
  expect($("send-menu")).toBeNull();
  expect(el.querySelector('[aria-label="More send options"]')).toBeNull();
  expect($("toolbar-stop")).not.toBeNull();
  expect($("send")!.getAttribute("aria-label")).toBe("Claude is working. Steer");
});

it("the send mode defaults to steer, and an unknown stored value is steer", async () => {
  expect(loadSendMode()).toBe("steer");
  localStorage.setItem("claude-ui.sendMode", "nonsense");
  expect(loadSendMode()).toBe("steer");
  saveSendMode("queue");
  expect(localStorage.getItem("claude-ui.sendMode")).toBe("queue");
  expect(loadSendMode()).toBe("queue");
  saveSendMode("steer");
  expect(localStorage.getItem("claude-ui.sendMode")).toBeNull();
});

it("queue mode: Enter queues and Alt+Enter steers while a turn runs", async () => {
  saveSendMode("queue");
  const onPrompt = vi.fn(async () => {});
  const onQueue = vi.fn(async () => {});
  const { box } = await render({ onPrompt, onQueue }, { ...emptySession(), state: "running" });
  await type(box, "later");
  await key(box, { key: "Enter" });
  expect(onQueue).toHaveBeenCalledWith("later", []);
  expect(onPrompt).not.toHaveBeenCalled();
  await type(box, "now");
  await key(box, { key: "Enter", altKey: true });
  expect(onPrompt).toHaveBeenCalledWith("now", []);
  expect(onQueue).toHaveBeenCalledTimes(1);
});

it("queue mode: the send button queues and is labelled Queue; the placeholder follows", async () => {
  saveSendMode("queue");
  const onPrompt = vi.fn(async () => {});
  const onQueue = vi.fn(async () => {});
  const { $, box } = await render({ onPrompt, onQueue }, { ...emptySession(), state: "running" });
  expect(box.placeholder).toBe("Claude is working… (Enter to queue, Alt+Enter to steer, Esc to stop)");
  await type(box, "hello");
  expect($("send")!.getAttribute("aria-label")).toBe("Claude is working. Queue");
  await act(async () => $("send")!.click());
  expect(onQueue).toHaveBeenCalledWith("hello", []);
  expect(onPrompt).not.toHaveBeenCalled();
});

it("steer mode: the send button steers", async () => {
  const onPrompt = vi.fn(async () => {});
  const onQueue = vi.fn(async () => {});
  const { $, box } = await render({ onPrompt, onQueue }, { ...emptySession(), state: "running" });
  await type(box, "hello");
  await act(async () => $("send")!.click());
  expect(onPrompt).toHaveBeenCalledWith("hello", []);
  expect(onQueue).not.toHaveBeenCalled();
});

it("queue mode without onQueue still steers; idle Enter still sends and idle Alt+Enter still queues", async () => {
  saveSendMode("queue");
  const onPrompt = vi.fn(async () => {});
  const run = await render({ onPrompt }, { ...emptySession(), state: "running" });
  await type(run.box, "a");
  await key(run.box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("a", []);
  unmount();
  const onQueue = vi.fn(async () => {});
  const idle = await render({ onPrompt, onQueue });
  await type(idle.box, "b");
  await key(idle.box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("b", []);
  await type(idle.box, "c");
  await key(idle.box, { key: "Enter", altKey: true });
  expect(onQueue).toHaveBeenCalledWith("c", []);
});

it("GH-77: the desktop placeholder mentions Alt+Enter while running", async () => {
  const { box } = await render({ onQueue: async () => {} }, { ...emptySession(), state: "running" });
  expect(box.placeholder).toBe("Claude is working… (Enter to steer, Alt+Enter to queue, Esc to stop)");
});

it("GH-77: Stop and Steer are 44px below md and on coarse pointers (also with a fine pointer at 390px)", async () => {
  const { $, box } = await render({ onQueue: async () => {} }, { ...emptySession(), state: "running" });
  await type(box, "x");
  for (const el of [$("toolbar-stop"), $("send")]) {
    expect(el!.className).toMatch(/\bmax-md:size-11\b/);
    expect(el!.className).toContain("pointer-coarse:size-11");
  }
});

// GH-77 review fixes.
it("GH-77: Delete of a chip another tab already sent leaves the typed text unchanged", async () => {
  const onDequeue = vi.fn(() => Promise.reject(Object.assign(new Error("gone"), { code: "unknown_item" })));
  const { box, el } = await render({ onDequeue }, queueView([{ id: "q1", text: "gone", imageCount: 0 }]));
  await type(box, "typed");
  await act(async () => void (el.querySelector('[aria-label="Delete: gone"]') as HTMLElement).click());
  await act(async () => {});
  expect(JSON.stringify(box.value)).toBe(JSON.stringify("typed"));
  expect(el.querySelector('[data-testid="prompt-error"]')).toBeNull();
});

it("GH-77: Send now of a chip already sent leaves the typed text unchanged", async () => {
  const onSendQueued = vi.fn(() => Promise.reject(Object.assign(new Error("gone"), { code: "unknown_item" })));
  const { box, el } = await render({ onSendQueued }, queueView([{ id: "q1", text: "gone", imageCount: 0 }]));
  await type(box, "typed");
  await act(async () => void (el.querySelector('[aria-label="Send now: gone"]') as HTMLElement).click());
  await act(async () => {});
  expect(JSON.stringify(box.value)).toBe(JSON.stringify("typed"));
});

it("GH-77: Delete of the last chip moves focus to the prompt box", async () => {
  const onDequeue = vi.fn(async () => ({ text: "one", images: [] }));
  const first = queueView([{ id: "q1", text: "one", imageCount: 0 }]);
  const d = await render({ onDequeue }, first);
  const del = d.el.querySelector('[aria-label="Delete: one"]') as HTMLElement;
  del.focus();
  await act(async () => void del.click());
  await d.rerender({ view: applyEvent(first, { type: "event", sessionId: "s1", seq: 2, part: { type: "prompt_queue", id: "prompt_queue", items: [] } }) });
  expect(document.activeElement?.tagName).toBe("TEXTAREA");
});

it("GH-77: after Delete of the first of two chips focus moves to the next Delete", async () => {
  const onDequeue = vi.fn(async () => ({ text: "one", images: [] }));
  const two = [{ id: "q1", text: "one", imageCount: 0 }, { id: "q2", text: "two", imageCount: 0 }];
  const first = queueView(two);
  const d = await render({ onDequeue }, first);
  const del = d.el.querySelector('[aria-label="Delete: one"]') as HTMLElement;
  del.focus();
  await act(async () => void del.click());
  await d.rerender({ view: applyEvent(first, { type: "event", sessionId: "s1", seq: 2, part: { type: "prompt_queue", id: "prompt_queue", items: [two[1]!] } }) });
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Delete: two");
});

it("GH-443: bash mode while a turn runs: Enter calls onBash, box clears, no error, nothing steers or queues", async () => {
  const onBash = vi.fn(async () => ({ itemId: "q1" }));
  const onQueue = vi.fn(async () => {});
  const onPrompt = vi.fn(async () => {});
  const { box, $ } = await render({ onBash, onQueue, onPrompt }, { ...emptySession(), state: "running" });
  await key(box, { key: "!" });
  await type(box, "ls");
  await key(box, { key: "Enter" });
  await act(async () => {});
  expect(onBash).toHaveBeenCalledWith("ls");
  expect(box.value).toBe("");
  expect($("prompt-error")).toBeNull();
  expect(onQueue).not.toHaveBeenCalled();
  expect(onPrompt).not.toHaveBeenCalled();
});

it("GH-443: bash mode while blocked (external turn) still sends the command", async () => {
  const onBash = vi.fn(async () => ({ itemId: "q1" }));
  const view = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "external_turn", id: "external_turn", running: true } });
  const { box, $ } = await render({ onBash, onQueue: async () => {} }, view);
  await key(box, { key: "!" });
  await type(box, "ls");
  await key(box, { key: "Enter" });
  await act(async () => {});
  expect(onBash).toHaveBeenCalledWith("ls");
  expect($("prompt-error")).toBeNull();
});

it("GH-443: Edit of a bash chip: empty box -> bash mode with the command; typed text -> !cmd line in prompt mode", async () => {
  const onDequeue = vi.fn(async () => ({ text: "ls -la", images: [], bash: true }));
  const view = queueView([{ id: "q1", text: "ls -la", imageCount: 0, bash: true }]);
  const a = await render({ onDequeue }, view);
  await act(async () => void (a.el.querySelector('[aria-label="Edit: ! ls -la"]') as HTMLElement).click());
  expect(a.box.value).toBe("ls -la");
  expect(a.$("bash-mode")).not.toBeNull();
  unmount();
  const b = await render({ onDequeue }, view);
  await type(b.box, "typed");
  await act(async () => void (b.el.querySelector('[aria-label="Edit: ! ls -la"]') as HTMLElement).click());
  expect(b.box.value).toBe("!ls -la\ntyped");
  expect(b.$("bash-mode")).toBeNull();
  unmount();
  const c = await render({ onDequeue, onBash: async () => {} }, view);
  await key(c.box, { key: "!" });
  await type(c.box, "pwd");
  await act(async () => void (c.el.querySelector('[aria-label="Edit: ! ls -la"]') as HTMLElement).click());
  expect(c.box.value).toBe("ls -la\npwd");
  expect(c.$("bash-mode")).not.toBeNull();
});

it("GH-443: bash chip Send now is disabled while a turn runs, enabled when idle", async () => {
  const onSendQueued = vi.fn(async () => {});
  const items = [{ id: "q1", text: "ls", imageCount: 0, bash: true as const }];
  const a = await render({ onSendQueued }, queueView(items, "running"));
  const btn = a.el.querySelector('[aria-label="Send now: ! ls"]') as HTMLElement;
  expect(btn.getAttribute("aria-disabled")).toBe("true");
  await act(async () => void btn.click());
  expect(onSendQueued).not.toHaveBeenCalled();
  unmount();
  const b = await render({ onSendQueued }, queueView(items, "idle"));
  const idle = b.el.querySelector('[aria-label="Send now: ! ls"]') as HTMLElement;
  expect(idle.getAttribute("aria-disabled")).toBeNull();
  await act(async () => void idle.click());
  expect(onSendQueued).toHaveBeenCalledWith("q1");
});

it("GH-443: bash chip Send now is also disabled while a terminal CLI turn or other background work shows (idle, working)", async () => {
  const view = applyEvent(queueView([{ id: "q1", text: "ls", imageCount: 0, bash: true }], "idle"), { type: "event", sessionId: "s1", seq: 2, part: { type: "session_state", id: "session_state", state: "idle", working: true } });
  const { el } = await render({}, view);
  expect((el.querySelector('[aria-label="Send now: ! ls"]') as HTMLElement).getAttribute("aria-disabled")).toBe("true");
});

it("GH-443: the bash placeholder while busy is accurate (no Esc to exit: Esc stops the turn)", async () => {
  const { box } = await render({ onBash: async () => {}, onQueue: async () => {} }, { ...emptySession(), state: "running" });
  await key(box, { key: "!" });
  expect(box.placeholder).toBe("Queue a shell command: it runs when the current work ends");
});

// ---- Pasted text (GH-441) ----

const lines200 = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join("\n");
const paste = (box: HTMLTextAreaElement, text: string) => {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", { value: { files: [], getData: () => text } });
  act(() => void box.dispatchEvent(e));
  return e;
};
const chips = (el: HTMLElement) => el.querySelectorAll('[data-testid="paste-chip"]');
const userView = (text: string) => applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "user_text", id: "u1", text, images: [] } });

it("paste of 200 lines inserts one token and one chip; the textarea holds only the token", async () => {
  const d = await render();
  const e = paste(d.box, lines200);
  expect(e.defaultPrevented).toBe(true);
  expect(d.box.value).toBe("[Pasted text #1 +199 lines]");
  expect(chips(d.el)).toHaveLength(1);
});

it("paste of one short line stays plain text", async () => {
  const d = await render();
  const e = paste(d.box, "hello world");
  expect(e.defaultPrevented).toBe(false);
  expect(chips(d.el)).toHaveLength(0);
});

it("Backspace after a token removes the whole token and its chip", async () => {
  const d = await render();
  paste(d.box, lines200);
  d.box.setSelectionRange(d.box.value.length, d.box.value.length);
  await key(d.box, { key: "Backspace" });
  expect(d.box.value).toBe("");
  expect(chips(d.el)).toHaveLength(0);
});

it("Remove on a chip removes its token", async () => {
  const d = await render();
  await type(d.box, "a ");
  paste(d.box, lines200);
  expect(chips(d.el)).toHaveLength(1);
  await act(async () => d.el.querySelector<HTMLElement>('[aria-label="Remove pasted text #1"]')!.click());
  expect(d.box.value).toBe("a ");
  expect(chips(d.el)).toHaveLength(0);
});

it("two pastes give chips #1 and #2; typing between them keeps both", async () => {
  const d = await render();
  paste(d.box, lines200);
  await type(d.box, `${d.box.value} and `);
  paste(d.box, "x\ny\nz\nw");
  expect(d.box.value).toBe("[Pasted text #1 +199 lines] and [Pasted text #2 +3 lines]");
  expect([...chips(d.el)].map((c) => c.textContent)).toEqual(["Pasted text #1 · 199 lines", "Pasted text #2 · 3 lines"]);
});

it("send: onPrompt gets the typed text with each paste as a pasted_content block at its position, all 200 lines included; chips clear", async () => {
  const onPrompt = vi.fn(async () => {});
  const d = await render({ onPrompt });
  paste(d.box, lines200);
  await type(d.box, `${d.box.value} Reply OK`);
  await key(d.box, { key: "Enter" });
  const sent = (onPrompt.mock.calls[0] as unknown as [string])[0];
  expect(sent).toContain(`<pasted_content id="${pasteTagId("s1")}">`);
  const segs = splitPasted(sent);
  expect(segs).toHaveLength(2);
  expect(segs[0]).toMatchObject({ kind: "paste" });
  expect((segs[0] as { body: string }).body.split("\n")).toHaveLength(200);
  expect(segs[1]).toEqual({ kind: "text", text: " Reply OK" });
  expect(d.box.value).toBe("");
  expect(chips(d.el)).toHaveLength(0);
});

it("a failed send puts the token text and its chip back", async () => {
  const onPrompt = vi.fn(() => Promise.reject(new Error("boom")));
  const d = await render({ onPrompt });
  paste(d.box, lines200);
  await key(d.box, { key: "Enter" });
  await vi.waitFor(() => expect(d.box.value).toBe("[Pasted text #1 +199 lines]"));
  expect(chips(d.el)).toHaveLength(1);
});

it("in bash mode a large paste stays plain text", async () => {
  const d = await render({ onBash: async () => {} });
  await key(d.box, { key: "!" });
  const e = paste(d.box, lines200);
  expect(e.defaultPrevented).toBe(false);
  expect(chips(d.el)).toHaveLength(0);
});

const tagged = `Fix this\n\n<pasted_content id="9f3a">\n${lines200}\n</pasted_content id="9f3a">\n\nplease`;

it("user bubble: a pasted_content block shows collapsed with its line count; click expands", async () => {
  const d = await render({}, userView(tagged));
  const block = d.$("pasted-block")!;
  expect(block.textContent).toContain("Pasted text · 199 lines");
  expect(block.getAttribute("aria-expanded")).toBe("false");
  expect(d.el.textContent).not.toContain("pasted_content");
  expect(d.el.textContent).toContain("Fix this");
  expect(d.el.textContent).toContain("please");
  await act(async () => block.click());
  expect(block.getAttribute("aria-expanded")).toBe("true");
  expect(d.$("pasted-block-body")!.textContent).toContain("line-200");
});

it("copy action of a bubble copies the text without the tags", async () => {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  const d = await render({}, userView(tagged));
  const copy = [...d.el.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Copy message")!;
  await act(async () => copy.click());
  const copied = (writeText.mock.calls[0] as unknown as [string])[0];
  expect(copied).not.toContain("pasted_content");
  expect(copied).toContain("line-200");
});

it("draft keeps the chip across a remount", async () => {
  const first = await render();
  paste(first.box, lines200);
  unmount();
  const second = await render();
  expect(second.box.value).toBe("[Pasted text #1 +199 lines]");
  expect(chips(second.el)).toHaveLength(1);
});

it("rewind puts the prompt back with its chip", async () => {
  const d = await render({ rewindTo: "u1", onRewindPreview: async () => ({ filesChanged: [], insertions: 0, deletions: 0, conversation: true }) }, userView(tagged));
  await vi.waitFor(() => expect(d.$("rewind-panel")!.querySelectorAll("button").length).toBeGreaterThan(1));
  const both = [...d.$("rewind-panel")!.querySelectorAll("button")].find((b) => /conversation/i.test(b.textContent ?? ""))!;
  await act(async () => both.click());
  await vi.waitFor(() => expect(d.box.value).toBe("Fix this[Pasted text #1 +199 lines]please"));
  expect(chips(d.el)).toHaveLength(1);
  expect(collapsePasted(tagged).pastes[1]).toBe(lines200);
});

// Review fixes (GH-441): token kept across cut / paste back / undo, soft-keyboard deletion, "!" with a token.
const setSel = (box: HTMLTextAreaElement, a: number, b = a) => box.setSelectionRange(a, b);
const sentOf = (f: { mock: { calls: unknown[][] } }) => f.mock.calls[0]![0] as string;

it("cut the token, paste its text back, send: the pasted block is sent, not the literal token", async () => {
  const onPrompt = vi.fn(async () => {});
  const d = await render({ onPrompt });
  await type(d.box, "intro ");
  paste(d.box, lines200);
  const token = "[Pasted text #1 +199 lines]";
  expect(d.box.value).toBe(`intro ${token}`);
  await type(d.box, "intro "); // cut
  expect(chips(d.el)).toHaveLength(0);
  const e = paste(d.box, token); // 27 chars: plain insert by the browser
  expect(e.defaultPrevented).toBe(false);
  await type(d.box, `intro ${token}`);
  expect(chips(d.el)).toHaveLength(1);
  await key(d.box, { key: "Enter" });
  const segs = splitPasted(sentOf(onPrompt));
  expect(segs.some((x) => x.kind === "paste" && x.body === lines200)).toBe(true);
  expect(sentOf(onPrompt)).not.toContain(token);
});

it("undo / redo of a token (text back to the same string) keeps the paste", async () => {
  const onPrompt = vi.fn(async () => {});
  const d = await render({ onPrompt });
  paste(d.box, lines200);
  await type(d.box, "");
  await type(d.box, "[Pasted text #1 +199 lines]");
  await key(d.box, { key: "Enter" });
  expect(splitPasted(sentOf(onPrompt)).some((x) => x.kind === "paste")).toBe(true);
});

it("a new paste after the token was removed gets a fresh id and sends both", async () => {
  const onPrompt = vi.fn(async () => {});
  const d = await render({ onPrompt });
  paste(d.box, lines200);
  await type(d.box, "");
  paste(d.box, "x\ny\nz\nw");
  expect(d.box.value).toBe("[Pasted text #2 +3 lines]");
  await key(d.box, { key: "Enter" });
  const segs = splitPasted(sentOf(onPrompt));
  expect(segs.filter((x) => x.kind === "paste")).toHaveLength(1);
  expect((segs.find((x) => x.kind === "paste") as { body: string }).body).toBe("x\ny\nz\nw");
});

it("a soft keyboard Backspace (keyCode 229, one character of the token deleted) removes the whole token", async () => {
  const d = await render();
  await type(d.box, "a ");
  paste(d.box, lines200);
  const full = d.box.value;
  await key(d.box, { key: "Unidentified", keyCode: 229 });
  setSel(d.box, full.length);
  await type(d.box, full.slice(0, -1)); // the keyboard deleted "]" only
  expect(d.box.value).toBe("a ");
  expect(chips(d.el)).toHaveLength(0);
});

it("Delete before a token removes the whole token", async () => {
  const d = await render();
  paste(d.box, lines200);
  await type(d.box, `a ${d.box.value}`);
  setSel(d.box, 2);
  await key(d.box, { key: "Delete" });
  expect(d.box.value).toBe("a ");
});

it("typing ! in a box that holds a token does not open shell mode", async () => {
  const onBash = vi.fn(async () => {});
  const d = await render({ onBash });
  paste(d.box, lines200);
  setSel(d.box, 0);
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "!" });
  await act(async () => void d.box.dispatchEvent(ev));
  expect(ev.defaultPrevented).toBe(false);
  expect(d.box.placeholder).not.toMatch(/shell/i);
});

// Review lows (GH-441): IME, pastes cleared after every send path, "!" on a soft keyboard.
it("a deletion inside a token during an IME composition is left to the IME (no healing)", async () => {
  const d = await render();
  await type(d.box, "a ");
  paste(d.box, lines200);
  const full = d.box.value;
  await act(async () => void d.box.dispatchEvent(new Event("compositionstart", { bubbles: true })));
  setSel(d.box, full.length);
  await type(d.box, full.slice(0, -1));
  expect(d.box.value).toBe(full.slice(0, -1));
  await act(async () => void d.box.dispatchEvent(new Event("compositionend", { bubbles: true })));
});

it("pastes restart at #1 after a queued send", async () => {
  const onQueue = vi.fn(async () => {});
  const d = await render({ onQueue }, { ...emptySession(), state: "running" });
  paste(d.box, lines200);
  await key(d.box, { key: "Enter", altKey: true });
  expect(onQueue).toHaveBeenCalled();
  paste(d.box, lines200);
  expect(d.box.value).toBe("[Pasted text #1 +199 lines]");
});

it("pastes restart at #1 after a dialog command", async () => {
  const onDialog = vi.fn();
  const d = await render({ onDialog });
  paste(d.box, lines200);
  await type(d.box, "/help");
  await key(d.box, { key: "Enter" });
  expect(onDialog).toHaveBeenCalled();
  expect(d.box.value).toBe("");
  paste(d.box, lines200);
  expect(d.box.value).toBe("[Pasted text #1 +199 lines]");
});

it("a soft keyboard that types ! into a box holding a token does not open shell mode", async () => {
  const onBash = vi.fn(async () => {});
  const d = await render({ onBash });
  paste(d.box, lines200);
  const tok = d.box.value;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(d.box, `!${tok}`);
    d.box.setSelectionRange(1, 1); // the caret sits right after the typed "!"
    d.box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(d.box.value).toBe(`!${tok}`);
  expect(d.box.placeholder).not.toMatch(/shell/i);
});

it("/btw <question> opens an Aside instead of sending, also while the turn runs", async () => {
  const onAside = vi.fn(async () => {});
  const onPrompt = vi.fn(async () => {});
  const running = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "session_state", id: "session_state", state: "running" } as never });
  const d = await render({ onAside, onPrompt, session: { id: "s1", cwd: "/tmp", state: "running", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"] } }, running);
  await type(d.box, "/btw which file?");
  await key(d.box, { key: "Enter" });
  expect(onAside).toHaveBeenCalledWith("which file?");
  expect(onPrompt).not.toHaveBeenCalled();
  expect(d.box.value).toBe("");
});

it("/btw alone asks for a question and opens nothing", async () => {
  const onAside = vi.fn(async () => {});
  const d = await render({ onAside });
  await type(d.box, "/btw");
  await key(d.box, { key: "Enter" });
  expect(onAside).not.toHaveBeenCalled();
  expect(d.el.querySelector('[data-testid="prompt-error"]')?.textContent).toContain("Type a question after /btw");
});

it("a rejected Aside puts the text back and shows the reason", async () => {
  const onAside = vi.fn(() => Promise.reject(new Error("An aside needs a reply in this session first")));
  const d = await render({ onAside });
  await type(d.box, "/btw hi");
  await key(d.box, { key: "Enter" });
  expect(d.box.value).toBe("/btw hi");
  expect(d.el.querySelector('[data-testid="prompt-error"]')?.textContent).toContain("needs a reply");
});

it("an Aside pane shows no Ask aside input behind its own permission card (no nested aside)", async () => {
  const perm = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "permission_request", id: "p1", requestId: "p1", toolUseId: "t1", tool: "Bash", input: { command: "rm x" }, suggestions: [], settled: false } as never });
  const d = await render({ onAside: async () => {}, aside: true }, perm);
  expect(d.$("aside-ask-open")).toBeNull();
  expect(d.$("permission-panel")).not.toBeNull();
});

it("Esc stops the turn of an Aside pane only from inside its popup, and of an owner pane only from outside", async () => {
  const running = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "session_state", id: "session_state", state: "running" } as never });
  const run = { id: "s1", cwd: "/tmp", state: "running" as const, model: "default", permissionMode: "default" as const, effort: "default" as const, permissionModes: ["default" as const] };
  const esc = (t: EventTarget) => act(async () => void t.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
  const inAside = vi.fn();
  const a = await render({ aside: true, onInterrupt: inAside, session: run }, running);
  a.el.setAttribute("data-aside-popup", "");
  await esc(document.body);
  expect(inAside).not.toHaveBeenCalled();
  await esc(a.el);
  expect(inAside).toHaveBeenCalledOnce();
  unmount();
  const owner = vi.fn();
  const o = await render({ onInterrupt: owner, session: run }, running);
  o.el.setAttribute("data-aside-popup", "");
  await esc(o.el);
  expect(owner).not.toHaveBeenCalled();
  await esc(document.body);
  expect(owner).toHaveBeenCalledOnce();
});

it("while a permission card replaces the prompt box, Ask aside still opens an Aside (button, and the palette's /btw insert)", async () => {
  const perm = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "permission_request", id: "p1", requestId: "p1", toolUseId: "t1", tool: "Bash", input: { command: "rm x" }, suggestions: [], settled: false } as never });
  const onAside = vi.fn(async () => {});
  const d = await render({ onAside }, perm);
  expect(d.box).toBeNull();
  await act(async () => void d.$("aside-ask-open")!.click());
  const input = d.el.querySelector<HTMLInputElement>('input[aria-label="Aside question"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "why rm?");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void d.$("aside-ask")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(onAside).toHaveBeenCalledWith("why rm?");
  expect(d.$("permission-panel")).not.toBeNull();
  unmount();
  const onInserted = vi.fn();
  const e = await render({ onAside, insert: "/btw ", onInserted }, perm);
  expect(e.el.querySelector('input[aria-label="Aside question"]')).not.toBeNull();
  expect(onInserted).toHaveBeenCalled();
});

it("GH-505 a mounted prompt box picks up a draft written for it, keeping what the user typed", async () => {
  const d = await render();
  expect(d.box.value).toBe("");
  saveDraft("s1", "run the tests");
  await act(async () => announceDraft("s1"));
  expect(d.box.value).toBe("run the tests");
  await type(d.box, "mine");
  await act(async () => (flushDrafts(), saveDraft("s1", "mine\n\nnext"), announceDraft("s1")));
  expect(d.box.value).toBe("mine\n\nnext");
  await act(async () => (saveDraft("other", "x"), announceDraft("other")));
  expect(d.box.value).toBe("mine\n\nnext");
});

it("GH-505 a box in a hidden pane shows the draft written meanwhile when the pane is shown again", async () => {
  const d = await render();
  await type(d.box, "mine");
  activity = "hidden";
  await d.rerender({});
  saveDraft("s1", "mine\n\nnext");
  activity = "visible";
  await d.rerender({});
  expect(d.box.value).toBe("mine\n\nnext");
});
