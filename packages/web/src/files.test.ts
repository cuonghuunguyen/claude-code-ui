import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { inDir } from "./paths.ts";
import { mediaKind, readFailure, diskChanged, docText, isDirty, lineBreaks, opened, reload, replaceDoc, saveBase, saved, selectionMention } from "./files.ts";

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
    expect(fail("binary", 1536)).toEqual({ text: "Binary file, not shown (1.5 KB)", notice: true });
    expect(fail("too_large", 3 * 1024 ** 2)).toEqual({ text: "File too large to show (3 MB)", notice: true });
    expect(fail("not_utf8", 6)).toEqual({ text: "File is not UTF-8 text, not shown (6 B)", notice: true });
    expect(fail("binary")).toEqual({ text: "Binary file, not shown", notice: true });
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
  it("readFailure: side_unsupported is a notice with its message", () => {
    expect(readFailure(Object.assign(new Error("Preview is not available for files in WSL"), { code: "side_unsupported" }))).toEqual({ text: "Preview is not available for files in WSL", notice: true });
  });
});
