import { describe, expect, it } from "vitest";
import { nameSelection, opErrorText, treeMenuSections } from "./file-tree-menu.ts";

const file = { name: "a.ts", path: "/p/a.ts", isDir: false };
const dir = { name: "src", path: "/p/src", isDir: true };
const ids = (s: ReturnType<typeof treeMenuSections>) => s.map((x) => x.map((e) => e.id));

describe("treeMenuSections (GH-360)", () => {
  it("a file: open, prompt and copy, change", () => {
    expect(ids(treeMenuSections({ kind: "file", entry: file, changed: false }, false))).toEqual([["open", "viewer"], ["mention", "copyPath", "copyRel"], ["rename", "duplicate", "delete"]]);
  });
  it("the file dialog item is named so and left out where there is no dialog", () => {
    const t = { kind: "file", entry: file, changed: false } as const;
    expect(treeMenuSections(t, false)[0]!.find((e) => e.id === "viewer")!.label).toBe("Open in file dialog");
    expect(ids(treeMenuSections(t, false, false))[0]).toEqual(["open"]);
  });
  it("Show changes only for a changed file", () => {
    expect(ids(treeMenuSections({ kind: "file", entry: file, changed: true }, false))[0]).toEqual(["open", "viewer", "changes"]);
  });
  it("a folder: new, copy, change, collapse (disabled when collapsed)", () => {
    const s = treeMenuSections({ kind: "dir", entry: dir, expanded: false }, false);
    expect(ids(s)).toEqual([["newFile", "newFolder"], ["copyPath", "copyRel"], ["rename", "delete"], ["collapse"]]);
    expect(s[3]![0]!.disabled).toBe(true);
    expect(treeMenuSections({ kind: "dir", entry: dir, expanded: true }, false)[3]![0]!.disabled).toBe(false);
  });
  it("the root: new and refresh", () => {
    expect(ids(treeMenuSections({ kind: "root" }, false))).toEqual([["newFile", "newFolder"], ["refresh"]]);
  });
  it("shortcut labels: F2, Del; Cmd+Backspace on a Mac; Delete is destructive; test ids", () => {
    const [, , change] = treeMenuSections({ kind: "file", entry: file, changed: false }, false);
    expect(change!.map((e) => [e.shortcut, e.keys, e.destructive, e.testId])).toEqual([["F2", "F2", undefined, "tree-menu-rename"], [undefined, undefined, undefined, "tree-menu-duplicate"], ["Del", "Delete", true, "tree-menu-delete"]]);
    expect(treeMenuSections({ kind: "file", entry: file, changed: false }, true)[2]![2]!.shortcut).toBe("⌘⌫");
  });
});

describe("opErrorText (GH-360)", () => {
  it("names the entry for the known codes and passes other messages", () => {
    expect(opErrorText("exists", "m", "a.ts")).toBe("A file or folder named “a.ts” already exists here.");
    expect(opErrorText("not_found", "m", "a.ts")).toBe("“a.ts” no longer exists.");
    expect(opErrorText("path_not_allowed", "m", "a.ts")).toContain("outside");
    expect(opErrorText("root_protected", "m", "a")).toContain("project root");
    expect(opErrorText("in_use", "m", "a")).toContain("Close that session");
    expect(opErrorText("too_large", "m", "a")).toContain("512 MB");
    expect(opErrorText("unknown_type", "m", "a")).toContain("older claude-ui");
    expect(opErrorText("bad_name", "A name is required.", "a")).toBe("A name is required.");
    expect(opErrorText("fs_error", "EACCES", "a")).toBe("EACCES");
  });
});

describe("nameSelection (GH-360)", () => {
  it("selects the name without the last extension; all for a folder or dotfile", () => {
    expect(nameSelection("a.test.ts", false)).toEqual([0, 6]);
    expect(nameSelection(".env", false)).toEqual([0, 4]);
    expect(nameSelection("Makefile", false)).toEqual([0, 8]);
    expect(nameSelection("v1.2", true)).toEqual([0, 4]);
  });
});

describe("GH-392 repository folder items", () => {
  const repo = { path: "/p/src", rel: "src", kind: "nested" as const };
  it("a repository folder: Show changes and Show graph first, then the folder items; no Show graph without onShowGraph; a plain folder has neither", () => {
    const t = { kind: "dir", entry: dir, expanded: true, repo } as const;
    expect(ids(treeMenuSections(t, false, true, true))[0]).toEqual(["repoChanges", "repoGraph"]);
    expect(ids(treeMenuSections(t, false, true, true)).slice(1)).toEqual(ids(treeMenuSections({ kind: "dir", entry: dir, expanded: true }, false)));
    expect(ids(treeMenuSections(t, false))[0]).toEqual(["repoChanges"]);
    expect(ids(treeMenuSections({ kind: "dir", entry: dir, expanded: true }, false, true, true)).flat()).not.toContain("repoChanges");
  });
});
