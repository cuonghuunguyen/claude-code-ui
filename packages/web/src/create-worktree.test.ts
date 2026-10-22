// @vitest-environment jsdom
import type { BranchRow } from "@claude-ui/protocol";
import { afterEach, expect, it } from "vitest";
import { baseOptions, branchKind, branchWithKey, checkoutRef, filterBranches, loadSource, saveSource } from "./create-worktree.ts";

const rows: BranchRow[] = [
  { name: "main", local: true, remote: "refs/remotes/origin/main", worktree: "/r" },
  { name: "feature/PRJ-12-login", local: false, remote: "refs/remotes/origin/feature/PRJ-12-login" },
  { name: "local-only", local: true },
  { name: "bugfix/prj-120-x", local: true },
];

afterEach(() => localStorage.clear());

it("branchKind: Local, Remote or both", () => {
  expect(rows.map(branchKind)).toEqual(["Local · Remote", "Remote", "Local", "Local"]);
});

it("checkoutRef: the local ref when there is one, else the remote ref", () => {
  expect(rows.map(checkoutRef)).toEqual(["refs/heads/main", "refs/remotes/origin/feature/PRJ-12-login", "refs/heads/local-only", "refs/heads/bugfix/prj-120-x"]);
});

it("filterBranches: case-insensitive, every word", () => {
  expect(filterBranches(rows, "").length).toBe(4);
  expect(filterBranches(rows, "LOGIN").map((r) => r.name)).toEqual(["feature/PRJ-12-login"]);
  expect(filterBranches(rows, "prj 12").map((r) => r.name)).toEqual(["feature/PRJ-12-login", "bugfix/prj-120-x"]);
});

it("baseOptions: local branches, then remote branches by short name", () => {
  expect(baseOptions(rows)).toEqual([
    { value: "refs/heads/main", label: "main" },
    { value: "refs/heads/local-only", label: "local-only" },
    { value: "refs/heads/bugfix/prj-120-x", label: "bugfix/prj-120-x" },
    { value: "refs/remotes/origin/main", label: "origin/main" },
    { value: "refs/remotes/origin/feature/PRJ-12-login", label: "origin/feature/PRJ-12-login" },
  ]);
});

it("branchWithKey: a branch whose name holds the key as a whole, any case", () => {
  expect(branchWithKey(rows, "PRJ-12")?.name).toBe("feature/PRJ-12-login");
  expect(branchWithKey(rows, "PRJ-120")?.name).toBe("bugfix/prj-120-x");
  expect(branchWithKey(rows, "PRJ-1")).toBeUndefined();
});

it("loadSource / saveSource: per browser, unknown falls back to the default", () => {
  expect(loadSource(true)).toBe("ticket");
  expect(loadSource(false)).toBe("name");
  saveSource("branch");
  expect(loadSource(true)).toBe("branch");
  localStorage.setItem("claude-ui.worktreeSource", "nope");
  expect(loadSource(false)).toBe("name");
});
