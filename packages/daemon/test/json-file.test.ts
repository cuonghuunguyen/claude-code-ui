import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createJsonFile } from "../src/json-file.ts";

describe("json-file", () => {
  const make = () => {
    const file = join(mkdtempSync(join(tmpdir(), "json-file-")), "s.json");
    let parses = 0;
    const store = createJsonFile(file, (raw) => (parses++, (raw ?? {}) as Record<string, number>), "test");
    return { file, store, parses: () => parses };
  };

  it("reads the file again only when it changed; another daemon's save (rename, same size) is seen", () => {
    const { file, store, parses } = make();
    store.change((d) => (d.a = 1));
    const base = parses();
    expect(store.get()).toEqual({ a: 1 });
    expect(store.get()).toEqual({ a: 1 });
    expect(parses()).toBe(base);
    writeFileSync(`${file}.other`, JSON.stringify({ a: 2 }));
    renameSync(`${file}.other`, file);
    expect(store.get()).toEqual({ a: 2 });
    expect(parses()).toBe(base + 1);
  });

  it("an in-place rewrite is seen", () => {
    const { file, store } = make();
    store.change((d) => (d.a = 1));
    writeFileSync(file, "{}");
    expect(store.get()).toEqual({});
  });
});
