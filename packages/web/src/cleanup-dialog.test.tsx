// @vitest-environment jsdom
import type { SessionListItem, Worktree, WorktreeStatusResult } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CleanupDialog } from "./cleanup-dialog.tsx";
import type { CleanupScope } from "./cleanup.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const NOW = Date.now();
const item = (id: string, cwd: string, o: Partial<SessionListItem> = {}): SessionListItem => ({ id, cwd, title: id, lastActivity: NOW, archived: false, transcript: true, state: "idle", ...o }) as SessionListItem;
const st = (o: Partial<WorktreeStatusResult> = {}): WorktreeStatusResult => ({ checkedAt: 0, uncommitted: 0, untracked: 0, commits: 0, ahead: 0, ignored: 0, branch: "b", branchMerged: false, running: 0, safety: "safe", ...o });
const M = "/r";
const P = (n: string) => `/r/.claude/worktrees/${n}`;
const worktrees: Record<string, Worktree[]> = {
  [M]: [
    { path: M, branch: "main", main: true },
    { path: P("safe"), branch: "worktree-safe", main: false },
    { path: P("work"), branch: "worktree-work", main: false },
    { path: P("busy"), branch: "worktree-busy", main: false },
    { path: "/x/ext", branch: "feat", main: false },
  ],
};
const STATUS: Record<string, WorktreeStatusResult> = {
  [P("safe")]: st(),
  [P("work")]: st({ safety: "has_work", uncommitted: 2, ahead: 1 }),
  [P("busy")]: st({ safety: "blocked", blocked: "sessions_running", running: 1 }),
  "/x/ext": st({ branchMerged: true, ignored: 3 }),
};
const list = [
  item("co", M, { coordinator: true }),
  item("w-closed", M, { coordinatorId: "co", workerName: "closed-one", state: "closed", live: false }),
  item("w-idle", M, { coordinatorId: "co", workerName: "idle-one", state: "idle" }),
  item("w-wt", P("safe"), { coordinatorId: "co", workerName: "in-wt", state: "closed", live: false }),
];

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
});

async function open(o: { scope?: CleanupScope; status?: (path: string) => Promise<WorktreeStatusResult>; remove?: (m: { type: string; path?: string; sessionId?: string }) => Promise<object>; cached?: Record<string, WorktreeStatusResult>; list?: SessionListItem[] } = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  const sent: Record<string, unknown>[] = [];
  const request = vi.fn(async (m: Record<string, unknown>) => {
    sent.push(m);
    if (m.type === "worktree.cached") return { statuses: o.cached ?? {} };
    if (m.type === "worktree.status") return (o.status ?? (async (p: string) => STATUS[p]!))(m.path as string);
    return (o.remove ?? (async () => ({})))(m as never);
  });
  const onClose = vi.fn();
  const onDone = vi.fn();
  const onRemoving = vi.fn();
  await act(async () => root!.render(<CleanupDialog scope={o.scope ?? { kind: "all" }} list={o.list ?? list} worktrees={worktrees} state={(s) => s.state} request={request as never} onClose={onClose} onDone={onDone} onRemoving={onRemoving} />));
  await act(async () => {});
  return { request, sent, onClose, onDone, onRemoving, rerender: (scope?: CleanupScope) => act(async () => root!.render(<CleanupDialog scope={scope} list={o.list ?? list} worktrees={worktrees} state={(s) => s.state} request={request as never} onClose={onClose} onDone={onDone} onRemoving={onRemoving} />)) };
}
const q = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const row = (key: string) => q(`[data-key="${key}"]`);
const check = (key: string) => row(key).querySelector<HTMLInputElement>('[data-testid="cleanup-check"]')!;
const click = (e: HTMLElement) => act(async () => e.click());
const fetchLines = () => qa('[data-testid="cleanup-fetch"]').map((e) => e.textContent);
const confirm = () => q<HTMLButtonElement>('[data-testid="cleanup-confirm"]');

it("lists worktrees with External tag and safety badges once statuses arrive; every status is requested at once (the daemon queues them)", async () => {
  let inFlight = 0;
  let max = 0;
  const release: (() => void)[] = [];
  const more: Record<string, Worktree[]> = { [M]: [...worktrees[M]!, ...Array.from({ length: 6 }, (_, i) => ({ path: P(`x${i}`), branch: `worktree-x${i}`, main: false }))] };
  Object.assign(worktrees, more);
  try {
    await open({
      status: (p) => {
        inFlight++;
        max = Math.max(max, inFlight);
        return new Promise((r) => release.push(() => (inFlight--, r(STATUS[p] ?? st()))));
      },
    });
    expect(qa('[data-testid="cleanup-badge"]').filter((b) => b.textContent === "Checking…").length).toBe(10);
    expect(max).toBe(10);
    for (let i = 0; i < 20; i++) await act(async () => release.splice(0).forEach((f) => f()));
  } finally {
    worktrees[M] = more[M]!.slice(0, 5);
  }
  const text = (key: string) => row(key).textContent;
  expect(text(`wt:${P("safe")}`)).toContain("Safe");
  expect(text(`wt:${P("work")}`)).toContain("Has work: 2 files, 1 commit");
  expect(text(`wt:${P("busy")}`)).toContain("Blocked: A session there is running or needs input");
  expect(text("wt:/x/ext")).toContain("External");
  expect(text(`wt:${P("safe")}`)).not.toContain("External");
});

it("a Blocked row's checkbox is disabled and described by its reason", async () => {
  await open();
  const c = check(`wt:${P("busy")}`);
  expect(c.disabled).toBe(true);
  const reason = document.getElementById(c.getAttribute("aria-describedby")!)!;
  expect(reason.textContent).toContain("Blocked: A session there is running or needs input");
});

it("pre-selects Safe managed worktrees and closed workers; button reads 'Remove 2'", async () => {
  await open({ list: list.filter((s) => s.id !== "w-wt") });
  const on = qa('[data-testid="cleanup-row"]').filter((r) => r.querySelector<HTMLInputElement>('[data-testid="cleanup-check"]')!.checked).map((r) => r.dataset.key);
  expect(on).toEqual([`wt:${P("safe")}`, "wk:w-closed"]);
  expect(confirm().textContent).toBe("Remove 2");
  expect(q("[data-testid=cleanup-ack]")).toBeNull();
});

it("ticking a Has work row reads 'Remove 3 (1 with unsaved work)' and stays disabled until the acknowledge box is ticked", async () => {
  await open({ list: list.filter((s) => s.id !== "w-wt") });
  await click(check(`wt:${P("work")}`));
  expect(confirm().textContent).toBe("Remove 3 (1 with unsaved work)");
  expect(confirm().disabled).toBe(true);
  expect(q("[data-testid=cleanup-ack]").closest("label")!.textContent).toBe("Discard uncommitted files and unpushed commits in 1 worktree");
  await click(q("[data-testid=cleanup-ack]"));
  expect(confirm().disabled).toBe(false);
  await click(check(`wt:${P("work")}`));
  expect(confirm().textContent).toBe("Remove 2");
  expect(confirm().disabled).toBe(false);
});

it("Also delete branch shows only for a merged kept branch and sends deleteBranch", async () => {
  const { sent } = await open({ list: [] });
  expect(q("[data-testid=cleanup-delete-branch]")).toBeNull();
  await click(check("wt:/x/ext"));
  const box = q<HTMLInputElement>("[data-testid=cleanup-delete-branch]");
  expect(box.closest("label")!.textContent).toBe("Also delete branch feat");
  await click(box);
  await click(confirm());
  await act(async () => {});
  expect(sent.filter((m) => m.type === "worktree.remove")).toEqual([
    { type: "worktree.remove", cwd: M, path: P("safe"), expectSafe: true, expect: { uncommitted: 0, ahead: 0, ignored: 0 }, deleteBranch: false },
    { type: "worktree.remove", cwd: M, path: "/x/ext", expectSafe: true, expect: { uncommitted: 0, ahead: 0, ignored: 3 }, deleteBranch: true },
  ]);
});

it("Also remove its worktree on a worker ticks the worktree row", async () => {
  await open({ scope: { kind: "coordinator", id: "co", title: "Boss" } });
  // The worker's worktree is Safe, managed: already ticked; untick through the worker's box.
  const also = () => row("wk:w-wt").querySelector<HTMLInputElement>('[data-testid="cleanup-also-worktree"]')!;
  expect(also().checked).toBe(true);
  await click(also());
  expect(check(`wt:${P("safe")}`).checked).toBe(false);
  await click(also());
  expect(check(`wt:${P("safe")}`).checked).toBe(true);
});

it("Only safe and Older than hide rows and the count follows", async () => {
  const old = list.map((s) => (s.id === "w-closed" ? { ...s, lastActivity: NOW - 10 * 86_400_000 } : s));
  await open({ list: old });
  expect(confirm().textContent).toBe("Remove 3");
  await click(q("[data-testid=cleanup-only-safe]"));
  expect(qa('[data-testid="cleanup-row"]').map((r) => r.dataset.key)).not.toContain(`wt:${P("work")}`);
  expect(qa('[data-testid="cleanup-row"]').map((r) => r.dataset.key)).not.toContain(`wt:${P("busy")}`);
  await click(q("[data-testid=cleanup-only-safe]"));
  const sel = q<HTMLSelectElement>("[data-testid=cleanup-older]");
  await act(async () => {
    sel.value = "7";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // Only the closed worker is older than 7 days (worktrees have headTime unknown here, which counts as old).
  expect(qa('[data-testid="cleanup-row"]').map((r) => r.dataset.key)).toContain("wk:w-closed");
  expect(qa('[data-testid="cleanup-row"]').map((r) => r.dataset.key)).not.toContain("wk:w-idle");
});

it("run sends one request at a time, then shows 'Removed 2, skipped 1' with the skipped reason; Close gets focus; onDone called", async () => {
  let active = 0;
  let max = 0;
  const { onDone, onClose, sent } = await open({
    list: list.filter((s) => s.id === "w-closed" || s.id === "co"),
    remove: async (m) => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      if (m.type === "worktree.remove" && m.path === P("safe")) throw new Error("Changed since it was checked: 1 files, 0 commits");
      return {};
    },
  });
  // Safe worktree + closed worker + external ticked = 3 requests, one refused.
  await click(check("wt:/x/ext"));
  await click(confirm());
  await act(async () => new Promise((r) => setTimeout(r, 60)));
  expect(max).toBe(1);
  expect(sent.filter((m) => !["worktree.status", "worktree.cached", "git.fetch", "worktree.cancel"].includes(m.type as string)).map((m) => m.type)).toEqual(["worker.remove", "worktree.remove", "worktree.remove"]);
  expect(q("[data-testid=cleanup-summary]").textContent).toContain("Removed 2, skipped 1");
  expect(q("[data-testid=cleanup-summary]").textContent).toContain("Changed since it was checked");
  expect(document.activeElement).toBe(q("[data-testid=cleanup-close]"));
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ removed: expect.any(Array), skipped: expect.any(Array) }));
  await click(q("[data-testid=cleanup-close]"));
  expect(onClose).toHaveBeenCalled();
});

it("shows 'Nothing to clean up' for an empty scope", async () => {
  await open({ scope: { kind: "project", cwd: "/none" }, list: [] });
  expect(q("[data-testid=cleanup-dialog]").textContent).toContain("Nothing to clean up");
  expect(confirm().disabled).toBe(true);
});

const esc = () => act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

it("Esc closes the dialog like Cancel, also with focus on the select or a checkbox", async () => {
  const { onClose } = await open();
  q<HTMLElement>("[data-testid=cleanup-older]").focus();
  await esc();
  expect(onClose).toHaveBeenCalledTimes(1);
  check(`wt:${P("safe")}`).focus();
  await esc();
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("the dialog closes during a run, the run continues, onRemoving marks each worktree and onDone gets the result", async () => {
  const release: (() => void)[] = [];
  const { onClose, onDone, onRemoving, rerender, sent } = await open({
    list: [],
    remove: (m) => (m.type === "worktree.remove" ? new Promise((r) => release.push(() => r({}))) : Promise.resolve({})),
  });
  await click(confirm());
  // Cancel reads Close and stays enabled; Esc closes too.
  const cancel = q<HTMLButtonElement>("[data-testid=cleanup-cancel]");
  expect(cancel.textContent).toBe("Close");
  expect(cancel.disabled).toBe(false);
  expect(onRemoving.mock.calls).toEqual([[P("safe"), true]]);
  await esc();
  expect(onClose).toHaveBeenCalledTimes(1);
  // The app closes it: the run goes on.
  await rerender(undefined);
  expect(onDone).not.toHaveBeenCalled();
  await act(async () => release.shift()!());
  await act(async () => {});
  expect(sent.filter((m) => m.type === "worktree.remove").map((m) => m.path)).toEqual([P("safe")]);
  expect(onRemoving.mock.calls.slice(0, 2)).toEqual([[P("safe"), true], [P("safe"), false]]);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(onDone).toHaveBeenCalledWith({ removed: ["worktree-safe"], skipped: [], notes: [] });
});

it("a Safe row with ignored files says how many ignored files will be deleted", async () => {
  await open();
  expect(row("wt:/x/ext").textContent).toContain("3 ignored files will be deleted");
  expect(row(`wt:${P("safe")}`).textContent).not.toContain("ignored");
});

it("'Also remove its worktree' ticked while a filter hides that worktree: not removed, the summary says so", async () => {
  const w = { ...list.find((s) => s.id === "w-wt")!, lastActivity: NOW - 40 * 86_400_000 };
  // The worktree row has a fresh session (activity now), so Older than hides it; the worker is old.
  const fresh = item("p", P("safe"), { lastActivity: NOW });
  const { sent } = await open({ scope: { kind: "coordinator", id: "co", title: "Boss" }, list: [list[0]!, w, fresh] });
  const sel = q<HTMLSelectElement>("[data-testid=cleanup-older]");
  await act(async () => {
    sel.value = "7";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(row(`wt:${P("safe")}`) ?? null).toBeNull();
  const also = row("wk:w-wt").querySelector<HTMLInputElement>('[data-testid="cleanup-also-worktree"]')!;
  expect(also.disabled).toBe(true);
  expect(also.checked).toBe(false);
  expect(also.closest("label")!.textContent).toContain("(hidden by the filter)");
  await click(confirm());
  await act(async () => {});
  expect(sent.filter((m) => m.type === "worktree.remove")).toEqual([]);
  expect(sent.filter((m) => m.type === "worker.remove")).toHaveLength(1);
  expect(q("[data-testid=cleanup-summary]").textContent).toContain("hidden by the filter");
});

it("fetches each repository first, shows the fetch line, then requests statuses with one scan id", async () => {
  const gates: Record<string, () => void> = {};
  const { sent } = await open({
    scope: { kind: "all" },
    list: [],
    remove: (m) => (m.type === ("git.fetch" as string) ? new Promise((r) => (gates[(m as { cwd?: string }).cwd!] = () => r({ remote: null }))) : Promise.resolve({})),
  });
  expect(sent.map((m) => m.type)).toEqual(["worktree.cached", "git.fetch"]);
  expect(sent[1]).toEqual({ type: "git.fetch", cwd: M, defaultRemote: true });
  expect(fetchLines()).toEqual(["Fetching…"]);
  expect(qa('[data-testid="cleanup-badge"]').every((b) => b.textContent === "Checking…")).toBe(true);
  await act(async () => gates[M]!());
  await act(async () => {});
  const statuses = sent.filter((m) => m.type === "worktree.status");
  expect(statuses.map((m) => m.path).sort()).toEqual([P("busy"), P("safe"), P("work"), "/x/ext"].sort());
  const ids = new Set(statuses.map((m) => m.scan));
  expect(ids.size).toBe(1);
  expect(typeof [...ids][0]).toBe("string");
  expect(fetchLines()).toEqual([expect.stringMatching(/^Fetched \d+ s ago$/)]);
  expect(row(`wt:${P("safe")}`).textContent).toContain("Safe");
});

it("a failed fetch shows the warning and still scans", async () => {
  const { sent } = await open({ list: [], remove: async (m) => (m.type === ("git.fetch" as string) ? Promise.reject(new Error("No remote for the default branch")) : {}) });
  expect(fetchLines()).toEqual(["Fetch failed: No remote for the default branch — results may be out of date"]);
  expect(sent.filter((m) => m.type === "worktree.status")).toHaveLength(4);
  expect(row(`wt:${P("safe")}`).textContent).toContain("Safe");
});

it("closing the dialog sends worktree.cancel with the scan id", async () => {
  const { sent } = await open({ list: [] });
  const scan = sent.find((m) => m.type === "worktree.status")!.scan;
  expect(sent.some((m) => m.type === "worktree.cancel")).toBe(false);
  await act(async () => root!.unmount());
  root = undefined;
  expect(sent.filter((m) => m.type === "worktree.cancel")).toEqual([{ type: "worktree.cancel", scan }]);
});

it("a row shows ignored files: checked at removal and remote branch deleted", async () => {
  const preview = { ...st(), ignored: undefined, upstreamGone: true as const };
  await open({ list: [], status: async (p) => (p === P("safe") ? preview : STATUS[p]!) });
  expect(row(`wt:${P("safe")}`).textContent).toContain("ignored files: checked at removal");
  expect(row(`wt:${P("safe")}`).textContent).toContain("remote branch deleted");
  expect(row(`wt:${P("safe")}`).textContent).not.toContain("ignored files will be deleted");
  // A counted result keeps today's text.
  expect(row("wt:/x/ext").textContent).toContain("3 ignored files will be deleted");
  expect(row("wt:/x/ext").textContent).not.toContain("checked at removal");
});

it("a squash-merged row says why it is Safe", async () => {
  await open({ list: [], status: async (p) => (p === P("safe") ? st({ ahead: 1, mergedInto: "origin/main" }) : STATUS[p]!) });
  expect(row(`wt:${P("safe")}`).textContent).toContain("Safe");
  expect(row(`wt:${P("safe")}`).textContent).toContain("changes already in origin/main (squash/rebase merged)");
});

it("cached rows show at once with Checking… and are not selectable until the fresh status", async () => {
  const release: (() => void)[] = [];
  const old = Date.now() - 5 * 60_000;
  const cached = { [P("safe")]: st({ checkedAt: old }), [P("work")]: st({ safety: "has_work", uncommitted: 2, ahead: 1, checkedAt: old }) };
  const { sent } = await open({ cached, status: (p) => new Promise((r) => release.push(() => r(STATUS[p] ?? st()))) });
  const safe = `wt:${P("safe")}`;
  expect(sent[0]).toEqual({ type: "worktree.cached", cwd: M, paths: expect.arrayContaining([P("safe")]) });
  expect(row(safe).textContent).toContain("Safe · Checking…");
  expect(row(safe).textContent).toContain("checked 5m");
  expect(row(`wt:${P("work")}`).textContent).toContain("Has work: 2 files, 1 commit · Checking…");
  expect(check(safe).disabled).toBe(true);
  expect(check(safe).checked).toBe(false);
  // Without a cached entry: plain Checking….
  expect(row(`wt:${P("busy")}`).textContent).toContain("Checking…");
  expect(row(`wt:${P("busy")}`).textContent).not.toContain("·  Checking");
  for (let i = 0; i < 5; i++) await act(async () => release.splice(0).forEach((f) => f()));
  expect(row(safe).textContent).not.toContain("Checking…");
  expect(check(safe).disabled).toBe(false);
  expect(check(safe).checked).toBe(true);
});
