import { describe, expect, it } from "vitest";
import { createLimits } from "../limits.ts";

describe("createLimits", () => {
  it("is not stopped before any blocks", () => {
    const limits = createLimits({ maxConsecutiveBlocks: 3, maxTotalBlocks: 20 });
    expect(limits.isStopped("s1")).toBe(false);
  });

  it("stops after maxConsecutiveBlocks consecutive blocks", () => {
    const limits = createLimits({ maxConsecutiveBlocks: 3, maxTotalBlocks: 20 });
    expect(limits.recordBlock("s1")).toBe(false);
    expect(limits.recordBlock("s1")).toBe(false);
    expect(limits.recordBlock("s1")).toBe(true); // crosses the limit, just now
    expect(limits.isStopped("s1")).toBe(true);
  });

  it("an allow resets the consecutive counter", () => {
    const limits = createLimits({ maxConsecutiveBlocks: 2, maxTotalBlocks: 20 });
    limits.recordBlock("s1");
    limits.recordAllow("s1");
    expect(limits.recordBlock("s1")).toBe(false); // consecutive count restarted at 1
    expect(limits.isStopped("s1")).toBe(false);
  });

  it("stops after maxTotalBlocks total blocks even if not consecutive", () => {
    const limits = createLimits({ maxConsecutiveBlocks: 100, maxTotalBlocks: 2 });
    limits.recordBlock("s1");
    limits.recordAllow("s1");
    expect(limits.recordBlock("s1")).toBe(true);
    expect(limits.isStopped("s1")).toBe(true);
  });

  it("once stopped, recordBlock keeps returning false (no repeated toast)", () => {
    const limits = createLimits({ maxConsecutiveBlocks: 1, maxTotalBlocks: 20 });
    expect(limits.recordBlock("s1")).toBe(true);
    expect(limits.recordBlock("s1")).toBe(false);
  });

  it("tracks sessions independently", () => {
    const limits = createLimits({ maxConsecutiveBlocks: 1, maxTotalBlocks: 20 });
    limits.recordBlock("s1");
    expect(limits.isStopped("s1")).toBe(true);
    expect(limits.isStopped("s2")).toBe(false);
  });

  it("options.allow/options.limits can change limits: stricter limits stop sooner", () => {
    const limits = createLimits({ maxConsecutiveBlocks: 1, maxTotalBlocks: 1 });
    expect(limits.recordBlock("s1")).toBe(true);
  });
});
