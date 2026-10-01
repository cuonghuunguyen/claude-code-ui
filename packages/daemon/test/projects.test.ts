import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjects } from "../src/projects.ts";

const at = (cwd: string, lastActivity: number) => ({ cwd, lastActivity });

describe("projects", () => {
  it("lists session cwds and opened projects, newest activity first", () => {
    const p = createProjects({ now: () => 50 });
    p.open("/r/empty");
    expect(p.list([at("/r/a", 10), at("/r/b", 90), at("/r/a", 70)])).toEqual(["/r/b", "/r/a", "/r/empty"]);
  });

  it("a removed project is hidden until it is opened again or gets a newer session", () => {
    let t = 100;
    const p = createProjects({ now: () => t });
    p.open("/r/x");
    p.remove("/r/x");
    p.remove("/r/a");
    expect(p.list([at("/r/a", 90)])).toEqual([]);
    expect(p.list([at("/r/a", 110)])).toEqual(["/r/a"]);
    t = 200;
    p.open("/r/x");
    expect(p.list([])).toEqual(["/r/x"]);
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
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
