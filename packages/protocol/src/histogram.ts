// Fixed-memory histogram of non-negative millisecond values (docs/spec.md "Performance monitor"): log-linear buckets of ~4 % width
// from 0.1 ms to ~11 min; count, sum and max are exact. Plain JSON, so daemon and web share it.
export const HIST_BUCKETS = 400;
export type Histogram = { n: number; sum: number; max: number; buckets: number[] };
export type HistSummary = { n: number; p50?: number; p95?: number; max?: number };
/** The p95 is shown only from this many values. */
export const P95_MIN_N = 30;

const BASE = 0.1;
const STEP = 1.04;
const LOG_STEP = Math.log(STEP);

export const newHistogram = (): Histogram => ({ n: 0, sum: 0, max: 0, buckets: new Array<number>(HIST_BUCKETS).fill(0) });

const indexOf = (ms: number) => (ms <= BASE ? 0 : Math.min(HIST_BUCKETS - 1, Math.ceil(Math.log(ms / BASE) / LOG_STEP)));
const upper = (i: number) => BASE * STEP ** i;

/** Negative, NaN and infinite values are ignored. */
export function record(h: Histogram, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  h.n++;
  h.sum += ms;
  if (ms > h.max) h.max = ms;
  h.buckets[indexOf(ms)]!++;
}

/** Upper bound of the bucket holding the p-th percentile (0-100), at most `max`; undefined when empty. */
export function percentile(h: Histogram, p: number): number | undefined {
  if (h.n === 0) return undefined;
  const target = Math.max(1, Math.ceil((p / 100) * h.n));
  let seen = 0;
  for (let i = 0; i < HIST_BUCKETS; i++) {
    seen += h.buckets[i]!;
    if (seen >= target) return Math.min(upper(i), h.max);
  }
  return h.max;
}

export function merge(into: Histogram, from: Histogram): void {
  into.n += from.n;
  into.sum += from.sum;
  if (from.max > into.max) into.max = from.max;
  for (let i = 0; i < HIST_BUCKETS; i++) into.buckets[i]! += from.buckets[i]!;
}

export function summarize(h: Histogram): HistSummary {
  if (h.n === 0) return { n: 0 };
  return { n: h.n, p50: percentile(h, 50), ...(h.n >= P95_MIN_N ? { p95: percentile(h, 95) } : {}), max: h.max };
}
