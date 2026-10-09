import { beforeEach, describe, expect, it } from "vitest";
import { FOCUS_TAB, NEW_TAB, keysFinal, avatarColor, avatarColors, closeMany, closeTab, stepNoWrap, groupTabs, loadCollapsed, loadTabs, moveGroup, moveGroupTo, moveTab, moveTabIn, openTab, saveCollapsed, staleTabs, replaceTab, saveTabs, tabFromHash, tabHash } from "./tabs.ts";

describe("tabs", () => {
  it("restored tabs the daemon does not list are stale; the new-session tab always stays", () => {
    expect(staleTabs(["a", "gone", NEW_TAB, "b"], new Set(["a", "b"]))).toEqual(["gone"]);
    expect(staleTabs(["a", NEW_TAB], new Set(["a"]))).toEqual([]);
  });

  it("opening a session adds its tab at the end once; opening it again only focuses it", () => {
    expect(openTab([], "a")).toEqual(["a"]);
    expect(openTab(["a", "b"], "c")).toEqual(["a", "b", "c"]);
    const tabs = ["a", "b"];
    expect(openTab(tabs, "a")).toBe(tabs);
  });

  it("closing the active tab focuses its right neighbour, else its left one, else nothing", () => {
    expect(closeTab(["a", "b", "c"], "b", "b")).toEqual({ tabs: ["a", "c"], active: "c" });
    expect(closeTab(["a", "b", "c"], "c", "c")).toEqual({ tabs: ["a", "b"], active: "b" });
    expect(closeTab(["a"], "a", "a")).toEqual({ tabs: [], active: undefined });
  });

  it("closing another tab keeps the active one", () => {
    expect(closeTab(["a", "b", "c"], "a", "c")).toEqual({ tabs: ["b", "c"], active: "c" });
    expect(closeTab(["a", NEW_TAB], NEW_TAB, "a")).toEqual({ tabs: ["a"], active: "a" });
  });

  it("drag reorder moves a tab to the drop target's slot", () => {
    expect(moveTab(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(moveTab(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveTab(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
    expect(moveTab(["a", "b"], "x", "a")).toEqual(["a", "b"]);
  });

  it("the new-session tab becomes the created session's tab in place", () => {
    expect(replaceTab(["a", NEW_TAB, "b"], NEW_TAB, "s")).toEqual(["a", "s", "b"]);
    // Already open elsewhere (cannot happen for a fresh id, but no duplicate either way).
    expect(replaceTab(["s", NEW_TAB], NEW_TAB, "s")).toEqual(["s"]);
    expect(replaceTab(["a"], NEW_TAB, "s")).toEqual(["a", "s"]);
  });

  it("the avatar color is stable per project", () => {
    expect(avatarColor("/home/u/proj")).toBe(avatarColor("/home/u/proj"));
    expect(new Set(["/a", "/b", "/c", "/d", "/e", "/f"].map((c) => avatarColor(c))).size).toBeGreaterThan(1);
  });

  it("known projects get distinct avatar colors, stable for the same set", () => {
    const root = "/home/u/tester-root/";
    const cwds = ["webapp", "api-server", "docs-site"].map((n) => root + n);
    const colors = avatarColors([...cwds, cwds[0]!]);
    expect(new Set(cwds.map((c) => avatarColor(c, colors))).size).toBe(3);
    expect(avatarColors([...cwds].reverse())).toEqual(colors);
    const nine = Array.from({ length: 9 }, (_, i) => `/p/${i}`);
    expect(new Set(nine.map((c) => avatarColor(c, avatarColors(nine)))).size).toBe(9);
  });

  it("the URL hash keeps the active tab, also the new-session tab", () => {
    const id = "0b5e6f1c-1111-4222-8333-444455556666";
    expect(tabFromHash(tabHash(id))).toBe(id);
    expect(tabFromHash(tabHash(NEW_TAB))).toBe(NEW_TAB);
    expect(tabFromHash("#focus")).toBe(FOCUS_TAB);
    expect(tabFromHash(tabHash(FOCUS_TAB))).toBe(FOCUS_TAB);
    expect(tabFromHash("")).toBeUndefined();
    expect(tabFromHash("#token=abc")).toBeUndefined();
  });
});

describe("tabs storage", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    globalThis.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as Storage;
  });

  it("open tabs and their order survive a reload", () => {
    saveTabs(["b", NEW_TAB, "a"]);
    expect(loadTabs()).toEqual(["b", NEW_TAB, "a"]);
  });

  it("garbage in storage gives no tabs", () => {
    expect(loadTabs()).toEqual([]);
    store.set("claude-ui.tabs", "{");
    expect(loadTabs()).toEqual([]);
    store.set("claude-ui.tabs", JSON.stringify({ a: 1 }));
    expect(loadTabs()).toEqual([]);
    store.set("claude-ui.tabs", JSON.stringify(["a", 3, "a"]));
    expect(loadTabs()).toEqual(["a"]);
  });
});

describe("tab groups by project", () => {
  const cwds: Record<string, string> = { a1: "/a", b1: "/b", a2: "/a", c1: "/c", b2: "/b" };
  const cwdOf = (id: string) => cwds[id];
  const flat = (t: string[]) => [...groupTabs(t, cwdOf).values()].flat();

  it("loading an interleaved list regroups in first-seen project order", () => {
    expect(flat(["a1", "b1", "a2", "c1", "b2"])).toEqual(["a1", "a2", "b1", "b2", "c1"]);
  });

  it("a new tab of a project lands at the end of its group", () => {
    expect(flat(openTab(["a1", "b1", "c1"], "a2"))).toEqual(["a1", "a2", "b1", "c1"]);
  });

  it("keysFinal: needs the session list and every tab resolved; the new-session tab is always final", () => {
    const known = new Set(["a", "b"]);
    const has = (id: string) => known.has(id);
    expect(keysFinal(["a", "b"], true, has)).toBe(true);
    expect(keysFinal(["a", NEW_TAB, "b"], true, has)).toBe(true);
    expect(keysFinal([], true, has)).toBe(true);
    expect(keysFinal(["a", "b"], false, has)).toBe(false); // list not loaded yet
    expect(keysFinal(["a", "c"], true, has)).toBe(false); // c not resolved yet
  });

  it("keysFinal: a tab whose subscribe failed counts as resolved, so it cannot hide the group chips forever (GH-201)", () => {
    const has = (id: string) => id === "a";
    expect(keysFinal(["a", "c"], true, has, new Set(["c"]))).toBe(true);
    expect(keysFinal(["a", "c", "d"], true, has, new Set(["c"]))).toBe(false);
    expect(keysFinal(["a", "c"], false, has, new Set(["c"]))).toBe(false);
  });

  it("moveTabIn with one shared key (keys not final) moves a tab across tabs of unknown project, not refused (GH-201)", () => {
    expect(moveTabIn(["a", "b", "c"], () => "", "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("moveTabIn reorders inside a group and ignores a move into another group", () => {
    const t = ["a1", "a2", "b1", "b2", "c1"];
    expect(moveTabIn(t, cwdOf, "a2", "a1")).toEqual(["a2", "a1", "b1", "b2", "c1"]);
    expect(moveTabIn(t, cwdOf, "a1", "b1")).toBe(t);
  });

  it("moveGroup swaps a group with its neighbour, keeps tab order, stops at the ends", () => {
    const t = ["a1", "a2", "b1", "b2", "c1"];
    expect(moveGroup(t, cwdOf, "/b", -1)).toEqual(["b1", "b2", "a1", "a2", "c1"]);
    expect(moveGroup(t, cwdOf, "/a", 1)).toEqual(["b1", "b2", "a1", "a2", "c1"]);
    expect(moveGroup(t, cwdOf, "/a", -1)).toEqual(t);
  });

  it("group moves from an interleaved stored order use the grouped order", () => {
    const t = ["a1", "b1", "a2"];
    expect(moveGroup(t, cwdOf, "/a", 1)).toEqual(["b1", "a1", "a2"]);
    expect(moveGroupTo(["a1", "b1", "a2", "c1"], cwdOf, "/c", "/a")).toEqual(["c1", "a1", "a2", "b1"]);
    expect(moveGroupTo(["a1", "b1", "a2", "c1"], cwdOf, "/a", "/c")).toEqual(["b1", "c1", "a1", "a2"]);
    expect(moveGroupTo(t, cwdOf, "/x", "/a")).toEqual(["a1", "a2", "b1"]);
  });

  it("collapsed groups persist per browser", () => {
    saveCollapsed(new Set(["/a"]));
    expect([...loadCollapsed()]).toEqual(["/a"]);
    localStorage.setItem("claude-ui.tab-groups-collapsed", "oops");
    expect(loadCollapsed().size).toBe(0);
  });

  it("the worktree set starts from the old key until it has its own", () => {
    saveCollapsed(new Set(["/a", "/a/wt"]), "project");
    expect([...loadCollapsed("worktree")]).toEqual(["/a", "/a/wt"]);
    saveCollapsed(new Set(["/a/wt"]), "worktree");
    saveCollapsed(new Set(), "project");
    expect([...loadCollapsed("worktree")]).toEqual(["/a/wt"]);
  });

  it("collapsed groups are kept per grouping mode; by project keeps the old key", () => {
    saveCollapsed(new Set(["/a"]), "project");
    saveCollapsed(new Set(["/a/wt"]), "worktree");
    expect([...loadCollapsed("project")]).toEqual(["/a"]);
    expect([...loadCollapsed("worktree")]).toEqual(["/a/wt"]);
    expect(localStorage.getItem("claude-ui.tab-groups-collapsed")).toBe('["/a"]');
  });

  it("with one key for every tab (no grouping) any tab moves anywhere", () => {
    expect(moveTabIn(["a1", "b1", "a2"], () => "", "a2", "a1")).toEqual(["a2", "a1", "b1"]);
    const t = ["a1", "b1", "a2"];
    expect([...groupTabs(t, () => "").values()].flat()).toEqual(t);
  });

  it("closeMany: an active tab in the group moves to the first tab after it, else the last before it, else none", () => {
    const tabs = ["a1", "a2", "b1", "b2"];
    expect(closeMany(tabs, ["a1", "a2"], "a2")).toEqual({ tabs: ["b1", "b2"], active: "b1" });
    expect(closeMany(tabs, ["b1", "b2"], "b1")).toEqual({ tabs: ["a1", "a2"], active: "a2" });
    expect(closeMany(tabs, tabs, "a1")).toEqual({ tabs: [], active: undefined });
    expect(closeMany(tabs, ["a1", "a2"], "b2")).toEqual({ tabs: ["b1", "b2"], active: "b2" });
    expect(closeMany(tabs, ["zz"], "a1")).toEqual({ tabs, active: "a1" });
    expect(closeMany(tabs, ["a1"], undefined)).toEqual({ tabs: ["a2", "b1", "b2"], active: undefined });
  });

  it("stepNoWrap: the neighbour in order, none past either end or for an unknown tab", () => {
    const order = ["focus", "a", "b"];
    expect(stepNoWrap(order, "focus", 1)).toBe("a");
    expect(stepNoWrap(order, "a", -1)).toBe("focus");
    expect(stepNoWrap(order, "b", 1)).toBeUndefined();
    expect(stepNoWrap(order, "focus", -1)).toBeUndefined();
    expect(stepNoWrap(order, "zz", 1)).toBeUndefined();
    expect(stepNoWrap(order, undefined, 1)).toBeUndefined();
  });
});
