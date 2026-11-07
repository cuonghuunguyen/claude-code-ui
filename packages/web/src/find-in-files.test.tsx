// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FsGrepResult } from "@claude-ui/protocol";
import { FindInFiles, type FindQuery } from "./find-in-files.tsx";
import { FIND_HISTORY_KEY } from "./find-in-files.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
beforeEach(() => (localStorage.clear(), vi.useFakeTimers()));
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const RESULT: FsGrepResult = {
  files: [
    { path: "src/a.ts", lines: [{ n: 1, text: "before" }, { n: 2, text: "a needle here", ranges: [[2, 8]] }, { n: 9, text: "needle again", ranges: [[0, 6]] }] },
    { path: "b.md", lines: [{ n: 4, text: "needle", ranges: [[0, 6]] }] },
  ],
  matches: 3, ms: 2, includeIgnored: false, git: true,
};

async function render(over: { res?: FsGrepResult | Error; connected?: boolean; initialQuery?: string } = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onSearch = vi.fn(async (_q: FindQuery) => {
    if (over.res instanceof Error) throw over.res;
    return over.res ?? RESULT;
  });
  const handlers = { onOpen: vi.fn(), onClose: vi.fn() };
  await act(async () => root!.render(<FindInFiles connected={over.connected ?? true} initialQuery={over.initialQuery} onSearch={onSearch} {...handlers} />));
  const q = (id: string) => el.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!;
  const set = (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const type = (value: string) => set(q("find-query"), value);
  const wait = (ms = 300) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const key = async (k: string, target: Element = q("find-query"), init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
    await act(async () => void target.dispatchEvent(e));
    return e;
  };
  const matches = () => [...el.querySelectorAll<HTMLElement>('[data-testid="find-match"]')];
  return { el, q, type, set, wait, key, matches, onSearch, ...handlers };
}

it("debounces: one search after typing stops; groups, context lines and marks", async () => {
  const { el, type, wait, onSearch, matches } = await render();
  expect(onSearch).not.toHaveBeenCalled();
  await type("n");
  await type("needle");
  await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
  expect(onSearch).not.toHaveBeenCalled();
  await wait();
  expect(onSearch).toHaveBeenCalledTimes(1);
  expect(onSearch).toHaveBeenCalledWith({ query: "needle", regex: false, globs: "", includeIgnored: undefined });
  expect([...el.querySelectorAll('[data-testid="find-file"]')].map((f) => (f as HTMLElement).dataset.path)).toEqual(["src/a.ts", "b.md"]);
  expect(matches().map((m) => `${m.dataset.path}:${m.dataset.line}`)).toEqual(["src/a.ts:2", "src/a.ts:9", "b.md:4"]);
  expect([...el.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["needle", "needle", "needle"]);
  expect(el.textContent).toContain("before");
  expect(el.textContent).toContain("⋯");
  expect(el.querySelector('[data-testid="find-status"]')!.textContent).toContain("3 matches in 2 files");
});

it("renders no stray 0 under a file header and says 1 match in 1 file", async () => {
  const one: FsGrepResult = { files: [{ path: "a.ts", lines: [{ n: 1, text: "needle", ranges: [[0, 6]] }] }], matches: 1, ms: 1, includeIgnored: false, git: true };
  const { el, type, wait } = await render({ res: one });
  await type("needle");
  await wait();
  expect(el.querySelector('[data-testid="find-results"]')!.textContent).toBe("a.ts1needle");
  expect(el.querySelector('[data-testid="find-status"]')!.textContent).toBe("1 match in 1 file");
});

it("initialQuery fills the box and searches at once", async () => {
  const { q, onSearch } = await render({ initialQuery: "foo" });
  expect(q("find-query").value).toBe("foo");
  expect(onSearch).toHaveBeenCalledTimes(1);
  expect(onSearch.mock.calls[0]![0].query).toBe("foo");
});

it("arrows in the list move the active match; Enter and a click open it; Esc closes", async () => {
  const { el, type, wait, key, matches, onOpen, onClose } = await render();
  await type("needle");
  await wait();
  const list = el.querySelector('[data-testid="find-results"]')!;
  expect(matches()[0]!.getAttribute("aria-selected")).toBe("true");
  await key("ArrowDown", list);
  expect(matches()[1]!.getAttribute("aria-selected")).toBe("true");
  await key("Enter", list);
  expect(onOpen).toHaveBeenLastCalledWith("src/a.ts", 9);
  await act(async () => matches()[2]!.click());
  expect(onOpen).toHaveBeenLastCalledWith("b.md", 4);
  await key("Escape");
  expect(onClose).toHaveBeenCalled();
});

it("Enter in the query box opens the first match", async () => {
  const { type, wait, key, onOpen } = await render();
  await type("needle");
  await wait();
  await key("Enter");
  expect(onOpen).toHaveBeenCalledWith("src/a.ts", 2);
});

it("ArrowUp in the query restores the newest pair of the history, ArrowDown the draft", async () => {
  localStorage.setItem(FIND_HISTORY_KEY, JSON.stringify([{ query: "old", globs: "" }, { query: "needle", globs: "*.ts" }]));
  const { q, type, wait, key, onOpen, matches, set } = await render();
  await type("draft");
  await wait();
  await key("ArrowUp");
  expect([q("find-query").value, q("find-globs").value]).toEqual(["needle", "*.ts"]);
  await key("ArrowUp");
  expect(q("find-query").value).toBe("old");
  await key("ArrowDown");
  await key("ArrowDown");
  expect(q("find-query").value).toBe("draft");
  await set(q("find-query"), "needle");
  await set(q("find-globs"), "*.md");
  await wait();
  await act(async () => matches()[0]!.click());
  expect(onOpen).toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(FIND_HISTORY_KEY)!).at(-1)).toEqual({ query: "needle", globs: "*.md" });
});

it("Include ignored shows the reply's value; a click searches with the opposite explicit value", async () => {
  const { q, type, wait, onSearch } = await render({ res: { ...RESULT, includeIgnored: true, git: false } });
  await type("needle");
  await wait();
  expect(q("find-ignored").getAttribute("aria-pressed")).toBe("true");
  await act(async () => q("find-ignored").click());
  await wait();
  expect(q("find-ignored").getAttribute("aria-pressed")).toBe("false");
  expect(onSearch).toHaveBeenLastCalledWith(expect.objectContaining({ includeIgnored: false }));
});

it("regex toggle searches with regex true", async () => {
  const { q, type, wait, onSearch } = await render();
  await type("need(le)");
  await act(async () => q("find-regex").click());
  await wait();
  expect(onSearch).toHaveBeenLastCalledWith(expect.objectContaining({ regex: true }));
});

it("git_missing and other errors show an alert; the panel stays usable", async () => {
  const miss = Object.assign(new Error("x"), { code: "git_missing" });
  const a = await render({ res: miss });
  await a.type("needle");
  await a.wait();
  expect(a.el.querySelector('[role="alert"]')!.textContent).toContain("needs git");
  act(() => root!.unmount());
  document.body.innerHTML = "";
  const b = await render({ res: Object.assign(new Error("bad pattern"), { code: "grep_failed" }) });
  await b.type("a(");
  await b.wait();
  expect(b.el.querySelector('[role="alert"]')!.textContent).toBe("Search failed: bad pattern");
  expect(b.q("find-query")).toBeTruthy();
});

it("notes for partial and shortened results; offline says so", async () => {
  const a = await render({ res: { ...RESULT, stopped: "time", cut: true } });
  await a.type("needle");
  await a.wait();
  const text = a.el.querySelector('[data-testid="find-status"]')!.textContent!;
  expect(text).toContain("stopped after 5 s");
  expect(text).toContain("shortened");
  act(() => root!.unmount());
  document.body.innerHTML = "";
  const b = await render({ connected: false });
  expect(b.el.querySelector('[data-testid="find-status"]')!.textContent).toContain("Not connected");
});

it("unmounting after a search sends a blank query to cancel", async () => {
  const { type, wait, onSearch } = await render();
  await type("needle");
  await wait();
  act(() => root!.unmount());
  expect(onSearch).toHaveBeenLastCalledWith(expect.objectContaining({ query: "" }));
});
