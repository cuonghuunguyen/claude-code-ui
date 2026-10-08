// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShortcutsDialog } from "./shortcuts-dialog.tsx";
import { resetAll, specOf } from "./keymap.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot>;
let el: HTMLDivElement;
const onClose = vi.fn();
beforeEach(async () => {
  localStorage.clear();
  resetAll();
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root.render(<ShortcutsDialog open onClose={onClose} />));
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
});

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = (id: string) => act(async () => void q(id)!.click());
const press = (init: KeyboardEventInit & { key: string }) => act(async () => void window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
const text = () => q("shortcuts-dialog")!.textContent ?? "";

it("lists the groups with the prompt box and fixed keys read-only", () => {
  const headings = [...document.querySelectorAll("h3")].map((h) => h.textContent);
  expect(headings).toEqual(["General", "Tabs", "Panels", "Session", "Prefix key", "In the prompt box", "Fixed"]);
  expect(q("shortcut-row-sidebar.toggle")!.textContent).toContain("Toggle sidebar");
  expect(text()).toContain("bold");
  expect(q("shortcut-row-sidebar.toggle")!.querySelector("kbd")!.textContent).toBe("CtrlB");
});

it("the filter matches a title or a key", async () => {
  const filter = q("shortcuts-filter") as HTMLInputElement;
  const type = (v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, v);
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
  await type("term");
  expect(q("shortcut-row-terminal.toggle")).not.toBeNull();
  expect(q("shortcut-row-terminal.new")).not.toBeNull();
  expect(q("shortcut-row-sidebar.toggle")).toBeNull();
  await type("alt+3");
  expect(q("shortcut-row-tab.goto3")).not.toBeNull();
  expect(q("shortcut-row-tab.goto4")).toBeNull();
});

it("recording a new combo saves the override; Reset restores the default", async () => {
  await click("shortcut-edit-sidebar.toggle");
  expect(q("shortcut-recording")).not.toBeNull();
  await press({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
  expect(q("shortcut-recording")).toBeNull();
  expect(specOf("sidebar.toggle", false)).toBe("mod+alt+b");
  expect(q("shortcut-row-sidebar.toggle")!.querySelector("kbd")!.textContent).toBe("CtrlAltB");
  await click("shortcut-reset-sidebar.toggle");
  expect(specOf("sidebar.toggle", false)).toBe("mod+b");
  expect(q("shortcut-reset-sidebar.toggle")).toBeNull();
});

it("Esc cancels the recorder without closing the dialog; Backspace removes the binding", async () => {
  await click("shortcut-edit-sidebar.toggle");
  await press({ key: "Escape" });
  expect(q("shortcut-recording")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(specOf("sidebar.toggle", false)).toBe("mod+b");
  await click("shortcut-edit-sidebar.toggle");
  await press({ key: "Backspace" });
  expect(specOf("sidebar.toggle", false)).toBeUndefined();
  expect(q("shortcut-row-sidebar.toggle")!.textContent).toContain("Not set");
});

it("a combo used elsewhere asks Replace or Cancel", async () => {
  await click("shortcut-edit-sidebar.toggle");
  await press({ key: "p", code: "KeyP", ctrlKey: true });
  expect(q("shortcut-conflict")!.textContent).toContain("Already used by Open file");
  expect(specOf("sidebar.toggle", false)).toBe("mod+b");
  await click("shortcut-cancel");
  expect(specOf("sidebar.toggle", false)).toBe("mod+b");
  await click("shortcut-edit-sidebar.toggle");
  await press({ key: "p", code: "KeyP", ctrlKey: true });
  await click("shortcut-replace");
  expect(specOf("sidebar.toggle", false)).toBe("mod+p");
  expect(specOf("file.open", false)).toBeUndefined();
});

it("a browser-reserved combo and a plain key are rejected with a message", async () => {
  await click("shortcut-edit-sidebar.toggle");
  await press({ key: "t", code: "KeyT", ctrlKey: true });
  expect(q("shortcut-error")!.textContent).toBe("The browser keeps this shortcut");
  await press({ key: "x", code: "KeyX" });
  expect(q("shortcut-error")!.textContent).toMatch(/Ctrl, Cmd or Alt/);
  expect(specOf("sidebar.toggle", false)).toBe("mod+b");
});

it("Reset all restores every default", async () => {
  await click("shortcut-edit-sidebar.toggle");
  await press({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
  await click("shortcuts-reset-all");
  expect(specOf("sidebar.toggle", false)).toBe("mod+b");
});

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

it("the filter takes focus when the dialog opens, not on every edit or reset", async () => {
  await settle();
  expect(document.activeElement).toBe(q("shortcuts-filter"));
  (q("shortcut-edit-sidebar.toggle") as HTMLElement).focus();
  await click("shortcut-edit-sidebar.toggle");
  await settle();
  expect(document.activeElement).not.toBe(q("shortcuts-filter"));
  await press({ key: "b", code: "KeyB", ctrlKey: true, altKey: true });
  await settle();
  expect(document.activeElement).not.toBe(q("shortcuts-filter"));
});


it("the filter text is cleared when the dialog closes", async () => {
  const filter = q("shortcuts-filter") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "term");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(q("shortcut-row-sidebar.toggle")).toBeNull();
  await act(async () => root.render(<ShortcutsDialog open={false} onClose={onClose} />));
  await act(async () => root.render(<ShortcutsDialog open onClose={onClose} />));
  expect((q("shortcuts-filter") as HTMLInputElement).value).toBe("");
  expect(q("shortcut-row-sidebar.toggle")).not.toBeNull();
});
