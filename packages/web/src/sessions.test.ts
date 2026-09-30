import { describe, expect, it } from "vitest";
import type { SessionListItem } from "@claude-ui/protocol";
import { groupByCwd, timeAgo } from "./sessions.ts";

const item = (id: string, cwd: string, lastActivity: number): SessionListItem => ({ id, cwd, state: "idle", model: "default", title: id, lastActivity });

describe("groupByCwd", () => {
  it("groups sessions by working directory, most recent group first, keeping order inside a group", () => {
    const groups = groupByCwd([item("a", "/p/x", 30), item("b", "/p/y", 20), item("c", "/p/x", 10)]);
    expect(groups.map((g) => [g.cwd, g.sessions.map((s) => s.id)])).toEqual([
      ["/p/x", ["a", "c"]],
      ["/p/y", ["b"]],
    ]);
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
