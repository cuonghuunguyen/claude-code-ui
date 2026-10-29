// @vitest-environment jsdom
// GH-399: a file as a main-area tab, its entry points in the Files panel, and the FileTab body.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { createEditorStore } from "./editor-store.ts";
import { FilesPanel, FileTab } from "./files-panel.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILES: Record<string, string> = { "/p/a.ts": "a", "/p/b.md": "# b", "/o/x.ts": "x" };
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

function setup() {
  const request = vi.fn(async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list") return { entries: [{ name: "a.ts", path: "/p/a.ts", isDir: false }] };
    if (m.type === "fs.read") return { content: FILES[m.path!] ?? "", mtime: 1 };
    return {};
  });
  const client = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const store = createEditorStore(() => client);
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  return { client, store, el, request };
}
const q = (el: Element, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

it("an item tab is not an editor tab of Files, in the panel or the dialog; Files' other tabs show", async () => {
  const { client, store, el } = setup();
  await store.open("/p/a.ts", { cwd: "/p", preview: false });
  await store.open("/p/b.md", { cwd: "/p", preview: false, item: true });
  for (const surface of ["panel", "dialog"] as const) {
    await act(async () => root!.render(<FilesPanel client={client} status="connected" cwd="/p" editors={store} surface={surface} onSend={() => {}} showTree onToggleTree={() => {}} />));
    expect([...el.querySelectorAll("[data-testid=editor-tab]")].map((t) => t.getAttribute("title"))).toEqual(["/p/a.ts"]);
  }
});

it("the header's Open in tab calls onOpenTab with the shown file; without the prop there is no button", async () => {
  const { client, store, el } = setup();
  await store.open("/p/a.ts", { cwd: "/p", preview: false });
  const onOpenTab = vi.fn();
  const draw = (tab?: (p: string) => void) => act(async () => root!.render(<FilesPanel client={client} status="connected" cwd="/p" editors={store} onOpenTab={tab} onSend={() => {}} showTree onToggleTree={() => {}} />));
  await draw();
  expect(q(el, "open-in-tab")).toBeNull();
  await draw(onOpenTab);
  await act(async () => q(el, "open-in-tab")!.click());
  expect(onOpenTab).toHaveBeenCalledWith("/p/a.ts");
});

it("the editor tab's context menu: Open in tab, Close, Copy path, Copy relative path; a middle click still closes", async () => {
  const { client, store, el } = setup();
  await store.open("/p/a.ts", { cwd: "/p", preview: false });
  const onOpenTab = vi.fn();
  const onCopy = vi.fn();
  await act(async () => root!.render(<FilesPanel client={client} status="connected" cwd="/p" editors={store} onOpenTab={onOpenTab} onCopy={onCopy} onSend={() => {}} showTree onToggleTree={() => {}} />));
  const open = async () => {
    const tab = q(el, "editor-tab")!;
    await act(async () => void tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
    return [...document.querySelectorAll<HTMLElement>('[data-testid="editor-tab-menu"] [role=menuitem]')];
  };
  const items = await open();
  expect(items.map((i) => i.textContent)).toEqual(["Open in tab", "Close", "Copy path", "Copy relative path"]);
  await act(async () => items[2]!.click());
  expect(onCopy).toHaveBeenCalledWith("/p/a.ts", "path");
  const again = await open();
  await act(async () => again[3]!.click());
  expect(onCopy).toHaveBeenLastCalledWith("a.ts", "relative path");
  const third = await open();
  await act(async () => third[0]!.click());
  expect(onOpenTab).toHaveBeenCalledWith("/p/a.ts");
  await act(async () => void el.querySelector<HTMLElement>("[data-testid=editor-tab] button")!.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })));
  expect(q(el, "editor-tab")).toBeNull();
});

it("the tree's file menu has Open in tab and a middle click on a file row opens a tab", async () => {
  const { client, store, el } = setup();
  const onOpenTab = vi.fn();
  await act(async () => root!.render(<FilesPanel client={client} status="connected" cwd="/p" editors={store} onOpenTab={onOpenTab} onSend={() => {}} showTree onToggleTree={() => {}} />));
  const row = () => el.querySelector<HTMLElement>('[data-testid="tree-entry"][data-path="/p/a.ts"]')!;
  await act(async () => void row().dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })));
  expect(onOpenTab).toHaveBeenCalledWith("/p/a.ts");
  await act(async () => void row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  const item = document.querySelector<HTMLElement>('[data-testid="tree-menu-openTab"]')!;
  expect(item.textContent).toBe("Open in tab");
  await act(async () => item.click());
  expect(onOpenTab).toHaveBeenCalledTimes(2);
});

it("opening a path that is a file tab already calls onItem and adds no Files tab", async () => {
  const { client, store, el } = setup();
  await store.open("/p/a.ts", { cwd: "/p", preview: false, item: true });
  const onItem = vi.fn();
  await act(async () => root!.render(<FilesPanel client={client} status="connected" cwd="/p" editors={store} onItem={onItem} openPath="/p/a.ts" onOpened={() => {}} onSend={() => {}} showTree onToggleTree={() => {}} />));
  expect(onItem).toHaveBeenCalledWith("/p/a.ts");
  expect(el.querySelectorAll("[data-testid=editor-tab]")).toHaveLength(0);
});

it("FileTab reads the file when the store has none (reload), shows its editor and Move to Files", async () => {
  const { client, store, el, request } = setup();
  const onMoveToFiles = vi.fn();
  await act(async () => root!.render(<FileTab store={store} client={client} path="/p/a.ts" cwd="/p" onSend={() => {}} onFolder={() => {}} onLink={() => {}} onMoveToFiles={onMoveToFiles} onFocusTab={() => {}} />));
  expect(request).toHaveBeenCalledWith({ type: "fs.read", path: "/p/a.ts" });
  expect(store.get().tabs["/p/a.ts"]).toMatchObject({ item: true });
  expect(store.get().tabs["/p/a.ts"]!.preview).toBeUndefined();
  expect(q(el, "code-editor")).not.toBeNull();
  await act(async () => q(el, "file-tab-to-files")!.click());
  expect(onMoveToFiles).toHaveBeenCalledWith("/p/a.ts");
});

it("FileTab of a loaded tab does not read again; a new focusKey calls onFocusTab without a fine pointer", async () => {
  const { client, store, request } = setup();
  await store.open("/p/a.ts", { cwd: "/p", item: true });
  request.mockClear();
  const onFocusTab = vi.fn();
  const draw = (focusKey: number) => act(async () => root!.render(<FileTab store={store} client={client} path="/p/a.ts" cwd="/p" focusKey={focusKey} onSend={() => {}} onFolder={() => {}} onLink={() => {}} onMoveToFiles={() => {}} onFocusTab={onFocusTab} />));
  await draw(0);
  expect(request).not.toHaveBeenCalled();
  expect(onFocusTab).not.toHaveBeenCalled();
  await draw(1);
  expect(onFocusTab).toHaveBeenCalledTimes(1);
});

it("a file that cannot be read shows the read error in its FileTab instead of an empty tab", async () => {
  const { el } = setup();
  const request = vi.fn(async () => {
    throw Object.assign(new Error("No such file"), { code: "not_found" });
  });
  const c2 = { request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>;
  const s2 = createEditorStore(() => c2);
  await act(async () => root!.render(<FileTab store={s2} client={c2} path="/p/gone.ts" cwd="/p" onSend={() => {}} onFolder={() => {}} onLink={() => {}} onMoveToFiles={() => {}} onFocusTab={() => {}} />));
  expect(q(el, "file-tab-loading")!.textContent).toBe("No such file");
  expect(s2.get().tabs["/p/gone.ts"]).toBeUndefined();
});
