// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SessionPane } from "./App.tsx";
import { emptySession } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};

const noop = () => {};
let unmount = noop;
afterEach(() => unmount());

async function render(over: Partial<ComponentProps<typeof SessionPane>> = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const props: ComponentProps<typeof SessionPane> = {
    scrollKey: 0,
    onInserted: noop,
    session: { id: "s1", cwd: "/tmp", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: ["default"] },
    view: emptySession(),
    models: [],
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
    onBash: async () => {},
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

/** Dispatches a keydown on `target`; returns true when nobody called preventDefault. */
async function key(target: HTMLElement, init: KeyboardEventInit) {
  let ok = true;
  await act(async () => void (ok = target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))));
  return ok;
}

const select = (box: HTMLTextAreaElement, a: number, b: number) => act(async () => (box.focus(), box.setSelectionRange(a, b)));

const click = (el: HTMLElement) =>
  act(async () => {
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    el.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    el.click();
  });

it("the toolbar has six labelled buttons with tooltips, one Tab stop", async () => {
  const { $ } = await render();
  const buttons = [...$("markdown-toolbar")!.querySelectorAll("button")];
  expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Bold", "Italic", "Inline code", "Code block", "Link", "Bullet list"]);
  expect(buttons[0]!.title).toContain("Ctrl+B");
  expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
  await act(async () => buttons[0]!.focus());
  await act(async () => void buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(document.activeElement).toBe(buttons[1]);
  expect(buttons.map((b) => b.tabIndex)).toEqual([-1, 0, -1, -1, -1, -1]);
});

it("clicking Bold wraps the selection, keeps focus in the box, and Enter sends the markdown", async () => {
  const onPrompt = vi.fn(async () => {});
  const { $, box } = await render({ onPrompt });
  await type(box, "hi");
  await select(box, 0, 2);
  await click($("format-bold")!);
  expect(box.value).toBe("**hi**");
  expect(document.activeElement).toBe(box);
  await key(box, { key: "Enter" });
  expect(onPrompt).toHaveBeenCalledWith("**hi**", []);
});

it("Ctrl+B / Ctrl+I / Ctrl+E format the selection and are default-prevented, so the window sidebar shortcut does not run", async () => {
  const seen: boolean[] = [];
  const spy = (e: KeyboardEvent) => void seen.push(e.defaultPrevented);
  window.addEventListener("keydown", spy);
  try {
    for (const [k, out] of [["b", "**hi**"], ["i", "*hi*"], ["e", "`hi`"]] as const) {
      const { box } = await render();
      await type(box, "hi");
      await select(box, 0, 2);
      expect(await key(box, { key: k, ctrlKey: true })).toBe(false);
      expect(box.value).toBe(out);
      unmount();
    }
    expect(seen).toEqual([true, true, true]);
  } finally {
    window.removeEventListener("keydown", spy);
  }
});

it("Ctrl+B with focus outside the prompt box reaches the window shortcut handler untouched", async () => {
  const { $ } = await render();
  expect(await key($("format-bold")!, { key: "b", ctrlKey: true })).toBe(true);
});

it("Ctrl+Shift+B and Ctrl+B while composing are not formatting", async () => {
  const { box } = await render();
  await type(box, "hi");
  await select(box, 0, 2);
  expect(await key(box, { key: "B", ctrlKey: true, shiftKey: true })).toBe(true);
  expect(await key(box, { key: "b", ctrlKey: true, isComposing: true })).toBe(true);
  expect(box.value).toBe("hi");
});

it("execCommand insertText is used when the browser has it", async () => {
  const { $, box } = await render();
  await type(box, "hi");
  await select(box, 0, 2);
  const exec = vi.fn((_cmd: string, _ui: boolean, s: string) => {
    box.setRangeText(s, box.selectionStart, box.selectionEnd, "end");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  (document as { execCommand: unknown }).execCommand = exec;
  try {
    await click($("format-bold")!);
  } finally {
    delete (document as { execCommand?: unknown }).execCommand;
  }
  expect(exec).toHaveBeenCalledWith("insertText", false, "**hi**");
  expect(box.value).toBe("**hi**");
  expect([box.selectionStart, box.selectionEnd]).toEqual([2, 4]);
});

it("bash mode hides the toolbar and Ctrl+B does not format there; / still opens the picker afterwards", async () => {
  const { $, box, rerender } = await render();
  await rerender({ view: { ...emptySession(), commands: [{ name: "review", description: "", argumentHint: "" }] } });
  expect($("markdown-toolbar")).not.toBeNull();
  await key(box, { key: "!" });
  expect($("markdown-toolbar")).toBeNull();
  expect($("bash-mode")).not.toBeNull();
  expect(await key(box, { key: "b", ctrlKey: true })).toBe(true);
  await key(box, { key: "Escape" });
  expect($("markdown-toolbar")).not.toBeNull();
  await type(box, "/re");
  expect(box.getAttribute("aria-expanded")).toBe("true");
});
