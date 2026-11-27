// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { resetPageForTests, setRecommendationHost } from "./recommendations.ts";
import { RunInTerminalContext, ShellFence } from "./shell-fence.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mount = async (run?: (c: string) => void, code = "npm test\n") => {
  const el = document.createElement("div");
  document.body.append(el);
  await act(async () => createRoot(el).render(<RunInTerminalContext value={run}><ShellFence code={code} language="bash" isIncomplete={false} /></RunInTerminalContext>));
  return el;
};

it("Run in terminal sends the command without the trailing newline", async () => {
  const run = vi.fn();
  const el = await mount(run);
  await act(async () => el.querySelector<HTMLButtonElement>("[data-testid=shell-run]")!.click());
  expect(run).toHaveBeenCalledWith("npm test");
});

it("has no run button without a terminal to run in", async () => {
  expect((await mount()).querySelector("[data-testid=shell-run]")).toBeNull();
});

// GH-1015: Copy still writes the clipboard when the Run in terminal tip shows; the second copy shows it, a fence without Run in terminal never.
const copyTwice = async (run?: (c: string) => void) => {
  const show = vi.fn();
  localStorage.clear();
  resetPageForTests();
  setRecommendationHost({ blocked: () => false, show });
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: write }, configurable: true });
  const el = await mount(run, "npm test\n");
  for (let i = 0; i < 2; i++) await act(async () => el.querySelector<HTMLButtonElement>("[data-testid=shell-copy]")!.click());
  return { show, write, el };
};
beforeEach(() => void (document.body.innerHTML = ""));

it("the second Copy offers the Run in terminal tip and still copies; Show me focuses the fence's Run button", async () => {
  const { show, write, el } = await copyTwice(vi.fn());
  expect(write).toHaveBeenCalledTimes(2);
  expect(show).toHaveBeenCalledOnce();
  await act(async () => show.mock.calls[0]![1].run());
  expect(document.activeElement).toBe(el.querySelector("[data-testid=shell-run]"));
});

it("a fence without Run in terminal never shows the tip", async () => {
  const { show, write } = await copyTwice();
  expect(write).toHaveBeenCalledTimes(2);
  expect(show).not.toHaveBeenCalled();
});

it("no tip while the fence is still streaming (its Run button is disabled)", async () => {
  const show = vi.fn();
  localStorage.clear();
  resetPageForTests();
  setRecommendationHost({ blocked: () => false, show });
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  const el = document.createElement("div");
  document.body.append(el);
  await act(async () => createRoot(el).render(<RunInTerminalContext value={vi.fn()}><ShellFence code="npm te" language="bash" isIncomplete /></RunInTerminalContext>));
  for (let i = 0; i < 3; i++) await act(async () => el.querySelector<HTMLButtonElement>("[data-testid=shell-copy]")!.click());
  expect(show).not.toHaveBeenCalled();
});
