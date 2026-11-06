import { describe, expect, it } from "vitest";
import { externalEntries, externalHow, isExternalId } from "./open-external-menu.ts";
import { treeMenuSections } from "./file-tree-menu.ts";

const editors = [{ id: "code" as const, label: "VS Code" }, { id: "idea" as const, label: "IntelliJ IDEA" }];
const labels = (o: Parameters<typeof externalEntries>[0]) => externalEntries(o).map((e) => e.label);

describe("externalEntries (GH-612)", () => {
  it("a file: reveal named by the OS, detected editors, default app", () => {
    expect(labels({ isDir: false, editors, platform: "mac" })).toEqual(["Reveal in Finder", "Open in VS Code", "Open in IntelliJ IDEA", "Open with Default App"]);
    expect(labels({ isDir: false, editors: [], platform: "win" })).toEqual(["Reveal in File Explorer", "Open with Default App"]);
    expect(labels({ isDir: false, editors: [], platform: "other" })).toEqual(["Open Containing Folder", "Open with Default App"]);
  });
  it("a folder has no default app", () => expect(labels({ isDir: true, editors, platform: "mac" })).toEqual(["Reveal in Finder", "Open in VS Code", "Open in IntelliJ IDEA"]));
  it("deleted: every entry disabled; ids round-trip", () => {
    const e = externalEntries({ isDir: false, editors, disabled: true, platform: "mac" });
    expect(e.every((x) => x.disabled)).toBe(true);
    expect(isExternalId(e[1]!.id) && externalHow(e[1]!.id)).toBe("code");
    expect(isExternalId("copyPath")).toBe(false);
  });
});

describe("treeMenuSections with the section", () => {
  const ext = externalEntries({ isDir: false, editors: [], platform: "mac" });
  const ids = (s: ReturnType<typeof treeMenuSections>) => s.map((x) => x.map((e) => e.id));
  it("one section after the copy section; none without entries", () => {
    const f = { kind: "file", entry: { name: "a", path: "/p/a", isDir: false }, changed: false } as const;
    expect(ids(treeMenuSections(f, false, true, false, true, false, ext))[3]).toEqual(["ext:reveal", "ext:default"]);
    expect(treeMenuSections(f, false)).toHaveLength(4);
    expect(ids(treeMenuSections({ kind: "root" }, false, true, false, true, false, ext))[2]).toEqual(["ext:reveal", "ext:default"]);
  });
});
