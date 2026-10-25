// @vitest-environment jsdom
import type { GitBranchInfo, GitCommit, GitCommitDetail } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { GraphPanel } from "./git-graph-panel.tsx";
import { noteRefs } from "./git-refs.ts";
import * as graph from "./git-graph.ts";

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
/** The branch the fake's first page reports as HEAD (a short hash: detached, no `head`). */
let statusBranch = "main";
/** The refs stamp the fake's first page reports. */
let stampValue = "s1";
/** The fake daemon has no stamp (an older daemon): git.refs fails, the first page has no `refs`. */
let noStamp = false;
/** Number of branches the fake lists. */
let branchCount = 2;
const branchRefs = () => (branchCount === 2 ? ["refs/heads/main", "refs/remotes/origin/main"] : ["refs/heads/main", ...Array.from({ length: branchCount - 1 }, (_, i) => `refs/heads/b${i}`)]);
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
  stampValue = "s1";
  noStamp = false;
  branchCount = 2;
  return act(() => root.render(null));
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

type Req = { type: string; skip?: number; hash?: string; path?: string; text?: string; ref?: string };
let fetchReply: () => Promise<unknown> = async () => ({ remote: { output: "", refs: null } });
const MAIN_ARGV = "refs/heads/main:refs/heads/main";
const infoMain = (o: Partial<GitBranchInfo> = {}): GitBranchInfo => ({
  ref: "refs/heads/main", local: hash(3), checkedOut: "here", remote: "origin", remoteRef: "refs/heads/main", tracking: "refs/remotes/origin/main", trackingHash: hash(2), upstream: "origin/main", ahead: 1, behind: 1,
  push: ["push", "origin", MAIN_ARGV], forcePush: ["push", `--force-with-lease=refs/heads/main:${hash(2)}`, "origin", MAIN_ARGV], pull: ["pull", "--no-rebase", "--ff-only", "origin", "refs/heads/main"], ...o,
});
let branchInfo: (ref: string) => GitBranchInfo = () => infoMain();
let writeReply: () => Promise<unknown> = async () => ({ remote: { output: "", refs: "s2" } });
function fake(all: GitCommit[], files: GitCommitDetail["files"] = [], page = 200, nogit = false) {
  const sent: Req[] = [];
  const request = vi.fn(async (m: Req) => {
    sent.push(m);
    if (m.type === "git.log") {
      const skip = m.skip ?? 0;
      const slice = all.slice(skip, skip + page);
      return { log: nogit ? null : { commits: slice, more: skip + page < all.length, ...(skip === 0 && { branches: branchRefs(), ...(!noStamp && { refs: stampValue }), ...(branchRefs().includes(`refs/heads/${statusBranch}`) ? { head: `refs/heads/${statusBranch}` } : {}) }) } };
    }
    if (m.type === "git.fetch") return fetchReply();
    if (m.type === "git.branch") return { branch: branchInfo(m.ref!) };
    if (m.type === "git.push" || m.type === "git.pull") return writeReply();
    if (m.type === "git.refs") return { refs: noStamp ? null : stampValue };
    if (m.type === "git.status") return { status: { branch: statusBranch, added: 0, removed: 0 } };
    if (m.type === "git.commit") return { commit: detail(all.find((c) => c.hash === m.hash)!, files) };
    return { content: `${m.hash}:${m.path}` };
  });
  return Object.assign({ request, onFsChanged: () => () => {} } as unknown as ReturnType<typeof connect>, { sent });
}
const mount = async (c: ReturnType<typeof fake>, hidden = false) => {
  await act(async () => root.render(<GraphPanel client={c} cwd="/p" hidden={hidden} />));
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

it("a submodule entry in commit details reads \"Submodule <path> → <short>\" and requests no diff", async () => {
  const c = fake(history(3), [{ status: "M", path: "libs/lib", submodule: { from: hash(1), to: hash(2) } }, { status: "M", path: "src/m.ts", added: 1, removed: 1 }]);
  await mount(c);
  await select(0);
  const sub = el.querySelector<HTMLElement>("[data-testid=commit-submodule]")!;
  expect(sub.textContent).toContain(`Submodule libs/lib → ${hash(2).slice(0, 7)}`);
  expect(el.querySelector("button[data-testid=commit-submodule]")).toBeNull();
  expect(el.querySelectorAll("[data-testid=commit-file]")).toHaveLength(1);
  await act(async () => sub.click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.fileAt")).toEqual([]);
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

it("the HEAD label comes from the first page's head: it follows a checkout on Refresh and needs no HEAD commit in the page; the panel sends no git.status", async () => {
  const c = fake(history(3).map((x) => ({ ...x, refs: [] })));
  await mount(c);
  expect((await optionTexts())[1]).toBe("HEAD (main)");
  await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  c.sent.length = 0;
  statusBranch = "1a2b3c4";
  await act(async () => el.querySelector<HTMLElement>("button[aria-label=Refresh]")!.click());
  await flush();
  expect(c.sent.some((m) => m.type === "git.status")).toBe(false);
  expect(c.sent.filter((m) => m.type === "git.log")).toEqual([expect.objectContaining({ skip: 0, fresh: true })]);
  expect((await optionTexts())[1]).toBe("HEAD");
});

it("the HEAD label keeps its branch when a filter matches nothing", async () => {
  const c = fake(history(3));
  await mount(c);
  vi.mocked(c.request).mockImplementation(async (m: Req) => ({ log: { commits: m.text ? [] : history(3), more: false, branches: ["refs/heads/main"], head: "refs/heads/main" } }));
  const input = el.querySelector<HTMLInputElement>("[data-testid=graph-filter-text]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "zzz");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, 350))));
  expect((await optionTexts())[1]).toBe("HEAD (main)");
});

const typeInto = async (testid: string, value: string) => {
  const input = el.querySelector<HTMLInputElement>(`[data-testid=${testid}]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => void (await new Promise((r) => setTimeout(r, 400))));
};
const logs = (c: ReturnType<typeof fake>) => c.sent.filter((m) => m.type === "git.log");

it("one git.log per open and per filter change", async () => {
  const c = fake(history(3));
  await mount(c);
  await act(async () => void (await new Promise((r) => setTimeout(r, 400))));
  expect(logs(c)).toHaveLength(1);
  await typeInto("graph-filter-text", "five");
  expect(logs(c)).toHaveLength(2);
  await typeInto("graph-filter-author", "ann");
  expect(logs(c)).toHaveLength(3);
  // Typing the same text again (spaces only) is no change.
  await typeInto("graph-filter-author", "ann ");
  expect(logs(c)).toHaveLength(3);
});

const refsReqs = (c: ReturnType<typeof fake>) => c.sent.filter((m) => m.type === "git.refs");

it("a hidden panel keeps its list; shown again it asks git.refs, sends no git.log while refs are unchanged and one after they changed", async () => {
  const c = fake(history(3));
  await mount(c);
  expect(logs(c)).toHaveLength(1);
  await mount(c, true);
  expect(el.querySelector<HTMLElement>("[data-testid=graph-panel]")!.className).toContain("hidden");
  await mount(c, false);
  expect(rowEls().length).toBeGreaterThan(0);
  expect(refsReqs(c)).toHaveLength(1);
  expect(logs(c)).toHaveLength(1);
  await mount(c, true);
  // A commit made after the last status poll: only the fresh stamp of git.refs shows it.
  stampValue = "s2";
  await mount(c, false);
  expect(refsReqs(c)).toHaveLength(2);
  expect(logs(c)).toHaveLength(2);
  expect(logs(c)[1]).not.toHaveProperty("fresh");
  expect(rowEls().length).toBeGreaterThan(0);
});

it("a daemon without a refs stamp: the list reloads on every return", async () => {
  noStamp = true;
  const c = fake(history(3));
  await mount(c);
  await mount(c, true);
  await mount(c, false);
  expect(logs(c)).toHaveLength(2);
  // A failing git.refs (an older daemon does not know it) reloads too.
  stampValue = "s1";
  noStamp = false;
  await mount(c, true);
  vi.mocked(c.request).mockImplementationOnce(async (m: Req) => (c.sent.push(m), Promise.reject(new Error("unknown type"))));
  await mount(c, false);
  expect(logs(c)).toHaveLength(3);
});

it("branch items render only while the menu is open", async () => {
  branchCount = 1000;
  await mount(fake(history(3)));
  const options = () => [...document.querySelectorAll<HTMLElement>("[role=option]")].filter((o) => !o.closest("[data-testid=commit-list]"));
  expect(options()).toHaveLength(0);
  await act(async () => {
    list().scrollTop = 100;
    list().dispatchEvent(new Event("scroll"));
  });
  expect(options()).toHaveLength(0);
  await act(async () => el.querySelector<HTMLElement>("[data-testid=graph-filter-branch]")!.click());
  await flush();
  expect(options().length).toBeGreaterThan(900);
  await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await new Promise((r) => setTimeout(r, 300));
  await flush();
  expect(options()).toHaveLength(0);
});

it("load more lays out only the new page", async () => {
  const spy = vi.spyOn(graph, "layoutPage");
  const c = fake(history(500), [], 200);
  await mount(c);
  spy.mockClear();
  await act(async () => {
    list().scrollTop = 200 * 28;
    list().dispatchEvent(new Event("scroll"));
  });
  await flush();
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  const [commits, state] = spy.mock.calls[0]!;
  expect(commits).toHaveLength(200);
  expect(state.lanes.length).toBeGreaterThan(0);
  spy.mockRestore();
});

it("details show the ref chips of the loaded commit", async () => {
  await mount(fake(history(3)));
  await select(0);
  const d = el.querySelector("[data-testid=commit-details]")!;
  expect([...d.querySelectorAll("[data-testid=commit-ref]")].map((x) => x.textContent)).toContain("main");
});

it("Fetch shows a spinner, disables itself, then reloads the graph with fresh and says so", async () => {
  const c = fake(history(3));
  await mount(c);
  let done!: (v: unknown) => void;
  fetchReply = () => new Promise((r) => (done = r));
  const btn = () => el.querySelector<HTMLButtonElement>("[data-testid=graph-fetch]")!;
  await act(async () => btn().click());
  expect(btn().getAttribute("aria-disabled")).toBe("true");
  expect(btn().disabled).toBe(false);
  expect(btn().getAttribute("aria-busy")).toBe("true");
  expect(btn().querySelector(".animate-spin")).not.toBeNull();
  c.sent.length = 0;
  await act(async () => done({ remote: { output: "x -> origin/x", refs: "s2" } }));
  await flush();
  expect(btn().getAttribute("aria-disabled")).not.toBe("true");
  expect(c.sent.map((m) => m.type)).toEqual(["git.log"]);
  expect(c.sent[0]).toMatchObject({ type: "git.log", skip: 0, fresh: true });
  expect(el.querySelector("[data-testid=graph-remote-result] [role=status]")!.textContent).toContain("Fetched all remotes");
  expect(el.querySelector("[data-testid=graph-remote-result] pre")!.textContent).toBe("x -> origin/x");
  expect(btn().className).toContain("max-md:size-11");
});

it("Fetch keeps focus while it runs and a second click sends nothing", async () => {
  const c = fake(history(3));
  await mount(c);
  fetchReply = () => new Promise(() => {});
  const btn = el.querySelector<HTMLButtonElement>("[data-testid=graph-fetch]")!;
  btn.focus();
  await act(async () => btn.click());
  expect(document.activeElement).toBe(btn);
  expect(el.querySelector(".sr-only[role=status]")!.textContent).toBe("Fetching all remotes…");
  await act(async () => btn.click());
  expect(c.sent.filter((m) => m.type === "git.fetch")).toHaveLength(1);
  fetchReply = async () => ({ remote: { output: "", refs: null } });
});

it("a failed fetch shows git's message, still reloads, and Dismiss removes it", async () => {
  const c = fake(history(3));
  await mount(c);
  fetchReply = () => Promise.reject(Object.assign(new Error("fatal: unable to access 'https://h/': Could not resolve host"), { code: "git_failed" }));
  c.sent.length = 0;
  await act(async () => el.querySelector<HTMLButtonElement>("[data-testid=graph-fetch]")!.click());
  await flush();
  expect(el.querySelector("[role=alert]")!.textContent).toContain("Could not resolve host");
  expect(c.sent.at(-1)).toMatchObject({ type: "git.log", skip: 0, fresh: true });
  await act(async () => el.querySelector<HTMLButtonElement>("button[aria-label=Dismiss]")!.click());
  expect(el.querySelector("[data-testid=graph-remote-result]")).toBeNull();
  fetchReply = async () => ({ remote: { output: "", refs: null } });
});

// ---- Branch menu (right click, long press, Shift+F10): push, force push, pull ----
const menuAt = async (target: Element) => {
  await act(async () => void target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await flush();
};
const items = () => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
const itemTexts = () => items().map((i) => i.textContent);
const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid=${id}]`)!;
const withRefs = (): GitCommit[] => {
  const h = history(3);
  h[1] = { ...h[1]!, refs: ["refs/remotes/origin/main", "refs/heads/feat"] };
  return h;
};
const chip = (ref: string) => el.querySelector(`[data-ref="${ref}"]`)!;
const closeMenu = () => act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
afterEach(() => {
  branchInfo = () => infoMain();
  writeReply = async () => ({ remote: { output: "", refs: "s2" } });
  document.body.querySelectorAll("[data-testid$=-dialog]").forEach((d) => d.remove());
});

it("right click on a local branch chip offers Push, Force push and Pull; a remote chip only Fetch", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(chip("refs/heads/main"));
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([{ type: "git.branch", cwd: "/p", ref: "refs/heads/main" }]);
  expect(itemTexts()).toEqual(expect.arrayContaining(["Push", "Force push…", "Pull", "Fetch all remotes"]));
  expect(items().every((i) => !i.hasAttribute("data-disabled"))).toBe(true);
  await closeMenu();
  c.sent.length = 0;
  await menuAt(chip("refs/remotes/origin/main"));
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([]);
  expect(byId("branch-push")).toBeNull();
  expect(itemTexts()).toEqual(["No local branch here", "Fetch all remotes"]);
  expect(byId("branch-none").hasAttribute("data-disabled")).toBe(true);
});

/** A touch held on `target`: pointerdown and touchstart, then the 500 ms long press timer of the menu; no `contextmenu` event (emulated and some real long presses fire none). */
const longPress = async (target: Element) => {
  const touch = { identifier: 1, target, clientX: 5, clientY: 5 };
  await act(async () => {
    target.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
    const ev = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "touches", { value: [touch] });
    target.dispatchEvent(ev);
    await new Promise((r) => setTimeout(r, 650));
  });
  await flush();
};

it("a long press on a branch chip with touch (no contextmenu event) opens the full menu for that chip", async () => {
  const c = fake(withRefs());
  await mount(c);
  await longPress(chip("refs/heads/main"));
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([{ type: "git.branch", cwd: "/p", ref: "refs/heads/main" }]);
  expect(itemTexts()).toEqual(expect.arrayContaining(["Push", "Force push…", "Pull", "Fetch all remotes"]));
});

it("a long press on a row with touch targets the row's local branches; on a remote chip only Fetch", async () => {
  const c = fake(withRefs());
  await mount(c);
  await longPress(rowEls()[1]!);
  expect(c.sent.filter((m) => m.type === "git.branch").map((m) => m.ref)).toEqual(["refs/heads/feat"]);
  await closeMenu();
  c.sent.length = 0;
  await longPress(chip("refs/remotes/origin/main"));
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([]);
  expect(itemTexts()).toEqual(["No local branch here", "Fetch all remotes"]);
});

it("the group header keeps the branch name and the ownership note on separate lines", async () => {
  const c = fake(withRefs());
  await mount(c);
  branchInfo = () => infoMain({ checkedOut: undefined });
  await menuAt(chip("refs/heads/main"));
  const head = byId("branch-menu-head");
  expect([...head.children].map((x) => x.textContent)).toEqual(["main", "not checked out here"]);
});

it("a row right click targets its local branches; Shift+F10 on the list targets the selected row", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(rowEls()[1]!);
  expect(c.sent.filter((m) => m.type === "git.branch").map((m) => m.ref)).toEqual(["refs/heads/feat"]);
  await closeMenu();
  c.sent.length = 0;
  await select(0);
  await act(async () => void list().dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
  await menuAt(list());
  expect(c.sent.filter((m) => m.type === "git.branch").map((m) => m.ref)).toEqual(["refs/heads/main"]);
});

it("a right click or long press on empty list space does not target the selected row", async () => {
  const c = fake(withRefs());
  await mount(c);
  await select(0);
  c.sent.length = 0;
  await act(async () => void list().dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true })));
  await menuAt(list());
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([]);
  expect(itemTexts()).toEqual(["No local branch here", "Fetch all remotes"]);
  await closeMenu();
  await longPress(list());
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([]);
  expect(itemTexts()).toEqual(["No local branch here", "Fetch all remotes"]);
});

it("Force push asks first: the dialog shows the exact command; Cancel runs nothing; Confirm sends git.push with the lease and reloads fresh", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-force-push").click());
  const dlg = byId("git-force-push-dialog");
  expect(dlg.textContent).toContain(`git push --force-with-lease=refs/heads/main:${hash(2)} origin ${MAIN_ARGV}`);
  expect(byId("git-command").textContent).toContain("--force-with-lease");
  await act(async () => byId("git-force-push-cancel").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.push")).toEqual([]);
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-force-push").click());
  c.sent.length = 0;
  await act(async () => byId("git-force-push-confirm").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.push")).toEqual([{ type: "git.push", cwd: "/p", ref: "refs/heads/main", local: hash(3), argv: infoMain().forcePush, lease: hash(2) }]);
  expect(c.sent.at(-1)).toMatchObject({ type: "git.log", skip: 0, fresh: true });
  expect(el.querySelector("[data-testid=graph-remote-result] [role=status]")!.textContent).toContain("Pushed main");
});

it("Push and Pull confirm with the exact command too; Pull sends git.pull", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-push").click());
  expect(byId("git-command").textContent).toBe(`git push origin ${MAIN_ARGV}`);
  await act(async () => byId("git-push-cancel").click());
  await flush();
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-pull").click());
  expect(byId("git-command").textContent).toBe("git pull --no-rebase --ff-only origin refs/heads/main");
  await act(async () => byId("git-pull-confirm").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.pull")).toEqual([{ type: "git.pull", cwd: "/p", ref: "refs/heads/main", local: hash(3), argv: infoMain().pull }]);
  expect(c.sent.filter((m) => m.type === "git.push")).toEqual([]);
});

it("a branch not checked out here says so in the menu and the dialog; one in another worktree disables Pull with the reason", async () => {
  const c = fake(withRefs());
  await mount(c);
  branchInfo = () => infoMain({ checkedOut: undefined, pull: ["fetch", "origin", "refs/heads/main:refs/heads/main"] });
  await menuAt(chip("refs/heads/main"));
  expect(document.body.textContent).toContain("not checked out here");
  await act(async () => byId("branch-push").click());
  expect(byId("git-push-dialog").textContent).toContain("main is not checked out here");
  await act(async () => byId("git-push-cancel").click());
  await flush();
  branchInfo = () => infoMain({ checkedOut: "/work/wt", pull: undefined, why: { pull: "Checked out in /work/wt: pull there" } });
  await menuAt(chip("refs/heads/main"));
  expect(document.body.textContent).toContain("checked out in wt");
  expect(byId("branch-pull").hasAttribute("data-disabled")).toBe(true);
  expect(byId("branch-pull").textContent).toContain("Checked out in /work/wt: pull there");
});

it("a rejected push shows git's message and still reloads", async () => {
  const c = fake(withRefs());
  await mount(c);
  writeReply = () => Promise.reject(Object.assign(new Error("! [rejected] main -> main (non-fast-forward)"), { code: "git_failed" }));
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-push").click());
  c.sent.length = 0;
  await act(async () => byId("git-push-confirm").click());
  await flush();
  expect(el.querySelector("[role=alert]")!.textContent).toContain("non-fast-forward");
  expect(c.sent.at(-1)).toMatchObject({ type: "git.log", fresh: true });
});

it("menu items are disabled while a remote operation runs", async () => {
  const c = fake(withRefs());
  await mount(c);
  fetchReply = () => new Promise(() => {});
  await act(async () => el.querySelector<HTMLButtonElement>("[data-testid=graph-fetch]")!.click());
  await menuAt(chip("refs/heads/main"));
  expect(items().length).toBeGreaterThan(0);
  expect(items().every((i) => i.hasAttribute("data-disabled"))).toBe(true);
  fetchReply = async () => ({ remote: { output: "", refs: null } });
});

it("Push (plain) sends the plain push argv, not the force one, and no lease", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-push").click());
  c.sent.length = 0;
  await act(async () => byId("git-push-confirm").click());
  await flush();
  const sent = c.sent.filter((m) => m.type === "git.push");
  expect(sent).toEqual([{ type: "git.push", cwd: "/p", ref: "refs/heads/main", local: hash(3), argv: infoMain().push }]);
  expect(sent[0]).not.toHaveProperty("lease");
  expect(JSON.stringify(sent[0])).not.toContain("force-with-lease");
});

it("a click on empty list space then Shift+F10 opens the selected row's branches, not an empty menu", async () => {
  const c = fake(withRefs());
  await mount(c);
  await select(0);
  // The press on empty space leaves a press with no target; the key press clears it.
  await act(async () => void list().dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true })));
  c.sent.length = 0;
  await act(async () => void list().dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
  await menuAt(list());
  expect(c.sent.filter((m) => m.type === "git.branch").map((m) => m.ref)).toEqual(["refs/heads/main"]);
  expect(itemTexts()).toEqual(expect.arrayContaining(["Push", "Force push…", "Pull"]));
});

it("the command block wraps at spaces (a long -c prefix is not cut mid-word)", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-push").click());
  const cls = byId("git-command").className;
  expect(cls).toContain("whitespace-pre-wrap");
  expect(cls).toContain("[overflow-wrap:anywhere]");
  expect(cls).not.toContain("break-all");
  await act(async () => byId("git-push-cancel").click());
  await flush();
});

it("exact: every git request carries exact: true, and Refresh calls onRefresh", async () => {
  const c = fake(withRefs(), FILES);
  const onRefresh = vi.fn();
  await act(async () => root.render(<GraphPanel client={c} cwd="/p/api" exact onRefresh={onRefresh} />));
  await flush();
  await select(0);
  await act(async () => fileBtn(2).click());
  await flush();
  await menuAt(chip("refs/heads/feat"));
  await act(async () => byId("branch-fetch").click());
  await flush();
  await act(async () => el.querySelector<HTMLElement>("button[aria-label=Refresh]")!.click());
  await flush();
  const types = new Set(c.sent.map((m) => m.type));
  for (const t of ["git.log", "git.commit", "git.fileAt", "git.fetch", "git.branch"]) expect(types.has(t)).toBe(true);
  const refs = c.sent.filter((m) => m.type.startsWith("git.") && m.type !== "git.status");
  expect(refs.length).toBeGreaterThan(5);
  for (const m of refs) expect(m).toMatchObject({ cwd: "/p/api", exact: true });
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

it("without exact no request carries it", async () => {
  const c = fake(history(3));
  await mount(c);
  expect(c.sent.some((m) => "exact" in m)).toBe(false);
});
