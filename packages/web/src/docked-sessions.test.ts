// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { dock, dockedIn, neighbourAfterDock, loadDocked, parseDocked, pruneDocked, saveDocked, stripTabs, undock } from "./docked-sessions.ts";

const A = "aaaaaaaa-2222-3333-4444-555555555555";
const B = "bbbbbbbb-2222-3333-4444-555555555555";
const C = "cccccccc-2222-3333-4444-555555555555";
afterEach(() => (saveDocked({}), localStorage.clear()));

it("parseDocked: junk, arrays, bad keys and bad areas read as empty; a valid map round trips", () => {
  for (const raw of [null, "{nope", "[]", '"x"', "1", `{"nope":"side"}`, `{"${A}":"main"}`, `{"${A}":1}`]) expect(parseDocked(raw)).toEqual({});
  expect(parseDocked(JSON.stringify({ [A]: "side", [B]: "bottom", x: "side", [C]: "top" }))).toEqual({ [A]: "side", [B]: "bottom" });
});

it("dock / undock: set, move to the other area, no-op returns the same object", () => {
  const d = dock({}, A, "side");
  expect(d).toEqual({ [A]: "side" });
  expect(dock(d, A, "side")).toBe(d);
  expect(dock(d, A, "bottom")).toEqual({ [A]: "bottom" });
  expect(undock(d, A)).toEqual({});
  expect(undock(d, B)).toBe(d);
});

it("stripTabs: wide removes docked ids, narrow returns the list itself, ids absent from the list are ignored", () => {
  const tabs = [A, B, C];
  expect(stripTabs(tabs, { [B]: "side", "dddddddd-2222-3333-4444-555555555555": "bottom" }, true)).toEqual([A, C]);
  expect(stripTabs(tabs, { [B]: "side" }, false)).toBe(tabs);
  expect(stripTabs(tabs, {}, true)).toBe(tabs);
});

it("dockedIn: strip order, per area", () => {
  const d = { [C]: "side", [A]: "side", [B]: "bottom" } as const;
  expect(dockedIn([A, B, C], d, "side")).toEqual([A, C]);
  expect(dockedIn([A, B, C], d, "bottom")).toEqual([B]);
  expect(dockedIn([A], { [B]: "side" }, "side")).toEqual([]);
});

it("pruneDocked: drops entries without a tab, the same object when nothing drops", () => {
  const d = { [A]: "side", [B]: "bottom" } as const;
  expect(pruneDocked(d, [A])).toEqual({ [A]: "side" });
  expect(pruneDocked(d, [A, B])).toBe(d);
});

it("saveDocked / loadDocked: stored per browser, the same object while the stored string is equal; empty removes the key", () => {
  saveDocked({ [A]: "side" });
  expect(loadDocked()).toEqual({ [A]: "side" });
  expect(loadDocked()).toBe(loadDocked());
  expect(localStorage.getItem("claude-ui.dockedSessions")).toBe(JSON.stringify({ [A]: "side" }));
  saveDocked({});
  expect(localStorage.getItem("claude-ui.dockedSessions")).toBeNull();
});

it("neighbourAfterDock: the strip tab right of the id, else left, else none; docked tabs are skipped", () => {
  const d = { [B]: "side" } as const;
  expect(neighbourAfterDock([A, B, C], d, A)).toBe(C);
  expect(neighbourAfterDock([A, B, C], d, C)).toBe(A);
  expect(neighbourAfterDock([B], d, B)).toBeUndefined();
  expect(neighbourAfterDock([A, B, C], { ...d, [C]: "bottom" }, A)).toBeUndefined();
});
