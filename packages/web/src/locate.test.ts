// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createShakeDetector, loadShakeLocate, saveShakeLocate, type Move } from "./locate.ts";

const run = (xs: number[], dt = 20, extra: Partial<Move> = {}, t0 = 0, d = createShakeDetector()) =>
  xs.map((x, i) => d({ x, t: t0 + i * dt, pointerType: "mouse", buttons: 0, ...extra }));
const S = [0, 60, 0, 60, 0, 60];

describe("shake detector", () => {
  it("4 direction changes of 40 px within 600 ms trigger once", () => {
    const r = run(S);
    expect(r.at(-1)).toBe(true);
    expect(r.filter(Boolean)).toHaveLength(1);
  });
  it("3 direction changes do not trigger", () => expect(run([0, 60, 0, 60, 0]).includes(true)).toBe(false));
  it("strokes shorter than 40 px do not count", () => {
    expect(run([0, 39, 0, 39, 0, 39]).includes(true)).toBe(false);
    expect(run([0, 40, 0, 40, 0, 40]).at(-1)).toBe(true);
  });
  it("reversals spread over more than 600 ms do not trigger", () => {
    expect(run(S, 250).includes(true)).toBe(false);
    expect(run(S, 200).includes(true)).toBe(true);
  });
  it("cooldown: a second shake within 2 s does nothing, after 2 s it triggers", () => {
    const d = createShakeDetector();
    expect(run(S, 20, {}, 0, d).includes(true)).toBe(true);
    expect(run(S, 20, {}, 500, d).includes(true)).toBe(false);
    expect(run(S, 20, {}, 2200, d).includes(true)).toBe(true);
  });
  it("touch and pen never trigger", () => {
    for (const pointerType of ["touch", "pen"]) expect(run(S, 20, { pointerType }).includes(true)).toBe(false);
  });
  it("a held button (drag, selection) resets", () => {
    expect(run(S, 20, { buttons: 1 }).includes(true)).toBe(false);
    const d = createShakeDetector();
    const r = S.map((x, i) => d({ x, t: i * 20, pointerType: "mouse", buttons: i === 2 ? 1 : 0 }));
    expect(r.includes(true)).toBe(false);
  });
});

describe("shake setting", () => {
  it("is on by default and saves per browser", () => {
    expect(loadShakeLocate()).toBe(true);
    saveShakeLocate(false);
    expect(localStorage.getItem("claude-ui.shakeLocate")).toBe("0");
    expect(loadShakeLocate()).toBe(false);
    saveShakeLocate(true);
    expect(localStorage.getItem("claude-ui.shakeLocate")).toBeNull();
  });
});
