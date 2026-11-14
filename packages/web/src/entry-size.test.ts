import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script
import { check } from "../scripts/check-entry-size.mjs";

const dirs: string[] = [];
afterEach(() => void dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A dist folder with an entry of `entry` bytes and one modulepreloaded chunk of `shared` bytes. */
function dist(entry: number, shared: number) {
  const d = mkdtempSync(join(tmpdir(), "entry-size-"));
  dirs.push(d);
  mkdirSync(join(d, "assets"));
  writeFileSync(join(d, "assets/index-abc.js"), "x".repeat(entry));
  writeFileSync(join(d, "assets/shared-def.js"), "y".repeat(shared));
  writeFileSync(join(d, "index.html"), '<head><script type="module" crossorigin src="/assets/index-abc.js"></script><link rel="modulepreload" crossorigin href="/assets/shared-def.js"></head>');
  return d;
}

const budget = { raw: 1000, br: 1000, initial: 1500 };

it("passes under the budgets", () => {
  const r = check(dist(800, 500), budget);
  expect(r.over).toEqual([]);
  expect(r.raw).toBe(800);
  expect(r.initial).toBe(1300);
});

it("fails when the entry chunk is over its raw budget", () => {
  expect(check(dist(1200, 0), budget).over).toEqual([expect.stringContaining("entry raw 1200 > 1000")]);
});

it("fails when the entry is small but its preloaded chunks bring the first load over: a lazy module pulled back into a shared chunk", () => {
  const r = check(dist(500, 1200), budget);
  expect(r.over).toEqual([expect.stringContaining("first load 1700 > 1500")]);
});
