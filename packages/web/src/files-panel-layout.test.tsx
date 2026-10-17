// @vitest-environment jsdom
// GH-394 slice B: the Files tab's layout (tree beside the editor from 672px, a drawer below), path header, tab bar and editor chrome.
import { act, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { FilesPanel, chromeTheme } from "./files-panel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ent = (path: string, isDir = false) => ({ name: path.split("/").at(-1)!, path, isDir });
const files: Record<string, string> = { "/p/sub/c.ts": "see", "/p/a.ts": "one\ntwo", "/p/b.ts": "bee", "/o/out.ts": "outside" };

/** A ResizeObserver whose width the test sets: `resize(w)` reports `w` for the observed Files panel. */
let observers: { cb: ResizeObserverCallback; target?: Element }[] = [];
const RO = globalThis.ResizeObserver;
beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = class {
    rec: { cb: ResizeObserverCallback; target?: Element };
    constructor(cb: ResizeObserverCallback) {
      this.rec = { cb };
      observers.push(this.rec);
    }
    observe(t: Element) {
      this.rec.target = t;
    }
    unobserve() {}
    disconnect() {}
  } as never;
});
const resize = (w: number) =>
  act(async () => observers.filter((o) => (o.target as HTMLElement | undefined)?.dataset?.testid === "files-panel").forEach((o) => o.cb([{ contentRect: { width: w } } as ResizeObserverEntry], {} as ResizeObserver)));

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => {
  act(() => root.render(null));
  globalThis.ResizeObserver = RO;
  localStorage.clear();
});
const q = <T extends Element = HTMLElement>(sel: string) => el.querySelector<T>(sel);
const panel = () => q("[data-testid=files-panel]")!;
/** The drawer is kept mounted (so the tree keeps its folders) and `hidden` while closed. */
const drawerOpen = () => {
  const d = q("[data-testid=file-tree-drawer]");
  return !!d && !d.hidden;
};
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

function fakeClient() {
  const request = vi.fn(async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list") return { entries: m.path === "/p" ? [ent("/p/a.ts"), ent("/p/b.ts"), ent("/p/sub", true)] : m.path === "/p/sub" ? [ent("/p/sub/c.ts")] : [] };
    if (m.type === "fs.read") return { content: files[m.path!] ?? "", mtime: 1 };
    return {};
  });
  return { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
}
async function show(p: Partial<ComponentProps<typeof FilesPanel>> = {}) {
  const props = { client: fakeClient(), status: "connected" as const, cwd: "/p", onSend: () => {}, showTree: true, onToggleTree: vi.fn(), ...p };
  await act(async () => root.render(<FilesPanel {...props} />));
  await flush();
  return props;
}

it("from 672px of panel width the tree sits beside the editor; at 671px it is a drawer, closed while a file shows", async () => {
  await show({ openPath: "/p/a.ts" });
  await resize(672);
  expect(panel().dataset.layout).toBe("beside");
  const nav = q("nav#file-tree")!;
  expect(nav).not.toBeNull();
  expect(nav.closest("[data-testid=file-tree-drawer]")).toBeNull();
  // The tree column is a sibling of the editor column, not above it.
  expect(nav.parentElement!.querySelector("[data-testid=code-editor]")).toBeNull();
  expect(q("[data-testid=code-editor]")).not.toBeNull();
  await resize(671);
  expect(panel().dataset.layout).toBe("drawer");
  expect(drawerOpen()).toBe(false);
  expect(q("[data-testid=code-editor]")).not.toBeNull();
});

it("the drawer opens with the Files button (showTree is not toggled), and closes on Esc, a scrim click and a file opened from it", async () => {
  const props = await show({ openPath: "/p/a.ts" });
  await resize(500);
  const button = q<HTMLButtonElement>("[data-testid=toggle-tree]")!;
  expect(button.getAttribute("aria-expanded")).toBe("false");
  await act(async () => button.click());
  expect(props.onToggleTree).not.toHaveBeenCalled();
  const drawer = q("[data-testid=file-tree-drawer]")!;
  expect(drawer.getAttribute("aria-label")).toBe("File tree");
  expect(drawer.querySelector("nav#file-tree")).not.toBeNull();
  expect(button.getAttribute("aria-expanded")).toBe("true");
  // Focus moves into the tree, and Esc closes the drawer and returns it to the Files button.
  await flush();
  expect(drawer.contains(document.activeElement)).toBe(true);
  const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => void document.activeElement!.dispatchEvent(esc));
  expect(esc.defaultPrevented).toBe(true);
  expect(drawerOpen()).toBe(false);
  expect(document.activeElement).toBe(button);
  // The scrim closes it.
  await act(async () => button.click());
  await act(async () => q<HTMLElement>("[data-testid=file-tree-scrim]")!.click());
  expect(drawerOpen()).toBe(false);
  // A file opened from it closes it and shows in the editor.
  await act(async () => button.click());
  await flush();
  await act(async () => q<HTMLElement>("[role=treeitem][data-path='/p/b.ts']")!.click());
  await flush();
  expect(drawerOpen()).toBe(false);
  expect(q("[data-testid=editor-tab][aria-selected=true]")!.textContent).toContain("b.ts");
});

it("Ctrl+\\ (the app flips showTree) toggles the drawer, and the kept beside setting is flipped back", async () => {
  let flip = () => {};
  const shown: boolean[] = [];
  function App() {
    const [showTree, setShowTree] = useState(true);
    flip = () => setShowTree((v) => !v);
    shown.push(showTree);
    return <FilesPanel client={fakeClient()} status="connected" cwd="/p" onSend={() => {}} showTree={showTree} onToggleTree={() => setShowTree((v) => !v)} openPath="/p/a.ts" />;
  }
  await act(async () => root.render(<App />));
  await flush();
  await resize(400);
  expect(drawerOpen()).toBe(false);
  await act(async () => flip());
  await flush();
  expect(drawerOpen()).toBe(true);
  expect(shown.at(-1)).toBe(true);
  await act(async () => flip());
  await flush();
  expect(drawerOpen()).toBe(false);
  expect(shown.at(-1)).toBe(true);
  // Wide again: the kept setting still shows the tree.
  await resize(900);
  expect(q("nav#file-tree")).not.toBeNull();
});

it("a breadcrumb folder opens the drawer in the drawer layout and reveals the folder", async () => {
  await show({ openPath: "/p/sub/c.ts", showTree: true });
  await resize(480);
  expect(drawerOpen()).toBe(false);
  const crumb = [...el.querySelectorAll<HTMLButtonElement>("nav[aria-label=Breadcrumb] button")].find((b) => b.textContent === "sub")!;
  await act(async () => crumb.click());
  await flush();
  await act(async () => new Promise<void>((r) => requestAnimationFrame(() => r())));
  await flush();
  expect(drawerOpen()).toBe(true);
  expect(q("[role=treeitem][data-path='/p/sub']")!.getAttribute("aria-expanded")).toBe("true");
});

it("widening past 672px and narrowing again leaves the drawer closed and the focus alone", async () => {
  await show({ openPath: "/p/a.ts" });
  await resize(480);
  await act(async () => q<HTMLButtonElement>("[data-testid=toggle-tree]")!.click());
  await flush();
  expect(drawerOpen()).toBe(true);
  await resize(800);
  const cm = q<HTMLElement>(".cm-content")!;
  cm.focus();
  await resize(480);
  await flush();
  expect(drawerOpen()).toBe(false);
  expect(document.activeElement).toBe(cm);
});

it("the tree keeps its folders across closing and opening the drawer", async () => {
  await show({ openPath: "/p/a.ts" });
  await resize(480);
  const button = q<HTMLButtonElement>("[data-testid=toggle-tree]")!;
  await act(async () => button.click());
  await flush();
  await act(async () => q<HTMLElement>("[role=treeitem][data-path='/p/sub']")!.click());
  await flush();
  expect(q("[role=treeitem][data-path='/p/sub/c.ts']")).not.toBeNull();
  await act(async () => button.click());
  expect(drawerOpen()).toBe(false);
  await act(async () => button.click());
  await flush();
  expect(q("[role=treeitem][data-path='/p/sub/c.ts']")).not.toBeNull();
});

it("while the drawer is open the editor column is inert, so Tab cannot go behind the scrim", async () => {
  await show({ openPath: "/p/a.ts" });
  await resize(480);
  const button = q<HTMLButtonElement>("[data-testid=toggle-tree]")!;
  await act(async () => button.click());
  await flush();
  expect(q("[data-testid=code-editor]")!.closest("[inert]")).not.toBeNull();
  await act(async () => button.click());
  expect(q("[data-testid=code-editor]")!.closest("[inert]")).toBeNull();
});

it("with no file open the tree fills the panel in both layouts, and a file opens the drawer closed", async () => {
  await show();
  await resize(800);
  expect(q("nav#file-tree")!.className).toContain("flex-1");
  await resize(400);
  expect(panel().dataset.layout).toBe("drawer");
  expect(q("nav#file-tree")!.className).toContain("flex-1");
  expect(q("[data-testid=file-tree-drawer]")).toBeNull();
  expect(q("[data-testid=file-tree-scrim]")).toBeNull();
});

it("the beside tree column resizes with the drag handle and remembers its width", async () => {
  await show({ openPath: "/p/a.ts" });
  await resize(900);
  const sep = q("[data-testid=files-tree-resizer]")!;
  expect(sep.getAttribute("role")).toBe("separator");
  await act(async () => void sep.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  expect(Number(localStorage.getItem("claude-ui.filesTreeWidth"))).toBeGreaterThan(160);
});

it("path header: the breadcrumb, then Pop out in the Files tab; Open in editor (not Pop out) in the dialog, only inside cwd; 44px below md", async () => {
  await show({ openPath: "/p/a.ts", onPopOut: () => {}, onOpenInFiles: () => {} });
  const header = q("[data-testid=file-path-header]")!;
  expect(header.className).toMatch(/\bmin-h-10\b/);
  expect(header.className).toContain("border-b");
  const pos = header.querySelector("nav[aria-label=Breadcrumb]")!.compareDocumentPosition(header.querySelector("[data-testid=files-popout]")!);
  expect(pos & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(header.querySelector("[data-testid=open-in-editor]")).toBeNull();
  expect(header.querySelector("[data-testid=files-popout]")!.className).toContain("max-md:size-11");
  for (const id of ["send-selection", "editor-save"]) expect(header.querySelector(`[data-testid=${id}]`)!.className, id).toContain("max-md:h-11");
  await show({ surface: "dialog", openPath: "/p/a.ts", onOpenInFiles: () => {} });
  const dialogHeader = q("[data-testid=file-path-header]")!;
  expect(dialogHeader.querySelector("[data-testid=open-in-editor]")).not.toBeNull();
  expect(dialogHeader.querySelector("[data-testid=files-popout]")).toBeNull();
  expect(dialogHeader.querySelector("[data-testid=open-in-editor]")!.className).toContain("max-md:h-11");
});

it("the conflict bar's buttons are 44px targets below md", async () => {
  let changed = (_: { path: string }) => {};
  let disk = "one";
  const client = {
    request: vi.fn(async (m: { type: string }) => (m.type === "fs.list" ? { entries: [] } : m.type === "fs.read" ? { content: disk, mtime: disk === "one" ? 1 : 2 } : {})),
    onFsChanged: (f: typeof changed) => ((changed = f), () => {}),
  } as unknown as ReturnType<typeof connect>;
  await show({ client, openPath: "/p/a.ts" });
  const { EditorView } = await import("@codemirror/view");
  const view = EditorView.findFromDOM(q(".cm-editor")!)!;
  await act(async () => view.dispatch({ changes: { from: 0, insert: "x" } }));
  disk = "changed";
  await act(async () => changed({ path: "/p/a.ts" }));
  await flush();
  const bar = q("[data-testid=editor-conflict]")!;
  const buttons = [...bar.querySelectorAll("button")];
  expect(buttons).toHaveLength(2);
  for (const b of buttons) expect(b.className, b.textContent!).toContain("max-md:h-11");
});

it("tab bar: a file icon, the active tab on bg-secondary, a close button of 44px below md", async () => {
  await show({ openPath: "/p/a.ts" });
  const bar = q("[role=tablist]")!;
  expect(bar.className).toContain("bg-card");
  expect(bar.className).toContain("overflow-x-auto");
  const tab = q("[data-testid=editor-tab]")!;
  expect(tab.className).toContain("bg-secondary");
  expect(tab.querySelector("svg, img")).not.toBeNull();
  const close = q("[aria-label='Close a.ts']")!;
  expect(close.className).toContain("max-md:size-11");
  expect(close.className).toContain("pointer-coarse:size-11");
  expect(tab.querySelector("button")!.className).toContain("max-md:min-h-11");
  expect(tab.querySelector("button")!.className).toContain("max-md:min-w-11");
});

it("editor chrome follows the diff: no gutter rule, muted numbers from the diff's formula, 20px lines, 3ch number column", () => {
  const gutters = chromeTheme[".cm-gutters"];
  expect(gutters.borderRight).toBe("none");
  expect(gutters.backgroundColor).toBe("var(--card)");
  expect(gutters.color).toBe("color-mix(in lab, var(--foreground) 65%, var(--card))");
  expect(chromeTheme[".cm-scroller"]).toMatchObject({ fontFamily: "var(--font-mono, monospace)", lineHeight: "20px" });
  expect(chromeTheme[".cm-lineNumbers .cm-gutterElement"]).toMatchObject({ padding: "0 1ch", minWidth: "3ch" });
  expect(chromeTheme[".cm-content"]).toMatchObject({ padding: "8px 0" });
  // Below lg the editor stays 16px / 24px (iOS zooms into smaller focused text).
  expect(chromeTheme["@media (width < 64rem)"]).toMatchObject({ ".cm-scroller": { lineHeight: "24px" } });
});
