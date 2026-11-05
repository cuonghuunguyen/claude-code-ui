import { mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalHistory } from "../src/local-history.ts";

const setup = (opts: { enabled?: boolean; exclude?: string[]; roots?: boolean } = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lh-")));
  const dir = join(root, "history");
  let t = 1_000_000;
  const file = join(root, "a.txt");
  writeFileSync(file, "v0");
  const h = createLocalHistory({
    dir,
    settings: () => ({ enabled: opts.enabled ?? true, exclude: opts.exclude ?? ["**/node_modules/**", "**/.git/**"] }),
    allowed: (p) => (p.startsWith(root) ? p : undefined),
    now: () => t,
  });
  return { root, dir, file, h, tick: (ms: number) => (t += ms) };
};

describe("local history", () => {
  it("before() stores the content a write replaces; list is newest first", async () => {
    const { h, file, tick } = setup();
    h.before(file, "save");
    tick(60_000);
    writeFileSync(file, "v1");
    h.before(file, "save");
    const l = await h.list(file);
    expect(l.map((e) => e.reason)).toEqual(["save", "save"]);
    expect(await h.read(file, l[1]!.id)).toBe("v0");
    expect(await h.read(file, l[0]!.id)).toBe("v1");
  });

  it("merges entries of one source within 10 s and keeps the content before the burst", async () => {
    const { h, file, tick } = setup();
    h.before(file, "save");
    tick(3000);
    h.before(file, "save", "v1");
    expect(await h.list(file)).toHaveLength(1);
    tick(11_000);
    h.before(file, "save", "v2");
    const l = await h.list(file);
    expect(l).toHaveLength(2);
    expect(await h.read(file, l[1]!.id)).toBe("v0");
  });

  it("a save and an agent edit within 10 s keep both contents", async () => {
    const { h, file, tick } = setup();
    h.before(file, "save", "v0");
    tick(3000);
    h.before(file, "agent", "v1");
    expect((await h.list(file)).map((e) => e.reason)).toEqual(["agent", "save"]);
  });

  it("the default excludes also match under a dot folder", async () => {
    const { h, root } = setup();
    mkdirSync(join(root, ".claude", "node_modules"), { recursive: true });
    const f = join(root, ".claude", "node_modules", "x.js");
    writeFileSync(f, "x");
    h.before(f, "save");
    expect(await h.list(f)).toEqual([]);
  });

  it("a git-write reason never merges, nor is merged into", async () => {
    const { h, file, tick } = setup();
    h.before(file, "save", "a");
    tick(3000);
    h.before(file, "rollback", "b");
    tick(1000);
    h.before(file, "save", "c");
    expect((await h.list(file)).map((e) => e.reason)).toEqual(["save", "rollback", "save"]);
  });

  it("skips the content of the newest entry", async () => {
    const { h, file, tick } = setup();
    h.before(file, "save", "same");
    tick(60_000);
    h.before(file, "rollback", "same");
    expect(await h.list(file)).toHaveLength(1);
  });

  it("keeps at most 50 entries, oldest pruned with their files", async () => {
    const { h, file, tick, dir } = setup();
    for (let i = 0; i < 55; i++) {
      tick(60_000);
      h.before(file, "save", `c${i}`);
    }
    const l = await h.list(file);
    expect(l).toHaveLength(50);
    expect(await h.read(file, l[49]!.id)).toBe("c5");
    const sub = readdirSync(dir)[0]!;
    expect(readdirSync(join(dir, sub))).toHaveLength(51); // entries.json + 50 contents
  });

  it("skips files over 256 KB, excluded globs, outside roots and disabled", async () => {
    const { h, file, root } = setup({ exclude: ["**/skip/**"] });
    h.before(file, "save", "x".repeat(256 * 1024 + 1));
    h.before(file, "agent", "é".repeat(150 * 1024)); // 300 KB in bytes
    mkdirSync(join(root, "skip"));
    const ex = join(root, "skip", "b.txt");
    writeFileSync(ex, "b");
    h.before(ex, "save");
    const out = join(tmpdir(), "outside-lh.txt");
    writeFileSync(out, "o");
    h.before(out, "save");
    expect(await h.list(file)).toEqual([]);
    expect(await h.list(ex)).toEqual([]);
    const off = setup({ enabled: false });
    off.h.before(off.file, "save");
    expect(await off.h.list(off.file)).toEqual([]);
  });

  it("a full queue drops items and before() never waits for the disk", async () => {
    const { h, root } = setup();
    for (let i = 0; i < 150; i++) {
      const f = join(root, `f${i}.txt`);
      writeFileSync(f, "x");
      h.before(f, "save", "x");
    }
    expect(h.dropped()).toBe(50);
    expect((await h.list(join(root, "f0.txt"))).length).toBe(1);
    expect(await h.list(join(root, "f120.txt"))).toEqual([]);
  });

  it("create: a named entry from disk bypasses merge and dedupe; rename and remove", async () => {
    const { h, file } = setup();
    h.before(file, "save");
    const e = await h.create(file, "before refactor");
    expect(e.reason).toBe("named");
    expect(await h.list(file)).toHaveLength(2);
    await h.rename(file, e.id, "renamed");
    expect((await h.list(file))[0]!.label).toBe("renamed");
    await expect(h.rename(file, e.id, "bad\u0007")).rejects.toMatchObject({ code: "bad_request" });
    await expect(h.rename(file, e.id, "")).rejects.toMatchObject({ code: "bad_request" });
    await h.remove(file, e.id);
    expect(await h.list(file)).toHaveLength(1);
    await expect(h.read(file, e.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses a path outside the roots", async () => {
    const { h } = setup();
    await expect(h.list(join(tmpdir(), "nope.txt"))).rejects.toMatchObject({ code: "path_not_allowed" });
  });

  it("bench: 1000 before() calls with 200 KB content enqueue fast", () => {
    const { h, file } = setup();
    const body = "x".repeat(200 * 1024);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) h.before(file, "agent", body);
    const ms = performance.now() - t0;
    console.log(`history bench: 1000 before() x 200 KB enqueued in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1000);
  });
});
