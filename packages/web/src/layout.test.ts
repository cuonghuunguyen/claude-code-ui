// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { loadTerminalDock, saveTerminalDock, useMinWidth, useTerminalDock } from "./layout.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => (vi.restoreAllMocks(), saveTerminalDock("bottom"), localStorage.clear()));

it("terminal dock defaults to bottom and keeps side per browser", () => {
  expect(loadTerminalDock()).toBe("bottom");
  saveTerminalDock("side");
  expect(localStorage.getItem("claude-ui.terminalDock")).toBe("side");
  expect(loadTerminalDock()).toBe("side");
  saveTerminalDock("bottom");
  expect(localStorage.getItem("claude-ui.terminalDock")).toBeNull();
  expect(loadTerminalDock()).toBe("bottom");
});

it("an unknown stored value reads as bottom", () => {
  localStorage.setItem("claude-ui.terminalDock", "left");
  expect(loadTerminalDock()).toBe("bottom");
});

it("blocked storage keeps the choice in memory", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  saveTerminalDock("side");
  expect(loadTerminalDock()).toBe("side");
});

it("useTerminalDock re-renders on save and on another tab's storage event", async () => {
  const el = document.body.appendChild(document.createElement("div"));
  const root = createRoot(el);
  const Probe = () => createElement("span", null, useTerminalDock());
  await act(async () => root.render(createElement(Probe)));
  expect(el.textContent).toBe("bottom");
  await act(async () => saveTerminalDock("side"));
  expect(el.textContent).toBe("side");
  localStorage.removeItem("claude-ui.terminalDock");
  await act(async () => void window.dispatchEvent(new StorageEvent("storage", { key: "claude-ui.terminalDock" })));
  expect(el.textContent).toBe("bottom");
  act(() => root.unmount());
  el.remove();
});

it("useMinWidth follows matchMedia change events", async () => {
  let wide = true;
  const ls = new Set<() => void>();
  const original = window.matchMedia;
  window.matchMedia = ((q: string) => ({
    matches: wide,
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
