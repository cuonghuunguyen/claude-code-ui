// @vitest-environment jsdom
// GH-135: the tab grouping setting in the tab strip (project / worktree / none).
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TabsBar, useGroupedTabs, type TabInfo } from "./tabs-bar.tsx";
import { NEW_TAB } from "./tabs.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: Record<string, TabInfo> = {
  a: { title: "Fix login", cwd: "/home/u/web", state: "running", unread: false },
  b: { title: "Docs", cwd: "/home/u/docs", state: "needs_input", unread: true },
  c: { title: "Refactor", cwd: "/home/u/api", state: "idle", unread: true },
  d: { title: "Old", cwd: "/home/u/api", state: "closed", unread: false },
  [NEW_TAB]: { title: "New session", unread: false },
};
const W1: TabInfo = { title: "Registry", cwd: "/r/acme/.claude/worktrees/a", group: "/r/acme/.claude/worktrees/a", groupLabel: "a", groupSub: "acme · ACME-397-registry-adapt", groupColor: "/r/acme", state: "idle", unread: false };
const W2: TabInfo = { ...W1, title: "Adapter", cwd: "/r/acme/.claude/worktrees/b", group: "/r/acme/.claude/worktrees/b", groupLabel: "b", groupSub: "acme · ACME-400" };
const WINFO: Record<string, TabInfo> = { w1: W1, w2: W2, a: { ...INFO.a!, group: "/home/u/web" }, [NEW_TAB]: { title: "New session", unread: false } };

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

it("by worktree: chips show the worktree name in the project color; details are in a tooltip, not a title", async () => {
  const el = await mount(<TabsBar {...noop} tabs={["w1", "w2", "a"]} activeId="a" info={(id) => WINFO[id]!} grouping="worktree" />);
  const c = chips(el);
  expect(c.length).toBe(3);
  expect(c.map((x) => x.textContent)).toEqual(["a1", "b1", "web1"]);
  expect(c[0]!.style.getPropertyValue("--av")).toBe(c[1]!.style.getPropertyValue("--av"));
  expect(c[0]!.getAttribute("aria-label")).toMatch(/^a \(acme · ACME-397-registry-adapt\), 1 tab/);
  expect(document.getElementById(c[0]!.getAttribute("aria-describedby")!)?.textContent).toBe("/r/acme/.claude/worktrees/a");
  for (const x of c) expect(x.hasAttribute("title")).toBe(false);
  // Keyboard focus opens the tooltip with "project · branch" and the path.
  await act(async () => c[0]!.focus());
  await act(async () => void new Promise((r) => setTimeout(r, 50)));
  const tip = document.querySelector('[data-slot="tooltip-content"]');
  expect(tip?.textContent).toContain("acme · ACME-397-registry-adapt");
  expect(tip?.textContent).toContain("/r/acme/.claude/worktrees/a");
});

it("hovering a chip opens the tooltip too", async () => {
  const el = await mount(<TabsBar {...noop} tabs={["w1", "a"]} activeId="a" info={(id) => WINFO[id]!} grouping="worktree" />);
  const c = chips(el)[0]!;
  for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
    await act(async () => void c.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, pointerType: "mouse" } as PointerEventInit)));
  }
  await act(async () => void new Promise((r) => setTimeout(r, 100)));
  expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain("acme · ACME-397-registry-adapt");
});

it("by project: the chip tooltip shows the project name and path", async () => {
  const el = await mount(<TabsBar {...noop} tabs={["a", "b"]} activeId="a" info={(id) => ({ ...INFO[id]!, group: INFO[id]!.cwd })} />);
  const c = chip(el, "/home/u/docs");
  expect(c.hasAttribute("title")).toBe(false);
  expect(c.getAttribute("aria-label")).toMatch(/^docs, 1 tab/);
  expect(document.getElementById(c.getAttribute("aria-describedby")!)?.textContent).toBe("/home/u/docs");
  await act(async () => c.focus());
  await act(async () => void new Promise((r) => setTimeout(r, 50)));
  const tip = document.querySelector('[data-slot="tooltip-content"]');
  expect(tip?.textContent).toContain("docs");
  expect(tip?.textContent).toContain("/home/u/docs");
});

it("no grouping: no chips, every tab shows its avatar, and tabs move across projects", async () => {
  localStorage.setItem("claude-ui.tab-groups-collapsed", '["/home/u/api"]');
  const onMove = vi.fn();
  const el = await mount(<TabsBar {...noop} onMove={onMove} tabs={["a", "b", "c", "d"]} activeId="c" info={(id) => ({ ...INFO[id]!, group: "" })} grouping="none" />);
  const tab = (id: string) => el.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
  expect(chips(el).length).toBe(0);
  expect(tab("c")).not.toBeNull();
  expect(tab("d")).not.toBeNull();
  expect(tab("d").textContent).toMatch(/^AOld/);
  await act(async () => void tab("a").querySelector('[role="tab"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, shiftKey: true, bubbles: true })));
  expect(onMove).toHaveBeenCalledWith("a", "b");
  expect(tab("b").hasAttribute("data-first")).toBe(false);
});

it("switching the grouping regroups the open tabs at once and keeps every tab and the active one", async () => {
  type Mode = "project" | "worktree" | "none";
  const keyFn = (mode: Mode) => (id: string) => (mode === "none" ? "" : mode === "project" ? (id === "a" ? "/home/u/web" : "/r/acme") : WINFO[id]!.group);
  function Host() {
    const [mode, setMode] = useState<Mode>("project");
    const [tabs, setTabs] = useState(["w1", "a", "w2"]);
    useGroupedTabs(tabs, setTabs, keyFn(mode));
    return (
      <>
        <button data-testid="flip" onClick={() => setMode((m) => (m === "project" ? "worktree" : m === "worktree" ? "none" : "project"))} />
        <TabsBar {...noop} tabs={tabs} activeId="w2" grouping={mode} info={(id) => ({ ...WINFO[id]!, group: keyFn(mode)(id), groupSub: undefined, groupLabel: id === "a" ? "web" : "acme" })} />
      </>
    );
  }
  const el = await mount(<Host />);
  const ids = () => [...el.querySelectorAll<HTMLElement>("[data-tab-id]")].map((t) => t.dataset.tabId);
  const check = () => {
    expect([...ids()].sort()).toEqual(["a", "w1", "w2"]);
    expect(el.querySelector('[data-tab-id="w2"] [role="tab"]')!.getAttribute("aria-selected")).toBe("true");
  };
  expect(ids()).toEqual(["w1", "w2", "a"]);
  expect(chips(el).map((c) => c.textContent)).toEqual(["acme2", "web1"]);
  check();
  await act(async () => el.querySelector<HTMLElement>('[data-testid="flip"]')!.click());
  expect(chips(el).length).toBe(3);
  check();
  await act(async () => el.querySelector<HTMLElement>('[data-testid="flip"]')!.click());
  expect(chips(el).length).toBe(0);
  check();
});

it("collapsed state follows the grouping mode", async () => {
  const Host = ({ grouping }: { grouping: "project" | "worktree" }) => (
    <TabsBar {...noop} tabs={["w1", "w2", "a"]} activeId="a" grouping={grouping} info={(id) => (grouping === "project" && id !== "a" ? { ...WINFO[id]!, group: "/r/acme", groupSub: undefined } : WINFO[id]!)} />
  );
  const el = await mount(<Host grouping="project" />);
  const show = (g: "project" | "worktree") => act(async () => root!.render(<Host grouping={g} />));
  const expanded = () => chips(el).map((c) => c.getAttribute("aria-expanded"));
  await act(async () => chip(el, "/r/acme").click());
  expect(expanded()).toEqual(["false", "true"]);
  await show("worktree");
  expect(expanded()).toEqual(["true", "true", "true"]);
  await show("project");
  expect(expanded()).toEqual(["false", "true"]);
  expect(localStorage.getItem("claude-ui.tab-groups-collapsed.worktree")).toBeNull();
});

// GH-277: close one session from the group chip menu (compact dropdown and chip context menu).
const TI = (title: string, cwd: string): TabInfo => ({ title, cwd, group: cwd, state: "idle", unread: false });
const INFO2: Record<string, TabInfo> = { [NEW_TAB]: { title: "New session", unread: false }, a1: TI("First", "/p/alpha"), a2: TI("Second", "/p/alpha"), a3: TI("Third", "/p/alpha"), b1: TI("Other", "/p/beta") };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const closers = () => [...document.querySelectorAll<HTMLElement>("[data-menu-close]")];
const menu = () => document.querySelector('[data-testid="tab-group-menu"]');
const keydown = (el: Element, k: string) => act(async () => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
const A = "/p/alpha";
function CloseHost({ onClose = () => {}, onSelect = () => {}, onCloseGroup = () => {} }: { onClose?: (id: string) => void; onSelect?: (id: string) => void; onCloseGroup?: (k: string, ids: string[]) => void }) {
  const [tabs, setTabs] = useState(["a1", "a2", "a3", "b1"]);
  return <TabsBar {...noop} compact tabs={tabs} activeId="b1" info={(id) => INFO2[id]!} onSelect={onSelect} onCloseGroup={onCloseGroup} onClose={(id) => { onClose(id); setTabs((t) => t.filter((x) => x !== id)); }} />;
}

it("GH-277 compact: each group menu row has a visible close item labelled Close <title>", async () => {
  const el = await mount(<TabsBar {...noop} compact tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO2[id]!} />);
  await act(async () => chip(el, A).click());
  await settle();
  expect(closers().map((c) => c.getAttribute("aria-label"))).toEqual(["Close First", "Close Second"]);
  for (const c of closers()) {
    expect(c.getAttribute("role")).toBe("menuitem");
    expect(c.querySelector("svg")).not.toBeNull();
    expect(c.hasAttribute("hidden")).toBe(false);
    expect(c.getAttribute("aria-hidden")).toBeNull();
    expect(c.className).toContain("pointer-coarse:w-11");
    expect(c.className).toContain("pointer-coarse:h-11");
  }
});

it("GH-277 compact: clicking a row's close item calls onClose with that id only, not Close group, and keeps the menu open", async () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const onCloseGroup = vi.fn();
  const el = await mount(<TabsBar {...noop} compact tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO2[id]!} onClose={onClose} onSelect={onSelect} onCloseGroup={onCloseGroup} />);
  await act(async () => chip(el, A).click());
  await settle();
  await act(async () => closers()[1]!.click());
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledWith("a2");
  expect(onSelect).not.toHaveBeenCalled();
  expect(onCloseGroup).not.toHaveBeenCalled();
  expect(menu()).not.toBeNull();
});

it("GH-277 compact: closing one row updates the menu and the chip count drops by one", async () => {
  const el = await mount(<CloseHost />);
  expect(chip(el, A).textContent).toMatch(/3$/);
  await act(async () => chip(el, A).click());
  await settle();
  await act(async () => closers()[0]!.click());
  await settle();
  expect(menu()).not.toBeNull();
  expect([...document.querySelectorAll<HTMLElement>("[data-menu-tab]")].map((n) => n.dataset.menuTab)).toEqual(["a2", "a3"]);
  expect(chip(el, A).textContent).toMatch(/2$/);
  expect(chip(el, A).getAttribute("aria-label")).toMatch(/, 2 tabs/);
});

it("GH-277 compact, keyboard: ArrowDown reaches the close item, Enter closes that tab, focus moves to the next row's close item", async () => {
  const el = await mount(<CloseHost />);
  await act(async () => chip(el, A).focus());
  await keydown(chip(el, A), "ArrowDown");
  await settle();
  expect((document.activeElement as HTMLElement).dataset.menuTab).toBe("a1");
  await keydown(document.activeElement!, "ArrowDown");
  expect(document.activeElement).toBe(closers()[0]);
  await keydown(document.activeElement!, "Enter");
  await settle();
  expect([...document.querySelectorAll<HTMLElement>("[data-menu-tab]")].map((n) => n.dataset.menuTab)).toEqual(["a2", "a3"]);
  expect((document.activeElement as HTMLElement).dataset.menuClose).toBe("a2");
  // Navigation continues from the refocused item.
  await keydown(document.activeElement!, "ArrowDown");
  expect((document.activeElement as HTMLElement).dataset.menuTab).toBe("a3");
  await keydown(document.activeElement!, "ArrowUp");
  expect((document.activeElement as HTMLElement).dataset.menuClose).toBe("a2");
  // Space closes too.
  await keydown(document.activeElement!, " ");
  await settle();
  expect([...document.querySelectorAll<HTMLElement>("[data-menu-tab]")].map((n) => n.dataset.menuTab)).toEqual(["a3"]);
  expect(document.activeElement).not.toBe(document.body);
});

it("GH-277 compact: closing the last tab of a group with its close item leaves focus on a control", async () => {
  function Host() {
    const [tabs, setTabs] = useState(["a1", "b1"]);
    return <TabsBar {...noop} compact tabs={tabs} activeId={tabs[tabs.length - 1]} onClose={(id) => setTabs((t) => t.filter((x) => x !== id))} info={(id) => INFO2[id]!} />;
  }
  const el = await mount(<Host />);
  await act(async () => chip(el, A).click());
  await settle();
  await act(async () => closers()[0]!.click());
  await settle();
  expect(chip(el, A)).toBeNull();
  expect(document.activeElement).not.toBe(document.body);
});

it("GH-277 Close group still closes the whole group", async () => {
  const onClose = vi.fn();
  const onCloseGroup = vi.fn();
  const el = await mount(<TabsBar {...noop} compact tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO2[id]!} onClose={onClose} onCloseGroup={onCloseGroup} />);
  await act(async () => void chip(el, A).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await settle();
  await act(async () => document.querySelector<HTMLElement>('[data-testid="tab-group-close"]')!.click());
  expect(onCloseGroup).toHaveBeenCalledWith(A, ["a1", "a2"]);
  expect(onClose).not.toHaveBeenCalled();
});

it("GH-277 not compact: the chip context menu lists the group's tabs with close items; closing one keeps the menu open", async () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const el = await mount(<TabsBar {...noop} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO2[id]!} onClose={onClose} onSelect={onSelect} />);
  const ctx = () => act(async () => void chip(el, A).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await ctx();
  await settle();
  expect(closers().map((c) => c.getAttribute("aria-label"))).toEqual(["Close First", "Close Second"]);
  await act(async () => document.querySelector<HTMLElement>('[data-menu-tab="a1"]')!.click());
  expect(onSelect).toHaveBeenCalledWith("a1");
  await ctx();
  await settle();
  await act(async () => closers()[0]!.click());
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onClose).toHaveBeenCalledWith("a1");
  expect(menu()).not.toBeNull();
});

it("GH-277 not compact: a collapsed group's context menu still lists its tabs", async () => {
  const el = await mount(<TabsBar {...noop} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO2[id]!} />);
  await act(async () => chip(el, A).click());
  await act(async () => void chip(el, A).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await settle();
  expect(closers().length).toBe(2);
});

// GH-359: Close other groups in the chip menus.
it("GH-359 not compact: the chip context menu has Close other groups before Close group and calls onCloseOtherGroups(key)", async () => {
  const onCloseOtherGroups = vi.fn();
  const el = await mount(<TabsBar {...noop} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO2[id]!} onCloseOtherGroups={onCloseOtherGroups} />);
  await act(async () => void chip(el, A).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await settle();
  const labels = [...document.querySelectorAll('[data-testid="tab-group-menu"] [role="menuitem"]')].map((i) => i.textContent);
  expect(labels.slice(-2)).toEqual(["Close other groups", "Close group"]);
  await act(async () => document.querySelector<HTMLElement>('[data-testid="tab-group-close-others"]')!.click());
  expect(onCloseOtherGroups).toHaveBeenCalledWith(A);
});

it("GH-359 compact: the chip menu has Close other groups", async () => {
  const onCloseOtherGroups = vi.fn();
  const el = await mount(<TabsBar {...noop} compact tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO2[id]!} onCloseOtherGroups={onCloseOtherGroups} />);
  await act(async () => void chip(el, A).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await settle();
  await act(async () => document.querySelector<HTMLElement>('[data-testid="tab-group-close-others"]')!.click());
  expect(onCloseOtherGroups).toHaveBeenCalledWith(A);
});

it("GH-359 Close other groups is disabled when there is no other group", async () => {
  const el = await mount(<TabsBar {...noop} compact tabs={["a1", "a2"]} activeId="a1" info={(id) => INFO2[id]!} onCloseOtherGroups={() => {}} />);
  await act(async () => void chip(el, A).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await settle();
  expect(document.querySelector('[data-testid="tab-group-close-others"]')!.getAttribute("aria-disabled")).toBe("true");
});

it("GH-359 Shift+F10 on a focused chip opens its context menu", async () => {
  const el = await mount(<TabsBar {...noop} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO2[id]!} />);
  chip(el, A).focus();
  await act(async () => void chip(el, A).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "F10", shiftKey: true })));
  await settle();
  expect(menu()).not.toBeNull();
});

// GH-378: Clean up group in the chip menus.
const cleanupFor = (count: number) => ({ cleanupMenu: vi.fn((scope?: string[]) => ({ items: [{ rule: "idle" as const, label: "Close idle tabs", count: scope ? count : 99 }], kept: { count: 0, text: "" } })), onCleanup: vi.fn() });

it("GH-378 not compact: the chip context menu has Clean up group before Close other groups and calls onCleanup('idle', group ids)", async () => {
  const c = cleanupFor(2);
  const el = await mount(<TabsBar {...noop} tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO2[id]!} onCloseOtherGroups={() => {}} {...c} />);
  await act(async () => void chip(el, A).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await settle();
  const labels = [...document.querySelectorAll('[data-testid="tab-group-menu"] [role="menuitem"]')].map((i) => i.textContent);
  expect(labels.slice(-3)).toEqual(["Clean up group2", "Close other groups", "Close group"]);
  await act(async () => document.querySelector<HTMLElement>('[data-testid="tab-group-cleanup"]')!.click());
  expect(c.onCleanup).toHaveBeenCalledWith("idle", ["a1", "a2"]);
});

it("GH-378 compact: the chip menu has Clean up group; disabled when the group has nothing to clean", async () => {
  const c = cleanupFor(0);
  const el = await mount(<TabsBar {...noop} compact tabs={["a1", "a2", "b1"]} activeId="b1" info={(id) => INFO2[id]!} {...c} />);
  await act(async () => void chip(el, A).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await settle();
  const item = document.querySelector<HTMLElement>('[data-testid="tab-group-cleanup"]')!;
  expect(item.getAttribute("aria-disabled")).toBe("true");
  await act(async () => item.click());
  expect(c.onCleanup).not.toHaveBeenCalled();
});
