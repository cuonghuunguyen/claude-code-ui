import { describe, expect, it } from "vitest";
import { nameSelection, opErrorText, treeMenuSections } from "./file-tree-menu.ts";

const file = { name: "a.ts", path: "/p/a.ts", isDir: false };
const dir = { name: "src", path: "/p/src", isDir: true };
const ids = (s: ReturnType<typeof treeMenuSections>) => s.map((x) => x.map((e) => e.id));

describe("treeMenuSections (GH-360)", () => {
  it("a file: open, prompt and copy, change", () => {
    expect(ids(treeMenuSections({ kind: "file", entry: file, changed: false }, false))).toEqual([["open", "openTab", "viewer"], ["cut", "copy"], ["mention", "copyPath", "copyRel"], ["rename", "duplicate", "delete"]]);
  });
  it("the file dialog item is named so and left out where there is no dialog", () => {
    const t = { kind: "file", entry: file, changed: false } as const;
    expect(treeMenuSections(t, false)[0]!.find((e) => e.id === "viewer")!.label).toBe("Open in file dialog");
    expect(ids(treeMenuSections(t, false, false))[0]).toEqual(["open", "openTab"]);
  });
  it("Show changes only for a changed file", () => {
    expect(ids(treeMenuSections({ kind: "file", entry: file, changed: true }, false))[0]).toEqual(["open", "openTab", "viewer", "changes"]);
  });
  it("a folder: new, copy, change, collapse (disabled when collapsed)", () => {
    const s = treeMenuSections({ kind: "dir", entry: dir, expanded: false }, false);
    expect(ids(s)).toEqual([["newFile", "newFolder"], ["cut", "copy", "paste"], ["mention", "copyPath", "copyRel"], ["rename", "delete"], ["collapse"]]);
    expect(s[4]![0]!.disabled).toBe(true);
    expect(treeMenuSections({ kind: "dir", entry: dir, expanded: true }, false)[4]![0]!.disabled).toBe(false);
  });
  it("the root: new and refresh", () => {
    expect(ids(treeMenuSections({ kind: "root" }, false))).toEqual([["newFile", "newFolder"], ["paste"], ["refresh"]]);
  });
  it("shortcut labels: F2, Del; Cmd+Backspace on a Mac; Delete is destructive; test ids", () => {
    const [, , , change] = treeMenuSections({ kind: "file", entry: file, changed: false }, false);
    expect(change!.map((e) => [e.shortcut, e.keys, e.destructive, e.testId])).toEqual([["F2", "F2", undefined, "tree-menu-rename"], [undefined, undefined, undefined, "tree-menu-duplicate"], ["Del", "Delete", true, "tree-menu-delete"]]);
    expect(treeMenuSections({ kind: "file", entry: file, changed: false }, true)[3]![2]!.shortcut).toBe("⌘⌫");
  });
});

describe("cut, copy, paste (GH-555)", () => {
  const flat = (s: ReturnType<typeof treeMenuSections>) => s.flat();
  it("shortcut labels per platform; Paste is disabled with an empty clipboard and on for a folder and the root", () => {
    const d = { kind: "dir", entry: dir, expanded: true } as const;
    const pick = (mac: boolean, canPaste: boolean) => Object.fromEntries(flat(treeMenuSections(d, mac, true, false, true, canPaste)).filter((e) => ["cut", "copy", "paste"].includes(e.id)).map((e) => [e.id, e]));
    expect(pick(false, false).cut!.shortcut).toBe("Ctrl+X");
    expect(pick(false, false).copy!.keys).toBe("Control+C");
    expect(pick(true, true).paste!.shortcut).toBe("⌘V");
    expect(pick(true, true).paste!.keys).toBe("Meta+V");
    expect(pick(false, false).paste!.disabled).toBe(true);
    expect(pick(false, true).paste!.disabled).toBe(false);
    expect(flat(treeMenuSections({ kind: "file", entry: file, changed: false }, false)).some((e) => e.id === "paste")).toBe(false);
    expect(flat(treeMenuSections({ kind: "root" }, false, true, false, true, true)).find((e) => e.id === "paste")!.disabled).toBeFalsy();
  });
  it("error texts of the new refusals", () => {
    expect(opErrorText("too_many", "m", "a")).toContain("10,000");
    expect(opErrorText("into_itself", "m", "a")).toContain("itself");
    expect(opErrorText("conflict", "m", "a")).toContain("changed");
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

it("GH-399 a file offers Open in tab after Open, left out where there is no tab", () => {
  const t = { kind: "file", entry: { name: "a.ts", path: "/p/a.ts", type: "file" }, changed: false } as never;
  expect(treeMenuSections(t, false)[0]!.map((e) => e.id)).toEqual(["open", "openTab", "viewer"]);
  expect(treeMenuSections(t, false)[0]![1]!.label).toBe("Open in tab");
  expect(treeMenuSections(t, false, true, false, false)[0]!.map((e) => e.id)).toEqual(["open", "viewer"]);
});
