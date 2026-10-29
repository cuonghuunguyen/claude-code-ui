// What a drag of a pane or session tab does on each drop target (GH-402, docs/spec.md "Layout"). Pure: every result maps to an existing menu command, App only executes it.
import { type DockArea, type Layout, PANE_IDS, type PaneId, areaOf, canMain } from "./layout.ts";
import { kindOf } from "./pane-ref.ts";
import { type DropZone, type SplitDir, type SplitRefusal, isSession } from "./split.ts";

/** A dock tab (`pane`), a strip tab (`tab`: pane ref, file, artifact, session) or a docked session tab (`docked`). */
export type Drag = { pane: PaneId } | { tab: string } | { docked: string };
/** `docked`: session id → its dock area. `canOpen`: the pane has a tab to show once it is in the main area (an owner session, a plan...); default true. */
export type DropCtx = { layout: Layout; docked: Readonly<Record<string, DockArea>>; canOpen?: (p: PaneId) => boolean };

export type DockDrop = { do: "movePane"; p: PaneId; before?: PaneId } | { do: "toFiles"; ref: string } | { do: "toArtifacts"; ref: string } | { do: "dock"; id: string };
export type MainDrop =
  | { do: "move"; p: PaneId; /** Index of the split the tab shows in. */ over?: number }
  | { do: "moveSplit"; p: PaneId; dir: SplitDir; before: boolean }
  | { do: "undock"; id: string; over?: number }
  | { do: "undockSplit"; id: string; dir: SplitDir; before: boolean }
  | { refused: SplitRefusal };

const isPane = (k: string | undefined): k is PaneId => PANE_IDS.includes(k as PaneId);

/** Drop on a dock area, its drop strip or one of its pane tabs (`before`); undefined: refused. */
export function dockDrop(d: Drag, area: DockArea, ctx: DropCtx, before?: PaneId): DockDrop | undefined {
  if ("pane" in d) return { do: "movePane", p: d.pane, before };
  if ("docked" in d) return ctx.docked[d.docked] === area ? undefined : { do: "dock", id: d.docked };
  const k = kindOf(d.tab);
  if (k === "file") return areaOf(ctx.layout, "files") === area ? { do: "toFiles", ref: d.tab } : undefined;
  if (k === "artifact") return areaOf(ctx.layout, "artifacts") === area ? { do: "toArtifacts", ref: d.tab } : undefined;
  if (isPane(k)) return { do: "movePane", p: k, before };
  return isSession(d.tab) && !ctx.docked[d.tab] ? { do: "dock", id: d.tab } : undefined;
}

/** Drop on the tab strip or the session area (`over`: split under the pointer in the centre zone); undefined: the strip tab's own drop rules apply. */
export function mainDrop(d: Drag, zone: DropZone | "strip", ctx: DropCtx, over = -1): MainDrop | undefined {
  if ("tab" in d) return undefined;
  const edge = zone !== "center" && zone !== "strip";
  const dir: SplitDir = zone === "left" || zone === "right" ? "row" : "col";
  const before = zone === "left" || zone === "top";
  const at = zone === "center" && over >= 0 ? { over } : {};
  if ("docked" in d) return edge ? { do: "undockSplit", id: d.docked, dir, before } : { do: "undock", id: d.docked, ...at };
  if (!canMain(d.pane)) return { refused: "changes" };
  if (!edge) return { do: "move", p: d.pane, ...(d.pane === "graph" ? {} : at) };
  if (d.pane === "graph") return { refused: "whole" };
  return ctx.canOpen && !ctx.canOpen(d.pane) ? { do: "move", p: d.pane } : { do: "moveSplit", p: d.pane, dir, before };
}
