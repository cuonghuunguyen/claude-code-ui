// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { groupByCwd, loadCollapsed, saveCollapsed, timeAgo } from "./sessions.ts";

const item = (id: string, cwd: string, lastActivity: number, title = id): SessionListItem => ({ id, cwd, state: "idle", model: "default", permissionMode: "default", effort: "default", permissionModes: [], title, lastActivity });

describe("groupByCwd", () => {
  it("groups sessions by working directory, most recent group first, keeping order inside a group", () => {
    const groups = groupByCwd([item("a", "/p/x", 30), item("b", "/p/y", 20), item("c", "/p/x", 10)]);
    expect(groups.map((g) => [g.cwd, g.sessions.map((s) => s.id)])).toEqual([
      ["/p/x", ["a", "c"]],
      ["/p/y", ["b"]],
    ]);
  });

  it("makes exactly one group per working directory whatever the input order, sessions newest first", () => {
    const groups = groupByCwd([item("a", "/p/x", 10), item("b", "/p/y", 40), item("c", "/p/x/", 30), item("d", "/p/y", 5), item("e", "/p/x", 20)]);
    expect(groups.map((g) => [g.cwd, g.sessions.map((s) => s.id)])).toEqual([
      ["/p/y", ["b", "d"]],
      ["/p/x", ["c", "e", "a"]],
    ]);
  });

  it("filters by session title or project name, case-insensitive", () => {
    const list = [item("a", "/p/web", 3, "Fix login"), item("b", "/p/api", 2, "Docs"), item("c", "/p/api", 1, "Add LOGIN test")];
    const ids = (q: string) => groupByCwd(list, q).map((g) => [g.cwd, g.sessions.map((s) => s.id)]);
    expect(ids("login")).toEqual([
      ["/p/web", ["a"]],
      ["/p/api", ["c"]],
    ]);
    expect(ids(" API ")).toEqual([["/p/api", ["b", "c"]]]);
    expect(ids("p/")).toEqual([]);
    expect(ids("")).toHaveLength(2);
  });
});

describe("collapsed groups", () => {
  afterEach(() => localStorage.clear());
  it("persist across reloads", () => {
    expect(loadCollapsed()).toEqual(new Set());
    saveCollapsed(new Set(["/p/x"]));
    expect(loadCollapsed()).toEqual(new Set(["/p/x"]));
    localStorage.setItem("claude-ui.collapsed", "{bad");
    expect(loadCollapsed()).toEqual(new Set());
  });
});

describe("timeAgo", () => {
  const now = 1_000_000_000;
  it("formats last activity relative to now", () => {
    expect(timeAgo(now - 10_000, now)).toBe("now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h");
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe("2d");
  });
});
