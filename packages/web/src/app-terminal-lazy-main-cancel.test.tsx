// @vitest-environment jsdom
// GH-397: a terminal tab whose code-split panel is not loaded yet (own module graph). Copy of the GH-374 harness.
// GH-374: the terminal panel is code split (React.lazy). Its first mount in a page load suspends and commits after the render that
// caused it. This file is its own module graph, so the panel here is not loaded yet when the test moves a pane.
import { act } from "react";
import { expect, it, vi } from "vitest";
import { TERM, el, start, press, tab, term } from "./app-terminal-lazy-harness.tsx";

it("a pointer press after Ctrl+` and before the chunk mounts cancels the pending focus (phone switcher tap, home main)", async () => {
  await start({ side: "right", areas: { side: ["changes", "files", "graph", "plan"], bottom: [], main: ["terminal"] } });
  act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "`", code: "Backquote", ctrlKey: true })));
  act(() => void document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await vi.waitFor(() => expect(el.querySelector(`[data-pane-tab-body="${TERM}"] [data-testid="terminal-view"]`)).not.toBeNull());
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(term.focused).toBe(0);
});
