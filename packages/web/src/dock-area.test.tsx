// @vitest-environment jsdom
import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DockHeader, DropStrip, PANE_DRAG_TYPE, PaneSlot, usePaneHosts } from "./dock-area.tsx";
import type { DockArea, PaneId } from "./layout.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  el = document.body.appendChild(document.createElement("div"));
  root = createRoot(el);
});
afterEach(() => (act(() => root.unmount()), el.remove()));

const h = (area: DockArea, over: Partial<Parameters<typeof DockHeader>[0]> = {}) => {
  const fns = { onSelect: vi.fn(), onMove: vi.fn(), onFlipSide: vi.fn(), onReset: vi.fn(), onDrag: vi.fn(), onDropAt: vi.fn() };
  const props = { area, panes: (area === "side" ? ["changes", "files", "graph"] : ["terminal"]) as PaneId[], active: (area === "side" ? "files" : "terminal") as PaneId, changes: 3, side: "right" as const, ...fns, ...over };
  return { fns, render: () => act(async () => root.render(<DockHeader {...props} />)) };
};
const doc = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

it("renders a labelled tablist with the active pane selected; click selects", async () => {
  const { fns, render } = h("side");
  await render();
  expect(el.querySelector('[role="tablist"]')!.getAttribute("aria-label")).toBe("Side panel");
  const tabs = [...el.querySelectorAll<HTMLElement>('[role="tab"]')];
  expect(tabs.map((t) => t.textContent)).toEqual(["changes3", "files", "graph"]);
  expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  await act(async () => tabs[0]!.click());
  expect(fns.onSelect).toHaveBeenCalledWith("changes");
});

it("the side menu moves the active pane, flips the side and resets", async () => {
  const { fns, render } = h("side");
  await render();
  await act(async () => doc("dock-menu-side").click());
  expect(doc("dock-move").textContent).toBe("Move Files to bottom panel");
  expect(doc("dock-side-flip").textContent).toBe("Move side panel to left");
  await act(async () => doc("dock-move").click());
  expect(fns.onMove).toHaveBeenCalledWith("files", "bottom");
  await act(async () => doc("dock-menu-side").click());
  await act(async () => doc("dock-side-flip").click());
  expect(fns.onFlipSide).toHaveBeenCalled();
  await act(async () => doc("dock-menu-side").click());
  await act(async () => doc("dock-reset").click());
  expect(fns.onReset).toHaveBeenCalled();
});

it("the bottom menu has no side flip and moves its pane to the side panel", async () => {
  const { fns, render } = h("bottom");
  await render();
  await act(async () => doc("dock-menu-bottom").click());
  expect(doc("dock-side-flip")).toBeNull();
  expect(doc("dock-move").textContent).toBe("Move Terminal to side panel");
  await act(async () => doc("dock-move").click());
  expect(fns.onMove).toHaveBeenCalledWith("terminal", "side");
});

it("a tab's context menu moves that pane", async () => {
  const { fns, render } = h("side");
  await render();
  await act(async () => void el.querySelector('[data-pane-tab="graph"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 4, clientY: 4 })));
  expect(doc("pane-move").textContent).toBe("Move to bottom panel");
  await act(async () => doc("pane-move").click());
  expect(fns.onMove).toHaveBeenCalledWith("graph", "bottom");
});

it("a pane host moves between slots without remounting its content", async () => {
  let setSlot: (n: 0 | 1) => void = () => {};
  let mounts = 0;
  const Counter = () => {
    const [n] = useState(() => ++mounts);
    return <span data-testid="c">{n}</span>;
  };
  const App = () => {
    const hosts = usePaneHosts();
    const [slot, set] = useState<0 | 1>(0);
    setSlot = set;
    return (
      <>
        <div data-testid="a">{slot === 0 && <PaneSlot host={hosts.files} />}</div>
        <div data-testid="b">{slot === 1 && <PaneSlot host={hosts.files} />}</div>
        {createPortal(<Counter />, hosts.files)}
      </>
    );
  };
  await act(async () => root.render(<App />));
  const span = el.querySelector("[data-testid=c]");
  expect(el.querySelector('[data-testid="a"] [data-testid="c"]')).toBe(span);
  await act(async () => setSlot(1));
  expect(el.querySelector('[data-testid="b"] [data-testid="c"]')).toBe(span);
  expect(mounts).toBe(1);
});

const fire = (target: Element, type: string, types: string[] = [PANE_DRAG_TYPE], data = new Map<string, string>()) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { dataTransfer: { setData: (k: string, v: string) => data.set(k, v), getData: (k: string) => data.get(k) ?? "", types, dropEffect: "", effectAllowed: "" } });
  target.dispatchEvent(e);
  return e;
};

it("dragging a tab carries the pane; dropping on another tab inserts before it; dragend clears", async () => {
  const { fns, render } = h("side");
  await render();
  const data = new Map<string, string>();
  await act(async () => void fire(el.querySelector('[data-pane-tab="files"]')!, "dragstart", [], data));
  expect(data.get(PANE_DRAG_TYPE)).toBe("files");
  expect(fns.onDrag).toHaveBeenCalledWith("files");
  const over = fire(el.querySelector('[data-pane-tab="changes"]')!, "dragover");
  expect(over.defaultPrevented).toBe(true);
  expect(fns.onDropAt).toHaveBeenCalledWith({ area: "side", before: "changes" });
  await act(async () => void fire(el.querySelector('[data-pane-tab="changes"]')!, "drop", [PANE_DRAG_TYPE], data));
  expect(fns.onMove).toHaveBeenCalledWith("files", "side", "changes");
  await act(async () => void fire(el.querySelector('[data-pane-tab="files"]')!, "dragend"));
  expect(fns.onDrag).toHaveBeenLastCalledWith(undefined);
});

it("a drag of something else (a session tab) is ignored", async () => {
  const { fns, render } = h("side");
  await render();
  const e = fire(el.querySelector('[data-pane-tab="changes"]')!, "dragover", ["application/x-claude-ui-tab"]);
  expect(e.defaultPrevented).toBe(false);
  expect(fns.onDropAt).not.toHaveBeenCalled();
});

it("the drop tab shows the insertion bar while it is the target", async () => {
  const { render } = h("side", { drag: "files", dropAt: { area: "side", before: "graph" } });
  await render();
  expect(el.querySelector('[data-pane-tab="graph"]')!.hasAttribute("data-drop-before")).toBe(true);
  expect(el.querySelector('[data-pane-tab="files"]')!.hasAttribute("data-drop-before")).toBe(false);
});

it("DropStrip names its area and takes the dropped pane", async () => {
  const onDrop = vi.fn();
  await act(async () => root.render(<DropStrip area="bottom" over={false} onOver={() => {}} onLeave={() => {}} onDrop={onDrop} />));
  expect(el.textContent).toBe("Bottom panel");
  const data = new Map([[PANE_DRAG_TYPE, "files"]]);
  await act(async () => void fire(el.firstElementChild!, "drop", [PANE_DRAG_TYPE], data));
  expect(onDrop).toHaveBeenCalledWith("files");
});

it("a menu opened from the keyboard focuses its first item; a pointer-opened one does not", async () => {
  const { render } = h("side");
  await render();
  // click() has detail 0, like Enter or Space on the focused trigger.
  await act(async () => doc("dock-menu-side").click());
  await act(async () => new Promise((r) => setTimeout(r, 50)));
  expect(document.activeElement).toBe(doc("dock-move"));
});

it.each([
  ["Shift+F10", { key: "F10", shiftKey: true }],
  ["the Menu key", { key: "ContextMenu" }],
])("%s on a focused pane tab opens its context menu with the first item focused, then Enter moves the pane", async (_n, key) => {
  const { fns, render } = h("side");
  await render();
  const tab = el.querySelector<HTMLElement>('[data-pane-tab="graph"]')!;
  tab.focus();
  // The browser's sequence: keydown, then a contextmenu event at the element (Chrome sends button 2, others 0).
  await act(async () => void tab.dispatchEvent(new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true })));
  await act(async () => void tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 0, clientY: 0 })));
  await vi.waitFor(() => expect(document.activeElement).toBe(doc("pane-move")));
  await act(async () => void doc("pane-move").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(fns.onMove).toHaveBeenCalledWith("graph", "bottom");
});

it("a right click on a pane tab does not take the focus into the menu", async () => {
  const { render } = h("side");
  await render();
  const tab = el.querySelector<HTMLElement>('[data-pane-tab="graph"]')!;
  await act(async () => void tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 4, clientY: 4 })));
  await act(async () => new Promise((r) => setTimeout(r, 80)));
  expect(document.activeElement).not.toBe(doc("pane-move"));
});
