import { expect, it, vi } from "vitest";
import { NEW_TAB } from "./tabs.ts";
import { type WorkspaceEffect, type WorkspaceHost, type WorkspaceIntent, type WorkspaceState, step } from "./workspace-layout.ts";

// Session ids are uuids: the docked map and the split only take those.
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const D = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const host = (live: string[] = []): WorkspaceHost => {
  let n = 0;
  return { splitFits: () => true, groupOf: () => "", exists: () => true, live: (o) => live.includes(o), grouped: () => true, newKey: () => `k${++n}`, perform: vi.fn() };
};
const ws = (p: Partial<WorkspaceState> = {}): WorkspaceState => ({ tabs: [], pinned: [], active: undefined, run: undefined, split: undefined, docked: {}, dockSel: {}, dockRun: {}, tabKeys: {}, heirOf: {}, closed: [], wide: true, ...p });
const run = (s: WorkspaceState, i: WorkspaceIntent, h = host()) => step(s, i, h);
const has = (effects: WorkspaceEffect[], e: WorkspaceEffect) => expect(effects).toContainEqual(e);

it("/clear on a pinned tab in the active split keeps its pin, place, split slot and key", () => {
  const split = { dir: "row" as const, ids: [A, B], at: 0, ratio: 0.5 };
  const r = run(ws({ tabs: [A, B, C], pinned: [A], active: A, split }), { type: "heir", from: A, to: D });
  expect(r.state.tabs).toEqual([D, B, C]);
  expect(r.state.pinned).toEqual([D]);
  expect(r.state.split).toMatchObject({ ids: [D, B], at: 0 });
  expect(r.state.active).toBe(D);
  expect(r.state.tabKeys).toEqual({ [D]: A, [A]: "k1" });
  expect(r.state.heirOf).toEqual({ [D]: A });
  has(r.effects, { type: "url", hash: `#${D}` });
  has(r.effects, { type: "show", id: D, explicit: true });
});

it("/clear on a docked, pinned tab keeps it docked and selected while the split and the active tab stay", () => {
  const split = { dir: "row" as const, ids: [B, C], at: 0, ratio: 0.5 };
  const r = run(ws({ tabs: [A, B, C], pinned: [A], active: B, split, docked: { [A]: "side" }, dockSel: { side: A }, dockRun: { [A]: "run1" } }), { type: "heir", from: A, to: D });
  expect(r.state.docked).toEqual({ [D]: "side" });
  expect(r.state.dockSel).toEqual({ side: D });
  expect(r.state.dockRun).toEqual({ [D]: "run1" });
  expect(r.state.pinned).toEqual([D]);
  expect(r.state.tabs).toEqual([D, B, C]);
  expect(r.state.split).toMatchObject({ ids: [B, C] });
  expect(r.state.active).toBe(B);
  expect(r.effects.some((e) => e.type === "url")).toBe(false);
});

it.each([
  ["a live session goes on in the background", [B], { type: "background", id: B }],
  ["a session that is not live is dropped", [], { type: "drop", id: B }],
] as [string, string[], WorkspaceEffect][])("Undo of a background tab close puts it back in place without showing it: %s", (_, live, release) => {
  const closed = run(ws({ tabs: [A, B, C], active: A }), { type: "close", id: B }, host(live));
  expect(closed.state).toMatchObject({ tabs: [A, C], active: A, closed: [{ id: B, at: 1 }] });
  expect(closed.effects).toEqual([release]);
  const back = run(closed.state, { type: "restore", id: B, show: false });
  expect(back.state).toMatchObject({ tabs: [A, B, C], active: A, closed: [] });
  expect(back.effects).toEqual([{ type: "show", id: B }]);
});

it("Close group closes the group's tabs onto the stack in strip order and activates the first tab after it", () => {
  const closed = run(ws({ tabs: [A, B, C, D], active: B, docked: { [D]: "bottom" } }), { type: "closeMany", ids: [A, B] }, host([A]));
  expect(closed.state).toMatchObject({ tabs: [C, D], active: C, closed: [{ id: A, at: 0 }, { id: B, at: 1 }], docked: { [D]: "bottom" } });
  expect(closed.effects.filter((e) => e.type === "background" || e.type === "drop")).toEqual([{ type: "background", id: A }, { type: "drop", id: B }]);
  has(closed.effects, { type: "show", id: C, explicit: true });
  has(closed.effects, { type: "url", hash: `#${C}` });
  expect(closed.result.closed).toEqual([{ id: A, at: 0 }, { id: B, at: 1 }]);

  // Undo: the tabs come back in order, the one that was shown is shown again, the other is held.
  const back = run(closed.state, { type: "undoClose", parts: [{ entries: closed.result.closed!, wasActive: B }] });
  expect(back.state).toMatchObject({ tabs: [A, B, C, D], active: B, closed: [] });
  expect(back.result.restored).toEqual([A, B]);
  has(back.effects, { type: "show", id: A });
  expect(back.effects).not.toContainEqual({ type: "show", id: B });
  has(back.effects, { type: "url", hash: `#${B}` });
});

it("Close group of every strip tab with a docked session left shows the New session tab", () => {
  const r = run(ws({ tabs: [A, B, C], active: A, docked: { [C]: "side" } }), { type: "closeMany", ids: [A, B] });
  expect(r.state.active).toBe(NEW_TAB);
  expect(r.state.tabs).toEqual([C, NEW_TAB]);
});

it.each([
  ["wide: it shows in its dock, the main tab stays", ws({ tabs: [A, B], active: B, docked: { [A]: "side" } }), { type: "open", id: A } as WorkspaceIntent, { active: B, dockSel: { side: A } }, [{ type: "revealDock", area: "side" }]],
  ["a window widened over a docked active tab: the dock shows it, the strip neighbour takes over", ws({ tabs: [A, B], active: A, docked: { [A]: "side" }, wide: false }), { type: "wide", on: true } as WorkspaceIntent, { active: B, dockSel: { side: A } }, [{ type: "revealDock", area: "side" }, { type: "url", hash: `#${B}` }]],
  ["narrow: the map is ignored", ws({ tabs: [A, B], active: B, docked: { [A]: "side" }, wide: false }), { type: "open", id: A } as WorkspaceIntent, { active: A, dockSel: {} }, [{ type: "url", hash: `#${A}` }]],
] as [string, WorkspaceState, WorkspaceIntent, Partial<WorkspaceState>, WorkspaceEffect[]][])("a Docked session never becomes the current tab: %s", (_, s, i, state, effects) => {
  const r = run(s, i);
  expect(r.state).toMatchObject(state);
  for (const e of effects) has(r.effects, e);
});

it("docking a split tab ends the split and the main area shows its strip neighbour", () => {
  const r = run(ws({ tabs: [A, B, C], active: B, split: { dir: "row", ids: [A, B], at: 1, ratio: 0.5 } }), { type: "dock", id: B, area: "side" });
  expect(r.state).toMatchObject({ split: undefined, active: C, docked: { [B]: "side" }, dockSel: { side: B } });
  has(r.effects, { type: "revealDock", area: "side" });
});

it("docking the active split tab next to the other split tab keeps that tab's subagent view and ends the split", () => {
  const split = { dir: "row" as const, ids: [A, B], at: 1, ratio: 0.5, runs: { [A]: "r1" } };
  const r = run(ws({ tabs: [A, B], active: B, split }), { type: "dock", id: B, area: "side" });
  expect(r.state).toMatchObject({ split: undefined, active: A, run: "r1", docked: { [B]: "side" } });
  has(r.effects, { type: "url", hash: `#${A}/agent/r1` });
});
