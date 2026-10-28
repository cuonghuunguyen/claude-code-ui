// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_LAYOUT, activePane, areaOf, loadLayout, loadPaneTabs, loadTerminalDock, movePane, parsePaneTabs, parseLayout, rememberPane, resetLayout, saveLayout, saveTerminalDock, withPane, useLayout, useMinWidth, useTerminalDock } from "./layout.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => (vi.restoreAllMocks(), resetLayout(), localStorage.clear()));

it("parseLayout: bad input reads as the default", () => {
  expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
  expect(parseLayout("{nope")).toEqual(DEFAULT_LAYOUT);
  expect(parseLayout('{"side":"left"}')).toEqual(DEFAULT_LAYOUT);
});

it("parseLayout: appends missing panes, drops unknown and duplicate ones", () => {
  const l = parseLayout('{"side":"left","areas":{"side":["files","zzz","files"],"bottom":["terminal","changes"]}}');
  expect(l).toEqual({ side: "left", areas: { side: ["files", "graph", "plan"], bottom: ["terminal", "changes"], main: [] } });
  expect(parseLayout('{"side":"top","areas":{}}').side).toBe("right");
});

it("parseLayout: GH-354 terminalDock=side migrates when no layout is stored", () => {
  expect(parseLayout(null, "side").areas).toEqual({ side: ["changes", "files", "graph", "plan", "terminal"], bottom: [], main: [] });
  expect(parseLayout(null, "bottom")).toEqual(DEFAULT_LAYOUT);
});

it("movePane: other area end, reorder before, no-op returns the same object", () => {
  const l = DEFAULT_LAYOUT;
  expect(movePane(l, "files", "bottom").areas).toEqual({ side: ["changes", "graph", "plan"], bottom: ["terminal", "files"], main: [] });
  expect(movePane(l, "files", "bottom", "terminal").areas.bottom).toEqual(["files", "terminal"]);
  expect(movePane(l, "graph", "side", "changes").areas.side).toEqual(["graph", "changes", "files", "plan"]);
  expect(movePane(l, "files", "side", "graph")).toBe(l);
  expect(movePane(l, "terminal", "bottom")).toBe(l);
  expect(movePane(l, "files", "bottom", "changes").areas.bottom).toEqual(["terminal", "files"]);
});

it("parseLayout: an old stored layout without plan and main puts Plan at the end of the side panel and main empty", () => {
  const l = parseLayout('{"side":"right","areas":{"side":["files","changes","graph"],"bottom":["terminal"]}}');
  expect(l.areas).toEqual({ side: ["files", "changes", "graph", "plan"], bottom: ["terminal"], main: [] });
});

it("parseLayout keeps files and graph in main and still drops changes and terminal from main to their default areas", () => {
  const l = parseLayout('{"side":"right","areas":{"side":[],"bottom":[],"main":["plan","changes","files","graph","terminal"]}}');
  expect(l.areas.main).toEqual(["plan", "files", "graph"]);
  expect(l.areas.side).toEqual(["changes"]);
  expect(l.areas.bottom).toEqual(["terminal"]);
});

it("movePane to main refuses changes (same object) and moves plan", () => {
  const l = DEFAULT_LAYOUT;
  expect(movePane(l, "changes", "main")).toBe(l);
  const n = movePane(l, "plan", "main");
  expect(n.areas.main).toEqual(["plan"]);
  expect(n.areas.side).not.toContain("plan");
  expect(areaOf(n, "plan")).toBe("main");
  expect(movePane(n, "plan", "side").areas.side.at(-1)).toBe("plan");
});

it("movePane moves files and graph to main; changes stays (same object)", () => {
  const n = movePane(movePane(DEFAULT_LAYOUT, "files", "main"), "graph", "main");
  expect(n.areas.main).toEqual(["files", "graph"]);
  expect(n.areas.side).toEqual(["changes", "plan"]);
  expect(movePane(n, "changes", "main")).toBe(n);
});

it("withPane does not remember an area for a main-home pane", () => {
  const l = movePane(DEFAULT_LAYOUT, "plan", "main");
  expect(withPane({}, "plan", l)).toEqual({ narrow: "plan" });
  expect(withPane({}, "changes", l)).toEqual({ narrow: "changes", side: "changes" });
});

it("withPane does not remember a dock tab for files with home main", () => {
  const l = movePane(DEFAULT_LAYOUT, "files", "main");
  expect(withPane({}, "files", l)).toEqual({ narrow: "files" });
});

it("DEFAULT_LAYOUT has plan after graph in the side panel", () => {
  expect(DEFAULT_LAYOUT.areas.side).toEqual(["changes", "files", "graph", "plan"]);
  expect(DEFAULT_LAYOUT.areas.main).toEqual([]);
});

it("activePane: newest history entry in the area, else files, else first", () => {
  expect(activePane(["changes", "files"], ["terminal", "changes", "files"])).toBe("changes");
  expect(activePane(["changes", "files"], [])).toBe("files");
  expect(activePane(["changes", "graph"], ["terminal"])).toBe("changes");
  expect(activePane([], ["files"])).toBeUndefined();
});

it("saveLayout keeps non-default layouts, removes the key for the default and the GH-354 key", () => {
  localStorage.setItem("claude-ui.terminalDock", "side");
  saveLayout(movePane(DEFAULT_LAYOUT, "files", "bottom"));
  expect(JSON.parse(localStorage.getItem("claude-ui.layout")!).areas.bottom).toEqual(["terminal", "files"]);
  expect(localStorage.getItem("claude-ui.terminalDock")).toBeNull();
  const a = loadLayout();
  expect(loadLayout()).toBe(a);
  resetLayout();
  expect(localStorage.getItem("claude-ui.layout")).toBeNull();
  expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
});

it("terminal dock = area of the terminal pane", () => {
  expect(loadTerminalDock()).toBe("bottom");
  saveTerminalDock("side");
  expect(areaOf(loadLayout(), "terminal")).toBe("side");
  expect(loadTerminalDock()).toBe("side");
  saveTerminalDock("bottom");
  expect(localStorage.getItem("claude-ui.layout")).toBeNull();
});

it("blocked storage keeps the layout in memory", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  saveTerminalDock("side");
  expect(loadTerminalDock()).toBe("side");
});

it("useLayout / useTerminalDock re-render on save and on another tab's storage event", async () => {
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  const Probe = () => createElement("span", null, `${useTerminalDock()} ${useLayout().side}`);
  await act(async () => root.render(createElement(Probe)));
  expect(el.textContent).toBe("bottom right");
  await act(async () => saveTerminalDock("side"));
  expect(el.textContent).toBe("side right");
  localStorage.setItem("claude-ui.layout", JSON.stringify({ ...DEFAULT_LAYOUT, side: "left" }));
  await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: "claude-ui.layout" })));
  expect(el.textContent).toBe("bottom left");
  act(() => root.unmount());
  el.remove();
});

it("useMinWidth follows matchMedia change events", async () => {
  let wide = true;
  const ls = new Set<() => void>();
  const original = window.matchMedia;
  window.matchMedia = ((q: string) => ({
    get matches() {
      return wide;
    },
    media: q,
    addEventListener: (_: string, l: () => void) => ls.add(l),
    removeEventListener: (_: string, l: () => void) => ls.delete(l),
  })) as never;
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  const Probe = () => createElement("span", null, String(useMinWidth(1024)));
  await act(async () => root.render(createElement(Probe)));
  expect(el.textContent).toBe("true");
  wide = false;
  await act(async () => ls.forEach((l) => l()));
  expect(el.textContent).toBe("false");
  act(() => root.unmount());
  el.remove();
  window.matchMedia = original;
});

it("parsePaneTabs: bad input reads as empty; unknown panes drop; narrow takes session", () => {
  for (const raw of [null, "{x", "[]"]) expect(parsePaneTabs(raw)).toEqual({});
  expect(parsePaneTabs('{"side":"zzz","bottom":"files","narrow":"session"}')).toEqual({ bottom: "files", narrow: "session" });
  expect(parsePaneTabs('{"narrow":"bogus"}')).toEqual({});
});

it("activePane: the remembered pane wins over files when the area holds it; history still wins; one the area lacks falls back", () => {
  expect(activePane(["changes", "files"], [], "changes")).toBe("changes");
  expect(activePane(["changes", "files"], ["files"], "changes")).toBe("files");
  expect(activePane(["changes", "files"], [], "terminal")).toBe("files");
  expect(activePane(["changes", "graph"], [], undefined)).toBe("changes");
});

it("rememberPane stores the pane under its area and as narrow; session only as narrow", () => {
  const stored = () => JSON.parse(localStorage.getItem("claude-ui.paneTabs")!);
  rememberPane("changes");
  expect(stored()).toEqual({ narrow: "changes", side: "changes" });
  rememberPane("terminal");
  expect(stored()).toEqual({ narrow: "terminal", side: "changes", bottom: "terminal" });
  rememberPane("session");
  expect(stored()).toEqual({ narrow: "session", side: "changes", bottom: "terminal" });
  saveLayout(movePane(DEFAULT_LAYOUT, "files", "bottom"));
  rememberPane("files");
  expect(stored().bottom).toBe("files");
  expect(loadPaneTabs()).toBe(loadPaneTabs());
});

it("Reset layout forgets the remembered tabs; saveTerminalDock does not", () => {
  rememberPane("changes");
  saveTerminalDock("side");
  saveTerminalDock("bottom");
  expect(localStorage.getItem("claude-ui.paneTabs")).not.toBeNull();
  resetLayout();
  expect(localStorage.getItem("claude-ui.paneTabs")).toBeNull();
  expect(loadPaneTabs()).toEqual({});
});

it("blocked storage keeps the remembered tabs in memory", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  rememberPane("graph");
  expect(loadPaneTabs().side).toBe("graph");
});
