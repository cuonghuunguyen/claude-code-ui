// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { autoChapter, decideFirstUse, finishRun, loadGuide, parseGuide, placePopover, resolveAnchor, restartGuide, saveGuide, setFreshBrowser, settled, skipGuide, takeFirstUseSnapshot, wasFreshBrowser, withStep, type GuideState } from "./guide.ts";

afterEach(() => (localStorage.clear(), setFreshBrowser(false)));

const store = (entries: Record<string, string>) => {
  const keys = Object.keys(entries);
  return { length: keys.length, key: (i: number) => keys[i] ?? null };
};

describe("first-use snapshot", () => {
  it("is fresh with no keys, or only the token and the theme", () => {
    expect(takeFirstUseSnapshot(store({}))).toBe(true);
    expect(takeFirstUseSnapshot(store({ "claude-ui.token": "t", "claude-ui.theme": "dark" }))).toBe(true);
    expect(wasFreshBrowser()).toBe(true);
  });
  it("is not fresh with any other claude-ui key", () => {
    expect(takeFirstUseSnapshot(store({ "claude-ui.tabs": "[]" }))).toBe(false);
    expect(takeFirstUseSnapshot(store({ "claude-ui.token": "t", "claude-ui.sidebarWidth": "300" }))).toBe(false);
  });
  it("ignores keys of other apps", () => {
    expect(takeFirstUseSnapshot(store({ other: "1" }))).toBe(true);
  });
  it("is not fresh when the storage throws", () => {
    const blocked = { get length(): number { throw new Error("blocked"); }, key: () => null };
    expect(takeFirstUseSnapshot(blocked)).toBe(false);
  });
});

describe("decideFirstUse", () => {
  it("starts the tour in a fresh browser on a daemon with no projects", () => {
    expect(decideFirstUse(true, 0)).toEqual({ v: 1, origin: "new", basics: "pending", session: "pending" });
  });
  it("offers it only (fresh browser, projects; or not fresh)", () => {
    const existing = { v: 1, origin: "existing", basics: "offered", session: "offered" };
    expect(decideFirstUse(true, 2)).toEqual(existing);
    expect(decideFirstUse(false, 0)).toEqual(existing);
  });
  it("an existing state never auto-starts", () => {
    expect(autoChapter(decideFirstUse(false, 0), { session: true })).toBeUndefined();
  });
});

describe("state parse and save", () => {
  const ok: GuideState = { v: 1, origin: "new", basics: "pending", session: "pending", step: "palette" };
  it("round-trips through storage", () => {
    saveGuide(ok);
    expect(loadGuide(true)).toEqual(ok);
  });
  it("absent is undefined", () => {
    expect(loadGuide(true)).toBeUndefined();
    expect(parseGuide(null, false)).toBeUndefined();
  });
  it("bad JSON, a future version or wrong types are absent in a fresh browser, existing otherwise", () => {
    for (const raw of ["{nope", JSON.stringify({ ...ok, v: 2 }), JSON.stringify({ ...ok, basics: "x" }), JSON.stringify({ ...ok, step: 3 }), "null"]) {
      expect(parseGuide(raw, true)).toBeUndefined();
      expect(parseGuide(raw, false)).toEqual({ v: 1, origin: "existing", basics: "offered", session: "offered" });
    }
  });
});

describe("transitions", () => {
  const fresh = decideFirstUse(true, 0);
  it("finishing Basics alone leaves the session chapter pending; with it, both are done", () => {
    expect(finishRun(withStep(fresh, "palette"), ["basics"])).toEqual({ ...fresh, basics: "done" });
    expect(finishRun(fresh, ["basics", "session"])).toMatchObject({ basics: "done", session: "done" });
    expect(finishRun(fresh, ["session"])).toMatchObject({ basics: "pending", session: "done" });
  });
  it("skip sets both chapters skipped and drops the saved step", () => {
    expect(skipGuide(withStep(fresh, "tabs"))).toEqual({ ...fresh, basics: "skipped", session: "skipped" });
  });
  it("restart sets both pending again", () => {
    expect(restartGuide(skipGuide(withStep(fresh, "tabs")))).toEqual(fresh);
    expect(restartGuide(decideFirstUse(false, 0))).toMatchObject({ origin: "existing", basics: "pending", session: "pending" });
  });
  it("Basics starts while pending; the session chapter once a session shows and Basics is not skipped", () => {
    expect(autoChapter(fresh, { session: false })).toBe("basics");
    const done = finishRun(fresh, ["basics"]);
    expect(autoChapter(done, { session: false })).toBeUndefined();
    expect(autoChapter(done, { session: true })).toBe("session");
    expect(autoChapter({ ...done, session: "done" }, { session: true })).toBeUndefined();
    expect(autoChapter({ ...fresh, basics: "skipped" }, { session: true })).toBeUndefined();
  });
  it("is settled once neither chapter is pending", () => {
    expect(settled(fresh)).toBe(false);
    expect(settled(skipGuide(fresh))).toBe(true);
    expect(settled(undefined)).toBe(false);
  });
});

describe("resolveAnchor", () => {
  it("takes the first visible element of the first candidate that has one", () => {
    document.body.innerHTML = `<i id="a1" class="no"></i><i id="a2"></i><i id="b"></i>`;
    const visible = (el: Element) => !el.classList.contains("no");
    expect(resolveAnchor(["#a1", "#a2", "#b"], visible)?.id).toBe("a2");
    expect(resolveAnchor(["#missing", "#b"], visible)?.id).toBe("b");
  });
  it("returns undefined when nothing is visible (the step shows centered)", () => {
    document.body.innerHTML = `<i id="a"></i>`;
    expect(resolveAnchor(["#a", "#none"], () => false)).toBeUndefined();
  });
  it("skips a hidden duplicate (the pane row below lg and the side panel header share a test id)", () => {
    document.body.innerHTML = `<b id="one" data-x></b><b id="two" data-x></b>`;
    expect(resolveAnchor(["[data-x]"], (el) => el.id === "two")?.id).toBe("two");
  });
});

describe("isVisible (the default of resolveAnchor)", () => {
  const box = (el: Element, left: number, top: number, w = 40, h = 20, rects = 1) => {
    Object.defineProperty(el, "getClientRects", { value: () => Array(rects).fill({}) });
    el.getBoundingClientRect = () => ({ left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON() {} });
  };
  it("is true for a laid-out element on screen, and resolveAnchor uses it with no second argument", () => {
    document.body.innerHTML = `<i id="a"></i>`;
    box(document.getElementById("a")!, 10, 10);
    expect(resolveAnchor(["#a"])?.id).toBe("a");
  });
  it("is false for display:none (no rects), [hidden], and an element translated off screen (a closed drawer)", () => {
    document.body.innerHTML = `<i id="none"></i><div hidden><i id="hid"></i></div><i id="off"></i>`;
    box(document.getElementById("none")!, 10, 10, 40, 20, 0);
    box(document.getElementById("hid")!, 10, 10);
    box(document.getElementById("off")!, -300, 10, 200, 20);
    expect(resolveAnchor(["#none", "#hid", "#off"])).toBeUndefined();
  });
});

describe("placePopover", () => {
  const view = { width: 1000, height: 700 };
  const size = { width: 320, height: 180 };
  it("goes on the preferred side", () => {
    const p = placePopover({ left: 20, top: 100, width: 100, height: 30 }, size, view, "right");
    expect(p.side).toBe("right");
    expect(p.left).toBeGreaterThan(120);
  });
  it("flips to the opposite side when it does not fit", () => {
    expect(placePopover({ left: 900, top: 100, width: 60, height: 30 }, size, view, "right").side).toBe("left");
  });
  it("falls back to bottom, then clamps to the gutter", () => {
    const p = placePopover({ left: 400, top: 10, width: 200, height: 680 }, { width: 900, height: 100 }, { width: 1000, height: 700 }, "right");
    expect(p.left).toBeGreaterThanOrEqual(16);
    expect(p.left + 900).toBeLessThanOrEqual(1000 - 16);
  });
});
