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

it("opening a binary, too large or not UTF-8 file shows its state in the viewer, no raw error, and keeps the open tabs", async () => {
  const states: Record<string, [string, number]> = { "/p/a.png": ["binary", 2048], "/p/big.log": ["too_large", 5 * 1024 ** 2], "/p/u16.txt": ["not_utf8", 10] };
  const request = vi.fn(async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list") return { entries: [] };
    if (m.type !== "fs.read") return {};
    const s = states[m.path!];
    if (!s) return { content: "ok", mtime: 1 };
    throw Object.assign(new Error(`${s[0]} raw: ${m.path}`), { code: s[0], size: s[1] });
  });
  const client = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  const show = (openPath: string) => act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} openPath={openPath} />));
  await show("/p/ok.txt");
  for (const [path, text] of [["/p/a.png", "Binary file, not shown (2 KB)"], ["/p/big.log", "File too large to show (5 MB)"], ["/p/u16.txt", "File is not UTF-8 text, not shown (10 B)"]]) {
    await show(path!);
    const notice = el.querySelector("[data-testid=file-notice]")!;
    expect(notice.textContent).toContain(text);
    expect(notice.textContent).toContain(path!.slice(3));
    expect(el.textContent).not.toMatch(/raw:|too_large|not_utf8/);
  }
  expect(el.querySelectorAll("[data-testid=editor-tab]")).toHaveLength(1);
  expect(el.querySelector("[data-testid=file-notice]")!.getAttribute("role")).toBe("status");
  // The notice is the current view: the tab strip does not mark the previous tab as selected.
  expect(el.querySelector("[data-testid=editor-tab]")!.getAttribute("aria-selected")).toBe("false");
  // Choosing the open tab again replaces the notice with its editor.
  await act(async () => (el.querySelector<HTMLButtonElement>("[data-testid=editor-tab] button")!.click(), undefined));
  expect(el.querySelector("[data-testid=file-notice]")).toBeNull();
  act(() => root.render(null));
});

it("an open clean tab whose file turns binary shows the notice instead of the stale text; a dirty one keeps its edits and shows the line", async () => {
  let binary = false;
  let changed = (_: { path: string }) => {};
  const request = vi.fn(async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list") return { entries: [] };
    if (m.type !== "fs.read") return {};
    if (binary) throw Object.assign(new Error("binary raw"), { code: "binary", size: 2048 });
    return { content: "export const x = 1;", mtime: 1 };
  });
  const client = { request, onFsChanged: (f: typeof changed) => ((changed = f), () => {}) } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} openPath="/p/main.ts" />));
  expect(el.querySelector("[data-testid=code-editor]")).not.toBeNull();
  binary = true;
  await act(async () => changed({ path: "/p/main.ts" }));
  expect(el.querySelector("[data-testid=file-notice]")!.textContent).toContain("Binary file, not shown (2 KB)");
  expect(el.querySelector("[data-testid=code-editor]")).toBeNull();
  expect(el.textContent).not.toContain("export const x");
  // Back to text: the editor returns with the new content.
  binary = false;
  await act(async () => changed({ path: "/p/main.ts" }));
  expect(el.querySelector("[data-testid=file-notice]")).toBeNull();
  expect(el.querySelector("[data-testid=code-editor]")).not.toBeNull();
  act(() => root.render(null));
});

it("a dirty tab whose file turns binary keeps the editor and its draft, with the state as a line", async () => {
  let binary = false;
  let changed = (_: { path: string }) => {};
  const request = vi.fn(async (m: { type: string }) => {
    if (m.type === "fs.list") return { entries: [] };
    if (m.type !== "fs.read") return {};
    if (binary) throw Object.assign(new Error("binary raw"), { code: "binary", size: 2048 });
    return { content: "one", mtime: 1 };
  });
  const client = { request, onFsChanged: (f: typeof changed) => ((changed = f), () => {}) } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} openPath="/p/main.ts" />));
  const { EditorView } = await import("@codemirror/view");
  const view = EditorView.findFromDOM(el.querySelector<HTMLElement>("[data-testid=code-editor] .cm-editor")!)!;
  await act(async () => view.dispatch({ changes: { from: 3, insert: "!" } }));
  binary = true;
  await act(async () => changed({ path: "/p/main.ts" }));
  expect(el.querySelector("[data-testid=code-editor]")).not.toBeNull();
  expect(el.textContent).toContain("Binary file, not shown (2 KB)");
  expect(el.querySelector("[data-testid=file-notice]")).toBeNull();
  act(() => root.render(null));
});
