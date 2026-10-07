// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { loadDiffMode, loadDiffScope, repoRoot, saveDiffMode, saveDiffScope, useDefaultDiffMode } from "./diff-mode.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

it("loadDiffMode defaults to session and keeps a saved mode; an unknown stored value reads as session", () => {
  expect(loadDiffMode()).toBe("session");
  saveDiffMode("branch");
  expect(loadDiffMode()).toBe("branch");
  localStorage.setItem("claude-ui.diffMode", "nonsense");
  expect(loadDiffMode()).toBe("session");
});

it("saveDiffMode(session) removes the key; storage that throws keeps the default", () => {
  saveDiffMode("uncommitted");
  expect(localStorage.getItem("claude-ui.diffMode")).toBe("uncommitted");
  saveDiffMode("session");
  expect(localStorage.getItem("claude-ui.diffMode")).toBeNull();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(loadDiffMode()).toBe("session");
  expect(() => saveDiffMode("branch")).not.toThrow();
  expect(loadDiffScope()).toBe("all");
  expect(() => saveDiffScope("project")).not.toThrow();
});

it("the scope defaults to all; project is kept and all removes the key", () => {
  expect(loadDiffScope()).toBe("all");
  saveDiffScope("project");
  expect(loadDiffScope()).toBe("project");
  saveDiffScope("all");
  expect(localStorage.getItem("claude-ui.diffScope")).toBeNull();
});

it("useDefaultDiffMode re-renders subscribers when saved", async () => {
  const el = document.createElement("div");
  const root = createRoot(el);
  const Probe = () => <span>{useDefaultDiffMode()}</span>;
  await act(async () => root.render(<Probe />));
  expect(el.textContent).toBe("session");
  await act(async () => saveDiffMode("uncommitted"));
  expect(el.textContent).toBe("uncommitted");
  await act(async () => root.render(null));
});

it("repoRoot drops the prefix segments from cwd: POSIX, Windows with backslashes, empty prefix", () => {
  expect(repoRoot("/r/s/t", "s/t/")).toBe("/r");
  expect(repoRoot("C:\\r\\s", "s/")).toBe("C:\\r");
  expect(repoRoot("/r", "")).toBe("/r");
  expect(repoRoot("/r/s/", "s/")).toBe("/r");
});
