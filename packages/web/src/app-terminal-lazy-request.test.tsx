// @vitest-environment jsdom
// GH-382: the terminal panel is code split (React.lazy) and its chunk is gated here, so it mounts only after the user asked for it
// (a pane tab click) while it was still loading after a move. Own file: the gate opens once per module graph. This file is its own module graph, so the panel is not loaded when the test moves a pane.
import { act } from "react";
import { expect, it, vi } from "vitest";
import { el, start, tab, moveByContextMenu, term } from "./app-terminal-lazy-harness.tsx";

const gate = vi.hoisted(() => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; });
vi.mock("./terminal-panel.tsx", async (orig) => (await gate.p, orig()));

it("a click on the Terminal pane tab while its code-split panel still loads after a move focuses the shell once it mounts (GH-382)", async () => {
  await start({ side: "right", areas: { side: ["changes", "files", "graph"], bottom: ["terminal"] } });
  await moveByContextMenu(tab("side-panel", "files"));
  await act(async () => new Promise((r) => setTimeout(r, 100)));
  await moveByContextMenu(tab("bottom-panel", "files"));
  await act(async () => new Promise((r) => setTimeout(r, 100)));
  expect(el.querySelector('[data-testid="terminal-view"]')).toBeNull();
  const t = tab("bottom-panel", "terminal");
  await act(async () => (t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })), t.click()));
  await act(async () => gate.open());
  await vi.waitFor(() => expect(el.querySelector('[data-testid="terminal-view"]')).not.toBeNull());
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(term.focused).toBe(1);
});
