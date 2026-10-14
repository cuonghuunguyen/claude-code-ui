// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalDockActions } from "./terminal-dock-actions.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => (act(() => root?.unmount()), (document.body.innerHTML = "")));
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const mount = async (ui: React.ReactElement) => {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root!.render(ui));
};

it("bottom: menu moves to side panel, maximize toggles pressed and label, hide calls onHide", async () => {
  const onMove = vi.fn();
  const onMaximize = vi.fn();
  const onHide = vi.fn();
  const ui = (maximized: boolean) => <TerminalDockActions dock="bottom" onMove={onMove} maximized={maximized} onMaximize={onMaximize} onHide={onHide} hideLabel="Hide terminal (Ctrl+`)" />;
  await mount(ui(false));
  await act(async () => q("terminal-menu")!.click());
  const item = q("terminal-move")!;
  expect(item.textContent).toBe("Move terminal to side panel");
  await act(async () => item.click());
  expect(onMove).toHaveBeenCalledWith("side");
  expect(q("terminal-maximize")!.getAttribute("aria-label")).toBe("Maximize terminal");
  expect(q("terminal-maximize")!.getAttribute("aria-pressed")).toBe("false");
  await act(async () => q("terminal-maximize")!.click());
  expect(onMaximize).toHaveBeenCalled();
  await act(async () => root!.render(ui(true)));
  expect(q("terminal-maximize")!.getAttribute("aria-label")).toBe("Restore terminal");
  expect(q("terminal-maximize")!.getAttribute("aria-pressed")).toBe("true");
  expect(q("terminal-hide")!.getAttribute("aria-label")).toBe("Hide terminal (Ctrl+`)");
  await act(async () => q("terminal-hide")!.click());
  expect(onHide).toHaveBeenCalled();
});

it("side: only the menu, item moves to bottom", async () => {
  const onMove = vi.fn();
  await mount(<TerminalDockActions dock="side" onMove={onMove} />);
  expect(q("terminal-maximize")).toBeNull();
  expect(q("terminal-hide")).toBeNull();
  await act(async () => q("terminal-menu")!.click());
  expect(q("terminal-move")!.textContent).toBe("Move terminal to bottom");
  await act(async () => q("terminal-move")!.click());
  expect(onMove).toHaveBeenCalledWith("bottom");
});

it("the actions are hidden below lg", async () => {
  await mount(<TerminalDockActions dock="side" onMove={() => {}} />);
  expect(q("terminal-dock-actions")!.className).toMatch(/\bhidden\b/);
  expect(q("terminal-dock-actions")!.className).toContain("lg:flex");
});
