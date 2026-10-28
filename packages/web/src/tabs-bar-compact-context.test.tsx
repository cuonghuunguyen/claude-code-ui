// @vitest-environment jsdom
// GH-431: compact chips on md and up: the hover/click menu lists the group's tabs only; the group actions are in the right-click context menu. Below md the tap menu keeps them.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TabsBar, type TabInfo } from "./tabs-bar.tsx";
import { NEW_TAB } from "./tabs.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "/p/alpha";
const T = (title: string, cwd: string): TabInfo => ({ title, cwd, group: cwd, state: "idle", unread: false });
const INFO: Record<string, TabInfo> = { [NEW_TAB]: { title: "New session", unread: false }, a1: T("First", A), a2: T("Second", A), b1: T("Beta one", "/p/beta") };
const noop = { onSelect: () => {}, onClose: () => {}, onMove: () => {}, onMoveGroup: () => {}, onMoveGroupTo: () => {}, onNew: () => {}, onAction: () => {}, onRenamed: () => {} };
const cleanup = (count: number) => ({ cleanupMenu: vi.fn((scope?: string[]) => ({ items: [{ rule: "idle" as const, label: "Close idle tabs", count: scope ? count : 99 }], kept: { count: 0, text: "" } })), onCleanup: vi.fn() });

let root: ReturnType<typeof createRoot> | undefined;
const realMatchMedia = window.matchMedia;
beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  window.matchMedia = realMatchMedia;
});

const mount = async (extra: Partial<React.ComponentProps<typeof TabsBar>> = {}) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<TabsBar {...noop} compact tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} onCloseOtherGroups={() => {}} {...cleanup(2)} {...extra} />));
  return el;
};
const chip = (el: HTMLElement) => el.querySelector<HTMLElement>(`[data-group-chip="${A}"]`)!;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const labels = () => [...document.querySelectorAll('[role="menuitem"]:not([data-menu-close]):not([data-menu-tab])')].map((i) => i.textContent);
const rows = () => [...document.querySelectorAll<HTMLElement>("[data-menu-tab]")].map((n) => n.dataset.menuTab);
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const rightClick = (c: Element) => act(async () => void c.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
const hover = async (c: Element) => {
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
    await act(async () => void c.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, pointerType: "mouse" } as PointerEventInit)));
  }
};

it("AC1 md and up: the compact chip's hover menu shows the header and the tab rows only", async () => {
  const el = await mount();
  await hover(chip(el));
  expect(rows()).toEqual(["a1", "a2"]);
  expect(labels()).toEqual([]);
  for (const id of ["tab-group-cleanup", "tab-group-close-others", "tab-group-close"]) expect(byId(id)).toBeNull();
  expect(byId("tab-group-menu")!.textContent).toContain("/p/alpha");
  expect(byId("tab-group-menu")!.querySelector('[role="separator"]')).toBeNull();
});

it("AC1 md and up: the click menu has no group actions either", async () => {
  const el = await mount();
  await act(async () => chip(el).click());
  await settle();
  expect(rows()).toEqual(["a1", "a2"]);
  expect(byId("tab-group-close")).toBeNull();
});

it("AC2 a right click on a compact chip opens a context menu: Move left/right, separator, Clean up, Close other groups, Close group; no Collapse/Expand", async () => {
  const el = await mount();
  await rightClick(chip(el));
  await settle();
  expect(byId("tab-group-menu")).toBeNull();
  const menu = byId("tab-group-context-menu")!;
  expect(menu).not.toBeNull();
  expect(labels()).toEqual(["Move group left", "Move group right", "Clean up group2", "Close other groups", "Close group"]);
  expect(rows()).toEqual([]);
  const sep = menu.querySelector('[role="separator"]')!;
  expect(sep.previousElementSibling?.textContent).toBe("Move group right");
  expect(sep.nextElementSibling?.getAttribute("data-testid")).toBe("tab-group-cleanup");
});

it("AC2 the context menu items keep their behaviour: move (first group: left disabled), clean up, close others, close group", async () => {
  const onMoveGroup = vi.fn();
  const onCloseGroup = vi.fn();
  const onCloseOtherGroups = vi.fn();
  const c = cleanup(2);
  const el = await mount({ onMoveGroup, onCloseGroup, onCloseOtherGroups, ...c });
  const open = async () => { await rightClick(chip(el)); await settle(); };
  await open();
  const items = () => [...document.querySelectorAll<HTMLElement>('[data-testid="tab-group-context-menu"] [role="menuitem"]')];
  expect(items()[0]!.hasAttribute("data-disabled")).toBe(true);
  await act(async () => items()[1]!.click());
  expect(onMoveGroup).toHaveBeenCalledWith(A, 1);
  await open();
  await act(async () => byId("tab-group-cleanup")!.click());
  expect(c.onCleanup).toHaveBeenCalledWith("idle", ["a1", "a2"]);
  await open();
  await act(async () => byId("tab-group-close-others")!.click());
  expect(onCloseOtherGroups).toHaveBeenCalledWith(A);
  await open();
  await act(async () => byId("tab-group-close")!.click());
  expect(onCloseGroup).toHaveBeenCalledWith(A, ["a1", "a2"]);
});

it("AC2 Clean up group is disabled with nothing to clean, Close other groups with no other group", async () => {
  const el = await mount({ tabs: ["a1", "a2"], ...cleanup(0) });
  await rightClick(chip(el));
  await settle();
  expect(byId("tab-group-cleanup")!.getAttribute("aria-disabled")).toBe("true");
  expect(byId("tab-group-close-others")!.getAttribute("aria-disabled")).toBe("true");
});

it("AC2 Shift+F10 and the ContextMenu key on a focused compact chip open the context menu", async () => {
  for (const init of [{ key: "F10", shiftKey: true }, { key: "ContextMenu" }]) {
    const el = await mount();
    await act(async () => chip(el).focus());
    await act(async () => void chip(el).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
    await settle();
    expect(byId("tab-group-context-menu")).not.toBeNull();
    expect(byId("tab-group-menu")).toBeNull();
    expect(byId("tab-group-context-menu")!.contains(document.activeElement)).toBe(true);
    await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })));
    await settle();
    expect(byId("tab-group-context-menu")).toBeNull();
    expect(document.activeElement).toBe(chip(el));
    act(() => root!.unmount());
    document.body.innerHTML = "";
  }
});

it("AC3 opening the context menu closes the hover menu, and hovering does not open it again while the context menu is open", async () => {
  const el = await mount();
  await hover(chip(el));
  expect(byId("tab-group-menu")).not.toBeNull();
  await rightClick(chip(el));
  await settle();
  expect(byId("tab-group-context-menu")).not.toBeNull();
  expect(byId("tab-group-menu")).toBeNull();
  await hover(chip(el));
  await settle();
  expect(byId("tab-group-menu")).toBeNull();
  expect(byId("tab-group-context-menu")).not.toBeNull();
});

it("AC4 below md there are no chips: the strip holding them is hidden below md (the switcher shows instead), so the chip menus have no phone variant", async () => {
  const el = await mount();
  const strip = chip(el).closest<HTMLElement>(".hidden")!;
  expect(strip.className).toContain("md:flex");
  expect(el.querySelector(".md\\:hidden")).not.toBeNull(); // the "Switch tab" switcher, shown below md only
});

it("AC5 a middle click on a compact chip still closes the group", async () => {
  const onCloseGroup = vi.fn();
  const el = await mount({ onCloseGroup });
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "auxclick"]) chip(el).dispatchEvent(new MouseEvent(type, { button: 1, bubbles: true, cancelable: true }));
  });
  expect(onCloseGroup).toHaveBeenCalledWith(A, ["a1", "a2"]);
  expect(byId("tab-group-menu")).toBeNull();
});

it("AC3 a click-opened menu closes when the context menu opens (focus goes into it), and the click menu opens again once the context menu is closed", async () => {
  const el = await mount();
  await act(async () => chip(el).click());
  await settle();
  expect(byId("tab-group-menu")).not.toBeNull();
  await rightClick(chip(el));
  await settle();
  expect(byId("tab-group-menu")).toBeNull();
  expect(byId("tab-group-context-menu")!.contains(document.activeElement)).toBe(true);
  await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })));
  await settle();
  expect(byId("tab-group-context-menu")).toBeNull();
  await act(async () => chip(el).click());
  await settle();
  expect(byId("tab-group-menu")).not.toBeNull();
  expect(rows()).toEqual(["a1", "a2"]);
});

/** A matchMedia whose md query can flip while mounted (use-narrow caches one list per query). */
const flippable = (narrow: boolean) => {
  const lists = new Map<string, object>();
  const listeners = new Set<() => void>();
  window.matchMedia = ((q: string) => {
    if (!lists.has(q)) lists.set(q, { get matches() { return narrow && q.includes("width <"); }, media: q, addEventListener: (_: string, f: () => void) => listeners.add(f), removeEventListener: (_: string, f: () => void) => listeners.delete(f) });
    return lists.get(q);
  }) as unknown as typeof window.matchMedia;
  return async (n: boolean) => { narrow = n; await act(async () => listeners.forEach((f) => f())); };
};

it("crossing md with the context menu open leaves the chip working: no remount, focus kept, the menus keep opening", async () => {
  const flip = flippable(false);
  const el = await mount();
  await act(async () => chip(el).focus());
  await rightClick(chip(el));
  await settle();
  expect(byId("tab-group-context-menu")).not.toBeNull();
  await flip(true);
  await settle();
  await flip(false);
  await settle();
  // The chip was neither remounted nor stranded: the open context menu still works and closes, then the click menu opens.
  expect(byId("tab-group-context-menu")).not.toBeNull();
  await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" })));
  await settle();
  expect(byId("tab-group-context-menu")).toBeNull();
  expect(document.activeElement).toBe(chip(el));
  await act(async () => chip(el).click());
  await settle();
  expect(byId("tab-group-menu")).not.toBeNull();
  expect(labels()).toEqual([]);
  expect(rows()).toEqual(["a1", "a2"]);
});
