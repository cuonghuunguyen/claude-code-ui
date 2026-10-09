// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TabsBar, useGroupedTabs, type TabInfo } from "./tabs-bar.tsx";
import { NEW_TAB, closeTab, moveTab } from "./tabs.ts";
import { SideLabel } from "./sides.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// One context menu per rendered tab: counts the tabs' renders.
const tabRenders = vi.hoisted(() => ({ n: 0 }));
vi.mock("@base-ui/react/context-menu", async (orig) => {
  const m = await orig<typeof import("@base-ui/react/context-menu")>();
  const Root = (p: Parameters<typeof m.ContextMenu.Root>[0]) => (tabRenders.n++, <m.ContextMenu.Root {...p} />);
  return { ...m, ContextMenu: { ...m.ContextMenu, Root } };
});

const INFO: Record<string, TabInfo> = {
  a: { title: "Fix login", cwd: "/home/u/web", state: "running", unread: false },
  b: { title: "Docs", cwd: "/home/u/docs", state: "needs_input", unread: true },
  c: { title: "Refactor", cwd: "/home/u/api", state: "idle", unread: true },
  d: { title: "Old", cwd: "/home/u/api", state: "closed", unread: false },
  [NEW_TAB]: { title: "New session", unread: false },
};

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => root?.unmount());

async function render(props: Partial<Parameters<typeof TabsBar>[0]> = {}, side: (cwd: string) => { label: string; short: string } | undefined = () => undefined) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const handlers = { onSelect: vi.fn(), onClose: vi.fn(), onSwipeClose: vi.fn(), onMove: vi.fn(), onMoveGroup: vi.fn(), onMoveGroupTo: vi.fn(), onNew: vi.fn(), onAction: vi.fn(), onRenamed: vi.fn() };
  await act(async () => root!.render(<SideLabel value={side}><TabsBar tabs={["a", "b", "c", "d", NEW_TAB]} activeId="c" info={(id) => INFO[id]!} {...handlers} {...props} /></SideLabel>));
  const tab = (id: string) => el.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
  return { el, tab, ...handlers, ...props };
}

it("a worktree session tab's tooltip names '<project> · <branch>' between title and path", async () => {
  const { tab } = await render({ info: (id) => (id === "a" ? { ...INFO.a!, cwd: "/home/u/web-wt", worktree: "web · feature-x" } : INFO[id]!) });
  expect(tab("a").title).toBe("Fix login (running)\nweb · feature-x\n/home/u/web-wt");
  expect(tab("b").title).not.toContain("·");
});

it("each tab shows avatar initial and title; the active one is selected", async () => {
  const { tab } = await render();
  expect(tab("c").textContent).toContain("Refactor");
  expect(tab("c").querySelector('[role="tab"]')!.getAttribute("aria-selected")).toBe("true");
  expect(tab("a").querySelector('[role="tab"]')!.getAttribute("aria-selected")).toBe("false");
  expect(tab("d").textContent).toMatch(/^AOld/);
  expect(tab(NEW_TAB).textContent).toContain("New session");
});

it("tab shows running / needs-input / unread state", async () => {
  const { tab } = await render();
  expect(tab("a").dataset.state).toBe("running");
  expect(tab("b").dataset.state).toBe("needs_input");
  expect(tab("c").dataset.state).toBe("unread");
  expect(tab("d").dataset.state).toBe("idle");
  expect(tab(NEW_TAB).dataset.state).toBe("new");
  expect(tab("b").querySelector('[role="tab"]')!.getAttribute("aria-label")).toBe("Docs, needs input");
  expect(tab("c").querySelector('[role="tab"]')!.getAttribute("aria-label")).toBe("Refactor, unread");
});

it("needs input and unread differ by shape, not only by colour", async () => {
  const { tab } = await render();
  // Needs input: an alert icon in place of the avatar. Unread: a dot on the avatar.
  expect(tab("b").querySelector(".lucide-circle-alert")).not.toBeNull();
  expect(tab("b").querySelector('[data-dot]')).toBeNull();
  expect(tab("c").querySelector(".lucide-circle-alert")).toBeNull();
  expect(tab("c").querySelector('[data-dot="unread"]')).not.toBeNull();
  expect(tab("b").title).toContain("needs input");
});

it("click selects; the close button and a middle click close the tab without selecting it", async () => {
  const { tab, onSelect, onClose } = await render();
  await act(async () => tab("a").querySelector<HTMLElement>('[role="tab"]')!.click());
  expect(onSelect).toHaveBeenCalledWith("a");
  await act(async () => tab("b").querySelector<HTMLElement>('[data-testid="tab-close"]')!.click());
  expect(onClose).toHaveBeenCalledWith("b");
  await act(async () => void tab("d").dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true })));
  expect(onClose).toHaveBeenCalledWith("d");
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("dropping a dragged tab on another moves it there", async () => {
  const { tab, onMove } = await render();
  const data = new Map<string, string>();
  const dataTransfer = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", types: [] as string[] };
  const fire = (el: HTMLElement, type: string) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { dataTransfer });
    el.dispatchEvent(e);
  };
  await act(async () => fire(tab("a"), "dragstart"));
  await act(async () => fire(tab("c"), "drop"));
  expect(onMove).toHaveBeenCalledWith("a", "c");
});

it("+ opens a new-session tab; the narrow switcher lists the tabs with their state and selects one", async () => {
  const { el, onNew, onSelect } = await render();
  await act(async () => el.querySelector<HTMLElement>('[data-testid="tab-new"]')!.click());
  expect(onNew).toHaveBeenCalled();
  const sw = el.querySelector<HTMLElement>('[data-testid="tab-switcher"]')!;
  expect(sw.getAttribute("aria-label")).toBe("Switch tab");
  await act(async () => sw.click());
  const options = [...document.querySelectorAll<HTMLElement>("[role=option]")];
  expect(options.map((o) => o.textContent)).toEqual(["Fix loginwebrunning", "Docsdocsneeds input", "ARefactorapiunread", "AOldapiclosed", "New session"]);
  expect(options[2]!.getAttribute("aria-selected")).toBe("true");
  await act(async () => options[1]!.click());
  expect(onSelect).toHaveBeenCalledWith("b");
});

it("phone: the switcher shows '<project or project · branch> · <side>' under the title, in the trigger and the rows (GH-165)", async () => {
  const lookup = (cwd: string) => (cwd.startsWith("/home/u/web") ? { label: "WSL: Ubuntu", short: "WSL" } : undefined);
  const info = (id: string) => (id === "a" ? { ...INFO.a!, cwd: "/home/u/web-wt", worktree: "web · feature-x" } : INFO[id]!);
  const { el } = await render({ info, activeId: "a" }, lookup);
  const sw = el.querySelector<HTMLElement>('[data-testid="tab-switcher"]')!;
  expect(sw.querySelector('[data-slot="tab-switcher-place"]')!.textContent).toBe("web · feature-x · WSL: Ubuntu");
  await act(async () => sw.click());
  const rows = [...document.querySelectorAll<HTMLElement>("[role=option]")];
  expect(rows[0]!.textContent).toBe("Fix loginweb · feature-x · WSL: Ubunturunning");
  // One side: no side label; a project without a worktree shows its name; the new-session tab has no line.
  expect(rows[1]!.textContent).toBe("Docsdocsneeds input");
  expect(rows[4]!.textContent).toBe("New session");
});

it("phone: error and closed sessions say so in the switcher (their header chip is gone below sm) (GH-165)", async () => {
  const { el } = await render({ info: (id) => (id === "c" ? { ...INFO.c!, state: "error" } : INFO[id]!) });
  await act(async () => el.querySelector<HTMLElement>('[data-testid="tab-switcher"]')!.click());
  const rows = [...document.querySelectorAll<HTMLElement>("[role=option]")];
  expect(rows[2]!.textContent).toContain("error");
  expect(rows[3]!.textContent).toContain("closed");
  expect(rows[0]!.textContent).not.toMatch(/error|closed/);
});

it("below md the titlebar controls have a 44px hit area and 8px gaps (touch-target-size, touch-spacing)", async () => {
  const { el } = await render();
  for (const id of ["tab-new", "tab-close-active"]) expect(el.querySelector(`[data-testid="${id}"]`)!.className).toMatch(/\bmax-md:size-11\b/);
  expect(el.querySelector('[data-testid="tab-switcher"]')!.className).toMatch(/\bmax-md:h-11!/);
  expect(el.firstElementChild!.className).toMatch(/\bmax-md:gap-2\b/);
});

it("phone: the switcher shows the active session's name and the tab count", async () => {
  const { el } = await render();
  const sw = el.querySelector('[data-testid="tab-switcher"]')!;
  expect(sw.querySelector(".truncate")!.textContent).toBe("Refactor");
  expect(sw.querySelector(".ml-auto")!.textContent).toBe("5");
});

it("arrow keys, Home and End move focus and selection between tabs; only the active tab is in the Tab order", async () => {
  const { tab, onSelect } = await render();
  const btn = (id: string) => tab(id).querySelector<HTMLElement>('[role="tab"]')!;
  expect(["a", "b", "c", "d", NEW_TAB].map((id) => btn(id).tabIndex)).toEqual([-1, -1, 0, -1, -1]);
  expect(tab("c").querySelector<HTMLElement>('[data-testid="tab-close"]')!.tabIndex).toBe(-1);
  const key = (id: string, k: string) => act(async () => void btn(id).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
  await key("c", "ArrowRight");
  expect(onSelect).toHaveBeenLastCalledWith("d");
  expect(document.activeElement).toBe(btn("d"));
  await key("c", "ArrowLeft");
  expect(onSelect).toHaveBeenLastCalledWith("b");
  await key("a", "ArrowLeft");
  expect(onSelect).toHaveBeenLastCalledWith(NEW_TAB);
  await key("c", "Home");
  expect(onSelect).toHaveBeenLastCalledWith("a");
  await key("c", "End");
  expect(onSelect).toHaveBeenLastCalledWith(NEW_TAB);
});

it("Delete on a focused tab closes it", async () => {
  const { tab, onClose } = await render();
  await act(async () => void tab("b").querySelector('[role="tab"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
  expect(onClose).toHaveBeenCalledWith("b");
});

/** TabsBar wired to real tab state, as App does. */
async function renderLive(initial = ["a", "b", "c"], initialActive = "b") {
  function Live() {
    const [s, set] = useState({ tabs: initial, active: initialActive as string | undefined });
    return (
      <TabsBar
        tabs={s.tabs}
        activeId={s.active}
        info={(id) => ({ ...INFO[id]!, cwd: "/home/u/web" })}
        onSelect={(active) => set((v) => ({ ...v, active }))}
        onClose={(id) => set((v) => closeTab(v.tabs, id, v.active))}
        onMove={(from, to) => set((v) => ({ ...v, tabs: moveTab(v.tabs, from, to) }))}
        onMoveGroup={() => {}} onMoveGroupTo={() => {}}
        onNew={() => {}}
        onAction={() => {}}
        onRenamed={() => {}}
      />
    );
  }
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<Live />));
  const btn = (id: string) => el.querySelector<HTMLElement>(`[data-tab-id="${id}"] [role="tab"]`)!;
  const order = () => [...el.querySelectorAll<HTMLElement>("[data-tab-id]")].map((t) => t.dataset.tabId);
  const key = (id: string, init: KeyboardEventInit) => act(async () => void btn(id).dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init })));
  return { el, btn, order, key };
}

it("after Delete closes the focused tab, focus moves to the tab that becomes active", async () => {
  const { el, btn, key } = await renderLive();
  btn("b").focus();
  await key("b", { key: "Delete" });
  expect(document.activeElement).toBe(btn("c"));
  await key("c", { key: "Delete" });
  expect(document.activeElement).toBe(btn("a"));
  await key("a", { key: "Delete" });
  expect(document.activeElement).toBe(el.querySelector('[data-testid="tab-new"]'));
});

it("Alt+Shift+Arrow and Ctrl+Shift+PageUp/PageDown move the focused tab; focus stays on it (WCAG 2.5.7)", async () => {
  const { btn, order, key } = await renderLive();
  btn("b").focus();
  await key("b", { key: "ArrowLeft", altKey: true, shiftKey: true });
  expect(order()).toEqual(["b", "a", "c"]);
  expect(document.activeElement).toBe(btn("b"));
  await key("b", { key: "ArrowLeft", altKey: true, shiftKey: true });
  expect(order()).toEqual(["b", "a", "c"]);
  await key("b", { key: "PageDown", ctrlKey: true, shiftKey: true });
  expect(order()).toEqual(["a", "b", "c"]);
  await key("b", { key: "ArrowRight", altKey: true, shiftKey: true });
  expect(order()).toEqual(["a", "c", "b"]);
  expect(document.activeElement).toBe(btn("b"));
  await key("b", { key: "PageUp", ctrlKey: true, shiftKey: true });
  expect(order()).toEqual(["a", "b", "c"]);
});

it("the tab context menu moves the tab left / right and closes it", async () => {
  const { el, btn, order } = await renderLive();
  const menu = async (id: string, item: string) => {
    await act(async () => void el.querySelector(`[data-tab-id="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent).slice(0, 3)).toEqual(["Move left", "Move right", "Close tab"]);
    await act(async () => items.find((i) => i.textContent === item)!.click());
  };
  await menu("b", "Move right");
  expect(order()).toEqual(["a", "c", "b"]);
  expect(document.activeElement).toBe(btn("b"));
  await menu("b", "Move left");
  expect(order()).toEqual(["a", "b", "c"]);
  await menu("a", "Close tab");
  expect(order()).toEqual(["b", "c"]);
  expect(document.activeElement).toBe(btn("b"));
  await menu("b", "Close tab");
  expect(order()).toEqual(["c"]);
  expect(document.activeElement).toBe(btn("c"));
});

it("Escape on the tab context menu returns focus to that tab", async () => {
  const { el, btn } = await renderLive();
  for (const id of ["b", "c"]) {
    btn("b").focus();
    await act(async () => void el.querySelector(`[data-tab-id="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => void (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => {});
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(btn(id));
  }
});

it("first and last tab: the move items that do nothing are disabled", async () => {
  const { el } = await renderLive();
  await act(async () => void el.querySelector('[data-tab-id="a"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
  const disabled = (t: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === t)!.getAttribute("aria-disabled");
  expect(disabled("Move left")).toBe("true");
  expect(disabled("Move right")).not.toBe("true");
});

it("inactive tab titles use muted-foreground (4.5:1 in light and dark)", async () => {
  const { tab } = await render();
  expect(tab("a").querySelector('[role="tab"]')!.className).toMatch(/\btext-muted-foreground\b/);
  expect(tab("c").querySelector('[role="tab"]')!.className).toMatch(/\btext-foreground\b/);
});

it("the sidebar toggle left of the tabs shows a sidebar icon (not OpenCode's Home grid-plus) and toggles the sessions sidebar", async () => {
  const onHome = vi.fn();
  const { el } = await render({ onHome, home: true });
  const home = el.querySelector<HTMLElement>('[data-testid="tab-home"]')!;
  expect(home.getAttribute("aria-label")).toBe("Toggle sidebar");
  expect(home.querySelector("svg")!.getAttribute("class")).toMatch(/\blucide-panel-left\b/);
  expect(home.getAttribute("aria-pressed")).toBe("true");
  expect(home.compareDocumentPosition(el.querySelector('[data-testid="tab-strip"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await act(async () => home.click());
  expect(onHome).toHaveBeenCalled();
});

it("right click on a session tab opens the session menu; Delete is disabled while it runs; the new-session tab has only the tab items", async () => {
  const { tab, onAction } = await render();
  const menu = async (id: string) => {
    await act(async () => void tab(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })));
    return document.querySelector<HTMLElement>('[role="menu"]');
  };
  expect((await menu("c"))!.textContent).toBe("Move leftMove rightClose tabRenameArchiveDelete…");
  await act(async () => document.querySelector<HTMLElement>('[data-testid="action-archive"]')!.click());
  expect(onAction).toHaveBeenLastCalledWith("c", "archive");
  expect((await menu("a"))!.querySelector('[data-testid="action-delete"]')!.getAttribute("aria-disabled")).toBe("true");
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect((await menu(NEW_TAB))!.textContent).toBe("Move leftMove rightClose tab");
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
});

it("double click on a tab title asks to rename; the renaming tab edits its title in place", async () => {
  const { tab, onAction, onRenamed } = await render({ renaming: "d" });
  await act(async () => void tab("c").querySelector('[role="tab"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(onAction).toHaveBeenLastCalledWith("c", "rename");
  const input = tab("d").querySelector<HTMLInputElement>('[data-testid="rename-input"]')!;
  expect(input.value).toBe("Old");
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input, "  Newer ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(onRenamed).toHaveBeenCalledWith("d", "Newer");
});

it("a tab with no transcript yet does not rename on double click", async () => {
  const { tab, onAction } = await render({ info: (id) => ({ ...INFO[id]!, transcript: false }) });
  await act(async () => void tab("c").querySelector('[role="tab"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(onAction).not.toHaveBeenCalled();
});

it("session tab buttons show the pointer cursor", async () => {
  const { tab } = await render();
  for (const id of ["a", "c", NEW_TAB]) expect(tab(id).querySelector('[role="tab"]')!.className).toMatch(/(^|\s)cursor-pointer(\s|$)/);
});

it("a tab switch re-renders only the tabs that lose or get the selection (GH-51)", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onClose = vi.fn();
  // App passes new closures and new info objects on every render.
  const show = (activeId: string) =>
    act(async () =>
      root!.render(
        <TabsBar tabs={["a", "b", "c", "d"]} activeId={activeId} info={(id) => ({ ...INFO[id]! })} onSelect={() => {}} onClose={(id) => onClose(id)} onMove={() => {}} onMoveGroup={() => {}} onMoveGroupTo={() => {}} onNew={() => {}} onAction={() => {}} onRenamed={() => {}} />,
      ),
    );
  await show("c");
  tabRenders.n = 0;
  await show("a");
  // Each group chip has a ContextMenu.Root too (Close group), and it re-renders with the bar: only the tabs are memoised.
  expect(tabRenders.n - el.querySelectorAll('[data-testid="tab-group-chip"]').length).toBe(2);
  // A tab that did not re-render still closes with the latest handler.
  await act(async () => el.querySelector<HTMLElement>('[data-tab-id="b"] [data-testid="tab-close"]')!.click());
  expect(onClose).toHaveBeenCalledWith("b");
});

// GH-109: project groups
const chip = (el: HTMLElement, cwd: string) => el.querySelector<HTMLElement>(`[data-group-chip="${cwd}"]`)!;
const key = (e: HTMLElement, k: string, o: KeyboardEventInit = {}) => act(async () => void e.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...o })));

it("a chip per project with two or more projects; none with one", async () => {
  const { el } = await render();
  expect([...el.querySelectorAll("[data-group-chip]")].map((c) => c.textContent)).toEqual(["web1", "docs1", "api2"]);
  await act(async () => root!.unmount());
  const one = await render({ tabs: ["c", "d"] });
  expect(one.el.querySelector("[data-group-chip]")).toBeNull();
});

it("chip click collapses the group, persists, and a reload keeps it; a running tab shows its icon on the chip", async () => {
  localStorage.removeItem("claude-ui.tab-groups-collapsed");
  let r = await render();
  expect(chip(r.el, "/home/u/web").getAttribute("aria-expanded")).toBe("true");
  await act(async () => chip(r.el, "/home/u/web").click());
  expect(chip(r.el, "/home/u/web").getAttribute("aria-expanded")).toBe("false");
  expect(r.el.querySelector('[data-tab-id="a"]')).toBeNull();
  expect(chip(r.el, "/home/u/web").querySelector('[data-icon="running"]')).not.toBeNull();
  expect(chip(r.el, "/home/u/api").querySelector("[data-icon]")).toBeNull();
  await act(async () => root!.unmount());
  r = await render();
  expect(chip(r.el, "/home/u/web").getAttribute("aria-expanded")).toBe("false");
  expect(r.el.querySelector('[data-tab-id="a"]')).toBeNull();
  expect(r.tab("c")).not.toBeNull();
  await act(async () => chip(r.el, "/home/u/web").click());
  expect(r.tab("a")).not.toBeNull();
});

it("chip is a focusable button; Enter and Space toggle it (native click)", async () => {
  const { el } = await render();
  const c = chip(el, "/home/u/docs");
  expect(c.tagName).toBe("BUTTON");
  expect(c.tabIndex).toBe(0);
});

it("Alt+Shift+Arrow on a chip moves its group; a tab does not move across groups", async () => {
  const { el, onMoveGroup, onMove } = await render();
  await key(chip(el, "/home/u/docs"), "ArrowLeft", { altKey: true, shiftKey: true });
  expect(onMoveGroup).toHaveBeenCalledWith("/home/u/docs", -1);
  await key(el.querySelector<HTMLElement>('[data-tab-id="a"] [role="tab"]')!, "ArrowRight", { altKey: true, shiftKey: true });
  expect(onMove).not.toHaveBeenCalled();
});

it("chip text has 4.5:1 contrast on every avatar color, light and dark", () => {
  const css = readFileSync(`${import.meta.dirname}/index.css`, "utf8");
  const lum = (h: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const pairs = [...css.matchAll(/--avatar-\w+: (#\w{6}); --avatar-\w+-fg: (#\w{6})/g)];
  expect(pairs.length).toBe(18);
  for (const [, bg, fg] of pairs) {
    const [a, b] = [lum(bg!), lum(fg!)];
    expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
});

it("a collapsed group with a needs-input tab shows the alert icon on its chip", async () => {
  localStorage.removeItem("claude-ui.tab-groups-collapsed");
  const { el } = await render();
  await act(async () => chip(el, "/home/u/docs").click());
  expect(chip(el, "/home/u/docs").querySelector('[data-icon="needs_input"]')).not.toBeNull();
});

it("chip drag moves the group onto the dropped-on chip's slot", async () => {
  const { el, onMoveGroupTo } = await render();
  const data = new Map<string, string>();
  const dt = { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", types: [] as string[], effectAllowed: "", dropEffect: "" };
  const fire = (target: HTMLElement, type: string) => act(async () => void target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: dt })));
  await fire(chip(el, "/home/u/api"), "dragstart");
  dt.types = [...data.keys()];
  await fire(chip(el, "/home/u/web"), "drop");
  expect(onMoveGroupTo).toHaveBeenCalledWith("/home/u/api", "/home/u/web");
});

it("collapsing the active tab's group activates the nearest visible tab after it, else before; the last visible group keeps its active tab shown", async () => {
  localStorage.removeItem("claude-ui.tab-groups-collapsed");
  function Live({ start }: { start: string }) {
    const [active, setActive] = useState(start);
    return <TabsBar tabs={["a", "b", "c", "d"]} activeId={active} info={(id) => INFO[id]!} onSelect={setActive} onClose={() => {}} onMove={() => {}} onMoveGroup={() => {}} onMoveGroupTo={() => {}} onNew={() => {}} onAction={() => {}} onRenamed={() => {}} />;
  }
  const mount = async (start: string) => {
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<Live start={start} />));
    return el;
  };
  const selected = (el: HTMLElement) => el.querySelector('[aria-selected="true"]')!.closest("[data-tab-id]")!.getAttribute("data-tab-id");
  let el = await mount("b");
  await act(async () => chip(el, "/home/u/docs").click());
  expect(selected(el)).toBe("c");
  await act(async () => root!.unmount());
  localStorage.removeItem("claude-ui.tab-groups-collapsed");
  el = await mount("c");
  await act(async () => chip(el, "/home/u/api").click());
  expect(selected(el)).toBe("b");
  // Everything else collapsed: the active tab stays visible.
  await act(async () => chip(el, "/home/u/docs").click());
  await act(async () => chip(el, "/home/u/web").click());
  expect(el.querySelector('[data-tab-id="a"]')).not.toBeNull();
  expect(el.querySelector('[data-tab-id="b"]')).toBeNull();
});

it("a tab that becomes active inside a collapsed group expands the group", async () => {
  localStorage.setItem("claude-ui.tab-groups-collapsed", JSON.stringify(["/home/u/docs"]));
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const show = (activeId: string) => act(async () => root!.render(<TabsBar tabs={["a", "b", "c"]} activeId={activeId} info={(id) => INFO[id]!} onSelect={() => {}} onClose={() => {}} onMove={() => {}} onMoveGroup={() => {}} onMoveGroupTo={() => {}} onNew={() => {}} onAction={() => {}} onRenamed={() => {}} />));
  await show("a");
  expect(el.querySelector('[data-tab-id="b"]')).toBeNull();
  await show("b");
  expect(el.querySelector('[data-tab-id="b"]')).not.toBeNull();
  expect(chip(el, "/home/u/docs").getAttribute("aria-expanded")).toBe("true");
  expect(localStorage.getItem("claude-ui.tab-groups-collapsed")).toBe("[]");
});

it("useGroupedTabs regroups an interleaved stored list (App uses it for its tab state)", async () => {
  const cwds: Record<string, string> = { a1: "/a", b1: "/b", a2: "/a" };
  let seen: string[] = [];
  function H() {
    const [t, set] = useState(["a1", "b1", "a2"]);
    useGroupedTabs(t, set, (id) => cwds[id]);
    seen = t;
    return null;
  }
  const el = document.createElement("div");
  root = createRoot(el);
  await act(async () => root!.render(<H />));
  expect(seen).toEqual(["a1", "a2", "b1"]);
});

it("useGroupedTabs leaves the list alone while not ready, and regroups once ready (GH-196)", async () => {
  const cwds: Record<string, string> = { a1: "/a", b1: "/b", a2: "/a" };
  let seen: string[] = [];
  function H({ ready }: { ready: boolean }) {
    const [t, set] = useState(["a1", "b1", "a2"]);
    useGroupedTabs(t, set, (id) => cwds[id], ready);
    seen = t;
    return null;
  }
  const el = document.createElement("div");
  root = createRoot(el);
  await act(async () => root!.render(<H ready={false} />));
  expect(seen).toEqual(["a1", "b1", "a2"]);
  await act(async () => root!.render(<H ready={true} />));
  expect(seen).toEqual(["a1", "a2", "b1"]);
});

it("the pinned Focus tab comes first with the number of waiting sessions, cannot be closed, and selects the page (GH-159)", async () => {
  const { el, tab, onSelect, onClose } = await render({ focus: { count: 3 } });
  const strip = el.querySelector('[data-testid="tab-strip"]')!;
  expect(strip.firstElementChild!.getAttribute("data-testid")).toBe("focus-tab");
  const focus = tab("focus");
  expect(focus.textContent).toBe("Focus3");
  expect(focus.querySelector('[role="tab"]')!.getAttribute("aria-label")).toBe("Focus, 3 sessions need input");
  // The count has a shape (alert icon) and a number, not only a color.
  expect(focus.querySelector(".lucide-circle-alert")).not.toBeNull();
  expect(focus.querySelector('[data-testid="tab-close"]')).toBeNull();
  await act(async () => focus.querySelector<HTMLElement>('[role="tab"]')!.click());
  expect(onSelect).toHaveBeenCalledWith("focus");
  await act(async () => focus.querySelector<HTMLElement>('[role="tab"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
  expect(onClose).not.toHaveBeenCalled();
});

it("Focus shows no badge at 0, is selected while the page shows, and the arrow keys reach it from the first tab (GH-159)", async () => {
  const { el, tab, onSelect } = await render({ focus: { count: 0 }, activeId: "focus" });
  expect(tab("focus").textContent).toBe("Focus");
  expect(tab("focus").querySelector('[role="tab"]')!.getAttribute("aria-selected")).toBe("true");
  expect(el.querySelector('[data-testid="tab-close-active"]')).toBeNull();
  const first = tab("a").querySelector<HTMLElement>('[role="tab"]')!;
  await act(async () => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
  expect(onSelect).toHaveBeenCalledWith("focus");
});

it("without a Focus prop there is no Focus tab (GH-159)", async () => {
  const { el } = await render();
  expect(el.querySelector('[data-testid="focus-tab"]')).toBeNull();
});

// GH-209: phone switcher rows close on a left swipe (touch and pen only), a click after a swipe selects nothing.
const swipeRows = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];
let now = 0;
const tick = (ms: number) => ((now += ms), vi.spyOn(performance, "now").mockReturnValue(now));
const touch = (target: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", x: number, y = 0, pointerType = "touch") =>
  act(async () => void target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType, pointerId: 7, clientX: x, clientY: y, isPrimary: true } as PointerEventInit)));
/** A finger from (0,0) by (dx, dy) over `ms`, in 16 ms steps, then lifted. */
async function swipeBy(target: Element, dx: number, ms = 600, dy = 0, pointerType = "touch", y0 = 100) {
  tick(1000);
  await touch(target, "pointerdown", 0, y0, pointerType);
  const n = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    tick(ms / n);
    await touch(target, "pointermove", (dx * i) / n, y0 + (dy * i) / n, pointerType);
  }
  tick(1);
  await touch(target, "pointerup", dx, y0 + dy, pointerType);
}
const shift = (row: Element) => parseFloat(/-?[\d.]+/.exec((row as HTMLElement).style.transform)?.[0] ?? "0");
async function openList(props: Partial<Parameters<typeof TabsBar>[0]> = {}) {
  const r = await render(props);
  await act(async () => r.el.querySelector<HTMLElement>('[data-testid="tab-switcher"]')!.click());
  for (const row of swipeRows()) row.getBoundingClientRect = () => ({ width: 300, height: 44, left: 0, top: 0, right: 300, bottom: 44, x: 0, y: 0, toJSON() {} });
  return r;
}
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

it("phone: a left swipe past the threshold closes the row's tab; the list stays open and nothing is selected", async () => {
  const { onSwipeClose, onSelect } = await openList({ onSwipeClose: vi.fn() });
  await swipeBy(swipeRows()[1]!, -200);
  await wait(500);
  expect(onSwipeClose).toHaveBeenCalledExactlyOnceWith("b");
  expect(onSelect).not.toHaveBeenCalled();
  expect(swipeRows().length).toBe(5);
});

it("phone: a swipe shows the row following the finger, 'Close' behind it, and fades it", async () => {
  await openList({ onSwipeClose: vi.fn() });
  const row = swipeRows()[1]!;
  tick(1000);
  await touch(row, "pointerdown", 0);
  for (const x of [-6, -20, -60, -100]) (tick(30), await touch(row, "pointermove", x));
  expect(shift(row)).toBe(-90);
  expect(Number(row.style.opacity)).toBeLessThan(1);
  expect(row.parentElement!.textContent).toContain("Close");
  await touch(row, "pointercancel", -100);
  await wait(300);
  expect(shift(row)).toBe(0);
});

it("phone: a right swipe moves the row 16px at most, closes nothing, selects nothing and springs back", async () => {
  const { onSwipeClose, onSelect } = await openList({ onSwipeClose: vi.fn() });
  const row = swipeRows()[1]!;
  tick(1000);
  await touch(row, "pointerdown", 0);
  for (const x of [20, 80, 200]) (tick(30), await touch(row, "pointermove", x));
  expect(shift(row)).toBeGreaterThan(0);
  expect(shift(row)).toBeLessThanOrEqual(16);
  tick(1);
  await touch(row, "pointerup", 200);
  await act(async () => row.click());
  await wait(300);
  expect(shift(row)).toBe(0);
  expect(onSwipeClose).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
});

it("phone: a short slow left swipe springs back and closes nothing", async () => {
  const { onSwipeClose } = await openList({ onSwipeClose: vi.fn() });
  const row = swipeRows()[1]!;
  await swipeBy(row, -30, 800);
  await wait(300);
  expect(shift(row)).toBe(0);
  expect(onSwipeClose).not.toHaveBeenCalled();
});

it("phone: a fast left flick closes", async () => {
  const { onSwipeClose } = await openList({ onSwipeClose: vi.fn() });
  await swipeBy(swipeRows()[2]!, -45, 50);
  await wait(500);
  expect(onSwipeClose).toHaveBeenCalledWith("c");
});

it("phone: a click right after a swipe does not select the row, a later tap does", async () => {
  const { onSelect } = await openList({ onSwipeClose: vi.fn() });
  const row = swipeRows()[1]!;
  await swipeBy(row, -30, 800);
  await act(async () => row.click());
  expect(onSelect).not.toHaveBeenCalled();
});

it("phone: a vertical drag on a row is left to the browser: nothing closes", async () => {
  const { onSwipeClose, onSelect } = await openList({ onSwipeClose: vi.fn() });
  await swipeBy(swipeRows()[1]!, -30, 400, 120);
  expect(shift(swipeRows()[1]!)).toBe(0);
  expect(onSwipeClose).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
});

it("phone: a mouse drag on a row does nothing", async () => {
  const { onSwipeClose } = await openList({ onSwipeClose: vi.fn() });
  await swipeBy(swipeRows()[1]!, -250, 600, 0, "mouse");
  await wait(300);
  expect(onSwipeClose).not.toHaveBeenCalled();
  expect(shift(swipeRows()[1]!)).toBe(0);
});

it("phone: the Focus row never swipes away and has no handlers", async () => {
  const { onSwipeClose } = await openList({ focus: { count: 2 }, onSwipeClose: vi.fn() });
  const focus = swipeRows()[0]!;
  expect(focus.textContent).toContain("Focus");
  await swipeBy(focus, -250);
  await wait(300);
  expect(onSwipeClose).not.toHaveBeenCalled();
  expect(shift(focus)).toBe(0);
});

it("phone: Delete on a row of the open list closes its tab and keeps the list open; rows are labelled", async () => {
  const { onSwipeClose } = await openList({ onSwipeClose: vi.fn() });
  const row = swipeRows()[3]!;
  expect(row.getAttribute("aria-keyshortcuts")).toBe("Delete");
  await act(async () => void row.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
  expect(onSwipeClose).toHaveBeenCalledWith("d");
  expect(swipeRows().length).toBe(5);
});

it("phone: the list stays open when a close changes the active tab", async () => {
  function Host() {
    const [tabs, setTabs] = useState(["a", "b", "c", "d"]);
    const [active, setActive] = useState("c");
    return (
      <TabsBar tabs={tabs} activeId={active} info={(id) => INFO[id]!} onSelect={setActive} onClose={() => {}} onMove={() => {}} onMoveGroup={() => {}} onMoveGroupTo={() => {}} onNew={() => {}} onAction={() => {}} onRenamed={() => {}}
        onSwipeClose={(id) => { const r = closeTab(tabs, id, active); setTabs(r.tabs); setActive(r.active!); }} />
    );
  }
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<Host />));
  await act(async () => el.querySelector<HTMLElement>('[data-testid="tab-switcher"]')!.click());
  for (const row of swipeRows()) row.getBoundingClientRect = () => ({ width: 300, height: 44, left: 0, top: 0, right: 300, bottom: 44, x: 0, y: 0, toJSON() {} });
  await swipeBy(swipeRows()[2]!, -200);
  await wait(500);
  expect(swipeRows().map((r) => r.textContent)).toEqual(["Fix loginwebrunning", "Docsdocsneeds input", "AOldapiclosed"]);
  expect(el.querySelector('[data-testid="tab-switcher"] .truncate')!.textContent).toBe("Old");
});

// GH-209 C2: a vertical swipe on the switcher button (not the list) goes to the next / previous tab, no wrap.
const trigger = (el: Element) => el.querySelector<HTMLElement>('[data-testid="tab-switcher"]')!;

it("phone: swiping up on the switcher button selects the next tab, down the previous; the list does not open", async () => {
  const { el, onSelect } = await render();
  await swipeBy(trigger(el), 0, 300, -40);
  expect(onSelect).toHaveBeenLastCalledWith("d");
  await swipeBy(trigger(el), 0, 300, 40);
  expect(onSelect).toHaveBeenLastCalledWith("b");
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(swipeRows().length).toBe(0);
});

it("phone: the Focus tab comes first in the order; no wrap at either end", async () => {
  const onSelect = vi.fn();
  const { el } = await render({ focus: { count: 0 }, activeId: "a", onSelect });
  await swipeBy(trigger(el), 0, 300, 40);
  expect(onSelect).toHaveBeenLastCalledWith("focus");
  onSelect.mockClear();
  await act(async () => root!.render(<TabsBar tabs={["a", "b", "c", "d", NEW_TAB]} activeId="focus" focus={{ count: 0 }} info={(id) => INFO[id]!} onSelect={onSelect} onClose={() => {}} onMove={() => {}} onMoveGroup={() => {}} onMoveGroupTo={() => {}} onNew={() => {}} onAction={() => {}} onRenamed={() => {}} />));
  await swipeBy(trigger(el), 0, 300, 40);
  expect(onSelect).not.toHaveBeenCalled();
  await act(async () => root!.render(<TabsBar tabs={["a", "b", "c", "d", NEW_TAB]} activeId={NEW_TAB} info={(id) => INFO[id]!} onSelect={onSelect} onClose={() => {}} onMove={() => {}} onMoveGroup={() => {}} onMoveGroupTo={() => {}} onNew={() => {}} onAction={() => {}} onRenamed={() => {}} />));
  await swipeBy(trigger(el), 0, 300, -60);
  expect(onSelect).not.toHaveBeenCalled();
});

it("phone: a 4px touch on the switcher button is a tap that still opens the list", async () => {
  const { el, onSelect } = await render();
  await swipeBy(trigger(el), 0, 60, -4);
  expect(onSelect).not.toHaveBeenCalled();
  // A tap ends with the compatibility mousedown, which is what opens base-ui's Select.
  await act(async () => void trigger(el).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 })));
  await wait(60);
  expect(swipeRows().length).toBe(5);
});

it("phone: a swipe that starts in the top 16px of the page is not ours; a horizontal one does nothing", async () => {
  const { el, onSelect, onClose } = await render();
  await swipeBy(trigger(el), 0, 300, -40, "touch", 8);
  expect(onSelect).not.toHaveBeenCalled();
  await swipeBy(trigger(el), 60, 300, 0);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(swipeRows().length).toBe(0);
});

it("phone: a mouse drag on the switcher button does not switch tabs", async () => {
  const { el, onSelect } = await render();
  await swipeBy(trigger(el), 0, 300, -40, "mouse");
  expect(onSelect).not.toHaveBeenCalled();
});

it("phone: the switcher button has touch-action none and a non-passive touchmove that cancels the scroll, except from the top 16px", async () => {
  const add = vi.spyOn(HTMLElement.prototype, "addEventListener");
  const { el } = await render();
  const t = trigger(el);
  expect(t.className).toMatch(/touch-none/);
  expect(add.mock.calls.some(([type, , o]) => type === "touchmove" && (o as AddEventListenerOptions)?.passive === false)).toBe(true);
  add.mockRestore();
  const fire = (type: string, y: number) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { touches: [{ clientX: 0, clientY: y }] });
    t.dispatchEvent(e);
    return e;
  };
  expect(fire("touchstart", 100).defaultPrevented).toBe(false);
  expect(fire("touchmove", 90).defaultPrevented).toBe(true);
  const uncancelable = new Event("touchmove", { bubbles: true, cancelable: false });
  t.dispatchEvent(uncancelable);
  expect(uncancelable.defaultPrevented).toBe(false);
  fire("touchstart", 8);
  expect(fire("touchmove", 40).defaultPrevented).toBe(false);
});

it("phone: a row's touchmove is cancelled only after the horizontal lock, never when the list scrolls", async () => {
  await openList({ onSwipeClose: vi.fn() });
  const row = swipeRows()[1]!;
  const move = () => {
    const e = new Event("touchmove", { bubbles: true, cancelable: true });
    row.dispatchEvent(e);
    return e.defaultPrevented;
  };
  tick(1000);
  await touch(row, "pointerdown", 0, 100);
  expect(move()).toBe(false);
  await touch(row, "pointermove", -4, 101);
  await touch(row, "pointermove", -40, 102);
  expect(move()).toBe(true);
  await touch(row, "pointercancel", -40, 102);
  tick(1000);
  await touch(row, "pointerdown", 0, 100);
  await touch(row, "pointermove", 2, 140);
  expect(move()).toBe(false);
});

it("phone: the slide-out of a swipe closes with the latest onSwipeClose, not the one of the render that started it", async () => {
  const stale = vi.fn();
  const latest = vi.fn();
  const handlers = { onSelect: () => {}, onClose: () => {}, onMove: () => {}, onMoveGroup: () => {}, onMoveGroupTo: () => {}, onNew: () => {}, onAction: () => {}, onRenamed: () => {} };
  const view = (cb: (id: string) => void) => <TabsBar {...handlers} tabs={["a", "b", "c", "d", NEW_TAB]} activeId="c" info={(id) => INFO[id]!} onSwipeClose={cb} />;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(view(stale)));
  await act(async () => trigger(el).click());
  for (const row of swipeRows()) row.getBoundingClientRect = () => ({ width: 300, height: 44, left: 0, top: 0, right: 300, bottom: 44, x: 0, y: 0, toJSON() {} });
  await swipeBy(swipeRows()[0]!, -200);
  await act(async () => root!.render(view(latest)));
  await wait(500);
  expect(stale).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledExactlyOnceWith("a");
});
