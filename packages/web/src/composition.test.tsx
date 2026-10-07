// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelInfo } from "@claude-ui/protocol";
import { SessionPane } from "./App.tsx";
import { applyEvent, emptySession, type SessionView } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};

const models: ModelInfo[] = [{ value: "default", displayName: "Default (recommended)", description: "" }];
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

const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
const nativeSelect = HTMLTextAreaElement.prototype.setSelectionRange;
const key = (box: HTMLElement, init: KeyboardEventInit) => act(async () => void box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
const compose = (box: HTMLElement, kind: "compositionstart" | "compositionend") => act(async () => void box.dispatchEvent(new CompositionEvent(kind, { bubbles: true })));
// One IME step: the DOM value changes, then an InputEvent with its inputType (React's onChange listens to input).
const ime = (box: HTMLTextAreaElement, value: string, inputType = "insertCompositionText", caret = value.length) =>
  act(async () => {
    setValue.call(box, value);
    nativeSelect.call(box, caret, caret);
    box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data: value, isComposing: inputType === "insertCompositionText" }));
  });
const running = applyEvent(emptySession(), { type: "event", sessionId: "s1", seq: 1, part: { type: "session_state", id: "st", state: "running" } });

it('Telex composition: "Tieengs Vieetj" becomes "Tiếng Việt" with no doubled or lost characters and the caret at the end', async () => {
  const onPrompt = vi.fn(async () => {});
  const { box } = await render({ onPrompt });
  const spy = vi.spyOn(HTMLTextAreaElement.prototype, "setSelectionRange");
  await compose(box, "compositionstart");
  for (const v of ["T", "Ti", "Tie", "Tiê", "Tiên", "Tiêng", "Tiếng"]) await ime(box, v);
  await compose(box, "compositionend");
  await ime(box, "Tiếng ", "insertText");
  await compose(box, "compositionstart");
  for (const v of ["V", "Vi", "Vie", "Viê", "Việ", "Việt"]) await ime(box, `Tiếng ${v}`);
  await compose(box, "compositionend");
  expect(box.value).toBe("Tiếng Việt");
  expect(box.selectionStart).toBe(10);
  expect(spy).not.toHaveBeenCalled();
  expect(onPrompt).not.toHaveBeenCalled();
  spy.mockRestore();
});

it("Enter while composing commits the word and sends nothing; Enter after compositionend sends", async () => {
  const onPrompt = vi.fn(async () => {});
  const { box } = await render({ onPrompt });
  await compose(box, "compositionstart");
  await ime(box, "Tiếng");
  const e = new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true, bubbles: true, cancelable: true });
  await act(async () => void box.dispatchEvent(e));
  expect(e.defaultPrevented).toBe(false);
  expect(onPrompt).not.toHaveBeenCalled();
  expect(box.value).toBe("Tiếng");
  await compose(box, "compositionend");
  await key(box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("Tiếng", []);
  expect(box.value).toBe("");
});

it("Safari order: the committing Enter after compositionend (keyCode 229, not isComposing) does not send", async () => {
  const onPrompt = vi.fn(async () => {});
  const { box } = await render({ onPrompt });
  await compose(box, "compositionstart");
  await ime(box, "Việt");
  await compose(box, "compositionend");
  await key(box, { key: "Enter", keyCode: 229 });
  expect(onPrompt).not.toHaveBeenCalled();
  expect(box.value).toBe("Việt");
  await key(box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("Việt", []);
});

it("slash picker: Enter, Tab, arrows and Esc while composing go to the IME; after compositionend Enter picks", async () => {
  const onPrompt = vi.fn(async () => {});
  const view = { ...emptySession(), commands: [{ name: "review", description: "", argumentHint: "" }, { name: "release", description: "", argumentHint: "" }] };
  const { box } = await render({ onPrompt }, view);
  await act(async () => {
    setValue.call(box, "go /");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await compose(box, "compositionstart");
  await ime(box, "go /re");
  expect(box.getAttribute("aria-expanded")).toBe("true");
  await key(box, { key: "ArrowDown", isComposing: true });
  expect(box.getAttribute("aria-activedescendant")).toBe("command-0");
  await key(box, { key: "Tab", isComposing: true });
  await key(box, { key: "Enter", isComposing: true });
  expect(box.value).toBe("go /re");
  await key(box, { key: "Escape", isComposing: true });
  expect(box.getAttribute("aria-expanded")).toBe("true");
  await compose(box, "compositionend");
  await key(box, { key: "Enter" });
  expect(box.value).toMatch(/^go \/(review|release) $/);
  expect(onPrompt).not.toHaveBeenCalled();
});

it("Esc that cancels a composition does not stop a running turn; a plain Esc does", async () => {
  const onInterrupt = vi.fn();
  const { box } = await render({ onInterrupt }, running);
  await compose(box, "compositionstart");
  await ime(box, "tiê");
  await key(box, { key: "Escape", keyCode: 229, isComposing: true });
  expect(onInterrupt).not.toHaveBeenCalled();
  await compose(box, "compositionend");
  await key(box, { key: "Escape" });
  expect(onInterrupt).toHaveBeenCalledTimes(1);
});

it('IME keydowns never switch modes: "!" and Shift+Tab with keyCode 229 are ignored', async () => {
  const onMode = vi.fn();
  const { box, $ } = await render({ onMode, onBash: async () => {} });
  await key(box, { key: "!", keyCode: 229 });
  expect($("bash-mode")).toBeNull();
  await key(box, { key: "Tab", shiftKey: true, isComposing: true });
  expect(onMode).not.toHaveBeenCalled();
});

it("replacement input (Unikey backspace + insert, autocorrect insertReplacementText) keeps text and caret", async () => {
  const onPrompt = vi.fn(async () => {});
  const { box, $ } = await render({ onPrompt });
  await ime(box, "a", "insertText");
  await key(box, { key: "Backspace", keyCode: 8 });
  await ime(box, "", "deleteContentBackward");
  await ime(box, "â", "insertText");
  await ime(box, "âng", "insertText");
  expect(box.value).toBe("âng");
  expect(box.selectionStart).toBe(3);
  await ime(box, "Tieng", "insertText");
  await ime(box, "Tiếng", "insertReplacementText");
  expect(box.value).toBe("Tiếng");
  expect(box.selectionStart).toBe(5);
  expect(onPrompt).not.toHaveBeenCalled();
  expect($("bash-mode")).toBeNull();
});

it("the caret effect still places the caret after a programmatic insert once the composition ended", async () => {
  const { box, rerender } = await render();
  await compose(box, "compositionstart");
  await ime(box, "xin chào");
  await compose(box, "compositionend");
  await rerender({ insert: "@a.ts" });
  expect(box.value).toBe("xin chào @a.ts ");
  expect(box.selectionStart).toBe(box.value.length);
});

it("@ mention composed: Enter while composing picks nothing; after compositionend Enter inserts the path", async () => {
  const onPrompt = vi.fn(async () => {});
  const onSearch = vi.fn(async () => ["src/tiếng.ts"]);
  const { box } = await render({ onPrompt, onSearch });
  await act(async () => {
    setValue.call(box, "@");
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await compose(box, "compositionstart");
  await ime(box, "@tiế");
  await act(async () => {});
  await key(box, { key: "Enter", keyCode: 229, isComposing: true });
  expect(box.value).toBe("@tiế");
  expect(onPrompt).not.toHaveBeenCalled();
  await compose(box, "compositionend");
  await key(box, { key: "Enter" });
  expect(box.value).toBe("@src/tiếng.ts ");
  expect(onPrompt).not.toHaveBeenCalled();
});

it("Esc that cancels a composition does not leave shell mode", async () => {
  const { box, $ } = await render({ onBash: async () => {} });
  await key(box, { key: "!" });
  expect($("bash-mode")).not.toBeNull();
  await compose(box, "compositionstart");
  await ime(box, "ls");
  await key(box, { key: "Escape", isComposing: true });
  expect($("bash-mode")).not.toBeNull();
});

it("a composition that never ends (lost compositionend) stops blocking keys once the box loses focus", async () => {
  const onPrompt = vi.fn(async () => {});
  const { box } = await render({ onPrompt });
  await compose(box, "compositionstart");
  await ime(box, "xin");
  await key(box, { key: "Enter" });
  expect(onPrompt).not.toHaveBeenCalled();
  await act(async () => void box.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await key(box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("xin", []);
});

// The user's selection is the browser's: React fires onSelect on keyup/selectionchange, and the composer must not collapse it.
const select = (box: HTMLTextAreaElement, start: number, end: number) =>
  act(async () => {
    nativeSelect.call(box, start, end);
    box.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    document.dispatchEvent(new Event("selectionchange"));
    box.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a", ctrlKey: true }));
  });

it("Ctrl+A keeps the whole text selected instead of moving the caret to the start", async () => {
  const { box } = await render();
  box.focus();
  await ime(box, "xin chao", "insertText");
  await select(box, 0, box.value.length);
  expect([box.selectionStart, box.selectionEnd]).toEqual([0, 8]);
});

it('EVKey (select the letter, type its replacement): "Viet" + j becomes "Việt", not a doubled letter', async () => {
  const { box } = await render();
  box.focus();
  await ime(box, "Viet", "insertText");
  // EVKey sends Shift+Left over "e"... here over "et", then types "ệt" over the selection.
  await select(box, 2, 4);
  expect([box.selectionStart, box.selectionEnd]).toEqual([2, 4]);
  await ime(box, "Việt", "insertReplacementText", 4);
  expect(box.value).toBe("Việt");
  expect(box.selectionStart).toBe(4);
});
