// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TabsBar, type TabInfo } from "./tabs-bar.tsx";
import { NEW_TAB, closeTab, moveTab } from "./tabs.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: Record<string, TabInfo> = {
  a: { title: "Fix login", cwd: "/home/u/web", state: "running", unread: false },
  b: { title: "Docs", cwd: "/home/u/docs", state: "needs_input", unread: true },
  c: { title: "Refactor", cwd: "/home/u/api", state: "idle", unread: true },
  d: { title: "Old", cwd: "/home/u/api", state: "closed", unread: false },
  [NEW_TAB]: { title: "New session", unread: false },
};

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => root?.unmount());

async function render(props: Partial<Parameters<typeof TabsBar>[0]> = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const handlers = { onSelect: vi.fn(), onClose: vi.fn(), onMove: vi.fn(), onNew: vi.fn(), onAction: vi.fn(), onRenamed: vi.fn() };
  await act(async () => root!.render(<TabsBar tabs={["a", "b", "c", "d", NEW_TAB]} activeId="c" info={(id) => INFO[id]!} {...handlers} {...props} />));
  const tab = (id: string) => el.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;
  return { el, tab, ...handlers };
}

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

it("+ opens a new-session tab; the narrow switcher selects a tab", async () => {
  const { el, onNew, onSelect } = await render();
  await act(async () => el.querySelector<HTMLElement>('[data-testid="tab-new"]')!.click());
  expect(onNew).toHaveBeenCalled();
  const select = el.querySelector<HTMLSelectElement>('[data-testid="tab-switcher"]')!;
  expect([...select.options].map((o) => o.text)).toEqual(["Fix login (running)", "Docs (needs input)", "Refactor (unread)", "Old", "New session"]);
  await act(async () => {
    select.value = "b";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onSelect).toHaveBeenCalledWith("b");
});

it("below md the titlebar controls have a 44px hit area and 8px gaps (touch-target-size, touch-spacing)", async () => {
  const { el } = await render();
  for (const id of ["tab-new", "tab-close-active"]) expect(el.querySelector(`[data-testid="${id}"]`)!.className).toMatch(/\bmax-md:size-11\b/);
  expect(el.querySelector('[data-testid="tab-switcher"]')!.parentElement!.className).toMatch(/\bmax-md:h-11\b/);
  expect(el.firstElementChild!.className).toMatch(/\bmax-md:gap-2\b/);
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
        info={(id) => INFO[id]!}
        onSelect={(active) => set((v) => ({ ...v, active }))}
        onClose={(id) => set((v) => closeTab(v.tabs, id, v.active))}
        onMove={(from, to) => set((v) => ({ ...v, tabs: moveTab(v.tabs, from, to) }))}
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
  const { el, order } = await renderLive();
  const menu = async (id: string, item: string) => {
    await act(async () => void el.querySelector(`[data-tab-id="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.map((i) => i.textContent).slice(0, 3)).toEqual(["Move left", "Move right", "Close tab"]);
    await act(async () => items.find((i) => i.textContent === item)!.click());
  };
  await menu("b", "Move right");
  expect(order()).toEqual(["a", "c", "b"]);
  await menu("b", "Move left");
  expect(order()).toEqual(["a", "b", "c"]);
  await menu("a", "Close tab");
  expect(order()).toEqual(["b", "c"]);
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

it("the Home button left of the tabs toggles the sessions sidebar", async () => {
  const onHome = vi.fn();
  const { el } = await render({ onHome, home: true });
  const home = el.querySelector<HTMLElement>('[data-testid="tab-home"]')!;
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
