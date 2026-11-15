// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { loadDiffMode, repoRoot, saveDiffMode } from "./diff-mode.ts";

afterEach(() => {
  localStorage.clear();
});

it("loadDiffMode defaults to uncommitted and keeps a saved mode; an unknown stored value reads as uncommitted", () => {
  expect(loadDiffMode()).toBe("uncommitted");
  saveDiffMode("session");
  expect(loadDiffMode()).toBe("session");
  localStorage.setItem("claude-ui.diffMode", "nonsense");
  expect(loadDiffMode()).toBe("uncommitted");
});

it("repoRoot drops the prefix segments from cwd: POSIX, Windows with backslashes, empty prefix", () => {
  expect(repoRoot("/r/s/t", "s/t/")).toBe("/r");
  expect(repoRoot("C:\\r\\s", "s/")).toBe("C:\\r");
  expect(repoRoot("/r", "")).toBe("/r");
  expect(repoRoot("/r/s/", "s/")).toBe("/r");
});
