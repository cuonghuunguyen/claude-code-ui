import { expect, it, vi } from "vitest";
import { createReposCache } from "../src/repos-cache.ts";

const res = (n: number) => ({ repos: [{ path: `/p${n}`, rel: "", kind: "main" as const }] });

it("a key is served from the cache for 10 s, then loaded again", async () => {
  let t = 0;
  const c = createReposCache({ now: () => t });
  const load = vi.fn(async () => res(1));
  await c.get("k", load, false);
  t = 9_999;
  await c.get("k", load, false);
  expect(load).toHaveBeenCalledTimes(1);
  t = 10_000;
  await c.get("k", load, false);
  expect(load).toHaveBeenCalledTimes(2);
});

it("fresh loads again and replaces the entry; clear drops every key; a rejected load is not kept; more than 64 keys drop the oldest", async () => {
  const c = createReposCache({ now: () => 0 });
  let n = 0;
  const load = vi.fn(async () => res(++n));
  expect((await c.get("k", load, false)).repos[0]!.path).toBe("/p1");
  expect((await c.get("k", load, true)).repos[0]!.path).toBe("/p2");
  expect((await c.get("k", load, false)).repos[0]!.path).toBe("/p2");
  c.clear();
  await c.get("k", load, false);
  expect(load).toHaveBeenCalledTimes(3);
  const bad = vi.fn(async () => Promise.reject(new Error("x")));
  await expect(c.get("b", bad, false)).rejects.toThrow("x");
  await expect(c.get("b", bad, false)).rejects.toThrow("x");
  expect(bad).toHaveBeenCalledTimes(2);
  const d = createReposCache({ now: () => 0 });
  const l = vi.fn(async () => res(0));
  for (let i = 0; i < 65; i++) await d.get(`k${i}`, l, false);
  await d.get("k64", l, false);
  expect(l).toHaveBeenCalledTimes(65);
  await d.get("k0", l, false);
  expect(l).toHaveBeenCalledTimes(66);
});
