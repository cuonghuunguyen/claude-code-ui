import { describe, expect, it } from "vitest";
import type { AvailablePlugin } from "@claude-ui/protocol";
import { chipOf, failureDialog, filterAvailable, formatInstalls, marketplaceLink, marketplaceText, updateNotice } from "./plugins.ts";

const avail = (name: string, installCount: number, extra: Partial<AvailablePlugin> = {}): AvailablePlugin => ({ pluginId: `${name}@m`, name, marketplaceName: "m", official: false, installCount, ...extra });

describe("plugins", () => {
  it("formats install counts like the extension", () => {
    expect([formatInstalls(999), formatInstalls(1000), formatInstalls(1234), formatInstalls(3_000_000), formatInstalls(2_450_000)]).toEqual(["999", "1k", "1.2k", "3m", "2.5m"]);
  });

  it("searches name, description and marketplace, most installed first", () => {
    const list = [avail("a", 1), avail("b", 50, { description: "Git helper" }), avail("c", 7, { marketplaceName: "gitstuff" })];
    expect(filterAvailable(list, "").map((p) => p.name)).toEqual(["b", "c", "a"]);
    expect(filterAvailable(list, " GIT ").map((p) => p.name)).toEqual(["b", "c"]);
  });

  it("shows marketplace sources and links", () => {
    expect(marketplaceText({ name: "x", source: "github", repo: "o/r", official: false })).toBe("GitHub: o/r");
    expect(marketplaceText({ name: "x", source: "directory", path: "/m", official: false })).toBe("Directory: /m");
    expect(marketplaceText({ name: "x", source: "npm", package: "p", official: false })).toBe("npm: p");
    expect(marketplaceLink({ name: "x", source: "github", repo: "o/r", official: false })).toBe("https://github.com/o/r");
    expect(marketplaceLink({ name: "x", source: "git", url: "git@github.com:o/r.git", official: false })).toBeUndefined();
    expect(marketplaceLink({ name: "x", source: "directory", path: "/m", official: false })).toBeUndefined();
  });

  it("matches MCP chips by name or plugin:<plugin>:<server>", () => {
    const servers = [{ name: "plugin:tools:db", status: "failed", error: "boom" }, { name: "web", status: "connected" }];
    expect(chipOf("tools@m", "db", servers)).toEqual({ status: "failed", title: "db: failed - boom" });
    expect(chipOf("tools@m", "web", servers)).toEqual({ status: "connected", title: "web: connected" });
    expect(chipOf("tools@m", "gone", servers)).toEqual({ status: "unknown", title: "gone: not loaded" });
  });

  it("words the update notices and failure dialogs", () => {
    expect(updateNotice("p@m", "p is already at the latest version (1.0.0).")).toBe("p is already at the latest version.");
    expect(updateNotice("p@m", "Skipped — q needs 1.0")).toBe("p was not updated because another plugin needs the version it has.");
    expect(updateNotice("p@m", "p is at 1.0 — version shown may be stale.")).toBe("p may already be at the latest version; the marketplace couldn't be checked.");
    expect(failureDialog("not_found", "p@market")).toMatchObject({ title: "p isn't in your copy of market", actions: [{ label: "Refresh the marketplace and retry" }] });
    expect(failureDialog("policy", "p@m")).toMatchObject({ title: "p can't be updated here", actions: [], close: "OK" });
    expect(failureDialog("network", "p@m").actions.map((a) => a.label)).toEqual(["Try again", "Copy error"]);
    expect(failureDialog("disabled", "p@m")).toMatchObject({ title: "p is turned off", actions: [{ label: "Turn on and update" }] });
  });
});
