// @vitest-environment jsdom
// GH-397: a terminal tab whose code-split panel is not loaded yet (own module graph). Copy of the GH-374 harness.
// GH-374: the terminal panel is code split (React.lazy). Its first mount in a page load suspends and commits after the render that
// caused it. This file is its own module graph, so the panel here is not loaded yet when the test moves a pane.
import { act } from "react";
import { expect, it, vi } from "vitest";
import { TERM, el, start, press, tab, term } from "./app-terminal-lazy-harness.tsx";

it("a terminal tab whose code-split panel mounts late stays quiet after a move and a key press (GH-382)", async () => {
  await start({ side: "right", areas: { side: ["changes", "files", "graph", "plan"], bottom: ["terminal"], main: [] } });
  expect(el.querySelector('[data-testid="terminal-panel"]')).toBeNull();
  await press({ key: "k", code: "KeyK", ctrlKey: true });
  await act(async () => [...document.querySelectorAll<HTMLElement>('[data-testid="palette"] [role="option"]')].find((o) => o.textContent?.startsWith("Move terminal to main area"))!.click());
  await press({ key: "Shift", code: "ShiftLeft" });
  await vi.waitFor(() => expect(el.querySelector('[data-testid="terminal-view"]')).not.toBeNull());
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(el.querySelector(`[data-pane-tab-body="${TERM}"] [data-testid="terminal-view"]`)).not.toBeNull();
  expect(term.focused).toBe(0);
});
