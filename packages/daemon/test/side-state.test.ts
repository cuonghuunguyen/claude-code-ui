import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateSideState } from "../src/side-state.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function setup(markers: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "side-state-"));
  dirs.push(root);
  const old = join(root, "config");
  mkdirSync(old);
  for (const f of ["sessions.json", "projects.json", "settings.json", "secrets.json"]) writeFileSync(join(old, f), `old ${f}`);
  mkdirSync(join(old, "uploads"));
  writeFileSync(join(old, "uploads", "u"), "x");
  for (const m of markers) m === "versions" ? mkdirSync(join(old, m)) : writeFileSync(join(old, m), "m");
  return { old, data: join(root, "side", ".data") };
}

describe("migrateSideState", () => {
  it("no Hub markers and an empty .data: the four files are copied (not uploads), the old ones stay", () => {
    const { old, data } = setup();
    const before = readdirSync(old).sort();
    expect(migrateSideState(old, data).sort()).toEqual(["projects.json", "secrets.json", "sessions.json", "settings.json"]);
    expect(readdirSync(data).sort()).toEqual(["projects.json", "secrets.json", "sessions.json", "settings.json"]);
    expect(readFileSync(join(data, "sessions.json"), "utf8")).toBe("old sessions.json");
    expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(readdirSync(old).sort()).toEqual(before);
    expect(readFileSync(join(old, "sessions.json"), "utf8")).toBe("old sessions.json");
  });
  it.each(["token", "daemon.json", "versions"])("a Hub marker (%s) in the config folder: .data starts empty, nothing copied", (marker) => {
    const { old, data } = setup([marker]);
    expect(migrateSideState(old, data)).toEqual([]);
    expect(() => readdirSync(data)).toThrow();
  });
  it("a .data that already has files is left alone, and a second start copies nothing again", () => {
    const { old, data } = setup();
    migrateSideState(old, data);
    writeFileSync(join(data, "sessions.json"), "new");
    expect(migrateSideState(old, data)).toEqual([]);
    expect(readFileSync(join(data, "sessions.json"), "utf8")).toBe("new");
  });
  it("no old config folder: nothing happens", () => {
    const { data } = setup();
    expect(migrateSideState(join(data, "..", "missing"), data)).toEqual([]);
  });
});
