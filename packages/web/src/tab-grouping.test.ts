// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { Worktree } from "@claude-ui/protocol";
import { loadTabCompact, loadTabGrouping, saveTabCompact, saveTabGrouping, tabGroup } from "./tab-grouping.ts";

const wt: Record<string, Worktree[]> = {
  "/r/acme": [
    { path: "/r/acme", branch: "master", main: true },
    { path: "/r/acme/.claude/worktrees/a", branch: "ACME-397-registry-adapt", main: false },
    { path: "/r/acme/.claude/worktrees/b", branch: "ACME-400", main: false },
  ],
};
const A = "/r/acme/.claude/worktrees/a";
const B = "/r/acme/.claude/worktrees/b";

beforeEach(() => localStorage.clear());

it("by project: a linked worktree session joins its project's group, labelled and colored by the project", () => {
  const g = { key: "/r/acme", label: "acme", color: "/r/acme" };
  expect(tabGroup(A, "project", wt)).toEqual(g);
  expect(tabGroup("/r/acme", "project", wt)).toEqual(g);
  expect(tabGroup("/p/web", "project", wt).key).toBe("/p/web");
  expect(tabGroup("/p/web/", "project", wt).key).toBe("/p/web");
});

it("by worktree: two worktrees of one project get distinct keys, the folder name as label and 'project · branch' as detail, both in the project color", () => {
  const a = tabGroup(A, "worktree", wt);
  const b = tabGroup(B, "worktree", wt);
  expect([a.key, b.key]).toEqual([A, B]);
  expect([a.sub, b.sub]).toEqual(["acme · ACME-397-registry-adapt", "acme · ACME-400"]);
  expect([a.label, b.label]).toEqual(["a", "b"]);
  expect([a.color, b.color]).toEqual(["/r/acme", "/r/acme"]);
});

it("by worktree: the main checkout shows its branch; a cwd in no worktree list shows its folder name", () => {
  expect(tabGroup("/r/acme", "worktree", wt).sub).toBe("acme · master");
  expect(tabGroup("/p/web", "worktree", wt)).toEqual({ key: "/p/web", label: "web", sub: undefined, color: "/p/web" });
});

it("none and unknown cwd give the empty key", () => {
  expect(tabGroup(A, "none", wt).key).toBe("");
  for (const m of ["project", "worktree", "none"] as const) expect(tabGroup(undefined, m, wt).key).toBe("");
});

it("the setting defaults to by project, survives a reload, and garbage falls back", () => {
  expect(loadTabGrouping()).toBe("project");
  saveTabGrouping("worktree");
  expect(loadTabGrouping()).toBe("worktree");
  saveTabGrouping("none");
  expect(loadTabGrouping()).toBe("none");
  saveTabGrouping("project");
  expect(localStorage.getItem("claude-ui.tabGrouping")).toBeNull();
  localStorage.setItem("claude-ui.tabGrouping", "bogus");
  expect(loadTabGrouping()).toBe("project");
});

it("compact tabs: off by default, kept per browser, and storage failures do not throw", () => {
  expect(loadTabCompact()).toBe(false);
  saveTabCompact(true);
  expect(localStorage.getItem("claude-ui.tabCompact")).toBe("1");
  expect(loadTabCompact()).toBe(true);
  saveTabCompact(false);
  expect(localStorage.getItem("claude-ui.tabCompact")).toBeNull();
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(loadTabCompact()).toBe(false);
  expect(() => saveTabCompact(true)).not.toThrow();
  get.mockRestore();
  set.mockRestore();
});
