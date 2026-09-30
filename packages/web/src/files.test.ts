import { describe, expect, it } from "vitest";
import { diskChanged, inDir, isDirty, opened, reload, saved } from "./files.ts";

const tab = opened("/p/a.ts", { content: "one", mtime: 1 });

describe("editor tab", () => {
  it("is dirty while the draft differs from the disk version", () => {
    expect(isDirty(tab)).toBe(false);
    expect(isDirty({ ...tab, draft: "two" })).toBe(true);
  });

  it("reloads a clean tab when the file changes on disk", () => {
    expect(diskChanged(tab, { content: "claude", mtime: 2 })).toMatchObject({ disk: "claude", draft: "claude", mtime: 2 });
  });

  it("keeps unsaved edits and shows a conflict when the file changes on disk; reload takes the disk version", () => {
    const t = diskChanged({ ...tab, draft: "mine" }, { content: "claude", mtime: 2 });
    expect(t).toMatchObject({ draft: "mine", disk: "one", mtime: 1, conflict: { content: "claude", mtime: 2 } });
    expect(reload(t)).toMatchObject({ draft: "claude", disk: "claude", mtime: 2, conflict: undefined });
  });

  it("ignores its own save and a change that leaves the content as it was", () => {
    const edited = { ...tab, draft: "two" };
    const s = saved(edited, "two", 5);
    expect(s).toMatchObject({ disk: "two", mtime: 5 });
    // Typing continued after the save; the watcher then reports the save's mtime.
    expect(diskChanged({ ...s, draft: "two!" }, { content: "two", mtime: 5 })).toEqual({ ...s, draft: "two!" });
    expect(diskChanged(edited, { content: "one", mtime: 9 })).toEqual({ ...edited, mtime: 9 });
  });

  it("saving over a conflict clears it", () => {
    const t = diskChanged({ ...tab, draft: "mine" }, { content: "claude", mtime: 2 });
    expect(saved(t, "mine", 3)).toMatchObject({ disk: "mine", draft: "mine", mtime: 3, conflict: undefined });
  });
});

describe("inDir", () => {
  it("matches the directory and paths below it only", () => {
    expect(inDir("/p/x/a.ts", "/p/x")).toBe(true);
    expect(inDir("/p/xy/a.ts", "/p/x")).toBe(false);
    expect(inDir("/p/x", "/p/x")).toBe(true);
  });
});
