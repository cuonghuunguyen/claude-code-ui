import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@claude-ui/protocol";
import { asideItem, cascade, clampRect, raise, setMinimized, type AsideState } from "./aside.ts";

const a = (id: string, o: Partial<AsideState> = {}): AsideState => ({ id, ownerId: "o", title: id, from: "p", minimized: false, readOnly: true, ...o });

describe("aside popups", () => {
  it("raise moves a popup to the top of the stack", () => {
    const l = [a("1"), a("2"), a("3")];
    expect(raise(l, "1").map((x) => x.id)).toEqual(["2", "3", "1"]);
    expect(raise(l, "3")).toBe(l);
    expect(raise(l, "x")).toBe(l);
  });
  it("setMinimized changes only that popup", () => {
    const l = setMinimized([a("1"), a("2")], "2", true);
    expect(l.map((x) => x.minimized)).toEqual([false, true]);
  });
  it("cascade steps 24 px from the top right", () => {
    expect(cascade(0, { w: 1000 })).toEqual({ x: 496, y: 24 });
    expect(cascade(2, { w: 1000 })).toEqual({ x: 448, y: 72 });
  });
  it("clampRect keeps the header in the viewport and the minimum size", () => {
    const v = { w: 1000, h: 800 };
    expect(clampRect({ x: -900, y: -50, w: 400, h: 300 }, v)).toEqual({ x: -360, y: 0, w: 400, h: 300 });
    expect(clampRect({ x: 2000, y: 2000, w: 400, h: 300 }, v)).toEqual({ x: 960, y: 760, w: 400, h: 300 });
    expect(clampRect({ x: 0, y: 0, w: 10, h: 10 }, v)).toMatchObject({ w: 320, h: 240 });
  });
  it("asideItem names the request source 'Aside: title'", () => {
    const info = { id: "x", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: [], cwd: "/p" } as unknown as SessionInfo;
    expect(asideItem(a("1", { title: "why?" }), info)).toMatchObject({ id: "1", title: "Aside: why?", archived: false });
  });
});
