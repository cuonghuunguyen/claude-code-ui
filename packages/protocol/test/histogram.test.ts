import { describe, expect, it } from "vitest";
import { HIST_BUCKETS, merge, newHistogram, percentile, record, summarize } from "../src/histogram.ts";

describe("histogram", () => {
  it("percentiles of 1..1000 within 4 %", () => {
    const h = newHistogram();
    for (let i = 1; i <= 1000; i++) record(h, i);
    expect(percentile(h, 50)!).toBeGreaterThanOrEqual(480);
    expect(percentile(h, 50)!).toBeLessThanOrEqual(520);
    expect(percentile(h, 95)!).toBeGreaterThanOrEqual(912);
    expect(percentile(h, 95)!).toBeLessThanOrEqual(988);
    expect(h.max).toBe(1000);
    expect(h.n).toBe(1000);
  });
  it("empty histogram has no percentiles", () => {
    const h = newHistogram();
    expect(percentile(h, 50)).toBeUndefined();
    expect(summarize(h)).toEqual({ n: 0 });
  });
  it("p95 only from n >= 30", () => {
    const h = newHistogram();
    for (let i = 1; i <= 29; i++) record(h, i);
    expect(summarize(h).p95).toBeUndefined();
    expect(summarize(h).p50).toBeDefined();
    record(h, 30);
    expect(summarize(h).p95).toBeDefined();
  });
  it("merge equals recording both", () => {
    const a = newHistogram(), b = newHistogram(), both = newHistogram();
    for (let i = 1; i <= 50; i++) (record(a, i * 3), record(both, i * 3));
    for (let i = 1; i <= 70; i++) (record(b, i * 7), record(both, i * 7));
    merge(a, b);
    expect(a).toEqual(both);
  });
  it("negative and NaN ignored; huge values land in the last bucket", () => {
    const h = newHistogram();
    record(h, -1);
    record(h, NaN);
    record(h, Infinity);
    expect(h.n).toBe(0);
    record(h, 1e12);
    expect(h.n).toBe(1);
    expect(h.buckets[HIST_BUCKETS - 1]).toBe(1);
    expect(percentile(h, 50)!).toBeGreaterThan(6e5);
    expect(h.max).toBe(1e12);
  });
  it("is plain JSON of fixed length", () => {
    const h = newHistogram();
    expect(h.buckets).toHaveLength(HIST_BUCKETS);
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
  });
});
