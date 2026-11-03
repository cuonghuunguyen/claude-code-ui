import { describe, expect, it } from "vitest";
import { addLog, logAllowed, LOG_RATE, pruneLog, loadAddonLog, readAddonLog, saveAddonLog, LOG_MAX, rendererFor, addonCommandOf, bandsOf, commandRows, clampHeight, gate, paneIdsOf, paneTitlesOf, addonViewOf, type AddonInfo } from "./addons.ts";

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

describe("rendererFor", () => {
  const claim = (name: string, state: AddonInfo["state"] = "enabled", renderers: NonNullable<AddonInfo["manifest"]>["renderers"] = [{ fence: "example", entry: `${name}.html` }]): AddonInfo => ({ ...addon([]), name, state, manifest: { ...addon([]).manifest!, name, renderers } }) as AddonInfo;
  it("returns the only claiming addon", () => {
    expect(rendererFor({ addons: [claim("a"), claim("b", "enabled", [{ tool: "T", entry: "t.html" }])], picks: {} }, "fence:example")).toMatchObject({ addon: { name: "a" }, entry: "a.html" });
    expect(rendererFor({ addons: [claim("b", "enabled", [{ tool: "T", entry: "t.html" }])], picks: {} }, "tool:T")?.entry).toBe("t.html");
    expect(rendererFor({ addons: [claim("a")], picks: {} }, "fence:other")).toBeUndefined();
  });
  it("uses the pick between two", () => expect(rendererFor({ addons: [claim("a"), claim("b")], picks: { "fence:example": "b" } }, "fence:example")?.addon.name).toBe("b"));
  it("without a pick takes the first name", () => expect(rendererFor({ addons: [claim("b"), claim("a")], picks: {} }, "fence:example")?.addon.name).toBe("a"));
  it("ignores a disabled addon, and a pick of one", () => {
    expect(rendererFor({ addons: [claim("a", "disabled"), claim("b")], picks: { "fence:example": "a" } }, "fence:example")?.addon.name).toBe("b");
    expect(rendererFor({ addons: [claim("a", "needs_approval")], picks: {} }, "fence:example")).toBeUndefined();
  });
});

describe("addon log", () => {
  it("gate: log needs the log capability", () => {
    expect(gate("log", ["log"])).toEqual({ ok: true });
    expect(gate("log", EVERY)).toMatchObject({ ok: false, code: "refused", message: "log needs capability log" });
  });
  it("addLog keeps the last LOG_MAX entries per addon and leaves the input alone", () => {
    let log = new Map();
    for (let i = 0; i < LOG_MAX + 5; i++) log = addLog(log, "a", { at: i, level: "info", text: String(i) });
    const before = log;
    const next = addLog(log, "b", { at: 0, level: "error", text: "x" });
    expect(log.get("a")).toHaveLength(LOG_MAX);
    expect(log.get("a")![0]!.text).toBe("5");
    expect(before.has("b")).toBe(false);
    expect(next.get("b")).toEqual([{ at: 0, level: "error", text: "x" }]);
  });
  it("addLog keeps time order and drops the oldest, not the last added", () => {
    let log = new Map();
    for (let i = 1; i <= LOG_MAX; i++) log = addLog(log, "a", { at: i * 10, level: "info", text: String(i) });
    const stale = addLog(log, "a", { at: 5, level: "info", text: "stale" });
    expect(stale.get("a")![0]!.text).toBe("1");
    expect(stale.get("a")).toHaveLength(LOG_MAX);
    const mid = addLog(log, "a", { at: 15, level: "info", text: "mid" });
    expect(mid.get("a")!.slice(0, 2).map((e) => e.text)).toEqual(["mid", "2"]);
  });
  it("save then load round-trips; bad or missing storage gives an empty log", () => {
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as Storage;
    const log = addLog(new Map(), "a", { at: 1, level: "warn", text: "t" });
    expect(saveAddonLog(log, storage)).toBe(true);
    expect(loadAddonLog(storage)).toEqual(log);
    m.set([...m.keys()][0]!, "{bad");
    expect(loadAddonLog(storage)).toEqual(new Map());
    expect(loadAddonLog({ getItem: () => { throw new Error("blocked"); } } as unknown as Storage)).toEqual(new Map());
    expect(readAddonLog({ getItem: () => { throw new Error("blocked"); } } as unknown as Storage)).toBeUndefined();
    expect(saveAddonLog(log, { setItem: () => { throw new Error("full"); } } as unknown as Storage)).toBe(false);
    m.set([...m.keys()][0]!, JSON.stringify({ a: [{ at: 1, level: "warn", text: "ok" }, { at: "x" }, null], b: "no" }));
    expect(loadAddonLog(storage)).toEqual(new Map([["a", [{ at: 1, level: "warn", text: "ok" }]]]));
  });
  it("logAllowed lets LOG_RATE lines per addon per second through", () => {
    const seen = new Map();
    const n = Array.from({ length: LOG_RATE + 3 }, () => logAllowed(seen, "a", 5_000)).filter(Boolean).length;
    expect(n).toBe(LOG_RATE);
    expect(logAllowed(seen, "b", 5_000)).toBe(true);
    expect(logAllowed(seen, "a", 6_000)).toBe(true);
  });
  it("pruneLog drops addons not listed and keeps the same Map when none go", () => {
    const log = addLog(addLog(new Map(), "a", { at: 1, level: "info", text: "x" }), "gone", { at: 1, level: "info", text: "y" });
    expect([...pruneLog(log, ["a"]).keys()]).toEqual(["a"]);
    expect(pruneLog(log, ["a", "gone"])).toBe(log);
  });
});
