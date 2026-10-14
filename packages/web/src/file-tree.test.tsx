// @vitest-environment jsdom
import { act, createRef, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { FileTree, type FileTreeHandle } from "./file-tree.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ent = (path: string, isDir = false) => ({ name: path.split("/").at(-1)!, path, isDir });
const listings: Record<string, ReturnType<typeof ent>[]> = {
  "/p": [ent("/p/src", true), ent("/p/README.md"), ent("/p/package.json"), ent("/p/new.ts")],
  "/p/src": [ent("/p/src/lib", true), ent("/p/src/app.ts")],
  "/p/src/lib": [ent("/p/src/lib/util.ts")],
};
const diff = { diff: { prefix: "", files: [{ status: "M", path: "src/app.ts" }, { status: "A", path: "new.ts", untracked: true }] } };

function setup(props: Partial<ComponentProps<typeof FileTree>> = {}, replies: Record<string, unknown> = {}) {
  const request = vi.fn(async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list") return { entries: listings[m.path!] ?? [] };
    if (m.type in replies) return replies[m.type];
    return {};
  });
  const client = { request } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const handle = createRef<FileTreeHandle | undefined>() as { current: FileTreeHandle | undefined };
  const onOpen = vi.fn();
  const render = (p: Partial<ComponentProps<typeof FileTree>> = {}) =>
    act(async () => root.render(<FileTree client={client} cwd="/p" onOpen={onOpen} handleRef={handle} {...props} {...p} />));
  const rows = () => [...el.querySelectorAll<HTMLElement>("[role=treeitem]")];
  const names = () => rows().map((r) => r.dataset.path!.slice(3));
  const row = (path: string) => rows().find((r) => r.dataset.path === path)!;
  const key = (target: Element, k: string, init: KeyboardEventInit = {}) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));
  return { request, el, root, render, rows, names, row, key, onOpen, handle, unmount: () => act(() => root.render(null)) };
}
afterEach(() => void (document.body.innerHTML = ""));

it("renders a flat ARIA tree: role=tree, treeitems with aria-level, aria-expanded on dirs, one tabIndex=0 row", async () => {
  const t = setup();
  await t.render();
  expect(t.el.querySelector("[role=tree]")).not.toBeNull();
  expect(t.names()).toEqual(["src", "README.md", "package.json", "new.ts"]);
  expect(t.row("/p/src").getAttribute("aria-expanded")).toBe("false");
  expect(t.row("/p/README.md").hasAttribute("aria-expanded")).toBe(false);
  expect(t.rows().every((r) => r.getAttribute("aria-level") === "1")).toBe(true);
  expect(t.rows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
  await act(async () => t.row("/p/src").click());
  expect(t.row("/p/src").getAttribute("aria-expanded")).toBe("true");
  expect(t.row("/p/src/app.ts").getAttribute("aria-level")).toBe("2");
  t.unmount();
});

it("file rows show the file-type icon (data-icon) and folder rows a folder icon", async () => {
  const t = setup();
  await t.render();
  expect(t.row("/p/new.ts").querySelector("svg[data-icon]")!.getAttribute("data-icon")).not.toBe("Document");
  expect(t.row("/p/package.json").querySelector("svg[data-icon]")).not.toBeNull();
  expect(t.row("/p/src").querySelector("svg[data-icon]")).toBeNull();
  expect(t.row("/p/src").querySelectorAll("svg").length).toBe(2);
  t.unmount();
});

it("git.diff marks: a modified file shows M in text-info, an untracked one U in text-success, the parent folder a dot; the name ends with the state", async () => {
  const t = setup({ gitStamp: "idle|1" }, { "git.diff": diff });
  await t.render();
  await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
  await act(async () => t.row("/p/src").click());
  const mark = (p: string) => t.row(p).querySelector("[data-testid=git-mark]")!;
  expect(mark("/p/src/app.ts").textContent).toBe("M");
  expect(mark("/p/src/app.ts").className).toContain("text-info");
  expect(mark("/p/new.ts").textContent).toBe("U");
  expect(mark("/p/new.ts").className).toContain("text-success");
  expect(mark("/p/src").className).toContain("rounded-full");
  expect(t.row("/p/src/app.ts").textContent).toBe("app.ts" + "M" + ", modified");
  expect(t.row("/p/src").textContent).toBe("src, contains changes");
  expect(t.request).toHaveBeenCalledWith({ type: "git.diff", cwd: "/p", base: "head" });
  t.unmount();
});

it("no gitStamp or not visible: no git.diff request; a null diff shows no marks", async () => {
  const none = setup({}, { "git.diff": diff });
  await none.render();
  await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
  expect(none.request.mock.calls.some(([m]) => m.type === "git.diff")).toBe(false);
  none.unmount();
  const hidden = setup({ gitStamp: "x", visible: false }, { "git.diff": diff });
  await hidden.render();
  await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
  expect(hidden.request.mock.calls.some(([m]) => m.type === "git.diff")).toBe(false);
  hidden.unmount();
  const outside = setup({ gitStamp: "x" }, { "git.diff": { diff: null } });
  await outside.render();
  await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
  expect(outside.el.querySelector("[data-testid=git-mark]")).toBeNull();
  outside.unmount();
});

it("keyboard: ArrowRight expands and lists a dir, ArrowLeft returns to the parent, Enter on a file opens it and asks for the editor focus, Space opens without", async () => {
  const t = setup();
  await t.render();
  t.row("/p/src").focus();
  await t.key(t.row("/p/src"), "ArrowRight");
  expect(t.request).toHaveBeenCalledWith({ type: "fs.list", path: "/p/src" });
  expect(t.names()).toContain("src/app.ts");
  await t.key(t.row("/p/src"), "ArrowRight");
  expect(document.activeElement).toBe(t.row("/p/src/lib"));
  await t.key(t.row("/p/src/lib"), "ArrowLeft");
  expect(document.activeElement).toBe(t.row("/p/src"));
  await t.key(t.row("/p/src"), "ArrowDown");
  expect(document.activeElement).toBe(t.row("/p/src/lib"));
  await t.key(t.row("/p/src/lib"), "End");
  expect(document.activeElement).toBe(t.row("/p/new.ts"));
  await t.key(t.row("/p/new.ts"), "Enter");
  expect(t.onOpen).toHaveBeenLastCalledWith("/p/new.ts", { focusEditor: true });
  await t.key(t.row("/p/new.ts"), " ");
  expect(t.onOpen).toHaveBeenLastCalledWith("/p/new.ts", {});
  await t.key(t.row("/p/new.ts"), "Home");
  await t.key(t.row("/p/src"), "ArrowLeft");
  expect(t.row("/p/src").getAttribute("aria-expanded")).toBe("false");
  t.unmount();
});

it("click on a file opens it; double click opens it pinned", async () => {
  const t = setup();
  await t.render();
  await act(async () => t.row("/p/README.md").click());
  expect(t.onOpen).toHaveBeenLastCalledWith("/p/README.md", {});
  await act(async () => void t.row("/p/README.md").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(t.onOpen).toHaveBeenLastCalledWith("/p/README.md", { pinned: true });
  t.unmount();
});

it('type-ahead: typing "rea" focuses README.md', async () => {
  const t = setup();
  await t.render();
  t.row("/p/src").focus();
  for (const k of "rea") await t.key(document.activeElement!, k);
  expect(document.activeElement).toBe(t.row("/p/README.md"));
  t.unmount();
});

it("filter: typing calls fs.search after the debounce and shows hits as a tree; an empty answer says so; Esc clears and restores the tree", async () => {
  const t = setup({}, { "fs.search": { paths: ["src/lib/util.ts"] } });
  await t.render();
  const input = t.el.querySelector<HTMLInputElement>("input[type=search]")!;
  expect(input.getAttribute("aria-label")).toBe("Filter files");
  const type = (v: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
    });
  await type("util");
  expect(t.request).toHaveBeenCalledWith({ type: "fs.search", cwd: "/p", query: "util" });
  expect(t.names()).toEqual(["src", "src/lib", "src/lib/util.ts"]);
  await type("zzz");
  await act(async () => void 0);
  t.request.mockImplementation(async (m: { type: string }) => (m.type === "fs.search" ? { paths: [] } : { entries: [] }));
  await type("nothing");
  expect(t.el.querySelector("[role=status]")!.textContent).toBe("No matching files.");
  const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => void input.dispatchEvent(esc));
  expect(input.value).toBe("");
  expect(t.names()).toEqual(["src", "README.md", "package.json", "new.ts"]);
  t.unmount();
});

it("collapse all clears the expanded dirs; reveal expands the ancestors of a path (fs.list per ancestor) and focuses its row", async () => {
  const t = setup();
  await t.render();
  await act(async () => t.row("/p/src").click());
  expect(t.names()).toContain("src/app.ts");
  await act(async () => t.handle.current!.collapseAll());
  expect(t.names()).toEqual(["src", "README.md", "package.json", "new.ts"]);
  await act(async () => t.handle.current!.reveal("/p/src/lib/util.ts", true));
  expect(t.names()).toContain("src/lib/util.ts");
  expect(t.request).toHaveBeenCalledWith({ type: "fs.list", path: "/p/src/lib" });
  expect(document.activeElement).toBe(t.row("/p/src/lib/util.ts"));
  t.unmount();
});

it("auto-reveal: changing activePath expands its ancestors without moving focus", async () => {
  const t = setup();
  await t.render();
  const before = document.activeElement;
  await t.render({ activePath: "/p/src/lib/util.ts" });
  await act(async () => void (await new Promise((r) => setTimeout(r, 10))));
  expect(t.names()).toContain("src/lib/util.ts");
  expect(document.activeElement).toBe(before);
  expect(t.row("/p/src/lib/util.ts").getAttribute("aria-selected")).toBe("true");
  t.unmount();
});

it("rows are 28px, 44px below md and on touch; the filter field is 44px there and 16px text", async () => {
  const t = setup();
  await t.render();
  const c = t.row("/p/src").className;
  expect(c).toContain("h-7");
  expect(c).toContain("max-md:h-11");
  expect(c).toContain("pointer-coarse:h-11");
  const f = t.el.querySelector("input")!.className;
  expect(f).toContain("max-md:h-11");
  expect(f).toContain("text-base");
  t.unmount();
});

// --- GH-360: context menu ---
const ctxMenu = (target: Element, init: MouseEventInit = {}) => act(async () => void target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5, ...init })));
const menuIds = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((i) => i.dataset.testid!.replace("tree-menu-", ""));
const menuItem = (id: string) => document.querySelector<HTMLElement>(`[data-testid="tree-menu-${id}"]`)!;
const closeMenu = async () => {
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => {});
};

it("GH-360 right click opens the menu of the row under it: file, folder, empty space", async () => {
  const t = setup();
  await t.render();
  await ctxMenu(t.row("/p/README.md"));
  expect(menuIds()).toEqual(["open", "viewer", "mention", "copyPath", "copyRel", "rename", "duplicate", "delete"]);
  await closeMenu();
  await ctxMenu(t.row("/p/src"));
  expect(menuIds()).toEqual(["newFile", "newFolder", "copyPath", "copyRel", "rename", "delete", "collapse"]);
  await closeMenu();
  await ctxMenu(t.el.querySelector('[data-testid="tree-empty-space"]')!);
  expect(menuIds()).toEqual(["newFile", "newFolder", "refresh"]);
  await closeMenu();
  t.unmount();
});

it("GH-360 Show changes only for a file with a git mark", async () => {
  const t = setup({ gitStamp: "s" }, { "git.diff": diff });
  await t.render();
  await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
  await ctxMenu(t.row("/p/new.ts"));
  expect(menuIds()).toContain("changes");
  await closeMenu();
  await ctxMenu(t.row("/p/README.md"));
  expect(menuIds()).not.toContain("changes");
  await closeMenu();
  t.unmount();
});

it("GH-360 menu commands: Open pins and focuses the editor, copy, mention, viewer, collapse, refresh", async () => {
  const onCopy = vi.fn();
  const onMention = vi.fn();
  const onViewer = vi.fn();
  const onReload = vi.fn();
  const t = setup({ onCopy, onMention, onViewer, onReload });
  await t.render();
  await act(async () => t.row("/p/src").click());
  const run = async (path: string, id: string) => {
    await ctxMenu(t.row(path));
    await act(async () => menuItem(id).click());
    await act(async () => {});
  };
  await run("/p/src/app.ts", "open");
  expect(t.onOpen).toHaveBeenLastCalledWith("/p/src/app.ts", { pinned: true, focusEditor: true });
  await run("/p/src/app.ts", "copyPath");
  expect(onCopy).toHaveBeenLastCalledWith("/p/src/app.ts", "path");
  await run("/p/src/app.ts", "copyRel");
  expect(onCopy).toHaveBeenLastCalledWith("src/app.ts", "relative path");
  await run("/p/src/app.ts", "mention");
  expect(onMention).toHaveBeenLastCalledWith("/p/src/app.ts");
  await run("/p/src/app.ts", "viewer");
  expect(onViewer).toHaveBeenLastCalledWith("/p/src/app.ts");
  await run("/p/src", "collapse");
  expect(t.row("/p/src").getAttribute("aria-expanded")).toBe("false");
  await ctxMenu(t.el.querySelector('[data-testid="tree-empty-space"]')!);
  await act(async () => menuItem("refresh").click());
  expect(onReload).toHaveBeenCalled();
  t.unmount();
});

it("GH-360 Shift+F10 and the ContextMenu key open the focused row's menu; F10 alone does not; Escape returns focus to the row", async () => {
  const t = setup();
  await t.render();
  t.row("/p/README.md").focus();
  await t.key(t.row("/p/README.md"), "F10");
  expect(document.querySelector('[role="menu"]')).toBeNull();
  for (const init of [{ key: "F10", shiftKey: true }, { key: "ContextMenu" }]) {
    await t.key(t.row("/p/README.md"), init.key, init);
    expect(menuIds()).toContain("open");
    await closeMenu();
    expect(document.activeElement).toBe(t.row("/p/README.md"));
  }
  t.unmount();
});

it("GH-360 long press: touchstart on a row, 500 ms later the menu of that row opens", async () => {
  vi.useFakeTimers();
  try {
    const t = setup();
    await t.render();
    await act(async () => void t.row("/p/src").dispatchEvent(Object.assign(new Event("touchstart", { bubbles: true, cancelable: true }), { touches: [{ clientX: 10, clientY: 10 }] })));
    await act(async () => void vi.advanceTimersByTime(600));
    expect(menuIds()).toEqual(["newFile", "newFolder", "copyPath", "copyRel", "rename", "delete", "collapse"]);
    t.unmount();
  } finally {
    vi.useRealTimers();
  }
});

it("GH-360 menu items are 44 px high below md", async () => {
  const t = setup();
  await t.render();
  await ctxMenu(t.row("/p/README.md"));
  expect(menuItem("open").className).toContain("max-md:h-11");
  await closeMenu();
  t.unmount();
});

// --- GH-360: write operations ---
const typeInto = (input: HTMLInputElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const nameInput = () => document.querySelector<HTMLInputElement>('[data-testid="tree-name-input"]');
const sent = (t: ReturnType<typeof setup>, type: string) => t.request.mock.calls.map((c) => c[0] as { type: string; path?: string; name?: string; dir?: boolean; dryRun?: boolean }).filter((m) => m.type === type);
/** fs.list as the fixture, the write operations as `ops` (a throw is the daemon's refusal). */
function ops(t: ReturnType<typeof setup>, handlers: Record<string, (m: { path: string; name?: string }) => unknown>) {
  t.request.mockImplementation((async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list") return { entries: listings[m.path!] ?? [] };
    const h = handlers[m.type];
    if (h) return h(m as never);
    return {};
  }) as never);
}
const refusal = (code: string, message = "refused") => Object.assign(new Error(message), { code });

it("GH-360 New file in a folder: the input is its first child; Enter sends fs.create and opens the file pinned; Escape and an empty blur send nothing", async () => {
  const t = setup();
  await t.render();
  ops(t, { "fs.create": (m) => ({ path: m.path }) });
  await ctxMenu(t.row("/p/src"));
  await act(async () => menuItem("newFile").click());
  await act(async () => {});
  const input = nameInput()!;
  expect(input.getAttribute("aria-label")).toBe("New file name in src");
  expect(document.activeElement).toBe(input);
  expect(t.names().slice(0, 2)).toEqual(["src", "src/lib"]);
  expect(input.closest('[role="none"]')!.previousElementSibling).toBe(t.row("/p/src"));
  await t.key(input, "Escape");
  expect(nameInput()).toBeNull();
  expect(sent(t, "fs.create")).toHaveLength(0);
  expect(document.activeElement).toBe(t.row("/p/src"));
  await ctxMenu(t.row("/p/src"));
  await act(async () => menuItem("newFile").click());
  await act(async () => {});
  await act(async () => void nameInput()!.blur());
  expect(nameInput()).toBeNull();
  expect(sent(t, "fs.create")).toHaveLength(0);
  await ctxMenu(t.row("/p/src"));
  await act(async () => menuItem("newFile").click());
  await act(async () => {});
  await typeInto(nameInput()!, "x.ts");
  await t.key(nameInput()!, "Enter");
  await act(async () => {});
  expect(sent(t, "fs.create")).toEqual([{ type: "fs.create", path: "/p/src/x.ts" }]);
  expect(t.onOpen).toHaveBeenLastCalledWith("/p/src/x.ts", { pinned: true, focusEditor: true });
  expect(nameInput()).toBeNull();
  t.unmount();
});

it("GH-360 New folder sends dir and focuses the new folder row; the root menu creates in the project", async () => {
  const t = setup();
  await t.render();
  const lists = { ...listings };
  t.request.mockImplementation((async (m: { type: string; path?: string; dir?: boolean }) => {
    if (m.type === "fs.list") return { entries: lists[m.path!] ?? [] };
    if (m.type === "fs.create") return (lists["/p"] = [...lists["/p"]!, ent(m.path!, true)]), { path: m.path };
    return {};
  }) as never);
  await ctxMenu(t.el.querySelector('[data-testid="tree-empty-space"]')!);
  await act(async () => menuItem("newFolder").click());
  await act(async () => {});
  expect(nameInput()!.getAttribute("aria-label")).toBe("New folder name in the project");
  expect(t.el.querySelector("[role=tree]")!.firstElementChild!.contains(nameInput())).toBe(true);
  await typeInto(nameInput()!, "docs");
  await t.key(nameInput()!, "Enter");
  await act(async () => {});
  await act(async () => {});
  expect(sent(t, "fs.create")).toEqual([{ type: "fs.create", path: "/p/docs", dir: true }]);
  expect(document.activeElement).toBe(t.row("/p/docs"));
  t.unmount();
});

it("GH-360 an invalid name or a sibling clash shows an alert and Enter sends nothing", async () => {
  const t = setup();
  await t.render();
  ops(t, {});
  await ctxMenu(t.row("/p/src"));
  await act(async () => menuItem("newFile").click());
  await act(async () => {});
  await typeInto(nameInput()!, "a/b");
  expect(document.querySelector('[data-testid="tree-name-message"]')!.textContent).toBe("A name cannot contain / or \\.");
  expect(nameInput()!.getAttribute("aria-invalid")).toBe("true");
  await t.key(nameInput()!, "Enter");
  await typeInto(nameInput()!, "app.ts");
  expect(document.querySelector('[role="alert"]')!.textContent).toBe("A file or folder named “app.ts” already exists here.");
  await t.key(nameInput()!, "Enter");
  expect(sent(t, "fs.create")).toHaveLength(0);
  expect(nameInput()).not.toBeNull();
  t.unmount();
});

it("GH-360 a daemon refusal keeps the input with the message", async () => {
  const t = setup();
  await t.render();
  ops(t, { "fs.create": () => { throw refusal("exists"); } });
  await ctxMenu(t.row("/p/src"));
  await act(async () => menuItem("newFile").click());
  await act(async () => {});
  await typeInto(nameInput()!, "fresh.ts");
  await t.key(nameInput()!, "Enter");
  await act(async () => {});
  expect(nameInput()!.value).toBe("fresh.ts");
  expect(document.querySelector('[role="alert"]')!.textContent).toBe("A file or folder named “fresh.ts” already exists here.");
  await typeInto(nameInput()!, "fresh2.ts");
  expect(document.querySelector('[data-testid="tree-name-message"]')).toBeNull();
  t.unmount();
});

it("GH-360 F2 renames: the name without its extension is selected, Enter sends fs.rename, onMoved is called, the renamed row is focused", async () => {
  const onMoved = vi.fn();
  const t = setup({ onMoved });
  await t.render();
  await act(async () => t.row("/p/src").click());
  const lists: Record<string, ReturnType<typeof ent>[]> = { ...listings, "/p/src": [ent("/p/src/lib", true), ent("/p/src/main.ts")] };
  t.request.mockImplementation((async (m: { type: string; path?: string; name?: string }) => {
    if (m.type === "fs.list") return { entries: lists[m.path!] ?? [] };
    if (m.type === "fs.rename") return { path: "/p/src/main.ts" };
    return {};
  }) as never);
  t.row("/p/src/app.ts").focus();
  await t.key(t.row("/p/src/app.ts"), "F2");
  await act(async () => {});
  const input = nameInput()!;
  expect(input.getAttribute("aria-label")).toBe("Rename app.ts");
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 3]);
  await typeInto(input, "main.ts");
  await t.key(input, "Enter");
  await act(async () => {});
  await act(async () => {});
  expect(sent(t, "fs.rename")).toEqual([{ type: "fs.rename", path: "/p/src/app.ts", name: "main.ts" }]);
  expect(onMoved).toHaveBeenCalledWith("/p/src/app.ts", "/p/src/main.ts");
  expect(document.activeElement).toBe(t.row("/p/src/main.ts"));
  t.unmount();
});

it("GH-360 typing in the name field does not reach the tree (type-ahead, arrows)", async () => {
  const t = setup();
  await t.render();
  t.row("/p/README.md").focus();
  await t.key(t.row("/p/README.md"), "F2");
  await act(async () => {});
  const input = nameInput()!;
  await t.key(input, "p");
  await t.key(input, "ArrowDown");
  expect(document.activeElement).toBe(input);
  t.unmount();
});

it("GH-360 Delete on a folder asks with the count; Cancel sends nothing; Confirm sends fs.delete, calls onDeleted and focuses the next row", async () => {
  const onDeleted = vi.fn();
  const t = setup({ onDeleted, dirtyUnder: () => 1 });
  await t.render();
  ops(t, { "fs.delete": (m) => ((m as { dryRun?: boolean }).dryRun ? { files: 2, folders: 1 } : { files: 2, folders: 1 }) });
  t.row("/p/src").focus();
  await t.key(t.row("/p/src"), "Delete");
  await act(async () => {});
  const dialog = () => document.querySelector('[data-testid="tree-delete-dialog"]');
  expect(dialog()!.textContent).toContain("Delete “src”?");
  expect(dialog()!.textContent).toContain("The folder and the 2 files and 1 folder in it are deleted for good. It does not go to the trash.");
  expect(dialog()!.textContent).toContain("1 open file has unsaved changes; it stays open.");
  expect(sent(t, "fs.delete")).toEqual([{ type: "fs.delete", path: "/p/src", dryRun: true }]);
  await act(async () => document.querySelector<HTMLElement>('[data-testid="tree-delete-cancel"]')!.click());
  expect(sent(t, "fs.delete")).toHaveLength(1);
  await act(async () => {});
  expect(document.activeElement).toBe(t.row("/p/src"));
  await t.key(t.row("/p/src"), "Delete");
  await act(async () => {});
  await act(async () => document.querySelector<HTMLElement>('[data-testid="tree-delete-confirm"]')!.click());
  await act(async () => {});
  await act(async () => {});
  expect(sent(t, "fs.delete").at(-1)).toEqual({ type: "fs.delete", path: "/p/src" });
  expect(onDeleted).toHaveBeenCalledWith("/p/src");
  expect(document.activeElement).toBe(t.row("/p/README.md"));
  t.unmount();
});

it("GH-360 Delete on a file says it goes for good, without counting", async () => {
  const t = setup();
  await t.render();
  ops(t, {});
  await ctxMenu(t.row("/p/README.md"));
  await act(async () => menuItem("delete").click());
  await act(async () => {});
  expect(document.querySelector('[data-testid="tree-delete-dialog"]')!.textContent).toContain("The file is deleted for good. It does not go to the trash.");
  expect(sent(t, "fs.delete")).toHaveLength(0);
  t.unmount();
});

it("GH-360 a failed delete shows the alert line; Dismiss removes it", async () => {
  const t = setup();
  await t.render();
  ops(t, { "fs.delete": () => { throw refusal("in_use"); } });
  await ctxMenu(t.row("/p/README.md"));
  await act(async () => menuItem("delete").click());
  await act(async () => {});
  await act(async () => document.querySelector<HTMLElement>('[data-testid="tree-delete-confirm"]')!.click());
  await act(async () => {});
  expect(document.querySelector('[data-testid="tree-op-error"]')!.textContent).toContain("A session works in this folder. Close that session first.");
  await act(async () => document.querySelector<HTMLElement>('[data-testid="tree-op-error"] button[aria-label="Dismiss"]')!.click());
  expect(document.querySelector('[data-testid="tree-op-error"]')).toBeNull();
  t.unmount();
});

it("GH-360 Duplicate sends fs.duplicate and focuses the copy", async () => {
  const t = setup();
  await t.render();
  const lists = { ...listings };
  t.request.mockImplementation((async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list") return { entries: lists[m.path!] ?? [] };
    if (m.type === "fs.duplicate") return (lists["/p"] = [...lists["/p"]!, ent("/p/README copy.md")]), { path: "/p/README copy.md" };
    return {};
  }) as never);
  await ctxMenu(t.row("/p/README.md"));
  await act(async () => menuItem("duplicate").click());
  await act(async () => {});
  await act(async () => {});
  expect(sent(t, "fs.duplicate")).toEqual([{ type: "fs.duplicate", path: "/p/README.md" }]);
  expect(document.activeElement).toBe(t.row("/p/README copy.md"));
  t.unmount();
});

it("GH-360 Rename while a filter is active clears the filter, reveals the row and shows the input", async () => {
  const t = setup();
  await t.render();
  const filter = t.el.querySelector<HTMLInputElement>('[data-testid="tree-filter"]')!;
  t.request.mockImplementation((async (m: { type: string; path?: string }) => (m.type === "fs.list" ? { entries: listings[m.path!] ?? [] } : m.type === "fs.search" ? { paths: ["src/app.ts"] } : {})) as never);
  await typeInto(filter, "app");
  await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
  expect(t.names()).toEqual(["src", "src/app.ts"]);
  await ctxMenu(t.row("/p/src/app.ts"));
  await act(async () => menuItem("rename").click());
  await act(async () => {});
  await act(async () => {});
  expect(filter.value).toBe("");
  expect(nameInput()!.value).toBe("app.ts");
  t.unmount();
});

it("GH-360 file menu has Rename F2, Duplicate and Delete with the shortcut hints; a folder has New file and New folder", async () => {
  const t = setup();
  await t.render();
  await ctxMenu(t.row("/p/README.md"));
  expect(menuIds()).toEqual(["open", "viewer", "mention", "copyPath", "copyRel", "rename", "duplicate", "delete"]);
  expect(menuItem("rename").getAttribute("aria-keyshortcuts")).toBe("F2");
  expect(menuItem("delete").className).toContain("text-destructive");
  await closeMenu();
  await ctxMenu(t.row("/p/src"));
  expect(menuIds()).toEqual(["newFile", "newFolder", "copyPath", "copyRel", "rename", "delete", "collapse"]);
  await closeMenu();
  t.unmount();
});
