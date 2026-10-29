import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { inDir } from "./paths.ts";
import { goneTab, restoredTab, mediaKind, pin, placeTab, readFailure, type Tab, diskChanged, docText, isDirty, lineBreaks, opened, reload, replaceDoc, saveBase, saved, selectionMention, fileMention, moveTabs, dropTabs, movedPath } from "./files.ts";

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

  it("reload clears the error of the save that hit the conflict", () => {
    const t = diskChanged({ ...tab, draft: "mine", error: "changed on disk" }, { content: "claude", mtime: 2 });
    expect(reload(t).error).toBeUndefined();
  });

  it("ignores its own save and a change that leaves the content as it was", () => {
    const edited = { ...tab, draft: "two" };
    const s = saved(edited, "two", 5);
    expect(s).toMatchObject({ disk: "two", mtime: 5 });
    // Typing continued after the save; the watcher then reports the save's mtime.
    expect(diskChanged({ ...s, draft: "two!" }, { content: "two", mtime: 5 })).toEqual({ ...s, draft: "two!" });
    expect(diskChanged(edited, { content: "one", mtime: 9 })).toEqual({ ...edited, mtime: 9 });
  });

  it("a plain save of a tab in conflict writes against its own version (the daemon refuses it); only Overwrite with mine takes the disk version", () => {
    const t = diskChanged({ ...tab, draft: "mine" }, { content: "claude", mtime: 2 });
    expect(saveBase(t, false)).toBe(1);
    expect(saveBase(t, true)).toBe(2);
    expect(saveBase(tab, true)).toBe(1);
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

describe("editor document", () => {
  const insert = (s: EditorState, at: number, text: string) => s.update({ changes: { from: at, insert: text } }).state;

  it("keeps the file's line breaks through edits, Enter and a reload", () => {
    let s = EditorState.create({ doc: "a\r\nb\r\n", extensions: lineBreaks("a\r\nb\r\n") });
    s = insert(s, 0, "x");
    s = insert(s, s.doc.length, `c${s.lineBreak}`);
    expect(docText(s)).toBe("xa\r\nb\r\nc\r\n");
    // A reload that converts the file to LF, then back to CRLF.
    s = s.update(replaceDoc(s, "d\ne")).state;
    expect(docText(s)).toBe("d\ne");
    s = s.update(replaceDoc(s, "f\r\ng\r\n")).state;
    expect(docText(s)).toBe("f\r\ng\r\n");
  });

  it("keeps mixed and lone-CR line breaks, an empty file and a missing final newline as they are", () => {
    for (const doc of ["a\r\nb\nc", "a\rb", "", "no newline"]) {
      const s = EditorState.create({ doc, extensions: lineBreaks(doc) });
      expect(docText(insert(s, 0, ""))).toBe(doc);
      expect(docText(s.update(replaceDoc(s, doc)).state)).toBe(doc);
    }
  });
});

describe("selectionMention", () => {
  const at = (doc: string, anchor: number, head = anchor) => EditorState.create({ doc, selection: { anchor, head } });
  const doc = "one\ntwo\nthree\nfour\n";

  it("is @path#Lstart-end relative to cwd, for a selection across lines", () => {
    expect(selectionMention(at(doc, 5, 10), "/p/src/a.ts", "/p")).toBe("@src/a.ts#L2-3");
    expect(selectionMention(at(doc, 10, 5), "/p/src/a.ts", "/p")).toBe("@src/a.ts#L2-3");
  });

  it("a Windows path is relative to cwd without case, in forward slashes", () => {
    expect(selectionMention(at(doc, 5, 10), "C:\\p\\src\\a.ts", "c:\\P")).toBe("@src/a.ts#L2-3");
  });

  it("is one line number for a selection inside a line", () => {
    expect(selectionMention(at(doc, 4, 6), "/p/a.ts", "/p")).toBe("@a.ts#L2");
  });

  it("leaves out the line where the selection ends at column 0", () => {
    expect(selectionMention(at(doc, 4, 8), "/p/a.ts", "/p")).toBe("@a.ts#L2");
    expect(selectionMention(at(doc, 0, 14), "/p/a.ts", "/p")).toBe("@a.ts#L1-3");
  });

  it("is the file only without a selection", () => {
    expect(selectionMention(at(doc, 5), "/p/a.ts", "/p")).toBe("@a.ts");
  });

  it("keeps a path outside cwd absolute and quotes a path with spaces, range inside the quotes", () => {
    expect(selectionMention(at(doc, 0, 2), "/q/a.ts", "/p")).toBe("@/q/a.ts#L1");
    expect(selectionMention(at(doc, 0, 2), "/p/my file.md", "/p")).toBe('@"my file.md#L1"');
  });
});

describe("readFailure", () => {
  const fail = (code: string, size?: number) => readFailure(Object.assign(new Error(`${code}: /p/x raw`), { code, size }));
  it("words each unshowable file, with its size, without the raw code", () => {
    expect(fail("binary", 1536)).toEqual({ text: "Binary file, not shown (1.5 KB)", notice: true, hint: "Only text files open in the editor." });
    expect(fail("too_large", 3 * 1024 ** 2)).toEqual({ text: "File too large to show (3 MB)", notice: true, hint: "The editor opens text files up to 2 MB." });
    expect(fail("not_utf8", 6)).toEqual({ text: "File is not UTF-8 text, not shown (6 B)", notice: true, hint: "The editor opens UTF-8 text only." });
    expect(fail("binary")).toEqual({ text: "Binary file, not shown", notice: true, hint: "Only text files open in the editor." });
  });
  it("passes a real error through", () => {
    expect(fail("fs_error")).toEqual({ text: "fs_error: /p/x raw", notice: false });
  });
});

describe("media", () => {
  it("mediaKind maps the allowlist (case-insensitive), ogg audio, ogv video, svg own kind, text files undefined", () => {
    expect(mediaKind("/p/A.PNG")).toBe("image");
    expect(mediaKind("/p/a.jpeg")).toBe("image");
    expect(mediaKind("/p/a.svg")).toBe("svg");
    expect(mediaKind("/p/a.mp4")).toBe("video");
    expect(mediaKind("/p/a.ogv")).toBe("video");
    expect(mediaKind("/p/a.ogg")).toBe("audio");
    expect(mediaKind("C:\\p\\a.MP3")).toBe("audio");
    for (const p of ["/p/a.ts", "/p/a.html", "/p/noext", "/p.png/file", "/p/a.constructor"]) expect(mediaKind(p)).toBeUndefined();
  });
});

describe("placeTab", () => {
  const tab = (path: string, preview?: boolean): Tab => ({ path, disk: "", draft: "", mtime: 1, ...(preview && { preview }) });
  const scope = (p: string) => inDir(p, "/p");
  const set = (...ts: Tab[]) => Object.fromEntries(ts.map((t) => [t.path, t]));

  it("a preview open replaces the previous preview tab at its position", () => {
    const tabs = set(tab("/p/a.ts"), tab("/p/b.ts", true), tab("/p/c.ts"));
    const next = placeTab(tabs, tab("/p/d.ts"), true, scope);
    expect(Object.keys(next)).toEqual(["/p/a.ts", "/p/d.ts", "/p/c.ts"]);
    expect(next["/p/d.ts"]!.preview).toBe(true);
    expect(Object.keys(placeTab(set(tab("/p/a.ts")), tab("/p/d.ts"), true, scope))).toEqual(["/p/a.ts", "/p/d.ts"]);
  });

  it("a pinned open adds a regular tab and keeps the preview; on an open preview tab it pins it; a preview open of an open tab changes nothing", () => {
    const tabs = set(tab("/p/b.ts", true));
    const added = placeTab(tabs, tab("/p/d.ts"), false, scope);
    expect(added["/p/d.ts"]!.preview).toBeUndefined();
    expect(added["/p/b.ts"]!.preview).toBe(true);
    expect(placeTab(tabs, tab("/p/b.ts"), false, scope)["/p/b.ts"]!.preview).toBeUndefined();
    expect(placeTab(tabs, tab("/p/b.ts"), true, scope)).toBe(tabs);
    expect(pin(tab("/p/x.ts"))).toEqual(tab("/p/x.ts"));
  });

  it("a preview tab outside the scope is left alone", () => {
    const tabs = set(tab("/q/b.ts", true));
    const next = placeTab(tabs, tab("/p/d.ts"), true, scope);
    expect(Object.keys(next)).toEqual(["/q/b.ts", "/p/d.ts"]);
    expect(next["/q/b.ts"]!.preview).toBe(true);
  });
});

describe("fileMention (GH-360)", () => {
  it("is the path relative to cwd as an @-mention; a Windows path with /; a space is quoted", () => {
    expect(fileMention("/p/src/a.ts", "/p")).toBe("@src/a.ts");
    expect(fileMention("C:\\p\\src\\a.ts", "C:\\p")).toBe("@src/a.ts");
    expect(fileMention("/p/my file.ts", "/p")).toBe('@"my file.ts"');
  });
});

describe("moveTabs and dropTabs (GH-360)", () => {
  const t = (path: string, draft?: string): Tab => ({ ...opened(path, { content: "one", mtime: 1 }), ...(draft !== undefined && { draft }) });
  const tabs = { "/p/a.ts": t("/p/a.ts", "edited"), "/p/src/b.ts": t("/p/src/b.ts"), "/p/src2/c.ts": t("/p/src2/c.ts") };
  it("moveTabs renames a file tab keeping its draft and order", () => {
    const m = moveTabs(tabs, "/p/a.ts", "/p/z.ts");
    expect(Object.keys(m)).toEqual(["/p/z.ts", "/p/src/b.ts", "/p/src2/c.ts"]);
    expect(m["/p/z.ts"]).toMatchObject({ path: "/p/z.ts", draft: "edited" });
  });
  it("moveTabs moves every tab below a renamed folder, not a sibling with the same prefix", () => {
    const m = moveTabs(tabs, "/p/src", "/p/lib");
    expect(Object.keys(m)).toEqual(["/p/a.ts", "/p/lib/b.ts", "/p/src2/c.ts"]);
    expect(m["/p/lib/b.ts"]!.path).toBe("/p/lib/b.ts");
    expect(movedPath("/p/src/b.ts", "/p/src", "/p/lib")).toBe("/p/lib/b.ts");
    expect(movedPath("/p/src2/c.ts", "/p/src", "/p/lib")).toBe("/p/src2/c.ts");
  });
  it("dropTabs closes clean tabs below the path and keeps a tab with unsaved edits", () => {
    expect(Object.keys(dropTabs(tabs, "/p/src"))).toEqual(["/p/a.ts", "/p/src2/c.ts"]);
    expect(Object.keys(dropTabs(tabs, "/p/a.ts"))).toEqual(["/p/a.ts", "/p/src/b.ts", "/p/src2/c.ts"]);
  });
});

describe("restoredTab (GH-366)", () => {
  const r = { content: "disk", mtime: 5 };
  it.each([
    ["no draft", undefined, { draft: "disk", conflict: undefined }],
    ["draft equal to disk", { draft: "disk", mtime: 1 }, { draft: "disk", conflict: undefined }],
    ["draft, same mtime", { draft: "mine", mtime: 5 }, { draft: "mine", conflict: undefined }],
    ["draft, other mtime", { draft: "mine", mtime: 4 }, { draft: "mine", conflict: r }],
  ])("%s", (_n, d, want) => {
    const t = restoredTab("/p/a.ts", r, d);
    expect(t).toMatchObject({ path: "/p/a.ts", disk: "disk", mtime: 5, draft: want.draft });
    expect(t.conflict).toEqual(want.conflict);
  });

  it("a draft on a changed file keeps its conflict after the post-watch refresh, and Save stays refused", () => {
    const t = restoredTab("/p/a.ts", r, { draft: "mine", mtime: 4 });
    expect(diskChanged(t, r)).toBe(t);
    expect(saveBase(t, false)).toBe(5);
    expect(saveBase(t, true)).toBe(5);
  });

  it("goneTab is dirty with the line; a file that comes back becomes a conflict", () => {
    const t = goneTab("/p/a.ts", { draft: "mine" });
    expect(isDirty(t)).toBe(true);
    expect(t).toMatchObject({ gone: true, error: "Deleted on disk. Save creates it again." });
    expect(diskChanged(t, r)).toMatchObject({ draft: "mine", conflict: r, gone: undefined, error: undefined });
  });
});
