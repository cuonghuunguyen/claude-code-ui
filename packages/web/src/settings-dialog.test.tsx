// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Settings } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { SettingsDialog } from "./settings-dialog.tsx";
import type { TabGrouping } from "./tab-grouping.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = "";
});

async function render({ failGet = false } = {}) {
  const onTabGrouping = vi.fn();
  let settings: Settings = { orchestration: { enabled: false, workerCap: 4, coordinatorPermissions: true } };
  const calls: Request[] = [];
  const request = vi.fn(async (msg: Request) => {
    calls.push(msg);
    if (failGet && msg.type === "settings.get") throw new Error("daemon unreachable");
    if (msg.type === "settings.set") {
      const v = (msg.patch.orchestration ?? {}) as Record<string, unknown>;
      if (typeof v.workerCap === "number" && (v.workerCap < 1 || v.workerCap > 20 || !Number.isInteger(v.workerCap))) throw new Error("Maximum workers must be a whole number from 1 to 20");
      settings = { orchestration: { ...settings.orchestration, ...v } };
    }
    return { settings };
  });
  const el = document.createElement("div");
  const prompt = document.createElement("textarea");
  prompt.setAttribute("aria-label", "Prompt");
  Object.defineProperty(prompt, "offsetParent", { get: () => document.body });
  document.body.append(el, prompt);
  function Host() {
    const [open, set] = useState(true);
    const [grouping, setGrouping] = useState<TabGrouping>("project");
    return (
      <SettingsDialog
        open={open}
        request={request as never}
        onClose={() => set(false)}
        tabGrouping={grouping}
        onTabGrouping={(g) => {
          onTabGrouping(g);
          setGrouping(g);
        }}
      />
    );
  }
  root = createRoot(el);
  await act(async () => root!.render(<Host />));
  const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return { calls, q, prompt, onTabGrouping };
}

it("shows the Orchestration section with labelled controls, loaded from the daemon", async () => {
  const { q } = await render();
  expect(q("settings-dialog")?.textContent).toContain("Orchestration");
  expect(q("settings-orchestration-enabled")?.getAttribute("aria-checked")).toBe("false");
  expect(q("settings-orchestration-coordinatorPermissions")?.getAttribute("aria-checked")).toBe("true");
  expect((q("settings-orchestration-workerCap") as HTMLInputElement).value).toBe("4");
  expect(document.querySelector('label[for="settings-orchestration-workerCap"]')?.textContent).toBe("Maximum workers");
  // Short accessible name; the hint is the description.
  const desc = (id: string) => document.getElementById(q(id)!.getAttribute("aria-describedby")!)?.textContent;
  expect(q("settings-orchestration-enabled")?.getAttribute("aria-label")).toBe("Enable orchestration");
  expect(desc("settings-orchestration-enabled")).toContain("start and supervise worker sessions");
  expect(desc("settings-orchestration-workerCap")).toContain("1 to 20");
  expect(desc("settings-orchestration-coordinatorPermissions")).toContain("reads and file edits inside the worker folder. Commands and everything else wait for you");
  expect(desc("settings-orchestration-coordinatorPermissions")).toContain("Edits can change code that commands you approve later will run.");
});

it("a switch sends a patch of its field only", async () => {
  const { q, calls } = await render();
  await act(async () => q("settings-orchestration-enabled")!.click());
  expect(calls.at(-1)).toEqual({ type: "settings.set", patch: { orchestration: { enabled: true } } });
  expect(q("settings-orchestration-enabled")?.getAttribute("aria-checked")).toBe("true");
});

it("an out-of-range cap shows the daemon's error in a Banner", async () => {
  const { q } = await render();
  const input = q("settings-orchestration-workerCap") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "25");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(q("banner-error")?.textContent).toContain("Maximum workers must be a whole number");
});

it("Tab grouping shows By project by default and picking By worktree applies at once without a daemon request", async () => {
  const { q, calls, onTabGrouping } = await render();
  expect(q("settings-tabs-grouping")?.textContent).toContain("By project");
  await act(async () => q("settings-tabs-grouping")!.click());
  expect([...document.querySelectorAll("[role=option]")].map((o) => o.textContent)).toEqual(["By project", "By worktree", "None"]);
  await act(async () => document.querySelectorAll<HTMLElement>("[role=option]")[1]!.click());
  expect(onTabGrouping).toHaveBeenCalledWith("worktree");
  expect(q("settings-tabs-grouping")?.textContent).toContain("By worktree");
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
});

it("the Tabs section shows while daemon settings load or fail", async () => {
  const { q } = await render({ failGet: true });
  expect(q("banner-error")?.textContent).toContain("daemon unreachable");
  expect(q("settings-tabs")).not.toBeNull();
});

it("Esc closes the dialog and the focus returns to the prompt box", async () => {
  const { q, prompt } = await render();
  await act(async () => void document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => void new Promise((r) => setTimeout(r, 50)));
  expect(q("settings-dialog")).toBeNull();
  expect(document.activeElement).toBe(prompt);
});

it("Default diff view is a per-browser choice: picking Uncommitted saves it and sends no settings.set", async () => {
  localStorage.removeItem("claude-ui.diffMode");
  const { q, calls } = await render();
  expect(q("settings-diff-mode")?.textContent).toContain("Session changes");
  await act(async () => q("settings-diff-mode")!.click());
  await act(async () => document.querySelector<HTMLElement>("[data-testid=settings-diff-mode-uncommitted]")!.click());
  expect(localStorage.getItem("claude-ui.diffMode")).toBe("uncommitted");
  expect(q("settings-diff-mode")?.textContent).toContain("Uncommitted");
  expect(calls.some((c) => c.type === "settings.set")).toBe(false);
  localStorage.removeItem("claude-ui.diffMode");
});
