// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
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
  // Go to line is the literal Ctrl+G; Cmd+G stays CodeMirror's find next.
  expect(key("g")).toBe(true);
  expect(key("g", { ctrlKey: false, metaKey: true })).toBe(false);
  view.destroy();
});

it("opening a binary, too large or not UTF-8 file gets a tab that shows its state, no raw error", async () => {
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
    expect(notice.querySelector("nav[aria-label=Breadcrumb] [aria-current=page]")!.textContent).toBe(path!.slice(3));
    expect(el.textContent).not.toMatch(/raw:|too_large|not_utf8/);
    // It is a tab like any file (here a preview tab replacing the previous one), and the active one.
    const tabs = [...el.querySelectorAll("[data-testid=editor-tab]")];
    expect(tabs).toHaveLength(1);
    expect(tabs.at(-1)!.getAttribute("aria-selected")).toBe("true");
    expect(tabs.at(-1)!.textContent).toContain(path!.slice(3));
  }
  expect(el.querySelector("[data-testid=file-notice]")!.getAttribute("role")).toBe("status");
  // The notice tab closes like any tab.
  await act(async () => el.querySelector<HTMLButtonElement>("[aria-label='Close u16.txt']")!.click());
  expect(el.querySelector("[data-testid=file-notice]")).toBeNull();
  expect(el.querySelectorAll("[data-testid=editor-tab]")).toHaveLength(0);
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

it("the header shows Collapse all and Reveal buttons only while the tree shows; Reveal needs an open file", async () => {
  const client = { request: vi.fn(async (m: { type: string }) => (m.type === "fs.list" ? { entries: [] } : {})), onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  const show = (showTree: boolean) => act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree={showTree} onToggleTree={() => {}} />));
  await show(false);
  expect(el.querySelector("[aria-label='Collapse all folders']")).toBeNull();
  expect(el.querySelector("[aria-label='Reveal active file in tree']")).toBeNull();
  await show(true);
  expect(el.querySelector("[aria-label='Collapse all folders']")).not.toBeNull();
  expect(el.querySelector<HTMLButtonElement>("[aria-label='Reveal active file in tree']")!.disabled).toBe(true);
  expect(el.querySelector("[aria-label='Reload the file tree']")!.className).toContain("max-md:size-11");
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

it("the editable editor is unchanged: not read-only, no tabindex", async () => {
  const request = vi.fn(async (m: { type: string }) => (m.type === "fs.list" ? { entries: [] } : m.type === "fs.read" ? { content: "one", mtime: 1 } : {}));
  const client = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  await act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} openPath="/p/main.ts" />));
  const { EditorView } = await import("@codemirror/view");
  const view = EditorView.findFromDOM(el.querySelector<HTMLElement>("[data-testid=code-editor] .cm-editor")!)!;
  expect(view.state.readOnly).toBe(false);
  expect(el.querySelector(".cm-content")!.hasAttribute("tabindex")).toBe(false);
  act(() => root.render(null));
});

// jsdom has no layout: CodeMirror's selection layer measures text ranges once the editor is focused.
const rangeProto = Range.prototype as { getClientRects?: () => unknown; getBoundingClientRect?: () => unknown };
rangeProto.getClientRects ??= () => Object.assign([], { item: () => null });
rangeProto.getBoundingClientRect ??= () => new DOMRect();

/** A panel over /p with a.ts, b.ts and src/c.ts; fs.read answers a 5-line text, fs.write is recorded. */
function treePanel(opts: { read?: (path: string) => Promise<unknown> | unknown } = {}) {
  const request = vi.fn(async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list")
      return {
        entries: m.path === "/p/src" ? [{ name: "c.ts", path: "/p/src/c.ts", isDir: false }] : [{ name: "src", path: "/p/src", isDir: true }, { name: "a.ts", path: "/p/a.ts", isDir: false }, { name: "b.ts", path: "/p/b.ts", isDir: false }],
      };
    if (m.type === "fs.read") return opts.read ? opts.read(m.path!) : { content: "one\ntwo\nthree\nfour\nfive", mtime: 1 };
    if (m.type === "fs.write") return { mtime: 2 };
    return {};
  });
  const client = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const show = (props: Partial<ComponentProps<typeof FilesPanel>> = {}) =>
    act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} {...props} />));
  const row = (path: string) => [...el.querySelectorAll<HTMLElement>("[role=treeitem]")].find((r) => r.dataset.path === path)!;
  const tabs = () => [...el.querySelectorAll<HTMLElement>("[data-testid=editor-tab]")];
  const tabButton = (name: string) => tabs().map((t) => t.querySelector("button")!).find((b) => b.textContent!.startsWith(name))!;
  const view = async () => {
    const { EditorView } = await import("@codemirror/view");
    return EditorView.findFromDOM(el.querySelector<HTMLElement>("[data-testid=code-editor] .cm-editor")!)!;
  };
  return { request, el, root, show, row, tabs, tabButton, view, click: (e: HTMLElement) => act(async () => e.click()), dbl: (e: HTMLElement) => act(async () => void e.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))) };
}

it("a single click on a tree file opens an italic preview tab; another single click replaces it; a double click pins; editing pins", async () => {
  const t = treePanel();
  await t.show();
  await t.click(t.row("/p/a.ts"));
  expect(t.tabs()).toHaveLength(1);
  expect(t.tabs()[0]!.querySelector("button")!.className).toContain("italic");
  expect(t.tabs()[0]!.querySelector("button")!.getAttribute("aria-label")).toBe("a.ts, preview");
  await t.click(t.row("/p/b.ts"));
  expect(t.tabs().map((x) => x.textContent)).toEqual(["b.ts×"]);
  await t.dbl(t.row("/p/b.ts"));
  expect(t.tabButton("b.ts").className).not.toContain("italic");
  await t.click(t.row("/p/a.ts"));
  expect(t.tabs()).toHaveLength(2);
  expect(t.tabButton("a.ts").className).toContain("italic");
  // Editing the preview tab pins it, so the next single click opens a third tab.
  const v = await t.view();
  await act(async () => v.dispatch({ changes: { from: 0, insert: "x" } }));
  expect(t.tabButton("a.ts").className).not.toContain("italic");
  await t.click(t.row("/p/src"));
  await t.click(t.row("/p/src/c.ts"));
  expect(t.tabs()).toHaveLength(3);
  // Double click on the tab pins it; middle click closes it.
  await t.dbl(t.tabButton("c.ts"));
  expect(t.tabButton("c.ts").className).not.toContain("italic");
  await act(async () => void t.tabButton("c.ts").dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1, cancelable: true })));
  expect(t.tabs()).toHaveLength(2);
  act(() => t.root.render(null));
});

it("dirty marker: editing a tab shows ● (aria-label unsaved); saving removes it and pins the tab", async () => {
  const t = treePanel();
  await t.show({ openPath: "/p/a.ts" });
  expect(t.el.querySelector("[aria-label=unsaved]")).toBeNull();
  const v = await t.view();
  await act(async () => v.dispatch({ changes: { from: 0, insert: "x" } }));
  expect(t.el.querySelector("[aria-label=unsaved]")!.textContent).toContain("●");
  await t.click(t.el.querySelector<HTMLElement>("[data-testid=editor-save]")!);
  expect(t.request).toHaveBeenCalledWith(expect.objectContaining({ type: "fs.write", path: "/p/a.ts" }));
  expect(t.el.querySelector("[aria-label=unsaved]")).toBeNull();
  act(() => t.root.render(null));
});

it("breadcrumb: the folders of the path below cwd, the file last with aria-current=page; a folder click shows the tree and reveals it", async () => {
  const t = treePanel();
  const onToggleTree = vi.fn();
  await t.show({ openPath: "/p/src/c.ts", showTree: false, onToggleTree });
  const nav = t.el.querySelector("nav[aria-label=Breadcrumb]")!;
  expect([...nav.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["src", "c.ts"]);
  expect(nav.querySelector("[aria-current=page]")!.textContent).toBe("c.ts");
  await act(async () => nav.querySelector("button")!.click());
  expect(onToggleTree).toHaveBeenCalledOnce();
  await t.show({ showTree: true });
  await act(async () => void (await new Promise((r) => requestAnimationFrame(r))));
  expect(t.row("/p/src").getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(t.row("/p/src"));
  act(() => t.root.render(null));
});

it("Ctrl+G opens the go-to-line dialog and a line number moves the cursor; Ctrl+F opens the search panel", async () => {
  const t = treePanel();
  await t.show({ openPath: "/p/a.ts" });
  const v = await t.view();
  const press = (key: string, init: KeyboardEventInit = {}) => act(async () => void v.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, code: `Key${key.toUpperCase()}`, bubbles: true, cancelable: true, ...init })));
  await press("g", { ctrlKey: true });
  const dialog = t.el.querySelector(".cm-goto-line")!;
  expect(dialog).not.toBeNull();
  const input = dialog.querySelector<HTMLInputElement>("input[name=line]")!;
  const form = input.form!;
  await act(async () => {
    input.value = "3";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(v.state.doc.lineAt(v.state.selection.main.head).number).toBe(3);
  expect(t.el.querySelector(".cm-search")).toBeNull();
  await press("f", { ctrlKey: true });
  expect(t.el.querySelector(".cm-search")).not.toBeNull();
  act(() => t.root.render(null));
});

it("openLine puts the cursor on that line, also in an already open tab", async () => {
  const t = treePanel();
  await t.show({ openPath: "/p/a.ts", openLine: 4 });
  expect((await t.view()).state.doc.lineAt((await t.view()).state.selection.main.head).number).toBe(4);
  await t.show({ openPath: undefined });
  await t.show({ openPath: "/p/a.ts", openLine: 2 });
  expect((await t.view()).state.doc.lineAt((await t.view()).state.selection.main.head).number).toBe(2);
  act(() => t.root.render(null));
});

it("an unshowable file shows its title and a hint line", async () => {
  const t = treePanel({ read: () => Promise.reject(Object.assign(new Error("raw"), { code: "binary", size: 2048 })) });
  await t.show({ openPath: "/p/a.ts" });
  const n = t.el.querySelector("[data-testid=file-notice]")!;
  expect(n.textContent).toContain("Binary file, not shown (2 KB)");
  expect(n.textContent).toContain("Only text files open in the editor.");
  expect(n.querySelector("svg[data-icon]")).not.toBeNull();
  act(() => t.root.render(null));
});

it("a slow fs.read shows Loading file… until it answers", async () => {
  vi.useFakeTimers();
  let done = (_: unknown) => {};
  const t = treePanel({ read: () => new Promise((r) => (done = r)) });
  await t.show({ openPath: "/p/a.ts" });
  expect(t.el.querySelector("[data-testid=file-loading]")).toBeNull();
  await act(async () => void (await vi.advanceTimersByTimeAsync(200)));
  expect(t.el.querySelector("[data-testid=file-loading]")!.textContent).toBe("Loading file…");
  await act(async () => (done({ content: "x", mtime: 1 }), void (await vi.advanceTimersByTimeAsync(10))));
  expect(t.el.querySelector("[data-testid=file-loading]")).toBeNull();
  expect(t.el.querySelector("[data-testid=code-editor]")).not.toBeNull();
  vi.useRealTimers();
  act(() => t.root.render(null));
});

const MD_DOC = "# Title\n\nsee [next](./next.md) and `src/c.ts:2`\n";
const mdPanel = () => treePanel({ read: (path) => ({ content: path.endsWith(".md") ? MD_DOC : "const a = 1;", mtime: 1 }) });

it("markdown tab: Source / Preview / Split (aria-pressed), the preview renders the draft live, the choice is kept in localStorage; a non-markdown file has no control", async () => {
  localStorage.clear();
  const t = mdPanel();
  await t.show({ openPath: "/p/docs/guide.md" });
  const btn = (m: string) => t.el.querySelector<HTMLElement>(`[data-testid=md-view-${m}]`)!;
  expect(t.el.querySelector("[role=group][aria-label='Markdown view']")).not.toBeNull();
  expect(btn("source").getAttribute("aria-pressed")).toBe("true");
  expect(t.el.querySelector("[data-testid=md-preview]")).toBeNull();
  await t.click(btn("preview"));
  expect(btn("preview").getAttribute("aria-pressed")).toBe("true");
  expect(localStorage.getItem("claude-ui.markdown-view")).toBe("preview");
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  const pane = t.el.querySelector<HTMLElement>("[data-testid=md-preview]")!;
  expect(pane.getAttribute("aria-label")).toBe("Markdown preview");
  expect(pane.tabIndex).toBe(0);
  expect(pane.querySelector("h1")!.textContent).toBe("Title");
  // The source stays mounted (undo history, selection), hidden.
  expect(t.el.querySelector("[data-testid=code-editor]")!.parentElement!.className).toContain("hidden");
  await t.click(btn("split"));
  expect(t.el.querySelector("[data-testid=code-editor]")!.parentElement!.className).not.toContain("hidden");
  const v = await t.view();
  await act(async () => v.dispatch({ changes: { from: 0, to: 7, insert: "# Changed" } }));
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  expect(t.el.querySelector("[data-testid=md-preview] h1")!.textContent).toBe("Changed");
  await t.show({ openPath: undefined });
  await t.show({ openPath: "/p/a.ts" });
  expect(t.el.querySelector("[aria-label='Markdown view']")).toBeNull();
  expect(t.el.querySelector("[data-testid=md-preview]")).toBeNull();
  act(() => t.root.render(null));
  localStorage.clear();
});

it("markdown tab below md: no Split button, a stored Split shows the Preview", async () => {
  localStorage.setItem("claude-ui.markdown-view", "split");
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as never;
  const t = mdPanel();
  await t.show({ openPath: "/p/docs/guide.md" });
  expect(t.el.querySelector("[data-testid=md-view-split]")).toBeNull();
  expect(t.el.querySelector("[data-testid=md-view-preview]")!.getAttribute("aria-pressed")).toBe("true");
  expect(t.el.querySelector("[data-testid=md-view-preview]")!.className).toContain("max-md:h-11");
  expect(t.el.querySelector("[data-testid=md-preview]")).not.toBeNull();
  window.matchMedia = original;
  act(() => t.root.render(null));
  localStorage.clear();
});

it("a link and a path in the markdown preview open that file in a tab, resolved from the markdown file's folder; an open at a line shows the source", async () => {
  localStorage.setItem("claude-ui.markdown-view", "preview");
  const t = mdPanel();
  await t.show({ openPath: "/p/docs/guide.md" });
  await act(async () => void (await new Promise((r) => setTimeout(r, 50))));
  const buttons = [...t.el.querySelectorAll<HTMLButtonElement>("[data-testid=md-preview] button[title='Open in Files tab']")];
  expect(buttons.map((b) => b.textContent)).toEqual(["next", "src/c.ts:2"]);
  await act(async () => buttons[0]!.click());
  expect(t.request).toHaveBeenCalledWith({ type: "fs.read", path: "/p/docs/next.md" });
  expect(t.tabs().map((x) => x.textContent)).toEqual(["next.md×"]);
  // A chat link with a line shows the source of a markdown file, although Preview is chosen.
  await t.show({ openPath: undefined });
  await t.show({ openPath: "/p/docs/guide.md", openLine: 3 });
  expect(t.el.querySelector("[data-testid=md-view-source]")!.getAttribute("aria-pressed")).toBe("true");
  expect(t.el.querySelector("[data-testid=md-preview]")).toBeNull();
  expect(localStorage.getItem("claude-ui.markdown-view")).toBe("preview");
  act(() => t.root.render(null));
  localStorage.clear();
});

it("a relative image in the markdown preview loads through fs.media from the file's folder; an image outside the root and a failing one show the alt text", async () => {
  const request = vi.fn(async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list") return { entries: [] };
    if (m.type === "fs.read") return { content: "![pic](img/pic.png) ![up](../up.png) ![out](../../../etc/x.png) ![gone](missing.png)", mtime: 1 };
    if (m.type === "fs.media") {
      if (m.path!.endsWith("missing.png")) throw new Error("nope");
      return { url: `/media/k${m.path}?v=1`, mime: "image/png", size: 1, mtime: 1 };
    }
    return {};
  });
  const client = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  const root = createRoot(el);
  localStorage.setItem("claude-ui.markdown-view", "preview");
  await act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} openPath="/p/docs/guide.md" />));
  await act(async () => void (await new Promise((r) => setTimeout(r, 80))));
  const pane = el.querySelector("[data-testid=md-preview]")!;
  expect([...pane.querySelectorAll("img")].map((i) => [i.getAttribute("src"), i.alt])).toEqual([["/media/k/p/docs/img/pic.png?v=1", "pic"], ["/media/k/p/up.png?v=1", "up"]]);
  expect(request).toHaveBeenCalledWith({ type: "fs.media", path: "/p/docs/img/pic.png" });
  expect(request.mock.calls.some(([m]) => (m as { path?: string }).path?.includes("etc"))).toBe(false);
  expect(pane.textContent).toContain("out");
  expect(pane.textContent).toContain("gone");
  expect(pane.textContent).not.toContain("blocked");
  act(() => root.render(null));
  localStorage.clear();
});

it("the breadcrumb keeps the file name when the pane is narrow: folders shrink first, middle folders collapse to … below md", async () => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as never;
  const t = treePanel();
  await t.show({ openPath: "/p/a/b/c/d/long-file-name.ts" });
  const nav = t.el.querySelector("nav[aria-label=Breadcrumb]")!;
  expect([...nav.querySelectorAll("li")].map((l) => l.textContent)).toEqual(["a", "…", "d", "long-file-name.ts"]);
  const lis = [...nav.querySelectorAll("li")];
  expect(lis.at(-1)!.className).toContain("shrink");
  expect(lis.at(-1)!.className).not.toContain("shrink-[1000]");
  expect(lis[0]!.className).toContain("shrink-[1000]");
  expect(lis[0]!.className).toContain("min-w-0");
  window.matchMedia = original;
  act(() => t.root.render(null));
});

it("a slow open keeps the active editor mounted (undo history, draft) and shows Loading file… as a line", async () => {
  const t = treePanel({ read: (path) => (path === "/p/b.ts" ? new Promise((r) => setTimeout(() => r({ content: "bee", mtime: 1 }), 400)) : { content: "one\ntwo", mtime: 1 }) });
  await t.show({ openPath: "/p/a.ts" });
  const v = await t.view();
  await act(async () => v.dispatch({ changes: { from: 0, insert: "x" } }));
  await t.click(t.row("/p/b.ts"));
  await act(async () => void (await new Promise((r) => setTimeout(r, 250))));
  expect(t.el.querySelector("[data-testid=file-loading]")!.textContent).toBe("Loading file…");
  expect(await t.view()).toBe(v);
  expect(v.state.doc.toString()).toBe("xone\ntwo");
  await act(async () => void (await new Promise((r) => setTimeout(r, 300))));
  expect(t.el.querySelector("[data-testid=file-loading]")).toBeNull();
  expect((await t.view()).state.doc.toString()).toBe("bee");
  act(() => t.root.render(null));
});

it("two quick single clicks: an older, slower answer does not take the preview tab or the focus", async () => {
  const t = treePanel({ read: (path) => (path === "/p/a.ts" ? new Promise((r) => setTimeout(() => r({ content: "aaa", mtime: 1 }), 300)) : { content: "bbb", mtime: 1 }) });
  await t.show();
  await t.click(t.row("/p/a.ts"));
  await t.click(t.row("/p/b.ts"));
  await act(async () => void (await new Promise((r) => setTimeout(r, 450))));
  expect(t.tabs().map((x) => x.textContent)).toEqual(["b.ts×"]);
  expect((await t.view()).state.doc.toString()).toBe("bbb");
  act(() => t.root.render(null));
});

it("a markdown file opened at a line shows its source only for that open", async () => {
  localStorage.setItem("claude-ui.markdown-view", "preview");
  const t = mdPanel();
  await t.show({ openPath: "/p/docs/guide.md", openLine: 2 });
  expect(t.el.querySelector("[data-testid=md-preview]")).toBeNull();
  await t.show({ openPath: undefined });
  await t.show({ openPath: "/p/docs/guide.md" });
  expect(t.el.querySelector("[data-testid=md-preview]")).not.toBeNull();
  act(() => t.root.render(null));
  localStorage.clear();
});

it("GH-360 renaming an open file moves its tab; deleting an open clean file closes its tab", async () => {
  const lists: Record<string, { name: string; path: string; isDir: boolean }[]> = { "/p": [{ name: "a.ts", path: "/p/a.ts", isDir: false }, { name: "b.ts", path: "/p/b.ts", isDir: false }] };
  const request = vi.fn(async (m: { type: string; path?: string; name?: string }) => {
    if (m.type === "fs.list") return { entries: lists[m.path!] ?? [] };
    if (m.type === "fs.read") return { content: "ok", mtime: 1 };
    if (m.type === "fs.rename") return (lists["/p"] = lists["/p"]!.map((e) => (e.path === m.path ? { name: m.name!, path: `/p/${m.name}`, isDir: false } : e))), { path: `/p/${m.name}` };
    if (m.type === "fs.delete") return (lists["/p"] = lists["/p"]!.filter((e) => e.path !== m.path)), { files: 0, folders: 0 };
    return {};
  });
  const client = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const show = (openPath?: string) => act(async () => root.render(<FilesPanel client={client} status="connected" cwd="/p" onSend={() => {}} showTree onToggleTree={() => {}} openPath={openPath} />));
  await show("/p/a.ts");
  await show("/p/b.ts");
  const titles = () => [...el.querySelectorAll("[data-testid=editor-tab]")].map((t) => t.textContent);
  expect(titles().join()).toContain("b.ts");
  const row = (p: string) => el.querySelector<HTMLElement>(`[data-testid=tree-entry][data-path="${p}"]`)!;
  const type = (v: string) => {
    const input = document.querySelector<HTMLInputElement>('[data-testid="tree-name-input"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input;
  };
  await act(async () => void row("/p/b.ts").dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true })));
  await act(async () => {});
  await act(async () => void type("c.ts").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await act(async () => {});
  await act(async () => {});
  expect(request.mock.calls.some(([m]) => m.type === "fs.rename")).toBe(true);
  expect(titles().join()).toContain("c.ts");
  expect(titles().join()).not.toContain("b.ts");
  await act(async () => void row("/p/c.ts").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true })));
  await act(async () => {});
  await act(async () => document.querySelector<HTMLElement>('[data-testid="tree-delete-confirm"]')!.click());
  await act(async () => {});
  await act(async () => {});
  expect(titles().join()).not.toContain("c.ts");
  act(() => root.render(null));
});
