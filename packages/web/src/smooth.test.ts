import { describe, expect, it } from "vitest";
import { nextRevealLength } from "./smooth.ts";

describe("nextRevealLength", () => {
  it("reveals at a steady minimum pace for a small backlog", () => {
    expect(nextRevealLength(0, 10, 16)).toBe(2); // 120 chars/s * 16ms ≈ 1.9 → 2
  });

  it("catches up faster when the backlog is large, never overshooting", () => {
    const n = nextRevealLength(0, 1000, 16);
    expect(n).toBeGreaterThan(20);
    expect(nextRevealLength(995, 1000, 1000)).toBe(1000);
  });

  it("reveals at least one char per frame and nothing when caught up", () => {
    expect(nextRevealLength(5, 6, 1)).toBe(6);
    expect(nextRevealLength(6, 6, 16)).toBe(6);
  });
});
