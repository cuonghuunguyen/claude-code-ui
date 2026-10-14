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
