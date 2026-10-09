// @vitest-environment jsdom
// GH-154: compact tabs (every group drawn as its chip; the chip opens a menu of its tabs) and the unread state on a chip.
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TabsBar, type TabInfo } from "./tabs-bar.tsx";
import { NEW_TAB } from "./tabs.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "/p/alpha";
const B = "/p/beta";
const T = (title: string, cwd: string, extra: Partial<TabInfo> = {}): TabInfo => ({ title, cwd, group: cwd, state: "idle", unread: false, ...extra });
const INFO: Record<string, TabInfo> = { [NEW_TAB]: { title: "New session", unread: false }, a1: T("First", A), a2: T("Second", A), b1: T("Beta one", B) };

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

const noop = { onSelect: () => {}, onClose: () => {}, onMove: () => {}, onMoveGroup: () => {}, onMoveGroupTo: () => {}, onNew: () => {}, onAction: () => {}, onRenamed: () => {} };
const mount = async (ui: React.ReactElement) => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(ui));
  return el;
};
const chips = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-testid="tab-group-chip"]')];
const chip = (el: HTMLElement, key: string) => el.querySelector<HTMLElement>(`[data-group-chip="${key}"]`)!;
const tabIds = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[data-tab-id]")].map((t) => t.dataset.tabId);
const order = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-testid="tab-group-chip"], [role="tab"]')].map((n) => n.getAttribute("data-group-chip") ?? n.closest("[data-tab-id]")?.getAttribute("data-tab-id"));
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init })));

it("a chip shows unread when nothing more urgent runs; needs input beats running beats unread", async () => {
  const info = (over: Record<string, Partial<TabInfo>>) => (id: string) => ({ ...INFO[id]!, ...over[id] });
  const view = (over: Record<string, Partial<TabInfo>>) => <TabsBar {...noop} tabs={["a1", "a2", "b1"]} activeId="b1" info={info(over)} />;
  const el = await mount(view({ a1: { unread: true } }));
  await act(async () => chip(el, A).click());
  expect(chip(el, A).querySelector('[data-dot="unread"]')).not.toBeNull();
  expect(chip(el, A).getAttribute("aria-label")).toMatch(/, unread$/);
  expect(chip(el, B).querySelector('[data-dot="unread"]')).toBeNull();
  await act(async () => root!.render(view({ a1: { unread: true }, a2: { state: "running" } })));
  expect(chip(el, A).querySelector('[data-icon="running"]')).not.toBeNull();
  expect(chip(el, A).querySelector('[data-dot="unread"]')).toBeNull();
  expect(chip(el, A).getAttribute("aria-label")).toMatch(/, running$/);
  await act(async () => root!.render(view({ a1: { state: "needs_input" }, a2: { state: "running" } })));
  expect(chip(el, A).querySelector('[data-icon="needs_input"]')).not.toBeNull();
  expect(chip(el, A).querySelector('[data-icon="running"]')).toBeNull();
});

it("compact: every group is its chip, the active tab stays after its chip, the stored collapse set is untouched", async () => {
  localStorage.setItem("claude-ui.tab-groups-collapsed", '["/p/beta"]');
  const el = await mount(<TabsBar {...noop} compact tabs={["a1", "a2", "b1"]} activeId="a2" info={(id) => INFO[id]!} />);
  expect(chips(el).map((c) => c.textContent)).toEqual(["alpha2", "beta1"]);
  expect(tabIds(el)).toEqual(["a2"]);
  expect(order(el)).toEqual([A, "a2", B]);
  expect(localStorage.getItem("claude-ui.tab-groups-collapsed")).toBe('["/p/beta"]');
  expect(chip(el, A).getAttribute("aria-haspopup")).toBe("menu");
});

it("compact: a single group still shows its chip", async () => {
  const el = await mount(<TabsBar {...noop} compact tabs={["a1", "a2"]} activeId="a1" info={(id) => INFO[id]!} />);
  expect(chips(el).map((c) => c.textContent)).toEqual(["alpha2"]);
  expect(tabIds(el)).toEqual(["a1"]);
});

it("compact: a chip click lists the group's tabs; picking one selects it and the strip follows the active tab", async () => {
  const onSelect = vi.fn();
  const view = (activeId: string) => <TabsBar {...noop} compact onSelect={onSelect} tabs={["a1", "a2", "b1"]} activeId={activeId} info={(id) => ({ ...INFO[id]!, state: id === "a2" ? "running" : "idle" })} />;
  const el = await mount(view("a1"));
  await act(async () => chip(el, A).click());
  await settle();
  expect(items().length).toBe(3); // two tabs and Close group
  expect(items()[0]!.textContent).toContain("First");
  expect(items()[0]!.getAttribute("aria-current")).toBe("true");
  expect(items()[1]!.textContent).toContain("Second");
  expect(items()[1]!.textContent).toContain("running");
  // The click opened the menu; it did not touch the collapse set.
  expect(localStorage.getItem("claude-ui.tab-groups-collapsed")).toBeNull();
  await act(async () => items()[1]!.click());
  expect(onSelect).toHaveBeenCalledWith("a2");
  await settle();
  expect(items().length).toBe(0);
  await act(async () => root!.render(view("b1")));
  expect(tabIds(el)).toEqual(["b1"]);
  expect(order(el)).toEqual([A, B, "b1"]);
});

it("compact, keyboard: ArrowDown opens the menu on its first item, Escape closes it and focus returns to the chip, Alt+Shift+Arrow still moves the group", async () => {
  const onMoveGroup = vi.fn();
  const el = await mount(<TabsBar {...noop} compact onMoveGroup={onMoveGroup} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />);
  const c = chip(el, A);
  await act(async () => c.focus());
  await key(c, "ArrowDown");
  await settle();
  expect(items().length).toBe(3); // two tabs and Close group
  expect(document.activeElement).toBe(items()[0]);
  await key(document.activeElement!, "Escape");
  await settle();
  expect(items().length).toBe(0);
  expect(document.activeElement).toBe(c);
  await key(c, "ArrowRight", { altKey: true, shiftKey: true });
  expect(onMoveGroup).toHaveBeenCalledWith(A, 1);
});

it("compact: a middle click on a menu item closes that tab and keeps the menu", async () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const el = await mount(<TabsBar {...noop} compact onClose={onClose} onSelect={onSelect} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />);
  await act(async () => chip(el, A).click());
  await settle();
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "auxclick"]) items()[1]!.dispatchEvent(new MouseEvent(type, { button: 1, bubbles: true }));
  });
  expect(onClose).toHaveBeenCalledWith("a2");
  expect(onSelect).not.toHaveBeenCalled();
  expect(items().length).toBe(3); // two tabs and Close group
});

it("compact: hovering the chip opens the menu after a short delay", async () => {
  const el = await mount(<TabsBar {...noop} compact tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />);
  const c = chip(el, A);
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
    await act(async () => void c.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, pointerType: "mouse" } as PointerEventInit)));
  }
  expect(items().length).toBe(0);
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  expect(items().length).toBe(0);
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  expect(items().length).toBe(3); // two tabs and Close group
});

it("compact: a pointer passing over the chip (gone within 50 ms) opens no menu", async () => {
  const el = await mount(<TabsBar {...noop} compact tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />);
  const c = chip(el, A);
  const fire = async (types: string[]) => {
    for (const type of types) await act(async () => void c.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, pointerType: "mouse" } as PointerEventInit)));
  };
  await fire(["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]);
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  await fire(["pointerout", "pointerleave", "mouseout", "mouseleave"]);
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  expect(items().length).toBe(0);
});

it("not compact: a chip click still collapses the group and no menu opens", async () => {
  const el = await mount(<TabsBar {...noop} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />);
  expect(chip(el, A).hasAttribute("aria-haspopup")).toBe(false);
  await act(async () => chip(el, A).click());
  await settle();
  expect(chip(el, A).getAttribute("aria-expanded")).toBe("false");
  expect(items().length).toBe(0);
});

it("a chip reflects only the hidden tabs of its group, not the visible active tab", async () => {
  const view = (compact: boolean) => <TabsBar {...noop} compact={compact} tabs={["a1", "a2", "b1"]} activeId="a1" info={(id) => ({ ...INFO[id]!, state: id === "a1" ? "running" : "idle", unread: id === "a2" })} />;
  const el = await mount(view(true));
  expect(chip(el, A).querySelector('[data-icon="running"]')).toBeNull();
  expect(chip(el, A).querySelector('[data-dot="unread"]')).not.toBeNull();
  expect(chip(el, A).getAttribute("aria-label")).toMatch(/, unread$/);
  // Expanded (not compact): every tab shows, so the chip adds nothing.
  await act(async () => root!.render(view(false)));
  expect(chip(el, A).querySelector('[data-icon="running"], [data-dot="unread"]')).toBeNull();
});

it("compact: re-rendering with equal props does not re-create the resize observer nor scroll the active tab again", async () => {
  const made = vi.fn();
  const scroll = vi.fn();
  const RO = globalThis.ResizeObserver;
  class FakeRO { constructor() { made(); } observe() {} disconnect() {} unobserve() {} }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
  const proto = Element.prototype as { scrollIntoView?: unknown };
  const had = proto.scrollIntoView;
  proto.scrollIntoView = scroll;
  try {
    const view = () => <TabsBar {...noop} compact tabs={["a1", "a2", "b1"]} activeId="a1" info={(id) => ({ ...INFO[id]! })} />;
    await mount(view());
    const m = made.mock.calls.length;
    const s = scroll.mock.calls.length;
    for (let i = 0; i < 5; i++) await act(async () => root!.render(view()));
    expect(made.mock.calls.length).toBe(m);
    expect(scroll.mock.calls.length).toBe(s);
  } finally {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO;
    proto.scrollIntoView = had;
  }
});

it("compact: dragging a chip onto another reorders the groups; the press does not leave a menu or backdrop in the way", async () => {
  const onMoveGroupTo = vi.fn();
  const el = await mount(<TabsBar {...noop} compact onMoveGroupTo={onMoveGroupTo} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />);
  const data = new Map<string, string>();
  const dt = { setData: (t: string, v: string) => void data.set(t, v), getData: (t: string) => data.get(t) ?? "", get types() { return [...data.keys()]; }, effectAllowed: "", dropEffect: "" };
  const fire = (target: Element, type: string, init: object = {}) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { dataTransfer: dt }, init);
    target.dispatchEvent(e);
  };
  const from = chip(el, B);
  await act(async () => void from.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
  await settle();
  // The press opens the menu (base-ui opens on mousedown); the drag that follows must close it.
  await act(async () => fire(from, "dragstart"));
  await settle();
  expect(items().length).toBe(0);
  expect(document.querySelectorAll('[role="presentation"]').length).toBe(0);
  await act(async () => fire(chip(el, A), "dragover"));
  await act(async () => fire(chip(el, A), "drop"));
  expect(onMoveGroupTo).toHaveBeenCalledWith(B, A);
});

it("compact: closing the last tab of a group by middle click leaves focus on a control, not on the page body", async () => {
  function Host() {
    const [tabs, setTabs] = useState(["a1", "b1"]);
    return <TabsBar {...noop} compact tabs={tabs} activeId={tabs[tabs.length - 1]} onClose={(id) => setTabs((t) => t.filter((x) => x !== id))} info={(id) => INFO[id]!} />;
  }
  const el = await mount(<Host />);
  await act(async () => chip(el, A).click());
  await settle();
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "auxclick"]) items()[0]!.dispatchEvent(new MouseEvent(type, { button: 1, bubbles: true }));
  });
  await settle();
  expect(el.querySelector('[data-group-chip="/p/alpha"]')).toBeNull();
  expect(document.activeElement).not.toBe(document.body);
});

const middle = async (target: Element) =>
  act(async () => {
    for (const type of ["mousedown", "mouseup", "auxclick"]) target.dispatchEvent(new MouseEvent(type, { button: 1, bubbles: true, cancelable: true }));
  });

it("close group: a middle click on a chip asks to close its tabs; compact does not open the menu, not compact does not collapse", async () => {
  const onCloseGroup = vi.fn();
  const el = await mount(<TabsBar {...noop} compact onCloseGroup={onCloseGroup} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />);
  await middle(chip(el, A));
  await settle();
  expect(onCloseGroup).toHaveBeenCalledWith(A, ["a1", "a2"]);
  expect(items().length).toBe(0);
  await act(async () => root!.render(<TabsBar {...noop} onCloseGroup={onCloseGroup} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />));
  await middle(chip(el, B));
  expect(onCloseGroup).toHaveBeenLastCalledWith(B, ["b1"]);
  expect(chip(el, B).getAttribute("aria-expanded")).toBe("true");
  expect(localStorage.getItem("claude-ui.tab-groups-collapsed")).toBeNull();
});

it("close group: the compact menu ends with Close group after a separator", async () => {
  const onCloseGroup = vi.fn();
  const el = await mount(<TabsBar {...noop} compact onCloseGroup={onCloseGroup} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />);
  await act(async () => chip(el, A).click());
  await settle();
  const last = items().at(-1)!;
  expect(last.textContent).toBe("Close group");
  expect(last.previousElementSibling?.getAttribute("role")).toBe("separator");
  await act(async () => last.click());
  expect(onCloseGroup).toHaveBeenCalledWith(A, ["a1", "a2"]);
});

it("close group: not compact, the chip's context menu has Collapse, Move left (off at the first group), Move right and Close group", async () => {
  const onCloseGroup = vi.fn();
  const onMoveGroup = vi.fn();
  const el = await mount(<TabsBar {...noop} onCloseGroup={onCloseGroup} onMoveGroup={onMoveGroup} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />);
  await act(async () => void chip(el, A).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await settle();
  expect(items().map((i) => i.textContent)).toEqual(["Collapse group", "Move group left", "Move group right", "Close group"]);
  expect(items()[1]!.hasAttribute("data-disabled")).toBe(true);
  await act(async () => items()[3]!.click());
  expect(onCloseGroup).toHaveBeenCalledWith(A, ["a1", "a2"]);
  await settle();
  expect(chip(el, A).getAttribute("aria-expanded")).toBe("true");
});

it("close group: Delete on a focused chip asks to close; Alt+Shift+Arrow still moves", async () => {
  const onCloseGroup = vi.fn();
  const onMoveGroup = vi.fn();
  const el = await mount(<TabsBar {...noop} onCloseGroup={onCloseGroup} onMoveGroup={onMoveGroup} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO[id]!} />);
  await act(async () => chip(el, A).focus());
  await key(chip(el, A), "Delete");
  expect(onCloseGroup).toHaveBeenCalledWith(A, ["a1", "a2"]);
  await key(chip(el, A), "ArrowRight", { altKey: true, shiftKey: true });
  expect(onMoveGroup).toHaveBeenCalledWith(A, 1);
});
