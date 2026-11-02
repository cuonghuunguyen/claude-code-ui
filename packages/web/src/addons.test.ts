import { describe, expect, it } from "vitest";
import { addonCommandOf, bandsOf, commandRows, clampHeight, gate, paneIdsOf, paneTitlesOf, addonViewOf, type AddonInfo } from "./addons.ts";

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

describe("bands", () => {
  const a = addon([{ id: "info", title: "Info", entry: "band.html", kind: "band" }, { id: "p", title: "P", entry: "p.html", kind: "pane" }, { id: "small", title: "S", entry: "s.html", kind: "band", phone: false }]);
  it("bandsOf lists band views of enabled addons, without phone:false ones on a phone", () => {
    expect(bandsOf([a], false).map((b) => b.view.id)).toEqual(["info", "small"]);
    expect(bandsOf([a], true).map((b) => b.view.id)).toEqual(["info"]);
  });
  it("clampHeight keeps 24..max", () => {
    expect([clampHeight(5), clampHeight(100.4), clampHeight(900), clampHeight(900, 160)]).toEqual([24, 100, 480, 160]);
  });
});

describe("commands", () => {
  const a = { ...addon([]), manifest: { ...addon([]).manifest!, commands: [{ name: "cmd", description: "Insert", argumentHint: "[text]" }, { name: "plain", description: "P" }] } } as AddonInfo;
  it("commandRows namespaces commands as addon:cmd", () => {
    expect(commandRows([a], [])).toEqual([
      { name: "example:cmd", description: "Insert", argumentHint: "[text]" },
      { name: "example:plain", description: "P", argumentHint: "" },
    ]);
  });
  it("commandRows drops a row that clashes with a session command or alias", () => {
    const rows = commandRows([a], [{ name: "x", description: "", argumentHint: "", aliases: ["example:cmd"] }]);
    expect(rows.map((r) => r.name)).toEqual(["example:plain"]);
  });
  it("commandRows drops a row that clashes with a dialog command or /btw", () => {
    // A dialog name has no ':' so only the CLI plugin form can clash; the filter still covers the dialog names.
    const mk = (name: string) => ({ ...a, name, manifest: { ...a.manifest!, commands: [{ name: "y", description: "d" }] } }) as AddonInfo;
    expect(commandRows([mk("x")], [{ name: "x:y", description: "", argumentHint: "" }])).toEqual([]);
    expect(commandRows([mk("x")], []).map((r) => r.name)).toEqual(["x:y"]);
  });
  it("addonCommandOf parses args", () => {
    const rows = commandRows([a], []);
    expect(addonCommandOf("/example:cmd release notes ", rows)).toEqual({ addon: "example", name: "cmd", args: "release notes" });
    expect(addonCommandOf("/example:plain", rows)).toEqual({ addon: "example", name: "plain", args: "" });
  });
  it("addonCommandOf ignores a command not in rows", () => {
    const rows = commandRows([a], []);
    expect(addonCommandOf("/example:other", rows)).toBeUndefined();
    expect(addonCommandOf("hello /example:cmd", rows)).toBeUndefined();
  });
});
