// @vitest-environment jsdom
import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DockHeader, PaneSlot, usePaneHosts } from "./dock-area.tsx";
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
  const fns = { onSelect: vi.fn(), onMove: vi.fn(), onFlipSide: vi.fn(), onReset: vi.fn() };
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
