// @vitest-environment jsdom
import { EditorView } from "codemirror";
import { expect, it } from "vitest";
import "./files-panel.tsx"; // registers the editor lookup (setEditorOf) that find-in-files.ts uses
import { selectionQuery } from "./find-in-files.ts";

it("loading the Files panel makes Find in files read the selection of a focused editor (GH-775)", () => {
  const view = new EditorView({ doc: "foo bar\nbaz", parent: document.body });
  view.dispatch({ selection: { anchor: 4, head: 7 } });
  expect(selectionQuery(view.contentDOM)).toBe("bar");
  view.destroy();
});
