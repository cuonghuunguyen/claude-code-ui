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
  await act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} watch={["/p/a.ts"]} />));
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
  const states: Record<string, [string, number]> = { "/p/a.bin": ["binary", 2048], "/p/big.log": ["too_large", 5 * 1024 ** 2], "/p/u16.txt": ["not_utf8", 10] };
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
  const show = (openPath: string) => act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} openPath={openPath} />));
  await show("/p/ok.txt");
  for (const [path, text] of [["/p/a.bin", "Binary file, not shown (2 KB)"], ["/p/big.log", "File too large to show (5 MB)"], ["/p/u16.txt", "File is not UTF-8 text, not shown (10 B)"]]) {
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
  await act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} openPath="/p/main.ts" />));
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
  await act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} openPath="/p/main.ts" />));
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

it("the editor follows the app theme: dark chrome while `.dark` is on <html>, switching live; syntax colors are the --syntax-* tokens", async () => {
  const request = vi.fn(async (m: { type: string }) => (m.type === "fs.list" ? { entries: [] } : m.type === "fs.read" ? { content: "def f(): return 1", mtime: 1 } : {}));
  const client = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} openPath="/p/app.py" />));
  const { EditorView } = await import("@codemirror/view");
  const { highlightingFor } = await import("@codemirror/language");
  const { tags } = await import("@lezer/highlight");
  const { syntaxStyle } = await import("./files-panel.tsx");
  const view = EditorView.findFromDOM(el.querySelector<HTMLElement>("[data-testid=code-editor] .cm-editor")!)!;
  expect(view.state.facet(EditorView.darkTheme)).toBe(false);
  await act(async () => document.documentElement.classList.add("dark"));
  expect(view.state.facet(EditorView.darkTheme)).toBe(true);
  await act(async () => document.documentElement.classList.remove("dark"));
  expect(view.state.facet(EditorView.darkTheme)).toBe(false);
  expect(highlightingFor(view.state, [tags.keyword])).toBe(syntaxStyle.style([tags.keyword]));
  expect(syntaxStyle.module!.getRules()).toContain("var(--syntax-keyword)");
  act(() => root.render(null));
});

it("markdown: headings and quotes take --syntax-constant (OpenCode markup.heading/quote: syntax-info), marks --syntax-comment, fenced code its own language colors", async () => {
  const md = "# Title\n\n> quote\n\n```python\ndef f():\n    return 1\n```\n";
  const request = vi.fn(async (m: { type: string }) => (m.type === "fs.list" ? { entries: [] } : m.type === "fs.read" ? { content: md, mtime: 1 } : {}));
  const client = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} openPath="/p/README.md" />));
  const { EditorView } = await import("@codemirror/view");
  const { ensureSyntaxTree, highlightingFor } = await import("@codemirror/language");
  const { tags } = await import("@lezer/highlight");
  const { syntaxStyle } = await import("./files-panel.tsx");
  const view = EditorView.findFromDOM(el.querySelector<HTMLElement>("[data-testid=code-editor] .cm-editor")!)!;
  const rules = syntaxStyle.module!.getRules();
  const colorOf = (tag: Parameters<typeof highlightingFor>[1]) => {
    const cls = highlightingFor(view.state, tag)!;
    return new RegExp(`\\.${cls} \\{[^}]*color: (var\\(--[\\w-]+\\))`).exec(rules)?.[1];
  };
  expect(colorOf([tags.heading1])).toBe("var(--syntax-constant)");
  expect(colorOf([tags.quote])).toBe("var(--syntax-constant)");
  expect(colorOf([tags.processingInstruction])).toBe("var(--syntax-comment)");
  act(() => root.render(null));
  const { loadLanguage } = await import("./files-panel.tsx");
  const { languages } = await import("@codemirror/language-data");
  const { EditorState } = await import("@codemirror/state");
  await languages.find((l) => l.name === "Python")!.load();
  const state = EditorState.create({ doc: md, extensions: await loadLanguage("/p/README.md")! });
  // Tables as in OpenCode (no Shiki theme scope for markup.table or its separators): header cells and pipes keep the text color.
  const { highlightTree } = await import("@lezer/highlight");
  const table = "| a | b |\n|---|---|\n| 1 | 2 |\n";
  const tableState = EditorState.create({ doc: table, extensions: await loadLanguage("/p/README.md")! });
  const styled: string[] = [];
  highlightTree(ensureSyntaxTree(tableState, table.length, 5000)!, syntaxStyle, (from, to) => void styled.push(table.slice(from, to)));
  expect(styled).toEqual([]);
  // The fenced block is a mounted Python tree: the node at `def` is Python's keyword, not markdown CodeText.
  expect(ensureSyntaxTree(state, state.doc.length, 5000)!.resolveInner(md.indexOf("def") + 1, 1).name).toBe("def");
});

it("autocomplete popup and search panel use the app tokens: popover, selected row on --secondary with a --foreground left bar (3:1 indicator), flex rows that do not wrap single labels", async () => {
  const { chromeTheme } = await import("./files-panel.tsx");
  const s = JSON.stringify(chromeTheme);
  expect(chromeTheme[".cm-tooltip"]).toMatchObject({ backgroundColor: "var(--popover)", color: "var(--popover-foreground)" });
  expect(chromeTheme[".cm-tooltip-autocomplete ul li[aria-selected]"]).toMatchObject({ background: "var(--secondary)", color: "var(--secondary-foreground)", boxShadow: "inset 2px 0 0 var(--foreground)" });
  expect(chromeTheme[".cm-panel.cm-search"]).toMatchObject({ display: "flex", flexWrap: "wrap" });
  expect(s).toContain("accentColor");
  expect(s).not.toMatch(/#[0-9a-f]{3,8}\b/i);
});

it("touch (pointer: coarse, the repo's pointer-coarse rule): autocomplete rows, search buttons, fields, option labels and close are 44px targets; desktop sizes untouched", async () => {
  const { chromeTheme } = await import("./files-panel.tsx");
  const coarse: Record<string, object> = chromeTheme["@media (pointer: coarse)"];
  for (const sel of [".cm-tooltip.cm-tooltip-autocomplete > ul > li", ".cm-panel.cm-search .cm-button", ".cm-panel.cm-search .cm-textfield", ".cm-panel.cm-search label"])
    expect(coarse[sel], sel).toMatchObject({ minHeight: "44px" });
  expect(coarse[".cm-panel.cm-search [name=close]"]).toMatchObject({ minWidth: "44px", minHeight: "44px", position: "static" });
  expect(JSON.stringify({ ...chromeTheme, "@media (pointer: coarse)": undefined })).not.toContain("44px");
});

it("the tree follows showTree; the Files button asks to toggle it", async () => {
  const client = { request: vi.fn(async (m: { type: string }) => (m.type === "fs.list" ? { entries: [] } : {})), onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  const onToggleTree = vi.fn();
  const show = (showTree: boolean) => act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree={showTree} onToggleTree={onToggleTree} />));
  await show(false);
  const btn = () => el.querySelector('[data-testid="toggle-tree"]')!;
  expect(el.querySelector('[data-testid="file-tree"]')).toBeNull();
  expect(btn().getAttribute("aria-expanded")).toBe("false");
  expect(btn().getAttribute("aria-controls")).toBe("file-tree");
  await act(async () => (btn() as HTMLElement).click());
  expect(onToggleTree).toHaveBeenCalledOnce();
  await show(true);
  expect(el.querySelector("nav#file-tree")).not.toBeNull();
  expect(btn().getAttribute("aria-expanded")).toBe("true");
  act(() => root.render(null));
});

/** A panel whose fs.media answers per path; fs.read answers text. */
function mediaPanel(opts: { media?: (path: string) => unknown; read?: string } = {}) {
  let changed = (_: { path: string }) => {};
  const request = vi.fn(async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list") return { entries: [] };
    if (m.type === "fs.media") {
      const r = opts.media ? opts.media(m.path!) : { url: `/media/abc/${m.path!.split("/").pop()}?v=1`, mime: "x", size: 2048, mtime: 1 };
      if (r instanceof Error) throw r;
      return r;
    }
    if (m.type === "fs.read") return { content: opts.read ?? "text", mtime: 1 };
    return {};
  });
  const client = { request, onFsChanged: (f: typeof changed) => ((changed = f), () => {}) } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  const show = (openPath: string) => act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} openPath={openPath} />));
  const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector<T>(`[data-testid=${sel}]`);
  const button = (text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  return { request, el, root, show, q, button, change: (path: string) => act(async () => changed({ path })) };
}

it("a .png opens an <img> with the fs.media URL, no fs.read, no Save button, size line with pixel size", async () => {
  const p = mediaPanel();
  await p.show("/p/a.png");
  const img = p.q<HTMLImageElement>("media-image")!;
  expect(img.getAttribute("src")).toBe("/media/abc/a.png?v=1");
  expect(p.request.mock.calls.some(([m]) => m.type === "fs.read")).toBe(false);
  expect(p.q("editor-save")).toBeNull();
  expect(p.q("media-info")!.textContent).toBe("2 KB");
  Object.defineProperty(img, "naturalWidth", { value: 640 });
  Object.defineProperty(img, "naturalHeight", { value: 480 });
  await act(async () => void img.dispatchEvent(new Event("load")));
  expect(p.q("media-info")!.textContent).toBe("640×480 · 2 KB");
  act(() => p.root.render(null));
});

it("Fit / 100% toggle switches the image classes and aria-pressed", async () => {
  const p = mediaPanel();
  await p.show("/p/a.png");
  const img = p.q("media-image")!;
  const fit = p.q("media-fit")!;
  expect(img.className).toContain("max-w-full");
  expect(fit.getAttribute("aria-pressed")).toBe("false");
  await act(async () => fit.click());
  expect(p.q("media-image")!.className).toContain("max-w-none");
  expect(fit.getAttribute("aria-pressed")).toBe("true");
  act(() => p.root.render(null));
});

it("a .mp4 opens <video controls> with the URL; a .mp3 opens <audio controls>", async () => {
  const p = mediaPanel();
  await p.show("/p/v.mp4");
  const v = p.q<HTMLVideoElement>("media-video")!;
  expect(v.hasAttribute("controls")).toBe(true);
  expect(v.getAttribute("src")).toBe("/media/abc/v.mp4?v=1");
  await p.show("/p/a.mp3");
  const a = p.q<HTMLAudioElement>("media-audio")!;
  expect(a.hasAttribute("controls")).toBe(true);
  expect(a.getAttribute("src")).toBe("/media/abc/a.mp3?v=1");
  act(() => p.root.render(null));
});

it("a decode error shows \"Unable to load image.\" (video: \"Unable to load video.\")", async () => {
  const p = mediaPanel();
  await p.show("/p/a.png");
  await act(async () => void p.q("media-image")!.dispatchEvent(new Event("error")));
  expect(p.q("file-notice")!.textContent).toBe("Unable to load image.");
  await p.show("/p/v.mp4");
  await act(async () => void p.q("media-video")!.dispatchEvent(new Event("error")));
  expect(p.q("file-notice")!.textContent).toBe("Unable to load video.");
  act(() => p.root.render(null));
});

it(".svg shows the image; Show source opens the text editor with the fs.read content; Show preview returns to the image", async () => {
  const p = mediaPanel({ read: "<svg/>" });
  await p.show("/p/i.svg");
  expect(p.q("media-image")).not.toBeNull();
  await act(async () => p.button("Show source").click());
  expect(p.q("code-editor")).not.toBeNull();
  expect(p.q("code-editor")!.textContent).toContain("<svg/>");
  expect(p.q("media-image")).toBeNull();
  await act(async () => p.button("Show preview").click());
  expect(p.q("media-image")).not.toBeNull();
  expect(p.q("code-editor")).toBeNull();
  act(() => p.root.render(null));
});

it("fs.changed on a media tab re-requests fs.media and the img src takes the new ?v=", async () => {
  let v = 1;
  const p = mediaPanel({ media: () => ({ url: `/media/abc/a.png?v=${v}`, mime: "image/png", size: 10, mtime: v }) });
  await p.show("/p/a.png");
  expect(p.q("media-image")!.getAttribute("src")).toContain("?v=1");
  v = 2;
  await p.change("/p/a.png");
  expect(p.q("media-image")!.getAttribute("src")).toContain("?v=2");
  expect(p.request.mock.calls.some(([m]) => m.type === "fs.read")).toBe(false);
  act(() => p.root.render(null));
});

it("fs.media refused for a WSL path shows the notice", async () => {
  const p = mediaPanel({ media: () => Object.assign(new Error("Preview is not available for files in WSL"), { code: "side_unsupported" }) });
  await p.show("/p/a.png");
  expect(p.q("file-notice")!.textContent).toContain("Preview is not available for files in WSL");
  expect(p.q("media-image")).toBeNull();
  act(() => p.root.render(null));
});
