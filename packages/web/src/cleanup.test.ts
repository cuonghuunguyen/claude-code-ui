import type { SessionListItem, SessionState, Worktree, WorktreeStatusResult } from "@claude-ui/protocol";
import { describe, expect, it } from "vitest";
import { cleanupCandidates, cleanupItems, confirmLabel, defaultSelection, filterRows, rowSafety, runCleanup, summaryText, type Row } from "./cleanup.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;
const s = (id: string, cwd: string, o: Partial<SessionListItem> = {}): SessionListItem => ({ id, cwd, title: id, lastActivity: NOW, archived: false, transcript: true, state: "idle", ...o }) as SessionListItem;
const st = (o: Partial<WorktreeStatusResult> = {}): WorktreeStatusResult => ({ checkedAt: 0, uncommitted: 0, untracked: 0, commits: 0, ahead: 0, ignored: 0, branch: "b", branchMerged: false, running: 0, safety: "safe", ...o });
const wt = (path: string, o: Partial<Row & { kind: "worktree" }> = {}): Row => ({ kind: "worktree", key: `wt:${path}`, project: "/r", path, external: false, outsideRoots: false, locked: false, sessions: 0, ...o }) as Row;
const wk = (id: string, state: SessionState, o: object = {}): Row => ({ kind: "worker", key: `wk:${id}`, id, name: id, cwd: "/r", state, lastActivity: NOW, ...o }) as Row;

const main: Worktree = { path: "/r", main: true };
const managed: Worktree = { path: "/r/.claude/worktrees/a", branch: "worktree-a", main: false };
const ext: Worktree = { path: "/x/ext", branch: "ext", main: false };
const state = (x: SessionListItem) => x.state;

describe("cleanup", () => {
  it("cleanupCandidates: all / project / coordinator scopes", () => {
    const worktrees = { "/r": [main, managed, ext], "/r/sub": [main, managed, ext], "/o": [{ path: "/o", main: true }, { path: "/o/w", main: false, locked: true } as Worktree] };
    const list = [s("c1", "/r", { coordinator: true }), s("w1", "/r/.claude/worktrees/a", { coordinatorId: "c1", workerName: "one" }), s("w2", "/o", { coordinatorId: "c2" }), s("p", "/x/ext", { lastActivity: 5 })];
    const all = cleanupCandidates({ kind: "all" }, list, worktrees, state);
    expect(all.worktrees.map((w) => w.path).sort()).toEqual(["/o/w", "/r/.claude/worktrees/a", "/x/ext"]);
    expect(all.worktrees.find((w) => w.path === "/x/ext")).toMatchObject({ external: true, sessions: 1, lastActivity: 5 });
    expect(all.worktrees.find((w) => w.path === "/o/w")).toMatchObject({ locked: true, external: true });
    expect(all.workers.map((w) => w.name)).toEqual(["one", "w2"]);
    expect(all.workers[0]!.worktree).toBe("/r/.claude/worktrees/a");
    const proj = cleanupCandidates({ kind: "project", cwd: "/r" }, list, worktrees, state);
    expect(proj.worktrees.map((w) => w.path)).toEqual(["/r/.claude/worktrees/a", "/x/ext"]);
    expect(proj.workers.map((w) => w.id)).toEqual(["w1"]);
    const co = cleanupCandidates({ kind: "coordinator", id: "c1", title: "c" }, list, worktrees, state);
    expect(co.workers.map((w) => w.id)).toEqual(["w1"]);
    expect(co.worktrees.map((w) => w.path)).toEqual(["/r/.claude/worktrees/a"]);
  });

  it("rowSafety: outside roots, locked, status blocked reasons, has_work text with singular/plural, worker running / needs input blocked", () => {
    expect(rowSafety(wt("/a", { outsideRoots: true }))).toEqual({ safety: "blocked", reason: "Outside the allowed roots" });
    expect(rowSafety(wt("/a", { locked: true }))).toEqual({ safety: "blocked", reason: "Locked (git worktree lock)" });
    expect(rowSafety(wt("/a"))).toEqual({ safety: "checking" });
    expect(rowSafety(wt("/a", { error: "boom" } as never))).toEqual({ safety: "blocked", reason: "boom" });
    expect(rowSafety(wt("/a", { status: st({ safety: "blocked", blocked: "contains_worktree" }) } as never)).reason).toBe("Contains another worktree");
    expect(rowSafety(wt("/a", { status: st({ safety: "blocked", blocked: "symlink" }) } as never))).toEqual({ safety: "blocked", reason: "The path is a symbolic link" });
    expect(rowSafety(wt("/a", { status: st({ safety: "blocked", blocked: "sessions_running" }) } as never)).reason).toBe("A session there is running or needs input");
    expect(rowSafety(wt("/a", { status: st({ safety: "has_work", uncommitted: 1, ahead: 2 }) } as never))).toEqual({ safety: "has_work", reason: "1 file, 2 commits" });
    expect(rowSafety(wt("/a", { status: st({ safety: "has_work", uncommitted: 3, ahead: 1 }) } as never)).reason).toBe("3 files, 1 commit");
    expect(rowSafety(wt("/a", { status: st({ safety: "has_work", uncommitted: 0, ahead: 2 }) } as never)).reason).toBe("2 commits, has unmerged commits");
    expect(rowSafety(wt("/a", { status: st() } as never))).toEqual({ safety: "safe" });
    expect(rowSafety(wk("a", "running"))).toEqual({ safety: "blocked", reason: "Running" });
    expect(rowSafety(wk("a", "needs_input")).reason).toBe("Needs input");
    expect(rowSafety(wk("a", "idle")).safety).toBe("safe");
  });

  it("defaultSelection: Safe managed worktrees and closed workers only; external Safe, has_work, blocked, idle and error workers unticked", () => {
    const safe = { status: st() } as never;
    const rows = [
      wt("/m", safe),
      wt("/e", { ...(safe as object), external: true } as never),
      wt("/h", { status: st({ safety: "has_work", uncommitted: 1 }) } as never),
      wt("/b", { locked: true }),
      wt("/c"),
      wk("closed", "closed"),
      wk("idle", "idle"),
      wk("err", "error"),
      wk("run", "running"),
    ];
    expect([...defaultSelection(rows)].sort()).toEqual(["wk:closed", "wt:/m"]);
  });

  it("filterRows: Older than uses max(session activity, headTime); Only safe; unknown activity counts as old", () => {
    const old = { status: st({ headTime: 1 }), lastActivity: 1 } as never;
    const fresh = { status: st({ headTime: NOW - DAY / 2 }), lastActivity: 1 } as never;
    const unknown = { status: st() } as never;
    const rows = [wt("/old", old), wt("/fresh", fresh), wt("/unknown", unknown), wt("/work", { status: st({ safety: "has_work", uncommitted: 1 }), lastActivity: 1 } as never), wk("w", "closed", { lastActivity: NOW - 2 * DAY })];
    const f = (o: Partial<Parameters<typeof filterRows>[1]>) => filterRows(rows, { olderThan: 0, onlySafe: false, ...o }, NOW).map((r) => r.key);
    expect(f({})).toHaveLength(5);
    expect(f({ olderThan: 1 })).toEqual(["wt:/old", "wt:/unknown", "wt:/work", "wk:w"]);
    expect(f({ olderThan: 7 })).toEqual(["wt:/old", "wt:/unknown", "wt:/work"]);
    expect(f({ onlySafe: true })).toEqual(["wt:/old", "wt:/fresh", "wt:/unknown", "wk:w"]);
  });

  it("confirmLabel: 'Remove 3' and 'Remove 3 (1 with unsaved work)'", () => {
    expect(confirmLabel(3, 0)).toBe("Remove 3");
    expect(confirmLabel(3, 1)).toBe("Remove 3 (1 with unsaved work)");
  });

  it("cleanupItems: a ticked worker and its ticked workers are removed bottom-up, so the parent goes too", async () => {
    const rows = [wk("mid", "closed", { coordinatorId: "root" }), wk("deep", "closed", { coordinatorId: "mid" }), wk("top", "closed", { coordinatorId: "mid" }), wk("solo", "closed")];
    const sent: { sessionId: string }[] = [];
    const items = cleanupItems(rows, new Set(rows.map((r) => r.key)), { deleteBranch: new Set() }, (async (m: { sessionId: string }) => void sent.push(m)) as never);
    for (const i of items) await i.run();
    const order = sent.map((m) => m.sessionId);
    expect(order.indexOf("mid")).toBeGreaterThan(order.indexOf("deep"));
    expect(order.indexOf("mid")).toBeGreaterThan(order.indexOf("top"));
    expect(order).toHaveLength(4);
  });

  it("cleanupItems: workers before worktrees; expectSafe only for rows Safe at listing; deleteBranch only with branchMerged", async () => {
    const rows = [
      wt("/safe", { status: st({ branchMerged: true }) } as never),
      wt("/work", { status: st({ safety: "has_work", uncommitted: 1, branchMerged: true }) } as never),
      wt("/unmerged", { status: st() } as never),
      wk("w", "closed"),
    ];
    const sent: unknown[] = [];
    const items = cleanupItems(rows, new Set(rows.map((r) => r.key)), { deleteBranch: new Set(["wt:/safe", "wt:/unmerged"]) }, (async (m: unknown) => void sent.push(m)) as never);
    for (const i of items) await i.run();
    expect(sent).toEqual([
      { type: "worker.remove", sessionId: "w" },
      { type: "worktree.remove", cwd: "/r", path: "/safe", expectSafe: true, expect: { uncommitted: 0, ahead: 0, ignored: 0 }, deleteBranch: true },
      { type: "worktree.remove", cwd: "/r", path: "/work", expectSafe: false, expect: { uncommitted: 1, ahead: 0, ignored: 0 }, deleteBranch: false },
      { type: "worktree.remove", cwd: "/r", path: "/unmerged", expectSafe: true, expect: { uncommitted: 0, ahead: 0, ignored: 0 }, deleteBranch: false },
    ]);
  });

  it("rowSafety safe with mergedInto gives the merged reason; cleanupItems omits expect.ignored when not counted; runCleanup notes ignoredDeleted", async () => {
    expect(rowSafety(wt("/m", { status: st({ ahead: 2, mergedInto: "origin/main" }) }))).toEqual({ safety: "safe", reason: "changes already in origin/main (squash/rebase merged)" });
    expect(rowSafety(wt("/n", { status: st() }))).toEqual({ safety: "safe" });
    const rows = [wt("/counted", { status: st({ ignored: 3 }) }), wt("/preview", { status: { ...st(), ignored: undefined } })];
    const sent: { path: string; expect: object }[] = [];
    const items = cleanupItems(rows, new Set(rows.map((r) => r.key)), { deleteBranch: new Set() }, (async (m: { path: string; expect: object }) => (sent.push(m), m.path === "/preview" ? { ignoredDeleted: 5 } : {})) as never);
    const r = await runCleanup(items);
    expect(sent.map((m) => m.expect)).toEqual([{ uncommitted: 0, ahead: 0, ignored: 3 }, { uncommitted: 0, ahead: 0 }]);
    expect("ignored" in sent[1]!.expect).toBe(false);
    expect(r.notes).toEqual(["preview: 5 ignored files deleted"]);
  });

  it("runCleanup: sequential, a rejection is skipped with its message, branchKept becomes a note; summaryText 'Removed 2, skipped 1'", async () => {
    const log: string[] = [];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const items = [
      { key: "1", label: "a", run: async () => (log.push("a0"), await delay(20), log.push("a1"), {}) },
      { key: "2", label: "b", run: async () => (log.push("b0"), Promise.reject(new Error("stale"))) },
      { key: "3", label: "feat", run: async () => (log.push("c0"), { branchKept: "not fully merged" }) },
    ];
    const prog: number[] = [];
    const r = await runCleanup(items, (n) => prog.push(n));
    expect(log).toEqual(["a0", "a1", "b0", "c0"]);
    expect(prog).toEqual([1, 2, 3]);
    expect(r.skipped).toEqual([{ label: "b", reason: "stale" }]);
    expect(r.notes).toEqual(["Branch feat kept: not fully merged"]);
    expect(summaryText(r)).toBe("Removed 2, skipped 1");
  });
});
