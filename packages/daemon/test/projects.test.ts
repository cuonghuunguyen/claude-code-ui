import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjects } from "../src/projects.ts";

// File modes are POSIX: on Windows chmod only sets the read-only flag.
const posix = process.platform !== "win32";

const at = (cwd: string, lastActivity: number) => ({ cwd, lastActivity });

describe("projects", () => {
  it("lists only added projects, newest activity first; transcript-only cwds are not listed", () => {
    const p = createProjects({ now: () => 50 });
    p.open("/r/a");
    p.open("/r/empty");
    expect(p.list([at("/r/a", 10), at("/r/b", 90), at("/r/a", 70)])).toEqual(["/r/a", "/r/empty"]);
    expect(p.list([at("/r/a", 10), at("/r/empty", 60)])).toEqual(["/r/empty", "/r/a"]);
    expect(createProjects().list([at("/r/b", 90)])).toEqual([]);
  });

  it("recent: not-added cwds with a session count and their newest activity, newest first", () => {
    const p = createProjects();
    p.open("/r/added/");
    expect(p.recent([at("/r/a", 10), at("/r/added", 99), at("/r/b/", 90), at("/r/a", 70), at("/r/b", 20)])).toEqual([
      { cwd: "/r/b", sessionCount: 2, lastActivity: 90 },
      { cwd: "/r/a", sessionCount: 2, lastActivity: 70 },
    ]);
  });

  it("a removed project is hidden, also with newer sessions, until it is added again", () => {
    let t = 100;
    const p = createProjects({ now: () => t });
    p.open("/r/x");
    p.remove("/r/x");
    expect(p.list([at("/r/x", 110)])).toEqual([]);
    expect(p.recent([at("/r/x", 110)])).toEqual([{ cwd: "/r/x", sessionCount: 1, lastActivity: 110 }]);
    t = 200;
    p.open("/r/x");
    expect(p.list([])).toEqual(["/r/x"]);
  });

  it("seed (upgrade) adds the given session cwds once, not those removed after their last activity; an old file is not seeded", () => {
    const file = join(mkdtempSync(join(tmpdir(), "projects-")), "projects.json");
    writeFileSync(file, '{"opened":{"/r/opened":5},"removed":{"/r/gone":100}}');
    const p = createProjects({ file });
    expect(p.seeded).toBe(false);
    p.seed([at("/r/used", 40), at("/r/gone", 90), at("/r/used", 60), at("/r/gone2", 10)]);
    expect(p.list([])).toEqual(["/r/used", "/r/gone2", "/r/opened"]);
    expect(createProjects({ file }).seeded).toBe(true);
  });

  it("a truncated file starts an empty list instead of stopping the daemon; a save leaves no temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "projects-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, '{"opened":{"/r/x":1');
    const p = createProjects({ file });
    expect(p.list([])).toEqual([]);
    p.open("/r/y");
    expect(createProjects({ file }).list([])).toEqual(["/r/y"]);
    expect(readdirSync(dir)).toEqual(["projects.json"]);
  });

  it("a corrupt file keeps the list in memory (no resurrected project); at start it counts as seeded", () => {
    const file = join(mkdtempSync(join(tmpdir(), "projects-")), "projects.json");
    const p = createProjects({ file });
    p.open("/r/x");
    p.remove("/r/x");
    p.open("/r/y");
    writeFileSync(file, "{");
    expect(p.list([at("/r/x", 5)])).toEqual(["/r/y"]);
    const q = createProjects({ file });
    expect(q.seeded).toBe(true);
    expect(q.list([])).toEqual([]);
  });

  it("a corrupt file after the first save (file was missing at start) keeps the list in memory", () => {
    const file = join(mkdtempSync(join(tmpdir(), "projects-")), "projects.json");
    const p = createProjects({ file });
    p.open("/r/a");
    writeFileSync(file, "{");
    expect(p.list([])).toEqual(["/r/a"]);
  });

  it("survives a restart through its file, owner-only", () => {
    const file = join(mkdtempSync(join(tmpdir(), "projects-")), "projects.json");
    const a = createProjects({ file, now: () => 5 });
    a.open("/r/kept");
    a.open("/r/gone");
    a.remove("/r/gone");
    expect(createProjects({ file }).list([])).toEqual(["/r/kept"]);
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("a hand-edited file of the wrong shape is ignored like a truncated one", () => {
    const file = join(mkdtempSync(join(tmpdir(), "projects-")), "projects.json");
    writeFileSync(file, '{"opened":null,"removed":[1]}');
    const p = createProjects({ file });
    p.open("/r/x");
    expect(p.list([])).toEqual(["/r/x"]);
  });

  it("two daemons on one file: each change applies to the latest file, so none is lost or brought back (GH-88)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "projects-")), "projects.json");
    const a = createProjects({ file });
    const b = createProjects({ file });
    a.open("/r/x");
    b.open("/r/y");
    expect(createProjects({ file }).list([])).toEqual(expect.arrayContaining(["/r/x", "/r/y"]));
    expect(a.list([])).toEqual(expect.arrayContaining(["/r/x", "/r/y"]));
    a.remove("/r/x");
    b.open("/r/z");
    expect(createProjects({ file }).list([]).sort()).toEqual(["/r/y", "/r/z"]);
    expect(b.has("/r/x")).toBe(false);
  });

  // root ignores file modes, so a read-only dir does not fail a write there.
  it.skipIf(!posix || process.getuid?.() === 0)("a failed save keeps the change in memory for the run; seed does not run again (GH-88)", () => {
    const dir = mkdtempSync(join(tmpdir(), "projects-"));
    const file = join(dir, "projects.json");
    writeFileSync(file, '{"opened":{"/r/old":1}}');
    const p = createProjects({ file, now: () => 5 });
    chmodSync(dir, 0o500);
    try {
      expect(() => p.open("/r/new")).toThrow();
      expect(p.list([]).sort()).toEqual(["/r/new", "/r/old"]);
      expect(p.has("/r/new")).toBe(true);
      expect(p.seeded).toBe(false);
      expect(() => p.seed([])).toThrow();
      expect(p.seeded).toBe(true);
      expect(readdirSync(dir)).toEqual(["projects.json"]);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("an unreadable file (a directory) keeps the list in memory instead of failing every call (GH-88)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "projects-")), "projects.json");
    const p = createProjects({ file });
    p.open("/r/x");
    rmSync(file);
    mkdirSync(file);
    expect(p.list([])).toEqual(["/r/x"]);
    expect(p.has("/r/x")).toBe(true);
    expect(p.seeded).toBe(false);
  });
});
