// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { FsGrepResult } from "@claude-ui/protocol";
import { FIND_HISTORY_KEY, loadFindHistory, lineSegments, matchRows, pushFindHistory, saveFindHistory, selectionQuery } from "./find-in-files.ts";

afterEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("history", () => {
  it("ignores blank, dedupes the pair, keeps the newest 20 and survives a reload", () => {
    let h = pushFindHistory([], { query: " ", globs: "" });
    expect(h).toEqual([]);
    h = pushFindHistory(pushFindHistory(h, { query: "a", globs: "" }), { query: "b", globs: "*.ts" });
    h = pushFindHistory(h, { query: "a", globs: "" });
    expect(h.map((e) => e.query)).toEqual(["b", "a"]);
    for (let i = 0; i < 30; i++) h = pushFindHistory(h, { query: `q${i}`, globs: "" });
    expect(h).toHaveLength(20);
    saveFindHistory(h);
    expect(loadFindHistory()).toEqual(h);
    localStorage.setItem(FIND_HISTORY_KEY, "not json");
    expect(loadFindHistory()).toEqual([]);
  });
});

const result: FsGrepResult = {
  files: [
    { path: "a.ts", lines: [{ n: 1, text: "x" }, { n: 2, text: "needle", ranges: [[0, 6]] }, { n: 9, text: "needle needle", ranges: [[0, 6], [7, 13]] }] },
    { path: "b.md", lines: [{ n: 4, text: "needle", ranges: [] }] },
  ],
  matches: 3, ms: 1, includeIgnored: false, git: true,
};

describe("matchRows and lineSegments", () => {
  it("lists match lines only, in order", () => {
    expect(matchRows(result).map((r) => r.key)).toEqual(["a.ts:2", "a.ts:9", "b.md:4"]);
    expect(matchRows(undefined)).toEqual([]);
  });
  it("splits at the ranges", () => {
    expect(lineSegments("ab needle c", [[3, 9]])).toEqual([{ text: "ab ", hit: false }, { text: "needle", hit: true }, { text: " c", hit: false }]);
    expect(lineSegments("plain", [])).toEqual([{ text: "plain", hit: false }]);
    expect(lineSegments("", undefined)).toEqual([{ text: "", hit: false }]);
  });
});

describe("selectionQuery", () => {
  it("reads a text field's selection; multi-line, blank and password give none", () => {
    const input = document.body.appendChild(document.createElement("input"));
    input.value = "foo bar";
    input.setSelectionRange(4, 7);
    expect(selectionQuery(input)).toBe("bar");
    input.setSelectionRange(3, 4);
    expect(selectionQuery(input)).toBeUndefined();
    const ta = document.body.appendChild(document.createElement("textarea"));
    ta.value = "a\nb";
    ta.setSelectionRange(0, 3);
    expect(selectionQuery(ta)).toBeUndefined();
    const pw = document.body.appendChild(document.createElement("input"));
    pw.type = "password";
    pw.value = "secret";
    pw.setSelectionRange(0, 6);
    expect(selectionQuery(pw)).toBeUndefined();
    expect(selectionQuery(document.body)).toBeUndefined();
  });
  it("reads a CodeMirror selection; two lines give none", () => {
    const view = new EditorView({ doc: "foo bar\nbaz", parent: document.body });
    view.dispatch({ selection: { anchor: 4, head: 7 } });
    expect(selectionQuery(view.contentDOM)).toBe("bar");
    view.dispatch({ selection: { anchor: 4, head: 10 } });
    expect(selectionQuery(view.contentDOM)).toBeUndefined();
    view.destroy();
  });
});
