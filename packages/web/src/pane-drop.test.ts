import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, type Layout, movePane } from "./layout.ts";
import { type Drag, type DropCtx, dockDrop, mainDrop } from "./pane-drop.ts";
import { NEW_TAB } from "./tabs.ts";

const U = "11111111-1111-1111-1111-111111111111";
const ctx = (over: Partial<DropCtx> = {}, layout: Layout = DEFAULT_LAYOUT): DropCtx => ({ layout, docked: {}, ...over });
const dockTab = (pane: "plan" | "files" | "graph" | "terminal" | "changes" | "artifacts"): Drag => ({ pane });
const strip = (tab: string): Drag => ({ tab });

describe("mainDrop: dock tab", () => {
  it.each(["plan", "files", "terminal", "artifacts"] as const)("%s: strip and centre move to main", (p) => {
    expect(mainDrop(dockTab(p), "strip", ctx())).toEqual({ do: "move", p });
    expect(mainDrop(dockTab(p), "center", ctx())).toEqual({ do: "move", p });
  });
  it("centre over a shown split shows it there", () => expect(mainDrop(dockTab("plan"), "center", ctx(), 1)).toEqual({ do: "move", p: "plan", over: 1 }));
  it.each([["left", "row", true], ["right", "row", false], ["top", "col", true], ["bottom", "col", false]] as const)("edge %s splits", (zone, dir, before) => {
    expect(mainDrop(dockTab("files"), zone, ctx())).toEqual({ do: "moveSplit", p: "files", dir, before });
  });
  it("edge with nothing to open: only the move", () => expect(mainDrop(dockTab("plan"), "right", ctx({ canOpen: () => false }))).toEqual({ do: "move", p: "plan" }));
  it("Git graph: centre and strip move, edges refused", () => {
    expect(mainDrop(dockTab("graph"), "strip", ctx())).toEqual({ do: "move", p: "graph" });
    expect(mainDrop(dockTab("graph"), "center", ctx(), 0)).toEqual({ do: "move", p: "graph" });
    expect(mainDrop(dockTab("graph"), "left", ctx())).toEqual({ refused: "whole" });
  });
  it("Changes never maps to main", () => {
    for (const z of ["strip", "center", "left", "right", "top", "bottom"] as const) expect(mainDrop(dockTab("changes"), z, ctx())).toEqual({ refused: "changes" });
  });
});

describe("mainDrop: docked session and strip tabs", () => {
  it("docked session: strip and centre undock, centre over a split shows it there, edge splits", () => {
    const d: Drag = { docked: "s1" };
    expect(mainDrop(d, "strip", ctx())).toEqual({ do: "undock", id: "s1" });
    expect(mainDrop(d, "center", ctx())).toEqual({ do: "undock", id: "s1" });
    expect(mainDrop(d, "center", ctx(), 0)).toEqual({ do: "undock", id: "s1", over: 0 });
    expect(mainDrop(d, "top", ctx())).toEqual({ do: "undockSplit", id: "s1", dir: "col", before: true });
  });
  it("strip tabs keep their own rules (undefined)", () => {
    for (const t of [U, `plan:${U}`, `file:${U}:/a`, NEW_TAB]) expect(mainDrop(strip(t), "center", ctx())).toBeUndefined();
  });
});

describe("dockDrop", () => {
  it("dock tab: existing move, before a tab when dropped on one", () => {
    expect(dockDrop(dockTab("plan"), "bottom", ctx())).toEqual({ do: "movePane", p: "plan", before: undefined });
    expect(dockDrop(dockTab("plan"), "bottom", ctx(), "terminal")).toEqual({ do: "movePane", p: "plan", before: "terminal" });
  });
  it("strip pane tab moves its kind into the area, before a tab when dropped on one", () => {
    const main = movePane(DEFAULT_LAYOUT, "terminal", "main");
    expect(dockDrop(strip(`terminal:${U}`), "side", ctx({}, main))).toEqual({ do: "movePane", p: "terminal", before: undefined });
    expect(dockDrop(strip(`plan:${U}`), "side", ctx(), "files")).toEqual({ do: "movePane", p: "plan", before: "files" });
  });
  it("file tab: only the area holding Files", () => {
    const f = strip(`file:${U}:/a/b.ts`);
    expect(dockDrop(f, "side", ctx())).toEqual({ do: "toFiles", ref: `file:${U}:/a/b.ts` });
    expect(dockDrop(f, "bottom", ctx())).toBeUndefined();
  });
  it("artifact tab: only the area holding Artifacts", () => {
    const a = strip(`artifact:${U}:p1`);
    expect(dockDrop(a, "side", ctx())).toEqual({ do: "toArtifacts", ref: `artifact:${U}:p1` });
    expect(dockDrop(a, "bottom", ctx())).toBeUndefined();
    expect(dockDrop(a, "bottom", ctx({}, movePane(DEFAULT_LAYOUT, "artifacts", "bottom")))).toEqual({ do: "toArtifacts", ref: `artifact:${U}:p1` });
  });
  it("session tab docks; New session and Focus are refused", () => {
    expect(dockDrop(strip(U), "bottom", ctx())).toEqual({ do: "dock", id: U });
    expect(dockDrop(strip(NEW_TAB), "bottom", ctx())).toBeUndefined();
  });
  it("docked session: the other area docks, its own area is a no-op", () => {
    const c = ctx({ docked: { s1: "side" } });
    expect(dockDrop({ docked: "s1" }, "bottom", c)).toEqual({ do: "dock", id: "s1" });
    expect(dockDrop({ docked: "s1" }, "side", c)).toBeUndefined();
  });
});
