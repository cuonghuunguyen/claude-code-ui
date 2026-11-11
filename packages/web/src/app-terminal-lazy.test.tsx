// @vitest-environment jsdom
// GH-374: the terminal panel is code split (React.lazy). Its first mount in a page load suspends and commits after the render that
// caused it. This file is its own module graph, so the panel here is not loaded yet when the test moves a pane.
import { act } from "react";
import { expect, it, vi } from "vitest";
import { el, start, tab, moveByContextMenu, term } from "./app-terminal-lazy-harness.tsx";

it("a terminal that mounts for the first time because a pane moved (lazy panel, late commit) leaves the focus on the moved tab", async () => {
  // Acceptance 6 run 1: after a reload the bottom panel holds the terminal, never shown in this page load.
  await start({ side: "right", areas: { side: ["changes", "files", "graph"], bottom: ["terminal"] } });
  // Files to the bottom panel: it opens with Files shown, the terminal is not mounted.
  await moveByContextMenu(tab("side-panel", "files"));
  await act(async () => new Promise((r) => setTimeout(r, 100)));
  expect(el.querySelector('[data-testid="terminal-panel"]')).toBeNull();
  // Files back: the terminal becomes the bottom panel's shown pane and mounts once its chunk has loaded.
  await moveByContextMenu(tab("bottom-panel", "files"));
  await vi.waitFor(() => expect(el.querySelector('[data-testid="terminal-view"]')).not.toBeNull());
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(document.activeElement).toBe(tab("side-panel", "files"));
  expect(term.focused).toBe(0);
});
