import { beforeEach, describe, expect, it } from "vitest";
import { NEW_TAB, avatarColor, avatarColors, closeTab, loadTabs, moveTab, openTab, staleTabs, replaceTab, saveTabs, tabFromHash, tabHash } from "./tabs.ts";

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
