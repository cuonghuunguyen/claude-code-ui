// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { FilesPanel } from "./files-panel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("watches the extra paths (the changes tab's files) with its editor tabs, on its one fs.watch list", async () => {
  const request = vi.fn(async (m: { type: string }) => (m.type === "fs.list" ? { entries: [] } : {}));
  const client = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} watch={["/p/a.ts"]} />));
  const watches = request.mock.calls.map(([m]) => m).filter((m) => m.type === "fs.watch");
  expect(watches.at(-1)).toEqual({ type: "fs.watch", paths: ["/p/a.ts"] });
  act(() => root.render(null));
});

it("editor keys: Ctrl+L selects the line and stays with the editor; Ctrl+S saves; Ctrl+Shift+S (also as a lowercase key) is left to the app", async () => {
  const { EditorState, EditorSelection } = await import("@codemirror/state");
  const { EditorView, keymap, runScopeHandlers } = await import("@codemirror/view");
  const { editorKeys } = await import("./files-panel.tsx");
  const onSave = vi.fn();
  const view = new EditorView({ state: EditorState.create({ doc: "one\ntwo", selection: EditorSelection.cursor(5), extensions: keymap.of(editorKeys({ onSave, onSend: () => {} })) }) });
  const key = (key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, cancelable: true, ...init });
    // Handled: CodeMirror's keydown handler calls preventDefault, so the app's shortcut skips the key.
    return runScopeHandlers(view, e, "editor");
  };
  expect(key("l")).toBe(true);
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("two");
  expect(key("s")).toBe(true);
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(key("S", { shiftKey: true })).toBe(false);
  expect(key("s", { shiftKey: true })).toBe(false);
  expect(onSave).toHaveBeenCalledTimes(1);
  view.destroy();
});
