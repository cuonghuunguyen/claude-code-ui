// @vitest-environment jsdom
import type { Part, ShellOutputResult } from "@claude-ui/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ShellsDialog } from "./shells-dialog.tsx";
import { applyEvent, emptySession, type SessionView } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const bash = (id: string, input: object, status: "running" | "done" | "error" | "stopped", extra: object = {}): Part =>
  ({ type: "tool_call", id, toolUseId: id, tool: "Bash", input, status, shell: "background", ...extra }) as Part;
const view = (...parts: Part[]): SessionView => parts.reduce((v, part, i) => applyEvent(v, { type: "event", sessionId: "s", seq: i + 1, part }), emptySession());
const q = (t: string) => document.querySelector(`[data-testid="${t}"]`) as HTMLElement | null;
const click = (el: Element | null) => act(async () => (el as HTMLElement).click());

let unmount = () => {};
beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

async function render(v: SessionView | undefined, p: { output?: (id: string) => Promise<ShellOutputResult>; kill?: (id: string) => Promise<unknown> } = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const output = p.output ?? (async () => ({ output: "", truncated: false }));
  const kill = p.kill ?? (async () => ({}));
  const draw = (view: SessionView | undefined) => act(async () => root.render(<ShellsDialog open view={view} output={output} kill={kill} onClose={() => {}} />));
  await draw(v);
  unmount = () => (root.unmount(), el.remove());
  return { draw };
}

it("lists each shell with command, description, status, exit code and run time; empty state without shells", async () => {
  const v = view(
    bash("a", { command: "npm run dev", description: "Start dev server" }, "running", { startedAt: Date.now() - 65_000 }),
    bash("b", { command: "sh -c 'exit 3'" }, "error", { startedAt: 1000, endedAt: 6000, exitCode: 3 }),
    bash("c", { command: "ping localhost" }, "stopped"),
    bash("d", { command: "echo hi" }, "done", { startedAt: 1000, endedAt: 2000, exitCode: 0 }),
  );
  await render(v);
  const rows = [...document.querySelectorAll('[data-testid="shell-row"]')];
  expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["running", "done", "stopped", "error"]);
  expect(rows[0]!.textContent).toContain("Start dev server");
  expect(rows[0]!.textContent).toContain("npm run dev");
  expect(rows[0]!.textContent).toContain("Running");
  expect(rows[0]!.textContent).toContain("1m 05s");
  expect(rows[1]!.textContent).toContain("Completed · exit 0");
  expect(rows[2]!.textContent).toContain("Killed");
  expect(rows[3]!.textContent).toContain("Failed · exit 3");
  expect(rows[3]!.textContent).toContain("5s");
  expect(q("shells-empty")).toBeNull();
  unmount();
  await render(view());
  expect(q("shells-empty")?.textContent).toBe("No background shells in this session.");
});

it("opening a shell shows its output with the Bash card rendering and polls while it runs; one final read when it ends", async () => {
  const running = view(bash("a", { command: "ping localhost" }, "running", { startedAt: 1000 }));
  let n = 0;
  const output = vi.fn(async () => ({ output: `line ${++n}\n`, truncated: false }));
  const { draw } = await render(running, { output });
  await click(q("shell-row"));
  expect(q("shell-output")?.textContent).toContain("$ ping localhost");
  expect(q("shell-output")?.textContent).toContain("line 1");
  expect(q("shell-meta")?.textContent).toContain("Running");
  const first = output.mock.calls.length;
  await act(async () => void vi.advanceTimersByTime(1000));
  expect(output.mock.calls.length).toBe(first + 1);
  expect(q("shell-output")?.textContent).toContain("line 2");
  await draw(view(bash("a", { command: "ping localhost" }, "done", { startedAt: 1000, endedAt: 5000, exitCode: 0 })));
  const ended = output.mock.calls.length;
  expect(ended).toBe(first + 2);
  expect(q("shell-meta")?.textContent).toContain("Completed · exit code 0");
  await act(async () => void vi.advanceTimersByTime(3000));
  expect(output.mock.calls.length).toBe(ended);
});

it("Kill asks first, then sends the call's toolUseId; a failed kill shows its error", async () => {
  const kill = vi.fn(async () => {
    throw new Error("stop failed");
  });
  await render(view(bash("a", { command: "ping localhost" }, "running")), { kill });
  await click(q("shell-row"));
  await click(q("shell-kill"));
  expect(q("shell-kill-dialog")).not.toBeNull();
  await click(q("shell-kill-cancel"));
  expect(kill).not.toHaveBeenCalled();
  await click(q("shell-kill"));
  await click(q("shell-kill-confirm"));
  expect(kill).toHaveBeenCalledWith("a");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not kill: stop failed");
  expect(q("shell-kill")?.textContent).toBe("Kill");
  expect(q("shell-told")).toBeNull();
});

it("after a successful Kill the dialog says Claude will be told on the next message", async () => {
  const kill = vi.fn(async () => ({}));
  const { draw } = await render(view(bash("a", { command: "ping localhost" }, "running")), { kill });
  await click(q("shell-row"));
  await click(q("shell-kill"));
  await click(q("shell-kill-confirm"));
  expect(kill).toHaveBeenCalledWith("a");
  expect(q("shell-told")).toBeNull();
  await draw(view(bash("a", { command: "ping localhost" }, "stopped")));
  expect(q("shell-told")?.textContent).toBe("Claude will be told on your next message.");
});

it("a finished shell has no Kill button; output not available shows an error", async () => {
  const output = async () => {
    throw new Error("Output is not available");
  };
  await render(view(bash("a", { command: "echo hi" }, "done", { exitCode: 0 })), { output });
  await click(q("shell-row"));
  expect(q("shell-kill")).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Output not available: Output is not available");
  expect(q("shell-output")).toBeNull();
});
