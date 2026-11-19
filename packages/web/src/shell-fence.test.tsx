// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
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
