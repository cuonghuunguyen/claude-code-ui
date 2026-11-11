// @vitest-environment jsdom
import type { GitBranchInfo, GitCommit, GitCommitDetail, GitCommitMenu } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { connect } from "./client.ts";
import { GraphPane, GraphPanel } from "./git-graph-panel.tsx";
import { forgetRepoChoices, getRepoChoice, setRepoChoice } from "./repo-choice.ts";
import type { GitRepo } from "@claude-ui/protocol";
import { forgetRemoteOps } from "./git-remote-ops.ts";
import { focusCommit } from "./graph-focus.ts";
import { noteRefs, refsOf } from "./git-refs.ts";
import * as graph from "./git-graph.ts";

vi.mock("@pierre/diffs/react", () => ({ MultiFileDiff: () => <div data-testid="pierre-diff" /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
let narrowNow = false;
const setNarrow = (n: boolean) => void (narrowNow = n);
window.matchMedia = ((query: string) => ({ get matches() { return narrowNow && query.includes("48rem"); }, media: query, addEventListener() {}, removeEventListener() {} })) as never;
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
  forgetRemoteOps();
  forgetRepoChoices();
  localStorage.removeItem("claude-ui.repoChoice");
  setNarrow(false);
  return act(() => root.render(null));
});
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

type Req = { type: string; cwd?: string; skip?: number; hash?: string; path?: string; text?: string; ref?: string };
let fetchReply: () => Promise<unknown> = async () => ({ remote: { output: "", refs: null } });
const MAIN_ARGV = "refs/heads/main:refs/heads/main";
const infoMain = (o: Partial<GitBranchInfo> = {}): GitBranchInfo => ({
  ref: "refs/heads/main", local: hash(3), checkedOut: "here", remote: "origin", remoteRef: "refs/heads/main", tracking: "refs/remotes/origin/main", trackingHash: hash(2), upstreamHash: hash(2), upstream: "origin/main", ahead: 1, behind: 1,
  push: ["push", "origin", MAIN_ARGV], forcePush: ["push", `--force-with-lease=refs/heads/main:${hash(2)}`, "origin", MAIN_ARGV], pull: ["pull", "--no-rebase", "--ff-only", "origin", "refs/heads/main"],
  headRef: "refs/heads/dev", headHash: hash(1), merge: ["merge", "--no-edit", "main"], rebase: ["rebase", "refs/heads/main"], ...o,
});
let branchInfo: (ref: string) => GitBranchInfo = () => infoMain();
/** The commit menu of the fake: HEAD is the tip (hash(3) in `withRefs`), everything is available. */
const commitMenu = (h: string, hard?: boolean): GitCommitMenu => ({
  hash: h, parents: 1, headRef: "refs/heads/main", headHash: hash(3), undo: ["reset", "--soft", "HEAD~1"], revert: ["revert", "--no-edit", h], cherryPick: ["cherry-pick", h],
  reset: { soft: ["reset", "--soft", h], mixed: ["reset", "--mixed", h], hard: ["reset", "--hard", "--no-recurse-submodules", h] },
  ...(hard && { lose: ["a.txt", "b.txt"], loseCount: 3, dirty: "fp1" }),
});
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
    if (m.type === "git.push" || m.type === "git.pull" || m.type === "git.merge" || m.type === "git.rebase" || m.type === "git.revert" || m.type === "git.undoCommit" || m.type === "git.cherryPick" || m.type === "git.checkout" || m.type === "git.branchCreate" || m.type === "git.reset") return writeReply();
    if (m.type === "git.commitMenu") return { commitMenu: commitMenu(m.hash!, (m as { hard?: boolean }).hard) };
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
  expect(items.map((o) => o.textContent)).toEqual(["All branches", "HEAD (main)", "main"]);
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
  // A long name is cut by the chip width; hover (title) shows it whole.
  expect(chips.find((c) => c.textContent === "origin/main")!.getAttribute("title")).toBe("origin/main");
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

it("a detached HEAD chip offers no Push or Pull, only Fetch", async () => {
  const all = history(3);
  all[0]!.refs = ["HEAD"];
  const c = fake(all);
  await mount(c);
  await menuAt([...el.querySelectorAll("[data-testid=commit-ref]")].find((x) => x.textContent === "HEAD")!);
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([]);
  expect(itemTexts()).toEqual(["New Branch…"]);
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

const mountNamed = async (c: ReturnType<typeof fake>, cwd: string, repoName?: string) => {
  await act(async () => root.render(<GraphPanel key={cwd} client={c} cwd={cwd} repoName={repoName} />));
  await flush();
};
const fetchBtn = () => el.querySelector<HTMLButtonElement>("[data-testid=graph-fetch]")!;
const resultText = () => el.querySelector("[data-testid=graph-remote-result] [role=status]")?.textContent;

it("Fetch of a named repository says \"Fetched all remotes of libs/lib\"; without a name today's text", async () => {
  const c = fake(history(3));
  await mountNamed(c, "/p/libs/lib", "libs/lib");
  fetchReply = () => new Promise(() => {});
  await act(async () => fetchBtn().click());
  expect(el.querySelector(".sr-only[role=status]")!.textContent).toBe("Fetching all remotes of libs/lib…");
  fetchReply = async () => ({ remote: { output: "", refs: null } });
  forgetRemoteOps();
  await mountNamed(c, "/p", undefined);
  await act(async () => fetchBtn().click());
  await flush();
  expect(resultText()).toBe("Fetched all remotes");
});

it("a result line and a running fetch stay with their repository across a remount; Dismiss clears that repository only", async () => {
  const c = fake(history(3));
  let done!: (v: unknown) => void;
  fetchReply = () => new Promise((r) => (done = r));
  await mountNamed(c, "/p", "p");
  await act(async () => fetchBtn().click());
  await mountNamed(c, "/p/libs/lib", "libs/lib");
  expect(fetchBtn().getAttribute("aria-busy")).not.toBe("true");
  fetchReply = async () => ({ remote: { output: "", refs: null } });
  await act(async () => fetchBtn().click());
  await flush();
  expect(resultText()).toBe("Fetched all remotes of libs/lib");
  await act(async () => done({ remote: { output: "", refs: null } }));
  await flush();
  expect(resultText()).toBe("Fetched all remotes of libs/lib");
  await mountNamed(c, "/p", "p");
  expect(resultText()).toBe("Fetched all remotes of p");
  expect(c.sent.filter((m) => m.type === "git.fetch" && m.cwd === "/p")).toHaveLength(1);
  await act(async () => el.querySelector<HTMLButtonElement>("button[aria-label=Dismiss]")!.click());
  await mountNamed(c, "/p/libs/lib", "libs/lib");
  expect(resultText()).toBe("Fetched all remotes of libs/lib");
});

it("a finished operation reloads the mounted panel of its repository with fresh", async () => {
  const c = fake(history(3));
  await mountNamed(c, "/p", "p");
  c.sent.length = 0;
  await act(async () => fetchBtn().click());
  await flush();
  expect(c.sent.at(-1)).toMatchObject({ type: "git.log", cwd: "/p", fresh: true });
});

it("Push and Pull results name the repository", async () => {
  const c = fake(withRefs());
  await mountNamed(c, "/p/libs/lib", "libs/lib");
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-push").click());
  await act(async () => byId("git-push-confirm").click());
  await flush();
  expect(resultText()).toBe("Pushed main of libs/lib to origin");
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-pull").click());
  await act(async () => byId("git-pull-confirm").click());
  await flush();
  expect(resultText()).toBe("Pulled main of libs/lib");
});

// ---- GraphPane: the selected repository ----
const own: GitRepo = { path: "/p", rel: "", kind: "main", branch: "main" };
const lib: GitRepo = { path: "/p/libs/lib", rel: "libs/lib", kind: "submodule", parent: "/p", branch: "a4a3b80" };
const out: GitRepo = { path: "/p/web", rel: "web", kind: "nested", parent: "/p", outsideRoots: true };
const mountPane = async (c: ReturnType<typeof fake>, list: GitRepo[], hidden = false) => {
  await act(async () => root.render(<GraphPane client={c} cwd="/p" hidden={hidden} repos={{ list, projectKey: "/p" }} />));
  await flush();
};
const pickRepo = (rel: string) => act(async () => setRepoChoice("/p", rel));
const selectorEl = () => el.querySelector<HTMLElement>("[data-testid=repo-selector]");

it("GraphPane: no selector for only the own repository; with 2+ the filter row starts with it", async () => {
  const c = fake(history(3));
  await mountPane(c, [own]);
  expect(selectorEl()).toBeNull();
  expect(logs(c)[0]).toMatchObject({ cwd: "/p", exact: true });
  await mountPane(c, [own, lib]);
  expect(selectorEl()).not.toBeNull();
  expect(el.querySelector("[data-testid=graph-filter-text]")!.closest("div")!.firstElementChild).toBe(selectorEl());
});

it("GraphPane: without a repository list yet it says Loading graph… and reads nothing; null (an older daemon) reads the cwd without exact", async () => {
  const c = fake(history(3));
  await act(async () => root.render(<GraphPane client={c} cwd="/p" />));
  await flush();
  expect(el.textContent).toContain("Loading graph…");
  expect(c.sent).toEqual([]);
  await act(async () => root.render(<GraphPane client={c} cwd="/p" repos={null} />));
  await flush();
  expect(el.textContent).not.toContain("Loading graph…");
  expect(logs(c)[0]).toMatchObject({ cwd: "/p" });
  expect(logs(c)[0]).not.toHaveProperty("exact");
});

it("GraphPane: picking libs/lib remounts the panel for it: git.log of lib, branch filter back to HEAD", async () => {
  const c = fake(history(3));
  await mountPane(c, [own, lib]);
  expect(selectorEl()!.getAttribute("aria-label")).toBe("Repository: p, branch main");
  c.sent.length = 0;
  await pickRepo("libs/lib");
  await flush();
  expect(logs(c)[0]).toMatchObject({ cwd: "/p/libs/lib", exact: true, ref: "HEAD", skip: 0 });
  expect(selectorEl()!.getAttribute("aria-label")).toBe("Repository: lib, branch a4a3b80");
});

it("GraphPane: a stored outsideRoots choice falls back to the own repository", async () => {
  setRepoChoice("/p", "web");
  const c = fake(history(3));
  await mountPane(c, [own, out]);
  expect(logs(c)[0]).toMatchObject({ cwd: "/p", exact: true });
});

it("GraphPane: Fetch names the repository while the selector shows; a running fetch stays with it", async () => {
  const c = fake(history(3));
  let done!: (v: unknown) => void;
  fetchReply = () => new Promise((r) => (done = r));
  await mountPane(c, [own, lib]);
  await act(async () => fetchBtn().click());
  expect(el.querySelector(".sr-only[role=status]")!.textContent).toBe("Fetching all remotes of p…");
  await pickRepo("libs/lib");
  await flush();
  expect(fetchBtn().getAttribute("aria-busy")).not.toBe("true");
  fetchReply = async () => ({ remote: { output: "", refs: null } });
  await act(async () => fetchBtn().click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.fetch").map((m) => m.cwd)).toEqual(["/p", "/p/libs/lib"]);
  expect(resultText()).toBe("Fetched all remotes of libs/lib");
  await act(async () => done({ remote: { output: "", refs: null } }));
  await flush();
  expect(resultText()).toBe("Fetched all remotes of libs/lib");
  await pickRepo("");
  await flush();
  expect(resultText()).toBe("Fetched all remotes of p");
  await mountPane(c, [own]);
  await act(async () => fetchBtn().click());
  await flush();
  expect(resultText()).toBe("Fetched all remotes");
});

it("GraphPane: a switch while the Graph is hidden sends no git.log until it shows; then git.refs of the repository", async () => {
  const c = fake(history(3));
  await mountPane(c, [own, lib]);
  await mountPane(c, [own, lib], true);
  c.sent.length = 0;
  await pickRepo("libs/lib");
  await flush();
  expect(c.sent.filter((m) => m.type === "git.log")).toEqual([]);
  await mountPane(c, [own, lib], false);
  expect(c.sent.find((m) => m.type === "git.refs")).toMatchObject({ cwd: "/p/libs/lib", exact: true });
  expect(logs(c)[0]).toMatchObject({ cwd: "/p/libs/lib", exact: true });
});

it("GraphPane: refs stamps are noted under the repository path", async () => {
  noteRefs("/p", "old");
  stampValue = "s7";
  const c = fake(history(3));
  await mountPane(c, [own, lib]);
  await pickRepo("libs/lib");
  await flush();
  expect(refsOf("/p/libs/lib")).toBe("s7");
  expect(refsOf("/p")).toBe("s7");
  stampValue = "s8";
  await pickRepo("");
  await mountPane(c, [own, lib], true);
  await mountPane(c, [own, lib], false);
  expect(refsOf("/p/libs/lib")).toBe("s7");
});

const SUBS: GitCommitDetail["files"] = [
  { status: "M", path: "libs/lib", submodule: { to: "a".repeat(40) } },
  { status: "M", path: "vendor/x", submodule: { to: "b".repeat(40) } },
  { status: "M", path: "web", submodule: { to: "c".repeat(40) } },
];
const showBtns = () => [...el.querySelectorAll<HTMLElement>("[data-testid=show-repo-graph]")];

it("GraphPane: Show graph of libs/lib on a listed submodule entry selects it; unlisted and outsideRoots entries have no button", async () => {
  const c = fake(history(3), SUBS);
  await mountPane(c, [own, lib, out]);
  await select(0);
  expect(showBtns().map((b) => b.textContent)).toEqual(["Show graph of libs/lib"]);
  expect(showBtns()[0]!.className).toContain("max-md:h-11");
  c.sent.length = 0;
  await act(async () => showBtns()[0]!.click());
  await flush();
  expect(getRepoChoice("/p")).toBe("libs/lib");
  expect(logs(c)[0]).toMatchObject({ cwd: "/p/libs/lib", exact: true });
  expect(c.sent.some((m) => m.type === "git.fileAt")).toBe(false);
});

it("GraphPane: below md the selector has its own full-width line", async () => {
  setNarrow(true);
  const c = fake(history(3));
  await mountPane(c, [own, lib]);
  expect(selectorEl()!.className).toContain("h-11");
  expect(selectorEl()!.className).toContain("w-full");
});

it("GraphPane: coming back to the hidden Graph checks git.refs of the selected repository with exact", async () => {
  setRepoChoice("/p", "libs/lib");
  const c = fake(history(3));
  await mountPane(c, [own, lib]);
  await mountPane(c, [own, lib], true);
  c.sent.length = 0;
  await mountPane(c, [own, lib], false);
  expect(c.sent.find((m) => m.type === "git.refs")).toMatchObject({ cwd: "/p/libs/lib", exact: true });
  expect(logs(c)).toEqual([]);
});

// ---- Branch menu (right click, long press, Shift+F10): push, force push, pull ----
const menuAt = async (target: Element) => {
  await act(async () => void target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 5, clientY: 5 })));
  await flush();
};
const items = () => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")];
/** The branch menu items; the commit section on top has its own tests. */
const itemTexts = () => items().filter((i) => !i.dataset.testid?.startsWith("commit-")).map((i) => i.textContent);
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
  // The current branch ("here"): no Checkout, Merge or Rebase; no Fetch (the toolbar has it).
  expect(itemTexts()).toEqual(["Push", "Force push…", "Pull", "New branch from main…"]);
  expect(items().every((i) => !i.hasAttribute("data-disabled"))).toBe(true);
  await closeMenu();
  c.sent.length = 0;
  await menuAt(chip("refs/remotes/origin/main"));
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([]);
  expect(byId("branch-push")).toBeNull();
  expect(itemTexts()).toEqual(["Checkout as new local branch", "New branch from origin/main…"]);
  expect(byId("branch-none")).toBeNull();
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
  expect(itemTexts()).toEqual(["Push", "Force push…", "Pull", "New branch from main…"]);
});

it("a long press on a row with touch opens the commit menu; on a remote chip the branch's", async () => {
  const c = fake(withRefs());
  await mount(c);
  await longPress(rowEls()[1]!);
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([]);
  expect(c.sent.filter((m) => m.type === "git.commitMenu").map((m) => m.hash)).toEqual([hash(2)]);
  await closeMenu();
  c.sent.length = 0;
  await longPress(chip("refs/remotes/origin/main"));
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([]);
  expect(itemTexts()).toEqual(["Checkout as new local branch", "New branch from origin/main…"]);
});

it("the group header keeps the branch name and the ownership note on separate lines", async () => {
  const c = fake(withRefs());
  await mount(c);
  branchInfo = () => infoMain({ checkedOut: undefined });
  await menuAt(chip("refs/heads/main"));
  const head = byId("branch-menu-head");
  expect([...head.children].map((x) => x.textContent)).toEqual(["main", "not checked out here"]);
});

it("a row right click opens its commit menu; Shift+F10 on the list the selected row's", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(rowEls()[1]!);
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([]);
  expect(c.sent.filter((m) => m.type === "git.commitMenu").map((m) => m.hash)).toEqual([hash(2)]);
  await closeMenu();
  c.sent.length = 0;
  await select(0);
  await act(async () => void list().dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
  await menuAt(list());
  expect(c.sent.filter((m) => m.type === "git.commitMenu").map((m) => m.hash)).toEqual([hash(3)]);
});

it("a right click or long press on empty list space does not target the selected row", async () => {
  const c = fake(withRefs());
  await mount(c);
  await select(0);
  c.sent.length = 0;
  await act(async () => void list().dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true })));
  await menuAt(list());
  expect(c.sent.filter((m) => m.type === "git.commitMenu")).toEqual([]);
  expect(itemTexts()).toEqual(["No local branch here"]);
  await closeMenu();
  await longPress(list());
  expect(c.sent.filter((m) => m.type === "git.commitMenu")).toEqual([]);
  expect(itemTexts()).toEqual(["No local branch here"]);
});

it("Force push asks first: the dialog shows the exact command; Cancel runs nothing; Confirm sends git.push with the lease and reloads fresh", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-force-push").click());
  const dlg = byId("git-force-push-dialog");
  expect(dlg.textContent).toContain(`git push --force-with-lease=refs/heads/main:${hash(2)} origin ${MAIN_ARGV}`);
  expect(byId("git-command").textContent).toContain("--force-with-lease");
  expect(dlg.textContent).toContain(`${hash(2).slice(0, 7)} → ${hash(3).slice(0, 7)}: 1 commit on the remote will be lost. Refused if the remote moved since your last fetch.`);
  await act(async () => byId("git-force-push-cancel").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.push")).toEqual([]);
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-force-push").click());
  c.sent.length = 0;
  await act(async () => byId("git-force-push-confirm").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.push")).toEqual([{ type: "git.push", cwd: "/p", ref: "refs/heads/main", local: hash(3), argv: infoMain().forcePush, lease: hash(2), tracking: hash(2) }]);
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
  expect(c.sent.filter((m) => m.type === "git.pull")).toEqual([{ type: "git.pull", cwd: "/p", ref: "refs/heads/main", local: hash(3), argv: infoMain().pull, tracking: hash(2) }]);
  expect(c.sent.filter((m) => m.type === "git.push")).toEqual([]);
});

it("Merge and Rebase name HEAD's branch, show the exact command and send the hashes the menu showed; a stop on conflicts says so", async () => {
  const c = fake(withRefs());
  await mount(c);
  branchInfo = () => infoMain({ checkedOut: undefined });
  await menuAt(chip("refs/heads/main"));
  expect(byId("branch-merge").textContent).toBe("Merge into dev…");
  expect(byId("branch-rebase").textContent).toBe("Rebase dev onto main…");
  await act(async () => byId("branch-merge").click());
  expect(byId("git-merge-dialog").textContent).toContain("Merge main into dev?");
  expect(byId("git-command").textContent).toBe("git merge --no-edit main");
  writeReply = async () => ({ written: { output: "CONFLICT", refs: "s2", operation: { kind: "merge", conflicted: ["a.txt"] } } });
  await act(async () => byId("git-merge-confirm").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.merge")).toEqual([{ type: "git.merge", cwd: "/p", ref: "refs/heads/main", local: hash(3), headRef: "refs/heads/dev", headHash: hash(1), argv: infoMain().merge }]);
  expect(el.querySelector("[data-testid=graph-remote-result] [role=status]")!.textContent).toContain("Merge of main stopped on conflicts");
  writeReply = async () => ({ written: { output: "", refs: "s3" } });
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-rebase").click());
  expect(byId("git-command").textContent).toBe("git rebase refs/heads/main");
  await act(async () => byId("git-rebase-confirm").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.rebase")).toHaveLength(1);
  expect(el.querySelector("[data-testid=graph-remote-result] [role=status]")!.textContent).toContain("Rebased onto main");
});

it("Merge and Rebase are disabled with the reason git gave", async () => {
  const c = fake(withRefs());
  await mount(c);
  branchInfo = () => infoMain({ checkedOut: undefined, merge: undefined, rebase: undefined, why: { merge: "A merge is in progress", rebase: "A merge is in progress" } });
  await menuAt(chip("refs/heads/main"));
  expect(byId("branch-merge").hasAttribute("data-disabled")).toBe(true);
  expect(byId("branch-merge").textContent).toContain("A merge is in progress");
});

it("a branch not checked out here says so in the menu and the dialog; one in another worktree disables Pull with the reason", async () => {
  const c = fake(withRefs());
  await mount(c);
  branchInfo = () => infoMain({ checkedOut: undefined, pull: ["fetch", "origin", "refs/heads/main:refs/heads/main"] });
  await menuAt(chip("refs/heads/main"));
  expect(document.body.textContent).toContain("not checked out here");
  await act(async () => byId("branch-push").click());
  expect(byId("git-push-dialog").textContent).toContain("Not checked out here.");
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
  expect(sent).toEqual([{ type: "git.push", cwd: "/p", ref: "refs/heads/main", local: hash(3), argv: infoMain().push, tracking: hash(2) }]);
  expect(sent[0]).not.toHaveProperty("lease");
  expect(JSON.stringify(sent[0])).not.toContain("force-with-lease");
});

it("a click on empty list space then Shift+F10 opens the selected row's commit menu, not an empty menu", async () => {
  const c = fake(withRefs());
  await mount(c);
  await select(0);
  // The press on empty space leaves a press with no target; the key press clears it.
  await act(async () => void list().dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true })));
  c.sent.length = 0;
  await act(async () => void list().dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })));
  await menuAt(list());
  expect(c.sent.filter((m) => m.type === "git.commitMenu").map((m) => m.hash)).toEqual([hash(3)]);
  expect(itemTexts()).toEqual(["New Branch…"]);
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
  await closeMenu();
  await act(async () => byId("graph-fetch").click());
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

it("the Stashes toggle shows the stash section and loads the list", async () => {
  const c = fake(history(3));
  await mount(c);
  expect(el.querySelector("[data-testid=stash-section]")).toBeNull();
  expect(c.sent.some((m) => m.type === "git.stashList")).toBe(false);
  const btn = el.querySelector<HTMLButtonElement>("[data-testid=graph-stashes]")!;
  await act(async () => btn.click());
  await flush();
  expect(btn.getAttribute("aria-pressed")).toBe("true");
  expect(el.querySelector("[data-testid=stash-section]")).not.toBeNull();
  expect(c.sent.filter((m) => m.type === "git.stashList")).toHaveLength(1);
});

const localChanges = () => Promise.reject(Object.assign(new Error("error: Your local changes to the following files would be overwritten by checkout:\n\ta.txt"), { code: "local_changes" }));

it("Checkout sends git.checkout and says so; the current branch's item is disabled with the reason", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(chip("refs/heads/main"));
  // The current branch can never be checked out, merged or rebased: those items are absent, not disabled.
  for (const id of ["branch-checkout", "branch-merge", "branch-rebase"]) expect(byId(id)).toBeNull();
  await closeMenu();
  branchInfo = () => infoMain({ checkedOut: undefined });
  writeReply = async () => ({ written: { output: "", refs: "s2" } });
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-checkout").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.checkout")).toEqual([{ type: "git.checkout", cwd: "/p", ref: "refs/heads/main" }]);
  expect(el.querySelector("[data-testid=graph-remote-result] [role=status]")!.textContent).toContain("Checked out main");
});

it("a local_changes refusal opens the Smart checkout dialog with git's text; Confirm resends with smart and a pop conflict says so", async () => {
  const c = fake(withRefs());
  await mount(c);
  branchInfo = () => infoMain({ checkedOut: undefined });
  writeReply = localChanges;
  await menuAt(chip("refs/heads/main"));
  await act(async () => byId("branch-checkout").click());
  await flush();
  expect(byId("git-smart-checkout-dialog").textContent).toContain("Local changes would be overwritten");
  expect(byId("git-smart-message").textContent).toContain("a.txt");
  expect(el.querySelector("[data-testid=graph-remote-result] [role=status]")).toBeNull();
  writeReply = async () => ({ written: { output: "CONFLICT", refs: "s2", operation: { kind: "conflict", conflicted: ["a.txt"] } } });
  await act(async () => byId("git-smart-checkout-confirm").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.checkout")).toEqual([{ type: "git.checkout", cwd: "/p", ref: "refs/heads/main" }, { type: "git.checkout", cwd: "/p", ref: "refs/heads/main", smart: true }]);
  expect(el.querySelector("[data-testid=graph-remote-result] [role=status]")!.textContent).toContain("applying your changes stopped on conflicts");
});

it("a remote chip offers only Checkout as new local branch, with no git.branch request", async () => {
  const c = fake(withRefs());
  await mount(c);
  c.sent.length = 0;
  writeReply = async () => ({ written: { output: "", refs: "s2" } });
  await menuAt(chip("refs/remotes/origin/main"));
  expect(itemTexts().slice(0, 1)).toEqual(["Checkout as new local branch"]);
  expect(c.sent.some((m) => m.type === "git.branch")).toBe(false);
  await act(async () => byId("branch-checkout-remote").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.checkout")).toEqual([{ type: "git.checkout", cwd: "/p", ref: "refs/remotes/origin/main" }]);
});

it("New branch from a row sends git.branchCreate with the row's hash and checkout on; the name is required", async () => {
  const c = fake(withRefs());
  await mount(c);
  writeReply = async () => ({ written: { output: "", refs: "s2" } });
  const row = rowEls()[1]!;
  await menuAt(row);
  expect(byId("branch-new").textContent).toBe("New Branch…");
  await act(async () => byId("branch-new").click());
  expect(byId("git-new-branch-confirm").hasAttribute("disabled")).toBe(true);
  const input = byId("git-new-branch-name") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "topic");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => byId("git-new-branch-confirm").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.branchCreate")).toEqual([{ type: "git.branchCreate", cwd: "/p", name: "topic", at: hash(2), checkout: true }]);
  expect(el.querySelector("[data-testid=graph-remote-result] [role=status]")!.textContent).toContain("Created and checked out topic");
});

it("details of a commit: a chip opens its branch's actions, the rest of the refs line the commit menu", async () => {
  const c = fake(withRefs());
  await mount(c);
  await select(1);
  const inDetails = el.querySelector("[data-testid=commit-details] [data-ref]")!;
  await menuAt(inDetails);
  expect(byId("branch-new").textContent).toBe("New branch from origin/main…");
  await closeMenu();
  await menuAt(el.querySelector("[data-testid=commit-details] [data-hash]")!);
  expect(byId("branch-new").textContent).toBe("New Branch…");
});

const rowOf = (h: string) => el.querySelector(`[data-hash="${h}"]`)!;

it("Copy Revision Number copies the full hash of the row, no daemon request", async () => {
  const c = fake(withRefs());
  await mount(c);
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await menuAt(rowOf(hash(2)));
  const sent = c.sent.length;
  await act(async () => byId("commit-copy-hash").click());
  expect(writeText).toHaveBeenCalledWith(hash(2));
  expect(c.sent.length).toBe(sent);
});

it("right click on a row offers the commit actions; Undo only on HEAD's commit; Revert sends the shown argv", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(rowOf(hash(2)));
  expect(byId("commit-menu-head").textContent).toBe(`Commit ${hash(2).slice(0, 7)}`);
  expect(byId("commit-undo")).toBeNull();
  expect(byId("commit-cherry-pick").textContent).toBe("Cherry-Pick");
  writeReply = async () => ({ written: { output: "", refs: "s2" } });
  await act(async () => byId("commit-revert").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.revert")).toEqual([{ type: "git.revert", cwd: "/p", hash: hash(2), headRef: "refs/heads/main", headHash: hash(3), argv: ["revert", "--no-edit", hash(2)] }]);
  expect(el.querySelector("[data-testid=graph-remote-result] [role=status]")!.textContent).toContain("Reverted");
  await menuAt(rowOf(hash(3)));
  expect(byId("commit-undo")).not.toBeNull();
});

it("a disabled commit action shows the reason", async () => {
  const c = fake(withRefs());
  await mount(c);
  const base = commitMenu(hash(2));
  (c.request as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (m: Req) => (m.type === "git.commitMenu" ? { commitMenu: { ...base, revert: undefined, why: { revert: "Merge commit: revert it in a terminal" } } } : {}));
  await menuAt(rowOf(hash(2)));
  expect(byId("commit-revert").hasAttribute("data-disabled")).toBe(true);
  expect(byId("commit-revert").textContent).toContain("Merge commit: revert it in a terminal");
});

it("Reset Current Branch to Here: Hard lists the files it loses and sends mode and dirty", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(rowOf(hash(2)));
  await act(async () => byId("commit-reset").click());
  await flush();
  expect(byId("git-command").textContent).toBe(`git reset --mixed ${hash(2)}`);
  await act(async () => byId("git-reset-hard").click());
  await flush();
  expect(c.sent.some((m) => m.type === "git.commitMenu" && (m as { hard?: boolean }).hard === true)).toBe(true);
  expect(byId("git-command").textContent).toBe(`git reset --hard --no-recurse-submodules ${hash(2)}`);
  expect(byId("git-reset-lose").textContent).toContain("a.txt");
  expect(byId("git-reset-lose").textContent).toContain("+1 more");
  expect(byId("git-reset-confirm").textContent).toBe("Reset hard");
  writeReply = async () => ({ written: { output: "", refs: "s2" } });
  await act(async () => byId("git-reset-confirm").click());
  await flush();
  expect(c.sent.filter((m) => m.type === "git.reset")).toEqual([{ type: "git.reset", cwd: "/p", hash: hash(2), mode: "hard", headRef: "refs/heads/main", headHash: hash(3), argv: ["reset", "--hard", "--no-recurse-submodules", hash(2)], dirty: "fp1" }]);
});

// ---- Annotate (GH-564): focusCommit ----
it("focusCommit before the pane shows: the filter gets the hash, git.log asks for it, the commit is selected; a nested repository's pane reads at GitRepo.path", async () => {
  const c = fake(history(10));
  // The Files tab sets the selector, then asks; the pane mounts hidden and has not read yet.
  setRepoChoice("/p", lib.rel);
  focusCommit(lib.path, hash(5));
  await mountPane(c, [own, lib], true);
  expect(c.sent.filter((m) => m.type === "git.log")).toEqual([]);
  await act(async () => root.render(<GraphPane client={c} cwd="/p" hidden={false} repos={{ list: [own, lib], projectKey: "/p" }} />));
  await act(async () => void (await new Promise((r) => setTimeout(r, 450))));
  await flush();
  expect(c.sent.filter((m) => m.type === "git.log").at(-1)).toMatchObject({ cwd: lib.path, text: hash(5), exact: true });
  expect((el.querySelector("[data-testid=graph-filter-text]") as HTMLInputElement).value).toBe(hash(5));
  expect(el.querySelector("[data-testid=commit-list]")!.getAttribute("aria-activedescendant")).toBe(`commit-${hash(5)}`);
  // Taken once: a remount does not apply it again.
  await act(async () => root.render(null));
  await mountPane(c, [own, lib]);
  expect((el.querySelector("[data-testid=graph-filter-text]") as HTMLInputElement).value).toBe("");
});

// ---- Branch popup ----
const openPopup = async () => {
  await act(async () => el.querySelector<HTMLElement>("[data-testid=graph-filter-branch]")!.click());
  await flush();
  await new Promise((r) => setTimeout(r, 50));
};
const search = () => document.querySelector<HTMLInputElement>("[data-testid=branch-popup-search]")!;
const typeQuery = async (v: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search(), v);
    search().dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const press = (k: string) => act(async () => void search().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
const popupRows = () => [...document.querySelectorAll<HTMLElement>("[data-testid=branch-popup-row]")].map((r) => r.textContent);

it("the commit menu has commit actions only, in order: Copy Revision Number, Cherry-Pick, Reset (red), Revert, Undo, New Branch…", async () => {
  const c = fake(withRefs());
  await mount(c);
  await menuAt(rowEls()[0]!);
  await flush();
  expect(items().map((i) => i.textContent)).toEqual(["Copy Revision Number", "Cherry-Pick", "Reset Current Branch to Here…", "Revert Commit", "Undo Commit", "New Branch…"]);
  expect(byId("commit-reset").className).toContain("text-destructive");
  expect(document.querySelector("[data-testid=branch-fetch]")).toBeNull();
});

it("the branch popup focuses its search box, groups All branches, HEAD, Local, and keeps Remote collapsed", async () => {
  await mount(fake(history(3)));
  await openPopup();
  expect(document.activeElement).toBe(search());
  expect(popupRows()).toEqual(["All branches", "HEAD (main)", "main", "Remote"]);
  expect(byId("branch-popup-current")).not.toBeNull();
  await act(async () => document.querySelector<HTMLElement>("[aria-expanded=false][role=button]")!.click());
  expect(popupRows()).toEqual(["All branches", "HEAD (main)", "main", "Remote", "origin/main"]);
});

it("typing filters by substring (a search expands Remote) and highlights the match; Enter filters the graph", async () => {
  const c = fake(history(3));
  await mount(c);
  await openPopup();
  await typeQuery("RIG");
  expect(popupRows()).toEqual(["origin/main"]);
  expect(byId("branch-popup-match").textContent).toBe("rig");
  await press("Enter");
  await flush();
  expect(c.sent.filter((m) => m.type === "git.log").at(-1)).toMatchObject({ ref: "refs/remotes/origin/main", skip: 0 });
  expect(document.querySelector("[data-testid=branch-popup]")).toBeNull();
});

it("ArrowDown and Enter pick a row; Esc clears the query first, a second Esc closes the popup", async () => {
  const c = fake(history(3));
  await mount(c);
  await openPopup();
  await typeQuery("ma");
  await press("Escape");
  expect(search().value).toBe("");
  expect(byId("branch-popup")).not.toBeNull();
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await flush();
  await new Promise((r) => setTimeout(r, 300));
  expect(document.querySelector("[data-testid=branch-popup]")).toBeNull();
});

it("ArrowRight opens the branch's actions (no Checkout, Merge or Rebase on the current branch), ArrowLeft closes them", async () => {
  const c = fake(withRefs());
  await mount(c);
  await openPopup();
  await press("ArrowDown");
  await press("ArrowDown");
  await press("ArrowRight");
  await flush();
  expect(c.sent.filter((m) => m.type === "git.branch")).toEqual([{ type: "git.branch", cwd: "/p", ref: "refs/heads/main" }]);
  expect([...byId("branch-popup-sub").querySelectorAll("[role=menuitem]")].map((i) => i.textContent)).toEqual(["Push", "Force push…", "Pull", "New branch from main…"]);
  await act(async () => void byId("branch-popup-sub").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true })));
  expect(document.querySelector("[data-testid=branch-popup-sub]")).toBeNull();
  expect(document.activeElement).toBe(search());
});

it("the › button of a row opens the same actions; Push there opens its dialog", async () => {
  const c = fake(withRefs());
  await mount(c);
  await openPopup();
  await act(async () => document.querySelector<HTMLElement>("[data-testid=branch-popup-more]")!.click());
  await flush();
  await act(async () => byId("branch-push").click());
  expect(byId("git-push-dialog")).not.toBeNull();
  expect(document.querySelector("[data-testid=branch-popup]")).toBeNull();
  await act(async () => byId("git-push-cancel").click());
  await flush();
});

it("mouse hover on a branch row opens its actions without taking focus from the search box; hover on All branches closes them", async () => {
  await mount(fake(withRefs()));
  await openPopup();
  const hover = async (el: Element, pointerType = "mouse") => {
    const e = new MouseEvent("pointerover", { bubbles: true });
    Object.defineProperty(e, "pointerType", { value: pointerType });
    await act(async () => void el.dispatchEvent(e));
    await flush();
  };
  const row = document.querySelector("[data-testid=branch-popup-row][data-ref='refs/heads/main']")!;
  await hover(row, "touch");
  expect(document.querySelector("[data-testid=branch-popup-sub]")).toBeNull();
  await hover(row);
  expect(byId("branch-popup-sub")).not.toBeNull();
  expect(document.activeElement).toBe(search());
  await hover(document.querySelector("[data-testid=branch-popup-row]")!);
  expect(document.querySelector("[data-testid=branch-popup-sub]")).toBeNull();
});

it("an outside press closes the popup at once, with a query typed or the actions open", async () => {
  await mount(fake(withRefs()));
  const outside = async () => {
    await act(async () => {
      for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) document.body.dispatchEvent(new MouseEvent(t, { bubbles: true }));
    });
    await flush();
    await new Promise((r) => setTimeout(r, 300));
  };
  await openPopup();
  await typeQuery("ma");
  await outside();
  expect(document.querySelector("[data-testid=branch-popup]")).toBeNull();
  await openPopup();
  expect(search().value).toBe("");
  await act(async () => document.querySelector<HTMLElement>("[data-testid=branch-popup-more]")!.click());
  await flush();
  await outside();
  expect(document.querySelector("[data-testid=branch-popup]")).toBeNull();
});

it("Esc with the actions open closes only them; a printable key on an action goes to the search box", async () => {
  await mount(fake(withRefs()));
  await openPopup();
  await act(async () => document.querySelector<HTMLElement>("[data-testid=branch-popup-more]")!.click());
  await flush();
  const item = byId("branch-push");
  await act(async () => void item.focus());
  await act(async () => void item.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(search());
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await flush();
  expect(document.querySelector("[data-testid=branch-popup-sub]")).toBeNull();
  expect(byId("branch-popup")).not.toBeNull();
});
