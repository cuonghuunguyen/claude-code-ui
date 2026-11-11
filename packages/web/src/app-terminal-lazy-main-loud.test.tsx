// @vitest-environment jsdom
// GH-397: a terminal tab whose code-split panel is not loaded yet (own module graph). Copy of the GH-374 harness.
// GH-374: the terminal panel is code split (React.lazy). Its first mount in a page load suspends and commits after the render that
// caused it. This file is its own module graph, so the panel here is not loaded yet when the test moves a pane.
import { expect, it, vi } from "vitest";
import { TERM, el, start, press, tab, term } from "./app-terminal-lazy-harness.tsx";

it("Ctrl+` before the terminal chunk loaded focuses the shell once it mounts (home main)", async () => {
  await start({ side: "right", areas: { side: ["changes", "files", "graph", "plan"], bottom: [], main: ["terminal"] } });
  await press({ key: "`", code: "Backquote", ctrlKey: true });
  await vi.waitFor(() => expect(el.querySelector(`[data-pane-tab-body="${TERM}"] [data-testid="terminal-view"]`)).not.toBeNull());
  await vi.waitFor(() => expect(term.focused).toBeGreaterThan(0));
});
