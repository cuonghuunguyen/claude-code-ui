// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TabsBar, type TabInfo } from "./tabs-bar.tsx";
import { NEW_TAB } from "./tabs.ts";

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
  const handlers = { onSelect: vi.fn(), onClose: vi.fn(), onMove: vi.fn(), onNew: vi.fn() };
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
  expect(tab("b").textContent).toContain("needs input");
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
