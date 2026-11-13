// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FsGrepResult, FsReplaceResult } from "@claude-ui/protocol";
import { FindInFiles, type FindQuery, type FindReplace } from "./find-in-files.tsx";
import { FIND_HISTORY_KEY } from "./find-in-files.ts";

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

const DRY: FsReplaceResult = {
  files: [
    { path: "src/a.ts", mtime: 11, size: 22, lines: [{ n: 2, after: "a pin here", ranges: [[2, 5]] }, { n: 9, none: true }] },
    { path: "b.md", mtime: 33, size: 44, lines: [{ n: 4, after: "pin", ranges: [[0, 3]] }] },
  ],
  changedFiles: 0, changedLines: 0,
};

async function render(over: { res?: FsGrepResult | Error; connected?: boolean; initialQuery?: string; initialReplace?: boolean; unsaved?: string[]; dry?: FsReplaceResult | Error; apply?: FsReplaceResult } = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const onSearch = vi.fn(async (_q: FindQuery) => {
    if (over.res instanceof Error) throw over.res;
    return over.res ?? RESULT;
  });
  const onReplace = vi.fn(async (r: FindReplace): Promise<FsReplaceResult> => {
    if (r.dryRun) {
      if (over.dry instanceof Error) throw over.dry;
      return over.dry ?? DRY;
    }
    return over.apply ?? { files: [], changedFiles: 2, changedLines: 3, undoId: "u1" };
  });
  const onUndo = vi.fn(async (_id: string, _u: string[]): Promise<FsReplaceResult> => ({ files: [], changedFiles: 2, changedLines: 3 }));
  const handlers = { onOpen: vi.fn(), onClose: vi.fn(), onReplace, onUndo, isUnsaved: (p: string) => !!over.unsaved?.includes(p) };
  await act(async () => root!.render(<FindInFiles connected={over.connected ?? true} initialQuery={over.initialQuery} initialReplace={over.initialReplace} onSearch={onSearch} {...handlers} />));
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

it("regex_unsupported shows plain words", async () => {
  const a = await render({ res: Object.assign(new Error("x"), { code: "regex_unsupported" }) });
  await a.type("a");
  await a.wait();
  expect(a.el.querySelector('[role="alert"]')!.textContent).toContain("no Perl regex support");
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

async function replaceMode(over: Parameters<typeof render>[0] = {}) {
  const r = await render({ initialReplace: true, ...over });
  await r.type("needle");
  await r.wait();
  await r.set(r.q("find-replace"), "pin");
  await r.wait();
  return r;
}
const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

it("replace mode: preview shows the old text struck through and the new line; a line without a replacement is disabled", async () => {
  const { el, matches, onReplace } = await replaceMode();
  expect(onReplace.mock.calls.filter(([r]) => r.dryRun)).toHaveLength(2);
  expect(onReplace.mock.calls[0]![0]).toMatchObject({ query: "needle", regex: false, replace: "", dryRun: true });
  expect(onReplace.mock.calls.at(-1)![0]).toMatchObject({ replace: "pin", dryRun: true, files: [{ path: "src/a.ts", lines: [2, 9] }, { path: "b.md", lines: [4] }] });
  expect(matches()[0]!.querySelector("del")?.textContent).toBe("needle");
  expect(matches()[0]!.querySelector('[data-testid="find-after"]')?.textContent).toBe("a pin here");
  expect(matches()[0]!.querySelector("ins")?.textContent).toBe("pin");
  expect(matches()[1]!.textContent).toContain("No replacement on this line");
  expect(matches()[1]!.getAttribute("aria-checked")).toBe("false");
  expect(el.querySelector('[data-testid="find-replace-all"]')).toHaveProperty("disabled", false);
});

it("Replace all sends only checked lines with the dry run's mtime and size, then shows the summary and searches again", async () => {
  const { el, matches, onReplace, onSearch, wait } = await replaceMode();
  await click(matches()[0]!.querySelector('[data-testid="find-match-check"]')!);
  expect(matches()[0]!.getAttribute("aria-checked")).toBe("false");
  const searches = onSearch.mock.calls.length;
  await click(el.querySelector('[data-testid="find-replace-all"]')!);
  const apply = onReplace.mock.calls.find(([r]) => !r.dryRun)![0];
  expect(apply).toMatchObject({ query: "needle", replace: "pin", files: [{ path: "b.md", lines: [4], mtime: 33, size: 44 }] });
  expect(el.querySelector('[data-testid="find-summary"]')?.textContent).toContain("Replaced 3 matches in 2 files.");
  await wait();
  expect(onSearch.mock.calls.length).toBeGreaterThan(searches);
  expect(el.querySelector('[data-testid="find-summary"]')).not.toBeNull();
});

it("a file checkbox unchecks all its lines; Replace in this file sends that file only", async () => {
  const { el, matches, onReplace } = await replaceMode();
  const checks = () => [...el.querySelectorAll<HTMLElement>('[data-testid="find-file-check"]')];
  await click(checks()[1]!);
  expect(checks()[1]!.getAttribute("aria-checked")).toBe("false");
  expect(matches()[2]!.getAttribute("aria-checked")).toBe("false");
  await click(el.querySelectorAll('[data-testid="find-replace-file"]')[0]!);
  expect(onReplace.mock.calls.find(([r]) => !r.dryRun)![0].files).toEqual([{ path: "src/a.ts", lines: [2], mtime: 11, size: 22 }]);
});

it("keyboard: Space toggles the active match, Shift+Space its file, Ctrl+Enter replaces in its file", async () => {
  const { el, matches, key, onReplace, q } = await replaceMode();
  const list = el.querySelector<HTMLElement>('[data-testid="find-results"]')!;
  await key(" ", list);
  expect(matches()[0]!.getAttribute("aria-checked")).toBe("false");
  await key(" ", list);
  expect(matches()[0]!.getAttribute("aria-checked")).toBe("true");
  await key(" ", list, { shiftKey: true });
  expect(matches()[0]!.getAttribute("aria-checked")).toBe("false");
  await key(" ", list, { shiftKey: true });
  await key("Enter", list, { ctrlKey: true });
  expect(onReplace.mock.calls.find(([r]) => !r.dryRun)![0].files).toEqual([{ path: "src/a.ts", lines: [2], mtime: 11, size: 22 }]);
  expect(q("find-query")).toBeTruthy();
});

it("Enter in the replace box writes nothing", async () => {
  const { q, key, onReplace } = await replaceMode();
  await key("Enter", q("find-replace"));
  expect(onReplace.mock.calls.some(([r]) => !r.dryRun)).toBe(false);
});

it("a file with unsaved editor edits is not sent and is listed as skipped", async () => {
  const { el, onReplace } = await replaceMode({ unsaved: ["b.md"] });
  await click(el.querySelector('[data-testid="find-replace-all"]')!);
  expect(onReplace.mock.calls.find(([r]) => !r.dryRun)![0].files.map((f) => f.path)).toEqual(["src/a.ts"]);
  const text = el.querySelector('[data-testid="find-skipped"]')!.textContent!;
  expect(text).toContain("Skipped 1 file:");
  expect(text).toContain("b.md");
  expect(text).toContain("unsaved");
});

it("the summary lists daemon skips and Undo sends fs.replaceUndo", async () => {
  const { el, onUndo } = await replaceMode({ apply: { files: [{ path: "src/a.ts", skipped: "changed" }], changedFiles: 1, changedLines: 1, undoId: "u9" } });
  await click(el.querySelector('[data-testid="find-replace-all"]')!);
  expect(el.querySelector('[data-testid="find-skipped"]')!.textContent).toContain("src/a.ts (changed after the search)");
  await click(el.querySelector('[data-testid="find-undo"]')!);
  expect(onUndo).toHaveBeenCalledWith("u9", []);
  expect(el.querySelector('[data-testid="find-summary"]')!.textContent).toContain("Undid the replace in 2 files.");
});

it("no undo id: says so", async () => {
  const { el } = await replaceMode({ apply: { files: [], changedFiles: 1, changedLines: 1 } });
  await click(el.querySelector('[data-testid="find-replace-all"]')!);
  expect(el.querySelector('[data-testid="find-undo"]')).toBeNull();
  expect(el.querySelector('[data-testid="find-summary"]')!.textContent).toContain("cannot be undone");
});

it("a bad replacement shows the error and disables Replace all", async () => {
  const err = Object.assign(new Error("Group $3 does not exist"), { code: "bad_replacement" });
  const { el } = await replaceMode({ dry: err });
  expect(el.querySelector('[data-testid="find-replace-error"]')!.textContent).toContain("Group $3 does not exist");
  expect(el.querySelector('[data-testid="find-replace-all"]')).toHaveProperty("disabled", true);
});

it("the toggle shows and hides the replace row and remembers the choice", async () => {
  const { el, q } = await render();
  expect(el.querySelector('[data-testid="find-replace"]')).toBeNull();
  await click(q("find-replace-toggle"));
  expect(q("find-replace-toggle").getAttribute("aria-expanded")).toBe("true");
  expect(el.querySelector('[data-testid="find-replace"]')).not.toBeNull();
  expect(localStorage.getItem("claude-ui.findReplace")).toBe("1");
});

it("plain Find is unchanged: no checkboxes, marks not struck through", async () => {
  const { el, type, wait } = await render();
  await type("needle");
  await wait();
  expect(el.querySelector('[data-testid="find-file-check"]')).toBeNull();
  expect(el.querySelector("mark")).not.toBeNull();
  expect(el.querySelector("del")).toBeNull();
});
