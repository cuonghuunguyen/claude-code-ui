import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@claude-ui/protocol";
import { asideItem, cascade, DEFAULT_SIZE, clampRect, defaultRect, raise, resizeRect, type AsideState } from "./aside.ts";

const a = (id: string, o: Partial<AsideState> = {}): AsideState => ({ id, ownerId: "o", title: id, from: "p", minimized: false, readOnly: true, ...o });

describe("aside popups", () => {
  it("raise moves a popup to the top of the stack", () => {
    const l = [a("1"), a("2"), a("3")];
    expect(raise(l, "1").map((x) => x.id)).toEqual(["2", "3", "1"]);
    expect(raise(l, "3")).toBe(l);
    expect(raise(l, "x")).toBe(l);
  });
  it("cascade steps down by more than a header, so no popup covers the header buttons of the one below it", () => {
    expect(cascade(0, { w: 1000 })).toEqual({ x: 336, y: 24 });
    expect(cascade(1, { w: 1000 }).y - cascade(0, { w: 1000 }).y).toBeGreaterThanOrEqual(56);
    expect(cascade(2, { w: 1000 })).toEqual({ x: 288, y: 136 });
    expect(DEFAULT_SIZE.h).toBeGreaterThanOrEqual(520);
  });
  it("defaultRect opens 640x760 when it fits and shrinks to the viewport otherwise", () => {
    expect(defaultRect(0, { w: 1600, h: 1000 })).toEqual({ x: 936, y: 24, w: 640, h: 760 });
    expect(defaultRect(0, { w: 600, h: 600 })).toEqual({ x: 24, y: 24, w: 552, h: 552 });
    expect(defaultRect(5, { w: 400, h: 300 })).toMatchObject({ w: 352, h: 240 });
  });
  it("clampRect keeps the header in the viewport and the minimum size", () => {
    const v = { w: 1000, h: 800 };
    expect(clampRect({ x: -900, y: -50, w: 400, h: 300 }, v)).toEqual({ x: -360, y: 0, w: 400, h: 300 });
    expect(clampRect({ x: 2000, y: 2000, w: 400, h: 300 }, v)).toEqual({ x: 960, y: 760, w: 400, h: 300 });
    expect(clampRect({ x: 0, y: 0, w: 10, h: 10 }, v)).toMatchObject({ w: 320, h: 240 });
  });
  it("resizeRect moves the dragged edge, keeps the opposite edge, the minimum size and the top edge at y >= 0", () => {
    const r = { x: 100, y: 100, w: 400, h: 300 };
    expect(resizeRect(r, "e", 50, 99)).toEqual({ x: 100, y: 100, w: 450, h: 300 });
    expect(resizeRect(r, "s", 99, 50)).toEqual({ x: 100, y: 100, w: 400, h: 350 });
    expect(resizeRect(r, "w", -50, 0)).toEqual({ x: 50, y: 100, w: 450, h: 300 });
    expect(resizeRect(r, "n", 0, -50)).toEqual({ x: 100, y: 50, w: 400, h: 350 });
    expect(resizeRect(r, "nw", 300, 300)).toEqual({ x: 180, y: 160, w: 320, h: 240 });
    expect(resizeRect(r, "ne", 0, -500)).toEqual({ x: 100, y: 0, w: 400, h: 400 });
  });
  it("asideItem names the request source 'Aside: title'", () => {
    const info = { id: "x", state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: [], cwd: "/p" } as unknown as SessionInfo;
    expect(asideItem(a("1", { title: "why?" }), info)).toMatchObject({ id: "1", title: "Aside: why?", archived: false });
  });
});
