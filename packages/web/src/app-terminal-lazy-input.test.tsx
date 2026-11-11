// @vitest-environment jsdom
// GH-382: the terminal panel is code split (React.lazy) and its chunk is gated here, so it mounts only after the user pressed a key
// following a move. This file is its own module graph, so the panel is not loaded when the test moves a pane.
import { act } from "react";
import { expect, it, vi } from "vitest";
import { el, start, tab, moveByContextMenu, term } from "./app-terminal-lazy-harness.tsx";

const gate = vi.hoisted(() => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; });
vi.mock("./terminal-panel.tsx", async (orig) => (await gate.p, orig()));

it("a key pressed after a move, before the terminal's code-split panel has loaded, leaves the focus where the user put it (GH-382)", async () => {
  await start({ side: "right", areas: { side: ["changes", "files", "graph"], bottom: ["terminal"] } });
  await moveByContextMenu(tab("side-panel", "files"));
  await act(async () => new Promise((r) => setTimeout(r, 100)));
  await moveByContextMenu(tab("bottom-panel", "files"));
  await act(async () => new Promise((r) => setTimeout(r, 100)));
  expect(el.querySelector('[data-testid="terminal-view"]')).toBeNull();
  expect(document.activeElement).toBe(tab("side-panel", "files"));
  const next = el.querySelector<HTMLElement>('[data-testid="dock-maximize"]')!;
  await act(async () => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  next.focus();
  await act(async () => gate.open());
  await vi.waitFor(() => expect(el.querySelector('[data-testid="terminal-view"]')).not.toBeNull());
  await act(async () => new Promise((r) => setTimeout(r, 300)));
  expect(term.focused).toBe(0);
  expect(document.activeElement).toBe(next);
  const t = tab("bottom-panel", "terminal");
  await act(async () => (t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })), t.click()));
  await vi.waitFor(() => expect(term.focused).toBe(1));
});
