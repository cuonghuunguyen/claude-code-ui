import { describe, expect, it } from "vitest";
import type { SessionListItem, SessionState } from "@claude-ui/protocol";
import type { SessionGroup, WorktreeRow } from "./sessions.ts";
import { confirmNames, groupEntries, groupSessions, idleTargets, tidy, workerCounts, workerEntries, type MenuEntry } from "./sidebar-menus.ts";

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;
const s = (id: string, o: Partial<SessionListItem> = {}): SessionListItem => ({ id, cwd: "/p", title: id, state: "idle", model: "m", permissionMode: "default", effort: "default", permissionModes: [], lastActivity: NOW - 40 * DAY, archived: false, transcript: true, ...o });
const st = (x: SessionListItem): SessionState => x.state;

describe("workerCounts", () => {
  it("idle and error with a CLI are finished; idle without one is closed; error without one and busy workers are neither", () => {
    const ws = [s("a"), s("b", { state: "error" }), s("c", { state: "closed", live: false }), s("d", { state: "error", live: false }), s("e", { state: "running" }), s("f", { state: "needs_input" })];
    expect(workerCounts(ws, st)).toEqual({ finished: ["a", "b"], closed: ["c"] });
  });
});

describe("idleTargets", () => {
  const o = { days: 7, now: NOW, state: st };
  it("keeps sessions younger than the limit, includes older ones", () => {
    const a = s("a", { lastActivity: NOW - 7 * DAY });
    const b = s("b", { lastActivity: NOW - 7 * DAY - 1 });
    expect(idleTargets([a, b], new Map(), o)).toEqual(["b"]);
  });
  it("skips the open, running, waiting, archived and untranscribed sessions", () => {
    const list = [s("act"), s("run", { state: "running" }), s("need", { state: "needs_input" }), s("arc", { archived: true }), s("none", { transcript: false }), s("ok")];
    expect(idleTargets(list, new Map(), { ...o, activeId: "act" })).toEqual(["ok"]);
  });
  it("takes a coordinator with all its workers, or none of them", () => {
    const c1 = s("c1");
    const c2 = s("c2");
    const w = new Map([
      ["c1", [s("w1", { coordinatorId: "c1" }), s("w2", { coordinatorId: "c1" })]],
      ["c2", [s("w3", { coordinatorId: "c2", state: "running" })]],
    ]);
    expect(idleTargets([c1, c2], w, o)).toEqual(["c1", "w1", "w2"]);
    const recent = new Map([["c1", [s("w1", { coordinatorId: "c1", lastActivity: NOW })]]]);
    expect(idleTargets([c1], recent, o)).toEqual([]);
  });
});

describe("groupSessions", () => {
  const row = (path: string, sessions: SessionListItem[]): WorktreeRow => ({ path, branch: path, main: false, sessions }) as WorktreeRow;
  const group: SessionGroup = { cwd: "/p", members: ["/p"], sessions: [s("a")], worktrees: [row("/p/w1", [s("b")]), row("/p/w2", [s("c")])] };
  it("a project holds its worktree rows' sessions, a row only its own", () => {
    expect(groupSessions(group).map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(groupSessions(group.worktrees[1]!).map((x) => x.id)).toEqual(["c"]);
  });
});

describe("groupEntries", () => {
  const base = { prefix: "g-", archivedView: false, onlyActive: false, setOnlyActive: () => {}, archiveCount: (d: number) => (d === 1 ? 0 : d), onArchive: () => {} };
  const ids = (e: MenuEntry[]) => e.map((x) => (x.kind === "sep" ? "-" : x.kind === "label" ? "label" : x.id));
  it("project: new, worktree, hide, archive, remove", () => {
    const e = groupEntries({ ...base, newSession: () => {}, newWorktree: () => {}, tail: { id: "g-remove", label: "Remove from list (files stay)", onSelect: () => {} } });
    expect(ids(e)).toEqual(["g-new-session", "g-new-worktree", "g-new-worktree-named", "-", "g-hide-inactive", "label", "g-archive-1", "g-archive-7", "g-archive-30", "-", "g-remove"]);
    expect(e.find((x) => x.kind === "item" && x.id === "g-archive-1")).toMatchObject({ disabled: true, label: "1 day (0)…" });
    expect(e.find((x) => x.kind === "item" && x.id === "g-archive-7")).toMatchObject({ disabled: false, label: "7 days (7)…" });
  });
  it("groupEntries adds Clean up… before the tail when cleanUp is given", () => {
    const e = groupEntries({ ...base, newSession: () => {}, cleanUp: () => {}, tail: { id: "g-remove", label: "x", onSelect: () => {} } });
    expect(ids(e).slice(-4)).toEqual(["-", "g-cleanup", "-", "g-remove"]);
    expect(e.find((x) => x.kind === "item" && x.id === "g-cleanup")).toMatchObject({ label: "Clean up…" });
    expect(ids(groupEntries(base)).includes("g-cleanup")).toBe(false);
  });
  it("workerEntries adds Clean up workers…", () => {
    const c = { finished: [], closed: [] };
    expect(workerEntries("w-", c, { close: () => {}, remove: () => {} }).map((x) => (x as { id: string }).id)).toEqual(["w-close-finished", "w-remove-closed"]);
    expect(workerEntries("w-", c, { close: () => {}, remove: () => {}, cleanUp: () => {} }).at(-1)).toMatchObject({ id: "w-cleanup", label: "Clean up workers…" });
  });
  it("archived view drops hide and archive; no stray separators", () => {
    const e = groupEntries({ ...base, archivedView: true, newSession: () => {}, tail: { id: "g-remove", label: "x", onSelect: () => {} } });
    expect(ids(e)).toEqual(["g-new-session", "-", "g-remove"]);
    expect(ids(groupEntries({ ...base, archivedView: true }))).toEqual([]);
  });
  it("outside the roots: no new session, starts at Hide", () => {
    expect(ids(groupEntries(base))[0]).toBe("g-hide-inactive");
  });
});

describe("helpers", () => {
  it("tidy removes leading, trailing and doubled separators", () => {
    const sep: MenuEntry = { kind: "sep" };
    const i = (id: string): MenuEntry => ({ kind: "item", id, label: id, onSelect: () => {} });
    expect(tidy([sep, i("a"), sep, sep, i("b"), sep]).map((x) => (x.kind === "sep" ? "-" : (x as { id: string }).id))).toEqual(["a", "-", "b"]);
  });
  it("confirmNames cuts after ten", () => {
    expect(confirmNames(["a", "b"])).toBe("a, b");
    expect(confirmNames(Array.from({ length: 12 }, (_, i) => `n${i}`))).toBe("n0, n1, n2, n3, n4, n5, n6, n7, n8, n9, +2 more");
  });
});
