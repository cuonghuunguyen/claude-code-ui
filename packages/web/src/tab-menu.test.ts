// @vitest-environment jsdom
import type { KeyboardEvent } from "react";
import { expect, it, vi } from "vitest";
import { openContextMenuFromKey, tabMenuSections } from "./tab-menu.ts";

const all = { session: true, pinned: false as boolean | undefined, first: false, last: false, canOthers: true, canRight: true, canAll: true, canReopen: true, hasCwd: true };

it("GH-359 session tab sections: move, close block, pin, copy and reveal in order with labels", () => {
  expect(tabMenuSections(all).map((s) => s.map((x) => x.label))).toEqual([
    ["Move left", "Move right"],
    ["Close tab", "Close others", "Close to the right", "Close all", "Reopen closed tab"],
    ["Pin tab"],
    ["Copy session ID", "Copy cwd path", "Reveal in sidebar"],
  ]);
  expect(tabMenuSections({ ...all, pinned: true })[2]!.map((x) => x.label)).toEqual(["Unpin tab"]);
  expect(tabMenuSections(all)[1]![1]!.testId).toBe("tab-menu-closeOthers");
});

it("GH-359 pinning is not offered without the pinned flag", () => {
  expect(tabMenuSections({ ...all, pinned: undefined }).flat().map((x) => x.id)).not.toContain("pin");
});

it("GH-359 the New session tab has the move and close sections only", () => {
  expect(tabMenuSections({ ...all, session: false })).toHaveLength(2);
});

it("GH-359 disabled flags follow the can* and position flags", () => {
  const off = tabMenuSections({ session: true, pinned: false, first: true, last: true, canOthers: false, canRight: false, canAll: false, canReopen: false, hasCwd: false });
  expect(off.flat().filter((x) => x.disabled).map((x) => x.id)).toEqual(["moveLeft", "moveRight", "closeOthers", "closeRight", "closeAll", "reopen", "copyCwd"]);
  expect(tabMenuSections(all).flat().some((x) => x.disabled)).toBe(false);
});

it("GH-359 Shift+F10 and the ContextMenu key dispatch contextmenu at the bottom-left; F10 alone and Ctrl+Shift+F10 do not", () => {
  const el = document.createElement("button");
  el.getBoundingClientRect = () => ({ left: 10, bottom: 40 }) as DOMRect;
  const seen = vi.fn();
  el.addEventListener("contextmenu", (ev) => seen((ev as MouseEvent).clientX, (ev as MouseEvent).clientY));
  const key = (init: Partial<KeyboardEvent>) => ({ key: "", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...init }) as unknown as KeyboardEvent<HTMLElement>;
  expect(openContextMenuFromKey(key({ key: "F10", shiftKey: true }), el)).toBe(true);
  expect(openContextMenuFromKey(key({ key: "ContextMenu" }), el)).toBe(true);
  expect(seen.mock.calls).toEqual([[10, 40], [10, 40]]);
  expect(openContextMenuFromKey(key({ key: "F10" }), el)).toBe(false);
  expect(openContextMenuFromKey(key({ key: "F10", shiftKey: true, ctrlKey: true }), el)).toBe(false);
  expect(seen).toHaveBeenCalledTimes(2);
});

it("GH-356 the split section is last, disabled without a second session, and absent without the split flag or on the New session tab", () => {
  const last = (x: Parameters<typeof tabMenuSections>[0]) => tabMenuSections(x).at(-1)!;
  expect(last({ ...all, split: { can: true } }).map((x) => [x.label, x.testId, x.disabled])).toEqual([
    ["Split right", "tab-menu-splitRight", false],
    ["Split down", "tab-menu-splitDown", false],
  ]);
  expect(last({ ...all, split: { can: false } }).map((x) => x.disabled)).toEqual([true, true]);
  expect(last(all).map((x) => x.id)).toEqual(["copyId", "copyCwd", "reveal"]);
  expect(tabMenuSections({ ...all, session: false, split: { can: true } })).toHaveLength(2);
});
