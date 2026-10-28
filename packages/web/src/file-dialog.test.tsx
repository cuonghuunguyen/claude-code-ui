// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { openSearchPanel } from "@codemirror/search";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { createEditorStore } from "./editor-store.ts";
import { FileDialog } from "./file-dialog.tsx";
import { FilesPanel } from "./files-panel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => {
  act(() => root.render(null));
  localStorage.clear();
});

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`).join("\n");
type Req = { type: string; path?: string };
const files: Record<string, string> = { "/p/a.ts": lines(50), "/p/b.ts": "bee", "/o/out.ts": "outside" };
function fakeClient(handler?: (m: Req) => unknown) {
  const request = vi.fn(async (m: Req) => {
    const h = handler?.(m);
    if (h !== undefined) return h;
    if (m.type === "fs.list") return { entries: [] };
    if (m.type === "fs.read") return { content: files[m.path!] ?? "", mtime: 1 };
    return {};
  });
  return Object.assign({ request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>, { calls: request });
}

const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const q = <T extends Element = HTMLElement>(sel: string, within: ParentNode = document) => within.querySelector<T>(sel);
const qa = (sel: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLElement>(sel)];
const click = (sel: string | HTMLElement) => act(async () => ((typeof sel === "string" ? q(sel)! : sel).click(), undefined));
const dlg = () => q("[data-testid=file-dialog]");

/** The Files tab and the file dialog on one store, as App wires them. */
function Harness(p: { client: ReturnType<typeof fakeClient>; store: ReturnType<typeof createEditorStore>; onSend?: (m: string) => void; onOpenInFiles?: () => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(!!p.startOpen);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  return (
    <>
      <div data-testid="side">
        <FilesPanel client={p.client} status="connected" cwd="/p" onSend={p.onSend ?? (() => {})} showTree={false} onToggleTree={() => {}} editors={p.store} suspended={open} onPopOut={() => (setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null), setOpen(true))} />
      </div>
      <FileDialog open={open} opener={opener} client={p.client} status="connected" cwd="/p" store={p.store} onClose={() => setOpen(false)} onSend={(m) => (setOpen(false), p.onSend?.(m))} onOpenInFiles={() => (setOpen(false), p.onOpenInFiles?.())} />
    </>
  );
}
const side = () => q("[data-testid=side]")!;
const tabTexts = (within: ParentNode) => qa("[data-testid=editor-tab] > button:first-child", within).map((t) => t.textContent);
const tabButton = (within: ParentNode, n: number) => qa("[data-testid=editor-tab] > button:first-child", within)[n]!;
const cmView = (within: ParentNode) => EditorView.findFromDOM(q(".cm-editor", within)!)!;
const type = (within: ParentNode, text: string) => act(async () => cmView(within).dispatch({ changes: { from: 0, insert: text } }));

async function setup(extra: Partial<Parameters<typeof Harness>[0]> = {}) {
  const client = fakeClient();
  const store = createEditorStore(() => client);
  await act(async () => root.render(<Harness client={client} store={store} {...extra} />));
  await flush();
  return { client, store };
}
const openTab = async (store: ReturnType<typeof createEditorStore>, path: string, o: { line?: number; outside?: boolean; preview?: boolean } = {}) => {
  await act(async () => void (await store.open(path, { cwd: "/p", preview: false, ...o })));
  await flush();
};

it("Pop out keeps open tabs and unsaved edits: the dialog lists the same tabs, ● on the dirty one, its editor shows the draft", async () => {
  const { store } = await setup();
  await openTab(store, "/p/b.ts");
  await openTab(store, "/p/a.ts");
  await type(side(), "DRAFT ");
  expect(tabTexts(side())).toEqual(["b.ts", "a.ts ●"]);
  await click("[data-testid=files-popout]");
  await flush();
  expect(dlg()).not.toBeNull();
  expect(tabTexts(dlg()!)).toEqual(["b.ts", "a.ts ●"]);
  expect(q(".cm-content", dlg()!)!.textContent).toContain("DRAFT l1");
});

it("the panel shows no editor while the dialog is open, and the dialog's edit is in the panel's editor after close", async () => {
  const { store } = await setup();
  await openTab(store, "/p/a.ts");
  expect(qa("[data-testid=code-editor]")).toHaveLength(1);
  await click("[data-testid=files-popout]");
  await flush();
  expect(qa("[data-testid=code-editor]")).toHaveLength(1);
  expect(q("[data-testid=code-editor]", side())).toBeNull();
  expect(q("[data-testid=files-suspended]", side())).not.toBeNull();
  await type(dlg()!, "FROM-DIALOG ");
  await click("[data-testid=viewer-close]");
  await flush();
  expect(q(".cm-content", side())!.textContent).toContain("FROM-DIALOG l1");
});

it("cursor and undo history survive the switch", async () => {
  const { store } = await setup();
  await openTab(store, "/p/a.ts");
  const before = cmView(side());
  await act(async () => before.dispatch({ selection: { anchor: before.state.doc.line(3).from } }));
  await act(async () => cmView(side()).dispatch({ changes: { from: cmView(side()).state.doc.line(3).from, insert: "x" } }));
  const head = cmView(side()).state.selection.main.head;
  await click("[data-testid=files-popout]");
  await flush();
  const inDialog = cmView(dlg()!);
  expect(inDialog.state.selection.main.head).toBe(head);
  const { undo } = await import("@codemirror/commands");
  await act(async () => void undo(inDialog));
  expect(inDialog.state.doc.line(3).text).toBe("l3");
});

it("Open in editor shows only for a file inside cwd and calls onOpenInFiles; a file outside cwd is a tab in the dialog, not in the Files tab", async () => {
  const onOpenInFiles = vi.fn();
  const { store } = await setup({ onOpenInFiles });
  await openTab(store, "/p/a.ts");
  await openTab(store, "/o/out.ts", { outside: true });
  expect(tabTexts(side())).toEqual(["a.ts"]);
  expect(q("[data-testid=open-in-editor]", side())).toBeNull();
  await click("[data-testid=files-popout]");
  await flush();
  expect(tabTexts(dlg()!)).toEqual(["a.ts", "out.ts"]);
  expect(q("[data-testid=files-popout]", dlg()!)).toBeNull();
  await click(tabButton(dlg()!, 1));
  await flush();
  expect(q("[data-testid=open-in-editor]", dlg()!)).toBeNull();
  await click(tabButton(dlg()!, 0));
  await click("[data-testid=open-in-editor]");
  expect(onOpenInFiles).toHaveBeenCalledOnce();
  expect(dlg()).toBeNull();
});

const pointer = (fine: boolean) => {
  window.matchMedia = ((query: string) => ({ matches: fine && query.includes("pointer: fine"), media: query, addEventListener() {}, removeEventListener() {} })) as never;
};

it("after Pop out with a mouse the keyboard focus is in the dialog's editor, so Ctrl+Z works without a click", async () => {
  pointer(true);
  try {
    const { store } = await setup();
    await openTab(store, "/p/a.ts");
    q<HTMLElement>("[data-testid=files-popout]")!.focus();
    await click("[data-testid=files-popout]");
    await flush();
    await vi.waitFor(() => expect(document.activeElement).toBe(cmView(dlg()!).contentDOM));
  } finally {
    pointer(false);
  }
});

it("on touch Pop out leaves the editor unfocused (the soft keyboard stays closed), and a dialog not opened by Pop out does not take the editor", async () => {
  const { store } = await setup();
  await openTab(store, "/p/a.ts");
  q<HTMLElement>("[data-testid=files-popout]")!.focus();
  await click("[data-testid=files-popout]");
  await flush();
  expect(document.activeElement).not.toBe(cmView(dlg()!).contentDOM);
  expect(dlg()!.contains(document.activeElement)).toBe(true);
  act(() => root.render(null));
  pointer(true);
  try {
    // A Read card or file link: the dialog opens with no Pop out button as its opener.
    const other = await setup({ startOpen: true });
    await openTab(other.store, "/p/b.ts");
    await flush();
    expect(document.activeElement).not.toBe(cmView(dlg()!).contentDOM);
  } finally {
    pointer(false);
  }
});

it("opening at a line puts the cursor on it in the dialog", async () => {
  const { store } = await setup();
  await openTab(store, "/p/a.ts", { line: 40 });
  await click("[data-testid=files-popout]");
  await flush();
  const v = cmView(dlg()!);
  expect(v.state.selection.main.head).toBe(v.state.doc.line(40).from);
});

it("a media file opens in the media viewer; a binary file shows its notice", async () => {
  const client = fakeClient((m) => {
    if (m.type === "fs.media") return { url: "/media/x/p.png", mime: "image/png", size: 3, mtime: 1 };
    if (m.type === "fs.read" && m.path === "/p/a.bin") throw Object.assign(new Error("binary"), { code: "binary", size: 2048 });
    return undefined;
  });
  const store = createEditorStore(() => client);
  await act(async () => root.render(<Harness client={client} store={store} startOpen />));
  await openTab(store, "/p/p.png");
  expect(q<HTMLImageElement>("[data-testid=media-image]", dlg()!)!.getAttribute("src")).toMatch(/\/media\/x\/p\.png$/);
  expect(client.calls.mock.calls.some(([m]) => m.type === "fs.read")).toBe(false);
  expect(q("[data-testid=open-in-editor]", dlg()!)).not.toBeNull();
  await openTab(store, "/p/a.bin");
  expect(q("[data-testid=file-notice]", dlg()!)!.textContent).toContain("Binary file, not shown (2 KB)");
});

it("Esc handled by the search panel does not close the dialog; a second Esc does", async () => {
  const { store } = await setup({ startOpen: true });
  await openTab(store, "/p/a.ts");
  const v = cmView(dlg()!);
  await act(async () => void openSearchPanel(v));
  const esc = (target: Element) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await esc(q(".cm-search input", dlg()!)!);
  expect(dlg()).not.toBeNull();
  expect(q(".cm-search", dlg()!)).toBeNull();
  await esc(v.contentDOM);
  await vi.waitFor(() => expect(dlg()).toBeNull());
});

it("focus returns to the opener on close", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  const client = fakeClient();
  const store = createEditorStore(() => client);
  const Wrapper = () => {
    const [open, setOpen] = useState(true);
    return <FileDialog open={open} opener={opener} client={client} status="connected" cwd="/p" store={store} onClose={() => setOpen(false)} onSend={() => {}} onOpenInFiles={() => {}} />;
  };
  await act(async () => root.render(<Wrapper />));
  await flush();
  await click("[data-testid=viewer-close]");
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  opener.remove();
});

it("Send selection closes the dialog and hands the @mention to onSend; Alt+K too; the drafts stay in the store", async () => {
  const onSend = vi.fn();
  const { store } = await setup({ startOpen: true, onSend });
  await openTab(store, "/p/a.ts");
  await click("[data-testid=send-selection]");
  expect(onSend).toHaveBeenCalledWith("@a.ts");
  await vi.waitFor(() => expect(dlg()).toBeNull());
  expect(store.get().tabs["/p/a.ts"]).toBeDefined();
  onSend.mockClear();
  await click("[data-testid=files-popout]");
  await flush();
  await act(async () => void cmView(dlg()!).contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "k", altKey: true, bubbles: true, cancelable: true })));
  expect(onSend).toHaveBeenCalledTimes(1);
});

it("opened with Pop out, Esc and Close return focus to the Pop out button, which the Files tab recreates while the dialog is open", async () => {
  const { store } = await setup();
  await openTab(store, "/p/a.ts");
  for (const close of ["esc", "x"]) {
    const popOut = q<HTMLButtonElement>("[data-testid=files-popout]", side())!;
    popOut.focus();
    await click(popOut);
    await flush();
    expect(popOut.isConnected).toBe(false);
    if (close === "x") await click("[data-testid=viewer-close]");
    else await act(async () => void cmView(dlg()!).contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(dlg()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(q("[data-testid=files-popout]", side())));
  }
});

it("a Read card for a file already open from another project's Files tab shows it in the dialog, at the line", async () => {
  const { store } = await setup({ startOpen: true });
  await openTab(store, "/o/out.ts", { preview: false }); // opened without the flag, as project B's Files tab would
  await openTab(store, "/p/a.ts");
  await act(async () => void (await store.open("/o/out.ts", { cwd: "/p", outside: true, line: 1 })));
  await flush();
  expect(store.get().tabs["/o/out.ts"]!.outside).toBe(true);
  expect(q(".cm-content", dlg()!)!.textContent).toContain("outside");
});

it("the restored editor scrolls its cursor into view", async () => {
  const { store } = await setup();
  await openTab(store, "/p/a.ts");
  const v = cmView(side());
  const head = v.state.doc.line(40).from;
  await act(async () => v.dispatch({ selection: { anchor: head } }));
  const spy = vi.spyOn(EditorView.prototype, "dispatch");
  await click("[data-testid=files-popout]");
  await flush();
  const effects = spy.mock.calls.flatMap((c) => ((c[0] as { effects?: unknown })?.effects ? [(c[0] as { effects: unknown }).effects].flat() : [])) as { value?: { range?: { head: number } } }[];
  spy.mockRestore();
  expect(effects.some((e) => e.value?.range?.head === head)).toBe(true);
});
