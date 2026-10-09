// @vitest-environment jsdom
import type { GitCommit, GitCommitDetail } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { GraphPanel } from "./git-graph-panel.tsx";

vi.mock("@pierre/diffs/react", () => ({ MultiFileDiff: () => <div data-testid="pierre-diff" /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;
Element.prototype.scrollTo = function (this: Element, o?: ScrollToOptions | number) {
  this.scrollTop = typeof o === "object" ? (o.top ?? 0) : 0;
  this.dispatchEvent(new Event("scroll"));
} as never;

// The list reports a size, so the virtualizer can compute scroll offsets.
const rect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function (this: Element) {
  return this.getAttribute("role") === "listbox" ? ({ width: 400, height: 500, top: 0, left: 0, right: 400, bottom: 500, x: 0, y: 0, toJSON() {} } as DOMRect) : rect.call(this);
};
// jsdom has no layout: the list is as high as its rows say and 500px of it shows.
const isList = (e: Element) => e.getAttribute("role") === "listbox";
Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return isList(this) ? Number.parseFloat((this.firstElementChild as HTMLElement).style.height) : 0; } });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return isList(this) ? 500 : 0; } });
/** What the fake's git.status reports as the current branch (a short hash: detached). */
let statusBranch = "main";
const hash = (i: number) => i.toString(16).padStart(40, "0");
/** A linear history of n commits, newest first (hash(n) is the tip). */
const history = (n: number): GitCommit[] =>
  Array.from({ length: n }, (_, k) => {
    const i = n - k;
    return { hash: hash(i), parents: i > 1 ? [hash(i - 1)] : [], author: "Ann", email: "a@x.test", time: 1_700_000_000 + i, subject: `commit ${i}`, refs: i === n ? ["HEAD", "refs/heads/main"] : [] };
  });
const detail = (c: GitCommit, files: GitCommitDetail["files"]): GitCommitDetail => ({ ...c, message: `${c.subject}\n\nbody text`, committer: "Ann", committerTime: c.time, files });

const el = document.createElement("div");
document.body.append(el);
const root = createRoot(el);
afterEach(() => {
  statusBranch = "main";
  return act(() => root.render(null));
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

type Req = { type: string; skip?: number; hash?: string; path?: string; text?: string; ref?: string };
function fake(all: GitCommit[], files: GitCommitDetail["files"] = [], page = 200, nogit = false) {
  const sent: Req[] = [];
  const request = vi.fn(async (m: Req) => {
    sent.push(m);
    if (m.type === "git.log") {
      const skip = m.skip ?? 0;
      const slice = all.slice(skip, skip + page);
      return { log: nogit ? null : { commits: slice, more: skip + page < all.length, ...(skip === 0 && { branches: ["refs/heads/main", "refs/remotes/origin/main"] }) } };
    }
    if (m.type === "git.status") return { status: { branch: statusBranch, added: 0, removed: 0 } };
    if (m.type === "git.commit") return { commit: detail(all.find((c) => c.hash === m.hash)!, files) };
    return { content: `${m.hash}:${m.path}` };
  });
  return Object.assign({ request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>, { sent });
}
const mount = async (c: ReturnType<typeof fake>) => {
  await act(async () => root.render(<GraphPanel client={c} cwd="/p" />));
  await flush();
};
const rowEls = () => el.querySelectorAll("[data-testid=commit-row]");
const list = () => el.querySelector<HTMLElement>("[data-testid=commit-list]")!;

it("renders 1000 commits virtualized: under 60 row elements", async () => {
  await mount(fake(history(1000), [], 1000));
  expect(rowEls().length).toBeGreaterThan(0);
  expect(rowEls().length).toBeLessThan(60);
});

it("loads the next page when scrolled near the end", async () => {
  const c = fake(history(500), [], 200);
  await mount(c);
  expect(c.sent.filter((m) => m.type === "git.log").map((m) => m.skip)).toEqual([0]);
  await act(async () => {
    list().scrollTop = 200 * 28;
    list().dispatchEvent(new Event("scroll"));
  });
  await flush();
  expect(c.sent.filter((m) => m.type === "git.log").map((m) => m.skip)).toContain(200);
});

it("up and down select commits and set aria-activedescendant", async () => {
  await mount(fake(history(10)));
  const key = (k: string) => act(async () => void list().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
  await key("ArrowDown");
  expect(list().getAttribute("aria-activedescendant")).toBe(`commit-${hash(10)}`);
  await key("ArrowDown");
  expect(list().getAttribute("aria-activedescendant")).toBe(`commit-${hash(9)}`);
  await key("ArrowUp");
  expect(list().getAttribute("aria-activedescendant")).toBe(`commit-${hash(10)}`);
  await key("End");
  expect(list().getAttribute("aria-activedescendant")).toBe(`commit-${hash(1)}`);
});

const FILES: GitCommitDetail["files"] = [
  { status: "A", path: "new.ts", added: 3, removed: 0 },
  { status: "D", path: "gone.ts", added: 0, removed: 2 },
  { status: "M", path: "src/m.ts", added: 1, removed: 1 },
  { status: "R", oldPath: "old.ts", path: "moved.ts", added: 0, removed: 0 },
];
const select = async (i: number) => {
  await act(async () => rowEls()[i]!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
};
const fileBtn = (i: number) => el.querySelectorAll<HTMLElement>("[data-testid=commit-file]")[i]!;

it("selecting a commit shows its message, parents and files with A/D/M/R and +N -N", async () => {
  await mount(fake(history(5), FILES));
  await select(0);
  const d = el.querySelector("[data-testid=commit-details]")!;
  expect(d.textContent).toContain("commit 5");
  expect(d.textContent).toContain("body text");
  expect(d.textContent).toContain(hash(5));
  expect(d.textContent).toContain(hash(4).slice(0, 7));
  expect(d.textContent).toContain("4 files changed");
  expect([...d.querySelectorAll("[data-testid=change-badge]")].map((b) => b.textContent)).toEqual(["A", "D", "M", "R"]);
  expect(fileBtn(0).textContent).toContain("+3");
  expect(fileBtn(3).textContent).toContain("old.ts → moved.ts");
});

it("clicking a file shows its diff from git.fileAt of parent and commit; an added file asks only the commit side", async () => {
  const c = fake(history(5), FILES);
  await mount(c);
  await select(0);
  await act(async () => fileBtn(2).click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.fileAt")).toEqual([
    { type: "git.fileAt", cwd: "/p", hash: hash(4), path: "src/m.ts" },
    { type: "git.fileAt", cwd: "/p", hash: hash(5), path: "src/m.ts" },
  ]);
  expect(el.querySelector("[data-testid=pierre-diff]")).not.toBeNull();
  await act(async () => el.querySelector<HTMLElement>("[data-testid=commit-back]")!.click());
  c.sent.length = 0;
  await act(async () => fileBtn(0).click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.fileAt")).toEqual([{ type: "git.fileAt", cwd: "/p", hash: hash(5), path: "new.ts" }]);
});

it("an author or text filter hides the graph column; a branch filter keeps it", async () => {
  const c = fake(history(5));
  await mount(c);
  expect(el.querySelector("[data-testid=commit-graph]")).not.toBeNull();
  const type = async (testid: string, value: string) => {
    const input = el.querySelector<HTMLInputElement>(`[data-testid=${testid}]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
  };
  await type("graph-filter-text", "five");
  expect(c.sent.at(-1)).toMatchObject({ type: "git.log", text: "five", skip: 0 });
  expect(el.querySelector("[data-testid=commit-graph]")).toBeNull();
  await type("graph-filter-text", "");
  expect(el.querySelector("[data-testid=commit-graph]")).not.toBeNull();
  await type("graph-filter-author", "ann");
  expect(el.querySelector("[data-testid=commit-graph]")).toBeNull();
});

it("a null log shows Not a git repository", async () => {
  await mount(fake([], [], 200, true));
  expect(el.textContent).toContain("Not a git repository");
});

it("a rename reads the parent side from the old path; an unchanged rename shows a notice, no diff", async () => {
  const c = fake(history(3), [{ status: "R", oldPath: "old.ts", path: "moved.ts", added: 0, removed: 0 }]);
  await mount(c);
  await select(0);
  await act(async () => fileBtn(0).click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.fileAt").map((m) => `${m.hash === hash(3) ? "commit" : "parent"}:${m.path}`)).toEqual(["parent:old.ts", "commit:moved.ts"]);
});

it("an unchanged rename shows a notice instead of a diff", async () => {
  const c = fake(history(3), [{ status: "R", oldPath: "old.ts", path: "moved.ts" }]);
  vi.mocked(c.request).mockImplementation(async (m: Req) => (m.type === "git.fileAt" ? { content: "same" } : m.type === "git.commit" ? { commit: detail(history(3)[0]!, [{ status: "R", oldPath: "old.ts", path: "moved.ts" }]) } : { log: { commits: history(3), more: false, branches: [] } }));
  await mount(c);
  await select(0);
  await act(async () => fileBtn(0).click());
  await flush();
  expect(el.querySelector("[data-testid=commit-file-diff]")!.textContent).toContain("Renamed without changes");
  expect(el.querySelector("[data-testid=pierre-diff]")).toBeNull();
});

it("drops commits a later page repeats and keeps one row per commit", async () => {
  const all = history(6);
  const c = fake(all, [], 200);
  vi.mocked(c.request).mockImplementation(async (m: Req) => {
    c.sent.push(m);
    // The second page starts one commit early (history moved between pages).
    return m.skip ? { log: { commits: all.slice(3), more: false } } : { log: { commits: all.slice(0, 4), more: true, branches: [] } };
  });
  await mount(c);
  await act(async () => {
    list().scrollTop = 1;
    list().dispatchEvent(new Event("scroll"));
  });
  await flush();
  const ids = [...rowEls()].map((r) => r.id);
  expect(ids).toHaveLength(6);
  expect(new Set(ids).size).toBe(6);
});

it("a late reply to a replaced first page is ignored", async () => {
  const slow: ((v: unknown) => void)[] = [];
  const c = fake(history(3));
  vi.mocked(c.request).mockImplementation((m: Req) => {
    c.sent.push(m);
    if (m.type !== "git.log") return Promise.resolve({});
    return new Promise((r) => slow.push(() => r({ log: { commits: m.text ? history(1) : history(3), more: false, branches: [] } })));
  });
  await mount(c);
  expect(slow).toHaveLength(1);
  const input = el.querySelector<HTMLInputElement>("[data-testid=graph-filter-text]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "x");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
  expect(slow).toHaveLength(2);
  // The newer reply first, then the stale one.
  await act(async () => slow[1]!(0));
  await act(async () => slow[0]!(0));
  expect(rowEls()).toHaveLength(1);
});

it("a parent link selects that commit and scrolls the list to it", async () => {
  const all = history(300);
  all[0] = { ...all[0]!, parents: [hash(299), hash(2)] };
  await mount(fake(all, [], 300));
  await select(0);
  expect(el.querySelector(`#commit-${hash(2)}`)).toBeNull();
  await act(async () => el.querySelectorAll<HTMLElement>("[data-testid=commit-parent]")[1]!.click());
  await act(async () => void (await new Promise((r) => setTimeout(r, 100))));
  expect(list().getAttribute("aria-activedescendant")).toBe(`commit-${hash(2)}`);
  expect(el.querySelector(`#commit-${hash(2)}`)).not.toBeNull();
});

it("the branch filter defaults to HEAD: the trigger says so and the first git.log asks for ref HEAD", async () => {
  const c = fake(history(3));
  await mount(c);
  expect(el.querySelector("[data-testid=graph-filter-branch]")!.textContent).toContain("HEAD (main)");
  expect(c.sent.find((m) => m.type === "git.log")).toMatchObject({ ref: "HEAD", skip: 0 });
});

it("a fresh repo with no commits says No commits yet. under the default HEAD", async () => {
  await mount(fake([]));
  expect(el.textContent).toContain("No commits yet.");
});

it("the branch select has a HEAD entry (with the current branch) that asks for ref HEAD", async () => {
  const c = fake(history(3));
  await mount(c);
  const trigger = el.querySelector<HTMLElement>("[data-testid=graph-filter-branch]")!;
  await act(async () => trigger.click());
  await flush();
  const items = [...document.querySelectorAll<HTMLElement>("[role=option]")].filter((o) => !o.closest("[data-testid=commit-list]"));
  expect(items.map((o) => o.textContent)).toEqual(["All branches", "HEAD (main)", "main", "origin/main"]);
  await act(async () => items[1]!.click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.log").at(-1)).toMatchObject({ ref: "HEAD", skip: 0 });
  expect(trigger.textContent).toContain("HEAD (main)");
});

it("ref chips: local green, remote purple, HEAD (bare and its branch) yellow, tags neutral", async () => {
  const all = history(4);
  all[0]!.refs = ["HEAD", "refs/heads/main", "refs/remotes/origin/main"];
  all[1]!.refs = ["refs/heads/dev", "refs/tags/v1"];
  all[2]!.refs = ["HEAD"];
  await mount(fake(all));
  const chips = [...el.querySelectorAll("[data-testid=commit-ref]")];
  const cls = (t: string) => chips.find((c) => c.textContent === t)!.className;
  expect(cls("main")).toContain("text-ref-head");
  expect(cls("main")).toContain("font-semibold");
  expect(cls("origin/main")).toContain("text-ref-remote");
  expect(cls("dev")).toContain("text-ref-local");
  expect(cls("HEAD")).toContain("text-ref-head");
  expect(cls("v1")).not.toMatch(/text-ref-|bg-\[/);
});

const optionTexts = async () => {
  await act(async () => el.querySelector<HTMLElement>("[data-testid=graph-filter-branch]")!.click());
  await flush();
  return [...document.querySelectorAll<HTMLElement>("[role=option]")].filter((o) => !o.closest("[data-testid=commit-list]")).map((o) => o.textContent);
};

it("detached HEAD at a tag: the tag stays neutral, a separate yellow HEAD chip shows, the select says plain HEAD", async () => {
  statusBranch = "1a2b3c4";
  const all = history(3);
  all[0]!.refs = ["refs/tags/v1", "refs/remotes/origin/x", "HEAD"];
  await mount(fake(all));
  const chips = [...el.querySelectorAll("[data-testid=commit-ref]")];
  const cls = (t: string) => chips.find((c) => c.textContent === t)!.className;
  expect(cls("v1")).not.toMatch(/text-ref-|bg-\[/);
  expect(cls("origin/x")).toContain("text-ref-remote");
  expect(cls("HEAD")).toContain("text-ref-head");
  expect((await optionTexts()).slice(0, 2)).toEqual(["All branches", "HEAD"]);
});

it("detached HEAD at a branch commit: the branch chip is green, HEAD is its own yellow chip", async () => {
  const all = history(3);
  all[0]!.refs = ["refs/heads/main", "HEAD"];
  await mount(fake(all));
  const chips = [...el.querySelectorAll("[data-testid=commit-ref]")];
  expect(chips.find((c) => c.textContent === "main")!.className).toContain("text-ref-local");
  expect(chips.find((c) => c.textContent === "HEAD")!.className).toContain("text-ref-head");
});

it("the HEAD label comes from git.status: it follows a checkout on Refresh and needs no HEAD commit in the page", async () => {
  const c = fake(history(3).map((x) => ({ ...x, refs: [] })));
  await mount(c);
  expect((await optionTexts())[1]).toBe("HEAD (main)");
  await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  c.sent.length = 0;
  statusBranch = "1a2b3c4";
  await act(async () => el.querySelector<HTMLElement>("button[aria-label=Refresh]")!.click());
  await flush();
  expect(c.sent.some((m) => m.type === "git.status")).toBe(true);
  expect((await optionTexts())[1]).toBe("HEAD");
});

it("the HEAD label keeps its branch when a filter matches nothing", async () => {
  const c = fake(history(3));
  await mount(c);
  vi.mocked(c.request).mockImplementation(async (m: Req) => ({ log: { commits: m.text ? [] : history(3), more: false, branches: ["refs/heads/main"] } }));
  const input = el.querySelector<HTMLInputElement>("[data-testid=graph-filter-text]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "zzz");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
  expect((await optionTexts())[1]).toBe("HEAD (main)");
});
