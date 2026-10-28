// @vitest-environment jsdom
import { act, createRef, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import type { GitRepo } from "@claude-ui/protocol";
import { FileTree, type FileTreeHandle } from "./file-tree.tsx";
import { forgetRepoChoices, getRepoChoice } from "./repo-choice.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ent = (path: string, isDir = false) => ({ name: path.split("/").at(-1)!, path, isDir });
const listings: Record<string, ReturnType<typeof ent>[]> = {
  "/p": [ent("/p/src", true), ent("/p/README.md"), ent("/p/package.json"), ent("/p/new.ts")],
  "/p/src": [ent("/p/src/lib", true), ent("/p/src/app.ts")],
  "/p/src/lib": [ent("/p/src/lib/util.ts")],
  "/q": [ent("/q/tools", true), ent("/q/libs", true), ent("/q/far", true), ent("/q/s.ts")],
  "/q/tools": [ent("/q/tools/inner", true)],
  "/q/tools/inner": [ent("/q/tools/inner/x.ts"), ent("/q/tools/inner/y.ts")],
  "/q/libs": [ent("/q/libs/lib", true)],
  "/q/libs/lib": [ent("/q/libs/lib/a.txt")],
};
const diff = { diff: { prefix: "", files: [{ status: "M", path: "src/app.ts" }, { status: "A", path: "new.ts", untracked: true }] } };

function setup(props: Partial<ComponentProps<typeof FileTree>> = {}, replies: Record<string, unknown> = {}) {
  const request = vi.fn(async (m: { type: string; path?: string; cwd?: string }) => {
    if (m.type === "fs.list") return { entries: listings[m.path!] ?? [] };
    const reply = replies[m.type];
    if (typeof reply === "function") return reply(m);
    if (m.type in replies) return reply;
    return {};
  });
  const client = { request } as unknown as ReturnType<typeof connect>;
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const handle = createRef<FileTreeHandle | undefined>() as { current: FileTreeHandle | undefined };
  const onOpen = vi.fn();
  const render = (p: Partial<ComponentProps<typeof FileTree>> = {}) =>
    act(async () => root.render(<FileTree client={client} cwd="/p" onOpen={onOpen} onViewer={() => {}} handleRef={handle} {...props} {...p} />));
  const rows = () => [...el.querySelectorAll<HTMLElement>("[role=treeitem]")];
  const names = () => rows().map((r) => r.dataset.path!.slice(3));
  const row = (path: string) => rows().find((r) => r.dataset.path === path)!;
  const key = (target: Element, k: string, init: KeyboardEventInit = {}) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init })));
  return { request, el, root, render, rows, names, row, key, onOpen, handle, unmount: () => act(() => root.render(null)) };
}
afterEach(() => {
  document.body.innerHTML = "";
  forgetRepoChoices();
  localStorage.clear();
});

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

it("GH-360 Shift+F10 on a focused row moves focus to the menu's first enabled item", async () => {
  const t = setup();
  await t.render();
  t.row("/p/src").focus();
  await t.key(t.row("/p/src"), "F10", { shiftKey: true });
  await vi.waitFor(() => expect(document.activeElement).toBe(menuItem("newFile")));
  expect(document.activeElement!.getAttribute("role")).toBe("menuitem");
  await closeMenu();
  t.unmount();
});

it("GH-360 deleting a row from the filter results removes it from the list", async () => {
  const t = setup();
  await t.render();
  const lists: Record<string, ReturnType<typeof ent>[]> = { ...listings };
  t.request.mockImplementation((async (m: { type: string; path?: string }) => {
    if (m.type === "fs.list") return { entries: lists[m.path!] ?? [] };
    if (m.type === "fs.search") return { paths: ["src/app.ts"] };
    if (m.type === "fs.delete") return { files: 0, folders: 0 };
    return {};
  }) as never);
  await typeInto(t.el.querySelector<HTMLInputElement>('[data-testid="tree-filter"]')!, "app");
  await act(async () => void (await new Promise((r) => setTimeout(r, 200))));
  expect(t.names()).toEqual(["src", "src/app.ts"]);
  await ctxMenu(t.row("/p/src/app.ts"));
  await act(async () => menuItem("delete").click());
  await act(async () => {});
  await act(async () => document.querySelector<HTMLElement>('[data-testid="tree-delete-confirm"]')!.click());
  await act(async () => {});
  await act(async () => {});
  expect(t.rows().some((r) => r.dataset.path === "/p/src/app.ts")).toBe(false);
  t.unmount();
});

it("GH-394 the file dialog's own tree (no onViewer) has no Open in file dialog item", async () => {
  const t = setup();
  await t.render({ onViewer: undefined });
  await ctxMenu(t.row("/p/README.md"));
  expect(menuIds()).toEqual(["open", "mention", "copyPath", "copyRel", "rename", "duplicate", "delete"]);
  await closeMenu();
  t.unmount();
});

const wait = (ms = 350) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const QMAIN: GitRepo = { path: "/q", rel: "", kind: "main", branch: "main" };
const QINNER: GitRepo = { path: "/q/tools/inner", rel: "tools/inner", kind: "nested", parent: "/q", branch: "main" };
const QLIB: GitRepo = { path: "/q/libs/lib", rel: "libs/lib", kind: "submodule", parent: "/q", branch: "a4a3b80" };
const QFAR: GitRepo = { path: "/q/far", rel: "far", kind: "nested", parent: "/q", outsideRoots: true };
const repos = (list: GitRepo[] = [QMAIN, QINNER, QLIB, QFAR]) => ({ list, projectKey: "proj" });
const diffs: Record<string, unknown> = {
  "/q": { diff: { prefix: "", files: [{ status: "M", path: "s.ts" }, { status: "A", path: "tools/inner/", untracked: true }, { status: "M", path: "libs/lib", submodule: { from: "a", to: "b" } }] } },
  "/q/tools/inner": { diff: { prefix: "", files: [{ status: "A", path: "x.ts", untracked: true }, { status: "M", path: "y.ts" }] } },
  "/q/libs/lib": { diff: { prefix: "", files: [] } },
};
const byCwd = (m: { cwd?: string }) => diffs[m.cwd!] ?? { diff: null };
const diffCalls = (t: { request: { mock: { calls: unknown[][] } } }) => t.request.mock.calls.map(([m]) => m as { type: string; cwd: string }).filter((m) => m.type === "git.diff");
const mark = (t: ReturnType<typeof setup>, p: string) => t.row(p).querySelector("[data-testid=git-mark]");
const openAll = async (t: ReturnType<typeof setup>) => {
  for (const p of ["/q/tools", "/q/tools/inner", "/q/libs"]) await act(async () => t.row(p).click());
};

it("GH-392 with a repository list: one git.diff per readable repository with cwd = its top, base head and exact; none for outsideRoots", async () => {
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos() }, { "git.diff": byCwd });
  await t.render();
  await wait();
  expect(diffCalls(t).map((m) => m.cwd).sort()).toEqual(["/q", "/q/libs/lib", "/q/tools/inner"]);
  expect(t.request).toHaveBeenCalledWith({ type: "git.diff", cwd: "/q/tools/inner", base: "head", exact: true });
  t.unmount();
});

it("GH-392 at most 4 git.diff requests in flight", async () => {
  const list: GitRepo[] = [QMAIN, ...Array.from({ length: 6 }, (_, i) => ({ path: `/q/r${i}`, rel: `r${i}`, kind: "nested" as const, parent: "/q" }))];
  const held: (() => void)[] = [];
  let pending = 0;
  let max = 0;
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos(list) }, {
    "git.diff": () => {
      pending++;
      max = Math.max(max, pending);
      return new Promise((res) => held.push(() => (pending--, res({ diff: null }))));
    },
  });
  await t.render();
  await wait();
  expect(held).toHaveLength(4);
  await act(async () => held.shift()!());
  expect(held).toHaveLength(4);
  while (held.length) await act(async () => held.shift()!());
  expect(max).toBe(4);
  expect(diffCalls(t)).toHaveLength(7);
  t.unmount();
});

it("GH-392 a re-triggered read during the first wave never exceeds 4 git.diff in flight over both runs", async () => {
  const list: GitRepo[] = [QMAIN, ...Array.from({ length: 9 }, (_, i) => ({ path: `/q/r${i}`, rel: `r${i}`, kind: "nested" as const, parent: "/q" }))];
  const held: (() => void)[] = [];
  let pending = 0;
  let max = 0;
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos(list) }, {
    "git.diff": () => {
      pending++;
      max = Math.max(max, pending);
      return new Promise((res) => held.push(() => (pending--, res({ diff: null }))));
    },
  });
  await t.render();
  await wait();
  expect(held).toHaveLength(4);
  await t.render({ gitStamp: "s2" });
  await wait();
  expect(pending).toBe(4);
  while (held.length) await act(async () => held.shift()!());
  await wait();
  expect(max).toBe(4);
  expect(pending).toBe(0);
  t.unmount();
});

describe("GH-392 a reply that arrives after the read was replaced shows no marks", () => {
  const held: Record<string, () => void> = {};
  const setupHeld = (props: Partial<ComponentProps<typeof FileTree>> = {}) =>
    setup({ cwd: "/q", gitStamp: "s", repos: repos([QMAIN]), ...props }, {
      "git.diff": (m: { cwd: string }) => new Promise((res) => (held[m.cwd] = () => res(byCwd(m)))),
    });
  afterEach(() => void Object.keys(held).forEach((k) => delete held[k]));

  it("after a repository list change", async () => {
    const t = setupHeld();
    await t.render();
    await wait();
    const releaseA = held["/q"]!;
    await t.render({ repos: repos([{ ...QMAIN, path: "/q", rel: "", branch: "dev" }, QLIB]) });
    await wait();
    await act(async () => releaseA());
    await wait(50);
    expect(mark(t, "/q/s.ts")).toBeNull();
    t.unmount();
  });

  it("after a cwd change", async () => {
    const t = setupHeld();
    await t.render();
    await wait();
    const releaseA = held["/q"]!;
    await t.render({ cwd: "/p", repos: undefined, gitStamp: "s" });
    await wait();
    await act(async () => releaseA());
    await wait(50);
    expect(t.el.querySelector("[data-testid=git-mark]")).toBeNull();
    t.unmount();
  });

  it("after unmount", async () => {
    const t = setupHeld();
    await t.render();
    await wait();
    const releaseA = held["/q"]!;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    t.unmount();
    await act(async () => releaseA());
    await wait(50);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

it("GH-392 a file in a nested repository shows its own mark; the parent's untracked folder entry gives no mark and no dot", async () => {
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos() }, { "git.diff": byCwd });
  await t.render();
  await wait();
  await openAll(t);
  expect(mark(t, "/q/tools/inner/x.ts")!.textContent).toBe("U");
  expect(mark(t, "/q/tools/inner/y.ts")!.textContent).toBe("M");
  expect(mark(t, "/q/s.ts")!.textContent).toBe("M");
  expect(mark(t, "/q/tools/inner")!.className).toContain("rounded-full");
  expect(mark(t, "/q/far")).toBeNull();
  t.unmount();
});

it("GH-392 a clean nested repository gets no mark from the parent's untracked entry", async () => {
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos() }, { "git.diff": (m: { cwd: string }) => (m.cwd === "/q/tools/inner" ? { diff: { prefix: "", files: [] } } : byCwd(m)) });
  await t.render();
  await wait();
  expect(mark(t, "/q/tools")).toBeNull();
  t.unmount();
});

it("GH-392 a moved submodule folder shows the letter M and no dot", async () => {
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos() }, { "git.diff": byCwd });
  await t.render();
  await wait();
  const m = mark(t, "/q/libs");
  expect(m!.className).toContain("rounded-full");
  await act(async () => t.row("/q/libs").click());
  const lib = mark(t, "/q/libs/lib")!;
  expect(lib.textContent).toBe("M");
  expect(lib.className).not.toContain("rounded-full");
  expect(t.row("/q/libs/lib").textContent).toContain(", modified");
  t.unmount();
});

it("GH-392 repository folders show the repository and submodule icons with their accessible labels and tooltips", async () => {
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos() }, { "git.diff": byCwd });
  await t.render();
  await act(async () => t.row("/q/tools").click());
  await act(async () => t.row("/q/libs").click());
  const icon = (p: string) => t.row(p).querySelector<HTMLElement>("[data-testid=tree-repo-icon]");
  expect(icon("/q/tools/inner")!.getAttribute("aria-label")).toBe("Repository inner, branch main");
  expect(icon("/q/tools/inner")!.title).toBe("main · repository");
  expect(icon("/q/tools/inner")!.querySelector("[data-icon=repo]")).not.toBeNull();
  expect(icon("/q/libs/lib")!.getAttribute("aria-label")).toBe("Submodule lib, branch a4a3b80");
  expect(icon("/q/libs/lib")!.querySelector("[data-icon=archive]")).not.toBeNull();
  expect(icon("/q/far")!.getAttribute("aria-label")).toBe("Repository far, outside the allowed folders");
  expect(icon("/q/tools")).toBeNull();
  t.unmount();
});

it("GH-392 no new request without a trigger: a re-rendered identical list does not read again; reloadKey reads every repository again", async () => {
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos() }, { "git.diff": byCwd });
  await t.render();
  await wait();
  expect(diffCalls(t)).toHaveLength(3);
  await t.render({ repos: repos([{ ...QMAIN }, { ...QINNER }, { ...QLIB }, { ...QFAR }]) });
  await wait();
  expect(diffCalls(t)).toHaveLength(3);
  await t.render({ reloadKey: 1 });
  await wait();
  expect(diffCalls(t)).toHaveLength(6);
  t.unmount();
});

it("GH-392 a failed read of one repository keeps the others' marks", async () => {
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos() }, { "git.diff": (m: { cwd: string }) => (m.cwd === "/q/libs/lib" ? Promise.reject(new Error("x")) : byCwd(m)) });
  await t.render();
  await wait();
  await openAll(t);
  expect(mark(t, "/q/s.ts")!.textContent).toBe("M");
  expect(mark(t, "/q/tools/inner/x.ts")!.textContent).toBe("U");
  t.unmount();
});

it("GH-392 a restarted read keeps the previous marks until its first reply", async () => {
  let hold = false;
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos([QMAIN]) }, { "git.diff": (m: { cwd: string }) => (hold ? new Promise(() => {}) : byCwd(m)) });
  await t.render();
  await wait();
  expect(mark(t, "/q/s.ts")!.textContent).toBe("M");
  hold = true;
  await t.render({ gitStamp: "s2" });
  await wait();
  expect(mark(t, "/q/s.ts")!.textContent).toBe("M");
  t.unmount();
});

const runMenu = async (t: ReturnType<typeof setup>, path: string, id: string) => {
  await ctxMenu(t.row(path));
  await act(async () => menuItem(id).click());
  await act(async () => {});
  if (document.querySelector('[role="menu"]')) await closeMenu();
};

it("GH-392 Show changes on a repository folder sets the choice to its rel and calls onShowChanges with the folder", async () => {
  const onShowChanges = vi.fn();
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos(), onShowChanges }, { "git.diff": byCwd });
  await t.render();
  await act(async () => t.row("/q/tools").click());
  await runMenu(t, "/q/tools/inner", "repoChanges");
  expect(getRepoChoice("proj")).toBe("tools/inner");
  expect(onShowChanges).toHaveBeenCalledWith("/q/tools/inner");
  t.unmount();
});

it("GH-392 Show graph on a repository folder sets the choice and calls onShowGraph", async () => {
  const onShowGraph = vi.fn();
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos(), onShowGraph }, { "git.diff": byCwd });
  await t.render();
  await act(async () => t.row("/q/libs").click());
  await runMenu(t, "/q/libs/lib", "repoGraph");
  expect(getRepoChoice("proj")).toBe("libs/lib");
  expect(onShowGraph).toHaveBeenCalledTimes(1);
  t.unmount();
});

it("GH-392 Show changes on a file inside a nested repository chooses that repository, then reveals the file; on a file of the own repository chooses the own one", async () => {
  const onShowChanges = vi.fn();
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos(), onShowChanges }, { "git.diff": byCwd });
  await t.render();
  await wait();
  await openAll(t);
  await runMenu(t, "/q/tools/inner/x.ts", "changes");
  expect(getRepoChoice("proj")).toBe("tools/inner");
  expect(onShowChanges).toHaveBeenLastCalledWith("/q/tools/inner/x.ts");
  await runMenu(t, "/q/s.ts", "changes");
  expect(getRepoChoice("proj")).toBe("");
  expect(onShowChanges).toHaveBeenLastCalledWith("/q/s.ts");
  t.unmount();
});

it("GH-392 an outsideRoots repository folder has the icon but no repository menu items", async () => {
  const t = setup({ cwd: "/q", gitStamp: "s", repos: repos(), onShowGraph: () => {} }, { "git.diff": byCwd });
  await t.render();
  await ctxMenu(t.row("/q/far"));
  expect(menuIds()).not.toContain("repoChanges");
  expect(menuIds()).not.toContain("repoGraph");
  await closeMenu();
  t.unmount();
});
