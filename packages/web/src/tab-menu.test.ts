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

it("GH-401 a session tab with dock offers Move to side / bottom panel after the pin; without dock none; pane and file tabs are unchanged", () => {
  const docked = tabMenuSections({ ...all, dock: true });
  expect(docked.map((s) => s.map((x) => x.label))).toEqual([
    ["Move left", "Move right"],
    ["Close tab", "Close others", "Close to the right", "Close all", "Reopen closed tab"],
    ["Pin tab"],
    ["Move to side panel", "Move to bottom panel"],
    ["Copy session ID", "Copy cwd path", "Reveal in sidebar"],
  ]);
  expect(docked[3]!.map((x) => x.id)).toEqual(["moveSide", "moveBottom"]);
  expect(tabMenuSections(all).flat().map((x) => x.id)).not.toContain("moveSide");
  expect(tabMenuSections({ ...all, session: false, dock: true })).toHaveLength(2);
  const pane = { ...all, pane: { label: "Plan" } };
  expect(tabMenuSections({ ...pane, dock: true })).toEqual(tabMenuSections(pane));
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

it("GH-395 a pane tab menu has move, close, pin, Move Plan to side/bottom panel, Go to session and split items that follow split.can, no copy/reveal", () => {
  const sections = tabMenuSections({ ...all, pane: { label: "Plan" }, split: { can: true } });
  expect(sections.map((x) => x.map((e) => e.label))).toEqual([
    ["Move left", "Move right"],
    ["Close tab", "Close others", "Close to the right", "Close all", "Reopen closed tab"],
    ["Pin tab"],
    ["Move Plan to side panel", "Move Plan to bottom panel"],
    ["Go to session"],
    ["Split right", "Split down"],
  ]);
  const flat = sections.flat();
  expect(flat.map((e) => e.id)).not.toContain("copyId");
  expect(flat.map((e) => e.id)).not.toContain("reveal");
  expect(flat.filter((e) => e.disabled)).toEqual([]);
  const off = tabMenuSections({ ...all, pane: { label: "Plan" }, split: { can: false } }).flat();
  expect(off.filter((e) => e.disabled).map((e) => e.id)).toEqual(["splitRight", "splitDown"]);
  expect(flat.find((e) => e.id === "moveSide")!.testId).toBe("tab-menu-moveSide");
  expect(flat.find((e) => e.id === "goToSession")!.testId).toBe("tab-menu-goToSession");
});

it("GH-396 a Git graph tab menu says Move Git graph to side / bottom panel and has Split right, Split down and the reason disabled", () => {
  const sections = tabMenuSections({ ...all, pane: { label: "Git graph" }, split: { can: false, whole: true } });
  const flat = sections.flat();
  expect(flat.map((e) => e.label)).toContain("Move Git graph to side panel");
  expect(flat.map((e) => e.label)).toContain("Move Git graph to bottom panel");
  expect(sections.at(-1)!.map((e) => e.id)).toEqual(["splitRight", "splitDown", "splitNote"]);
  expect(sections.at(-1)!.every((e) => e.disabled)).toBe(true);
  const note = flat.find((e) => e.id === "splitNote")!;
  expect(note.label).toBe("Git graph needs the whole area");
  expect(note.testId).toBe("tab-menu-splitNote");
});

it("GH-399 an item tab: no move to a dock, Move to Files, copy paths and Reveal in Files, then Go to session and split", () => {
  const sections = tabMenuSections({ ...all, pinned: undefined, pane: { label: "File", item: "file" }, split: { can: true } });
  expect(sections.map((s) => s.map((x) => x.id))).toEqual([
    ["moveLeft", "moveRight"],
    ["close", "closeOthers", "closeRight", "closeAll", "reopen"],
    ["moveToFiles", "copyPath", "copyRel", "revealInFiles"],
    ["goToSession"],
    ["splitRight", "splitDown"],
  ]);
  const flat = sections.flat();
  expect(flat.find((e) => e.id === "moveToFiles")!.label).toBe("Move to Files");
  expect(flat.map((e) => e.id)).not.toContain("moveSide");
  expect(tabMenuSections({ ...all, pane: { label: "File", item: "file" }, split: { can: true } })[2]!.map((e) => e.id)).toEqual(["pin"]);
});

it("GH-400 an artifact tab: no dock moves, no file entries; Go to session and split stay", () => {
  const sections = tabMenuSections({ ...all, pinned: undefined, pane: { label: "Artifact", item: "artifact" }, split: { can: true } });
  const ids = sections.flat().map((e) => e.id);
  for (const gone of ["moveSide", "moveBottom", "moveToFiles", "copyPath", "copyRel", "revealInFiles"]) expect(ids).not.toContain(gone);
  expect(ids).toEqual(expect.arrayContaining(["goToSession", "splitRight", "splitDown", "close"]));
});
