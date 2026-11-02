import { expect, it } from "vitest";
import { fitTabs } from "./overflow-tabs.ts";

it("fitTabs: all fit", () => expect(fitTabs([60, 60, 60], 200, 4, 32, 0)).toEqual([0, 1, 2]));
it("undefined width shows all", () => expect(fitTabs([60, 60, 60], undefined, 4, 32, 0)).toEqual([0, 1, 2]));
it("prefix leaves room for the more button", () => expect(fitTabs([60, 60, 60, 60, 60], 200, 4, 32, -1)).toEqual([0, 1]));
it("a selected tab past the fit replaces the last shown ones, order kept", () => expect(fitTabs([60, 60, 60, 60, 60], 200, 4, 32, 4)).toEqual([0, 4]));
it("selected wider than the budget still shows alone", () => expect(fitTabs([300], 100, 4, 32, 0)).toEqual([0]));
it("no selection keeps at least the first tab", () => expect(fitTabs([300, 50], 100, 4, 32, -1)).toEqual([0]));
