import { expect, it } from "vitest";
import { menuPosition } from "./selection-menu.ts";

const view = { width: 1000, height: 800 };
const rect = (left: number, top: number, width = 100, height = 20) => ({ left, top, width, height, right: left + width, bottom: top + height });

it("desktop: centered above the anchor, 8px gap", () => {
  expect(menuPosition(rect(400, 300), view, false)).toEqual({ left: 450, top: 292, transform: "translate(-50%, -100%)" });
});
it("desktop: flips below when the top would leave the viewport", () => {
  expect(menuPosition(rect(400, 20), view, false)).toEqual({ left: 450, top: 48, transform: "translateX(-50%)" });
});
it("coarse pointer: below the anchor, even with room above", () => {
  expect(menuPosition(rect(400, 300), view, true)).toEqual({ left: 450, top: 328, transform: "translateX(-50%)" });
});
it("x is clamped 48px from the viewport edges", () => {
  expect(menuPosition(rect(0, 300, 10), view, false).left).toBe(48);
  expect(menuPosition(rect(990, 300, 10), view, false).left).toBe(952);
});
it("a wide menu keeps its whole width inside the viewport", () => {
  expect(menuPosition(rect(990, 300, 10), view, false, 190).left).toBe(897);
  expect(menuPosition(rect(0, 300, 10), view, false, 190).left).toBe(103);
});
