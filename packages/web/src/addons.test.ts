import { describe, expect, it } from "vitest";
import { gate, paneIdsOf, paneTitlesOf, addonViewOf, type AddonInfo } from "./addons.ts";

const EVERY = ["session.read", "prompt.insert", "ui.status", "ui.toast", "ui.pane", "ui.band", "ui.command"];
const addon = (views: NonNullable<AddonInfo["manifest"]>["views"]): AddonInfo =>
  ({ name: "example", source: { kind: "local", path: "/x" }, approved: EVERY, state: "enabled", base: "/addon/n/example/", manifest: { name: "example", version: "1", description: "", capabilities: EVERY, themes: [], views, commands: [], renderers: [] } }) as AddonInfo;

describe("gate", () => {
  it("allows ui.ready without capabilities", () => expect(gate("ui.ready", [])).toEqual({ ok: true }));
  it("allows session.read only with session.read", () => {
    expect(gate("session.read", ["session.read"])).toEqual({ ok: true });
    expect(gate("session.read", ["ui.toast"])).toMatchObject({ ok: false, code: "refused" });
  });
  it("refuses prompt.insert without prompt.insert", () => expect(gate("prompt.insert", ["ui.toast"])).toMatchObject({ ok: false, code: "refused", message: "prompt.insert needs capability prompt.insert" }));
  it("refuses prompt.submit even with every capability", () => expect(gate("prompt.submit", EVERY)).toMatchObject({ ok: false }));
  it("refuses an unknown type, also one named like an Object prototype key", () => {
    for (const t of ["fs.read", "", "constructor", "__proto__", "toString"]) expect(gate(t, EVERY), t).toMatchObject({ ok: false, code: "unknown" });
  });
});

describe("addon panes", () => {
  const a = addon([
    { id: "stats", title: "Stats", entry: "pane.html", kind: "pane", phone: false },
    { id: "wide", title: "Wide", entry: "wide.html", kind: "pane" },
    { id: "info", title: "Info", entry: "band.html", kind: "band" },
  ]);
  it("paneIdsOf hides phone:false views on phone", () => {
    expect(paneIdsOf([a], false)).toEqual(["addon:example:stats", "addon:example:wide"]);
    expect(paneIdsOf([a], true)).toEqual(["addon:example:wide"]);
  });
  it("paneIdsOf skips band views", () => expect(paneIdsOf([a], false)).not.toContain("addon:example:info"));
  it("titles and view lookup", () => {
    expect(paneTitlesOf([a]).get("addon:example:stats")).toBe("Stats");
    expect(addonViewOf([a], "addon:example:wide")?.view.entry).toBe("wide.html");
    expect(addonViewOf([a], "addon:example:info")).toBeUndefined();
    expect(addonViewOf([a], "addon:other:wide")).toBeUndefined();
  });
});
