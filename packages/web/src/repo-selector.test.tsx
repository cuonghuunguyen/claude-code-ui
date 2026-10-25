// @vitest-environment jsdom
import type { GitRepo } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RepoSelector } from "./repo-selector.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
let narrow = false;
window.matchMedia = ((query: string) => ({
  get matches() {
    return narrow && query.includes("48rem");
  },
  media: query,
  addEventListener() {},
  removeEventListener() {},
})) as never;

const R = (rel: string, kind: GitRepo["kind"], parent?: string, extra: Partial<GitRepo> = {}): GitRepo => ({ path: rel ? `/p/${rel}` : "/p", rel, kind, ...(parent && { parent }), branch: "main", ...extra });
const main = R("", "main");
const sub = R("libs/lib", "submodule", "/p", { branch: "a4a3b80" });
const inner = R("tools/inner", "nested", "/p");
const deep = R("tools/inner/deep", "submodule", "/p/tools/inner");
const list = [main, sub, inner, deep];

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(async () => {
  await act(async () => root.render(null));
  narrow = false;
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
async function show(p: Partial<Parameters<typeof RepoSelector>[0]> = {}) {
  const onSelect = vi.fn();
  await act(async () => root.render(<RepoSelector list={list} selected={sub} onSelect={onSelect} {...p} />));
  return onSelect;
}
const trigger = () => el.querySelector<HTMLElement>("[data-testid=repo-selector]")!;
const open = async () => (await act(async () => trigger().click()), await flush());
const rows = () => [...document.querySelectorAll<HTMLElement>("[role=treeitem]")];
const key = (k: string, target: Element = document.activeElement!) => act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));

it("the trigger shows icon, name and branch", async () => {
  await show();
  expect(trigger().getAttribute("aria-label")).toBe("Repository: lib, branch a4a3b80");
  expect(trigger().getAttribute("aria-haspopup")).toBe("tree");
  expect(trigger().textContent).toBe("liba4a3b80");
  expect(trigger().querySelector("[data-icon=archive]")).not.toBeNull();
});

it("opens a tree in git.repos order with aria-level, aria-expanded on parents, aria-selected on the selected row", async () => {
  await show();
  await open();
  const tree = document.querySelector("[role=tree]")!;
  expect(tree.getAttribute("aria-label")).toBe("Repositories");
  expect(rows().map((r) => [r.dataset.rel, r.getAttribute("aria-level"), r.getAttribute("aria-expanded"), r.getAttribute("aria-selected")])).toEqual([
    ["", "1", "true", "false"],
    ["libs/lib", "2", null, "true"],
    ["tools/inner", "2", "true", "false"],
    ["tools/inner/deep", "3", null, "false"],
  ]);
  expect(rows()[1]!.getAttribute("tabindex")).toBe("0");
  expect(rows()[0]!.getAttribute("tabindex")).toBe("-1");
  expect(document.activeElement).toBe(rows()[1]);
});

it("submodule rows use the archive icon, others the repo icon", async () => {
  await show();
  await open();
  expect(rows().map((r) => r.querySelector("[data-icon]")!.getAttribute("data-icon"))).toEqual(["repo", "archive", "repo", "archive"]);
});

it("an outsideRoots row is aria-disabled with the reason and Enter does nothing", async () => {
  const out = R("web", "nested", "/p", { outsideRoots: true });
  const onSelect = await show({ list: [main, out], selected: main });
  await open();
  const row = rows()[1]!;
  expect(row.getAttribute("aria-disabled")).toBe("true");
  expect(row.textContent).toContain("outside the allowed folders");
  await key("ArrowDown");
  expect(document.activeElement).toBe(row);
  await key("Enter");
  expect(onSelect).not.toHaveBeenCalled();
  expect(rows()).toHaveLength(2);
});

it("keyboard: arrows, Home/End, ←/→, type-ahead, Enter selects and closes, Space selects", async () => {
  const onSelect = await show();
  await open();
  await key("ArrowDown");
  expect(document.activeElement).toBe(rows()[2]);
  await key("ArrowUp");
  await key("ArrowUp");
  expect(document.activeElement).toBe(rows()[0]);
  await key("End");
  expect(document.activeElement).toBe(rows()[3]);
  await key("Home");
  expect(document.activeElement).toBe(rows()[0]);
  await key("ArrowLeft");
  expect(rows()).toHaveLength(1);
  expect(rows()[0]!.getAttribute("aria-expanded")).toBe("false");
  await key("ArrowRight");
  expect(rows()).toHaveLength(4);
  await key("ArrowRight");
  expect(document.activeElement).toBe(rows()[1]);
  await act(async () => {
    for (const k of ["t", "o"]) document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  expect(document.activeElement).toBe(rows()[2]);
  await key("Enter");
  expect(onSelect).toHaveBeenCalledWith("tools/inner");
  expect(document.querySelector("[role=tree]")).toBeNull();
  await open();
  await key(" ");
  expect(onSelect).toHaveBeenCalledTimes(2);
});

it("Escape closes and focus returns to the trigger", async () => {
  await show();
  await open();
  await key("Escape");
  await flush();
  expect(document.querySelector("[role=tree]")).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it("the filter shows only above 10 entries and narrows the tree", async () => {
  await show();
  await open();
  expect(document.querySelector("[data-testid=repo-filter]")).toBeNull();
  await key("Escape");
  const many = [main, ...Array.from({ length: 11 }, (_, i) => R(`m${i}`, "nested", "/p"))];
  await show({ list: many, selected: main });
  await open();
  const input = document.querySelector<HTMLInputElement>("[data-testid=repo-filter]")!;
  expect(document.activeElement).toBe(input);
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input, "m1");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(rows().map((r) => r.dataset.rel)).toEqual(["", "m1", "m10"]);
  await act(async () => {
    set.call(input, "zz");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.body.textContent).toContain("No repositories match.");
  await key("ArrowDown", input);
});

it("truncation notes show in the footer", async () => {
  await show({ truncated: { scan: "count", submodules: [{ repo: "/p", count: 14 }] } });
  await open();
  const t = document.querySelector("[data-testid=repo-truncated]")!;
  expect(t.textContent).toContain("Showing the first 4 repositories");
  expect(t.textContent).toContain("14 submodules of p, only the first 10 shown");
});

it("narrow: the tree opens in a full-width sheet with 44px rows", async () => {
  narrow = true;
  await show();
  await open();
  const sheet = document.querySelector("[data-testid=repo-sheet]")!;
  expect(sheet.getAttribute("role")).toBe("dialog");
  expect(sheet.className).toContain("inset-x-0");
  expect(sheet.textContent).toContain("Repositories");
  expect(rows()[0]!.className).toContain("max-md:h-11");
  expect(trigger().className).toContain("h-11 w-full");
});

it("←/→ inside the tree do not reach the document listener", async () => {
  await show();
  await open();
  const seen = vi.fn();
  document.addEventListener("keydown", seen);
  await key("ArrowLeft");
  await key("ArrowRight");
  document.removeEventListener("keydown", seen);
  expect(seen).not.toHaveBeenCalled();
});

const many = (n: number) => [main, ...Array.from({ length: n }, (_, i) => R(`m${i}`, "nested", "/p"))];

it("Escape in the filter field closes the selector and focus returns to the trigger", async () => {
  await show({ list: many(11), selected: main });
  await open();
  const input = document.querySelector<HTMLInputElement>("[data-testid=repo-filter]")!;
  expect(document.activeElement).toBe(input);
  await key("Escape", input);
  await flush();
  expect(document.querySelector("[role=tree]")).toBeNull();
  expect(document.activeElement).toBe(trigger());
});

it("←/→ in the filter field do not reach the document listener", async () => {
  await show({ list: many(11), selected: main });
  await open();
  const input = document.querySelector<HTMLInputElement>("[data-testid=repo-filter]")!;
  const seen = vi.fn();
  document.addEventListener("keydown", seen);
  await key("ArrowLeft", input);
  document.removeEventListener("keydown", seen);
  expect(seen).not.toHaveBeenCalled();
});

it("a chevron click that hides the focused row moves focus to the collapsed row", async () => {
  await show({ selected: deep });
  await open();
  expect(document.activeElement).toBe(rows()[3]);
  await act(async () => rows()[2]!.querySelector<HTMLElement>("[data-testid=repo-chevron]")!.click());
  await flush();
  expect(rows()).toHaveLength(3);
  expect(document.activeElement).toBe(rows()[2]);
});
