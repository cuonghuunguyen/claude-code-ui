// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DOCKED_DRAG_TYPE, PANE_DRAG_TYPE } from "./dock-area.tsx";
import type { Drag } from "./pane-drop.ts";
import { useSplitDrop } from "./split-drop.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => act(() => root?.unmount()));

function mount(on: Parameters<typeof useSplitDrop>[0]) {
  let state: ReturnType<typeof useSplitDrop>["state"];
  function C() {
    const d = useSplitDrop(on);
    state = d.state;
    return <div data-testid="area" ref={d.ref} />;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<C />));
  return { area: host.firstElementChild as HTMLElement, state: () => state };
}
const ev = (type: string, dt: Record<string, string>) => {
  const e = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown; clientX: number; clientY: number };
  e.dataTransfer = { types: Object.keys(dt), getData: (k: string) => dt[k] ?? "", dropEffect: "" };
  e.clientX = 0;
  e.clientY = 0;
  return e;
};

it("GH-402 a dock tab drag over the area shows the overlay with the refusal; dragend clears it", () => {
  const refuse = vi.fn((d: Drag) => ("pane" in d && d.pane === "changes" ? ("changes" as const) : undefined));
  const { area, state } = mount({ enabled: () => true, onDrop: vi.fn(), refuse, dragged: () => ({ pane: "changes" }) });
  act(() => void area.dispatchEvent(ev("dragover", { [PANE_DRAG_TYPE]: "" })));
  expect(state()?.refused).toBe("changes");
  act(() => void window.dispatchEvent(new Event("dragend")));
  expect(state()).toBeUndefined();
});

it("GH-402 drop passes the dock or docked drag to onDrop unless refused", () => {
  const onDrop = vi.fn();
  const { area } = mount({ enabled: () => true, onDrop, refuse: () => undefined });
  act(() => void area.dispatchEvent(ev("drop", { [PANE_DRAG_TYPE]: "plan" })));
  act(() => void area.dispatchEvent(ev("drop", { [DOCKED_DRAG_TYPE]: "s1" })));
  expect(onDrop.mock.calls.map((c) => c[0])).toEqual([{ pane: "plan" }, { docked: "s1" }]);
});

it("GH-402 a disabled area ignores the drag", () => {
  const onDrop = vi.fn();
  const { area } = mount({ enabled: () => false, onDrop });
  act(() => void area.dispatchEvent(ev("drop", { [PANE_DRAG_TYPE]: "plan" })));
  expect(onDrop).not.toHaveBeenCalled();
});
