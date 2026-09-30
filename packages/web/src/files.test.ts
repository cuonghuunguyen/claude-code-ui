import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { diskChanged, docText, inDir, isDirty, lineBreaks, opened, reload, replaceDoc, saved } from "./files.ts";

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
