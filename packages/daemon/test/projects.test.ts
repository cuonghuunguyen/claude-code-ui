import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
});
