import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isVisualizeWrite, visualizeReadable } from "../src/visualize-write.ts";
import { canSymlink } from "./symlink-support.ts";

describe("isVisualizeWrite", () => {
  let root: string;
  let up: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "vis-write-")));
    up = join(root, "uploads", "s1");
    mkdirSync(up, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const w = (file_path: unknown, tool = "Write") => isVisualizeWrite(tool, { file_path, content: "<b>x</b>" }, up);

  it("allows a Write of a new .html file directly in <uploads>/visualize, the folder absent or present", () => {
    expect(w(join(up, "visualize", "sales.html"))).toBe(true);
    mkdirSync(join(up, "visualize"));
    expect(w(join(up, "visualize", "sales-chart_2.html"))).toBe(true);
    writeFileSync(join(up, "visualize", "old.html"), "x");
    expect(w(join(up, "visualize", "old.html"))).toBe(true);
  });

  it("refuses another tool, no upload folder, a relative or non-string path, another extension or folder", () => {
    expect(w(join(up, "visualize", "a.html"), "Edit")).toBe(false);
    expect(w(join(up, "visualize", "a.html"), "Bash")).toBe(false);
    expect(isVisualizeWrite("Write", { file_path: join(up, "visualize", "a.html") }, undefined)).toBe(false);
    expect(w("visualize/a.html")).toBe(false);
    expect(w(42)).toBe(false);
    expect(w(join(up, "visualize", "a.js"))).toBe(false);
    expect(w(join(up, "visualize", "a.html.sh"))).toBe(false);
    expect(w(join(up, "visualize", ".html"))).toBe(false);
    expect(w(join(up, "a.html"))).toBe(false);
    expect(w(join(up, "visualize", "sub", "a.html"))).toBe(false);
    expect(w(join(up, "other", "a.html"))).toBe(false);
    expect(w(join(root, "uploads", "s2", "visualize", "a.html"))).toBe(false);
  });

  it("refuses path traversal and a NUL byte", () => {
    expect(w(`${up}/visualize/../../s2/visualize/a.html`)).toBe(false);
    expect(w(`${up}/visualize/../a.html`)).toBe(false);
    expect(w(`${up}/visualize/./a.html`)).toBe(false);
    expect(w(`${up}/x/../visualize/a.html`)).toBe(false);
    expect(w(`${up}/visualize/a.html\0`)).toBe(false);
  });

  it("refuses a hard link to a file elsewhere", () => {
    mkdirSync(join(up, "visualize"));
    writeFileSync(join(root, "secret.html"), "x");
    linkSync(join(root, "secret.html"), join(up, "visualize", "h.html"));
    expect(w(join(up, "visualize", "h.html"))).toBe(false);
  });

  it("refuses an existing target that is a folder", () => {
    mkdirSync(join(up, "visualize", "d.html"), { recursive: true });
    expect(w(join(up, "visualize", "d.html"))).toBe(false);
  });

  it.runIf(canSymlink)("refuses a symlinked visualize folder or target file", () => {
    mkdirSync(join(root, "elsewhere"));
    symlinkSync(join(root, "elsewhere"), join(up, "visualize"), "dir");
    expect(w(join(up, "visualize", "a.html"))).toBe(false);
    rmSync(join(up, "visualize"));
    mkdirSync(join(up, "visualize"));
    writeFileSync(join(root, "target.html"), "x");
    symlinkSync(join(root, "target.html"), join(up, "visualize", "l.html"));
    expect(w(join(up, "visualize", "l.html"))).toBe(false);
    symlinkSync(join(root, "missing.html"), join(up, "visualize", "dangling.html"));
    expect(w(join(up, "visualize", "dangling.html"))).toBe(false);
  });

  it.runIf(canSymlink)("accepts the path through a symlinked upload folder (e.g. /tmp -> /private/tmp) and its real path", () => {
    const link = join(root, "link");
    symlinkSync(join(root, "uploads"), link, "dir");
    const viaLink = join(link, "s1");
    expect(isVisualizeWrite("Write", { file_path: join(viaLink, "visualize", "a.html") }, viaLink)).toBe(true);
    expect(isVisualizeWrite("Write", { file_path: join(up, "visualize", "a.html") }, viaLink)).toBe(true);
    expect(isVisualizeWrite("Write", { file_path: join(viaLink, "visualize", "a.html") }, up)).toBe(false);
  });
});

describe("visualizeReadable", () => {
  let parent: string;
  beforeEach(() => {
    parent = join(realpathSync(mkdtempSync(join(tmpdir(), "vis-read-"))), "uploads");
    mkdirSync(join(parent, "s1", "visualize"), { recursive: true });
    writeFileSync(join(parent, "s1", "visualize", "a.html"), "<b>a</b>");
    writeFileSync(join(parent, "s1", "b.html"), "x");
  });
  afterEach(() => rmSync(dirname(parent), { recursive: true, force: true }));

  it("reads an existing <parent>/<id>/visualize/<name>.html only", () => {
    expect(visualizeReadable(join(parent, "s1", "visualize", "a.html"), parent)).toBe(join(parent, "s1", "visualize", "a.html"));
    expect(visualizeReadable(join(parent, "s1", "visualize", "missing.html"), parent)).toBeUndefined();
    expect(visualizeReadable(join(parent, "s1", "b.html"), parent)).toBeUndefined();
    expect(visualizeReadable(`${parent}/s1/visualize/../b.html`, parent)).toBeUndefined();
    expect(visualizeReadable(join(dirname(parent), "s1", "visualize", "a.html"), parent)).toBeUndefined();
    expect(visualizeReadable("visualize/a.html", parent)).toBeUndefined();
    expect(visualizeReadable(42, parent)).toBeUndefined();
  });

  it.runIf(canSymlink)("refuses a symlinked file", () => {
    writeFileSync(join(dirname(parent), "secret.html"), "x");
    symlinkSync(join(dirname(parent), "secret.html"), join(parent, "s1", "visualize", "l.html"));
    expect(visualizeReadable(join(parent, "s1", "visualize", "l.html"), parent)).toBeUndefined();
  });

  it.runIf(canSymlink)("refuses a symlinked session folder", () => {
    mkdirSync(join(dirname(parent), "out", "visualize"), { recursive: true });
    writeFileSync(join(dirname(parent), "out", "visualize", "a.html"), "x");
    symlinkSync(join(dirname(parent), "out"), join(parent, "s2"), "dir");
    expect(visualizeReadable(join(parent, "s2", "visualize", "a.html"), parent)).toBeUndefined();
  });
});
