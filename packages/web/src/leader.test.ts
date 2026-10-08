import { expect, it } from "vitest";
import { LEADER_MS, leaderStep, prefixCommand } from "./leader.ts";

const key = (k: string, init: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...init });

it("the leader arms and is swallowed; other keys pass while idle", () => {
  expect(leaderStep(undefined, key("a", { altKey: true }), 100, true)).toEqual({ armedAt: 100, swallow: true });
  expect(leaderStep(undefined, key("c"), 100, false)).toEqual({ swallow: false });
});

it("a second key within the time runs its command and is swallowed", () => {
  expect(leaderStep(100, key("c"), 100 + LEADER_MS, false)).toEqual({ swallow: true, run: "session.new" });
  expect(leaderStep(100, key("3"), 200, false).run).toBe("tab.goto3");
  expect(leaderStep(100, key("9"), 200, false).run).toBe("tab.gotoLast");
  expect(leaderStep(100, key("?"), 200, false).run).toBe("shortcuts.open");
});

it("after the time the second key is a normal key", () => {
  expect(leaderStep(100, key("c"), 101 + LEADER_MS, false)).toEqual({ swallow: false });
  // The leader again re-arms.
  expect(leaderStep(100, key("a", { altKey: true }), 101 + LEADER_MS, true)).toEqual({ armedAt: 101 + LEADER_MS, swallow: true });
});

it("Esc and an unknown key cancel and are swallowed", () => {
  expect(leaderStep(100, key("Escape"), 200, false)).toEqual({ swallow: true, run: undefined });
  expect(leaderStep(100, key("q"), 200, false)).toEqual({ swallow: true, run: undefined });
  expect(leaderStep(100, key("c", { ctrlKey: true }), 200, false)).toEqual({ swallow: true, run: undefined });
});

it("a modifier alone keeps the prefix armed", () => {
  expect(leaderStep(100, key("Shift"), 200, false)).toEqual({ armedAt: 100, swallow: false });
});

it("prefixCommand maps tmux's keys", () => {
  expect(prefixCommand("N")).toBe("tab.next");
  expect(prefixCommand("0")).toBeUndefined();
});
