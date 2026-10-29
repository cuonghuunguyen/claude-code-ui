// Drag a tab onto the session area (GH-356, docs/spec.md "Split view"): an overlay shows what the drop does; native capture listeners, because xterm and previews inside the area swallow React's drag events (same reason as `useAreaDrop`).
import { useCallback, useRef, useState } from "react";
import { TAB_DRAG_TYPE, draggedTab } from "./tabs-bar.tsx";
import { DOCKED_DRAG_TYPE, PANE_DRAG_TYPE } from "./dock-area.tsx";
import { PANE_IDS, type PaneId } from "./layout.ts";
import type { Drag } from "./pane-drop.ts";
import { type DropZone, type SplitRefusal, dropZone } from "./split.ts";

/** Overlay rectangle in px relative to the area. */
export type DropState = { zone: DropZone; box: { left: number; top: number; width: number; height: number }; /** Index of the split under the pointer (centre zone), -1 when none. */ over: number; /** Why a drop here does nothing (the overlay shows it). */ refused?: SplitRefusal };

const rel = (r: DOMRect, a: DOMRect) => ({ left: r.left - a.left, top: r.top - a.top, width: r.width, height: r.height });

/** Where a tab dropped at (x, y) lands in `area`, and the rectangle the overlay shows. */
export function dropTarget(area: HTMLElement, x: number, y: number): DropState {
  const a = area.getBoundingClientRect();
  const zone = dropZone(a, x, y);
  // Screen order (the `order` style), the order of `Split.ids`.
  const splits = [...area.querySelectorAll<HTMLElement>('[data-testid="split"]')].sort((x, y) => +x.style.order - +y.style.order);
  const over = zone === "center" ? splits.findIndex((s) => { const r = s.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; }) : -1;
  const full = { left: 0, top: 0, width: a.width, height: a.height };
  const box =
    zone === "left" ? { ...full, width: a.width / 2 }
    : zone === "right" ? { ...full, left: a.width / 2, width: a.width / 2 }
    : zone === "top" ? { ...full, height: a.height / 2 }
    : zone === "bottom" ? { ...full, top: a.height / 2, height: a.height / 2 }
    : over >= 0 ? rel(splits[over]!.getBoundingClientRect(), a)
    : full;
  return { zone, box, over };
}

/** The drag an event carries, by its type: a strip tab, a dock pane tab or a docked session tab (`read`: the data, only readable in a drop). */
const dragOf = (e: DragEvent, known: Drag | undefined, read: boolean): Drag | undefined => {
  const t = e.dataTransfer;
  if (!t) return undefined;
  const get = (type: string) => (read ? t.getData(type) : "");
  if (t.types.includes(TAB_DRAG_TYPE)) return { tab: (read ? get(TAB_DRAG_TYPE) : draggedTab() || t.getData(TAB_DRAG_TYPE)) || "" };
  if (t.types.includes(PANE_DRAG_TYPE)) {
    const p = read ? get(PANE_DRAG_TYPE) : known && "pane" in known ? known.pane : "";
    return PANE_IDS.includes(p as PaneId) ? { pane: p as PaneId } : undefined;
  }
  if (t.types.includes(DOCKED_DRAG_TYPE)) return { docked: read ? get(DOCKED_DRAG_TYPE) : known && "docked" in known ? known.docked : "" };
  return undefined;
};
const idOf = (d: Drag) => ("tab" in d ? d.tab : "pane" in d ? d.pane : d.docked);

/** Ref callback for the session area. `enabled`: a tab drop makes sense now (wide, a session shows). `dragged`: the dock or docked tab being dragged (dragover cannot read the data; App state). */
export function useSplitDrop(on: { enabled: () => boolean; onDrop: (d: Drag, t: DropState) => void; refuse?: (d: Drag, t: DropState) => SplitRefusal | undefined; dragged?: () => Drag | undefined }) {
  const latest = useRef(on);
  latest.current = on;
  const [state, setState] = useState<DropState>();
  const ref = useCallback((n: HTMLElement | null) => {
    if (!n) return;
    const isDrag = (e: DragEvent) => !!e.dataTransfer && [TAB_DRAG_TYPE, PANE_DRAG_TYPE, DOCKED_DRAG_TYPE].some((t) => e.dataTransfer!.types.includes(t)) && latest.current.enabled();
    const clear = () => setState(undefined);
    const over = (e: DragEvent) => {
      if (!isDrag(e)) return;
      e.preventDefault();
      // dragover cannot read the data: the strip tab sets `draggedTab`, App knows the dock tabs.
      const d = dragOf(e, latest.current.dragged?.(), false);
      const t0 = dropTarget(n, e.clientX, e.clientY);
      const t = { ...t0, refused: d && idOf(d) ? latest.current.refuse?.(d, t0) : undefined };
      e.dataTransfer!.dropEffect = t.refused ? "none" : "move";
      setState((s) => (s && s.zone === t.zone && s.over === t.over && s.refused === t.refused && s.box.width === t.box.width && s.box.height === t.box.height && s.box.left === t.box.left && s.box.top === t.box.top ? s : t));
    };
    const leave = (e: DragEvent) => !(e.relatedTarget instanceof Node && n.contains(e.relatedTarget)) && clear();
    const drop = (e: DragEvent) => {
      if (!isDrag(e)) return;
      const d = dragOf(e, latest.current.dragged?.(), true);
      e.preventDefault();
      clear();
      if (!d || !idOf(d)) return;
      const target = dropTarget(n, e.clientX, e.clientY);
      if (!latest.current.refuse?.(d, target)) latest.current.onDrop(d, target);
    };
    n.addEventListener("dragover", over, true);
    n.addEventListener("dragleave", leave, true);
    n.addEventListener("drop", drop, true);
    // A drag that ends elsewhere or is cancelled with Esc.
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      n.removeEventListener("dragover", over, true);
      n.removeEventListener("dragleave", leave, true);
      n.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  return { state, ref };
}
