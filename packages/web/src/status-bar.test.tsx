// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ContextUsage, GitStatus, Part, PlanUsage } from "@claude-ui/protocol";
import { applyEvent, emptySession, type SessionView } from "./store.ts";
import { backgroundShells, countdown, StatusBar, tokens, totals } from "./status-bar.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-10-01T10:00:00Z").getTime();
const usage: ContextUsage = { totalTokens: 241_100, maxTokens: 1_000_000, percentage: 24, categories: [{ name: "Messages", tokens: 241_100, kind: "used" }] };
const plan: PlanUsage = {
  plan: "max",
  status: "allowed",
  windows: [
    { kind: "session", label: "Current session", percent: 1, resetsAt: NOW + (4 * 60 + 38) * 60_000 + 30_000, severity: "normal", active: true },
    { kind: "weekly_all", label: "Current week (all models)", percent: 18, resetsAt: NOW + ((2 * 24 + 14) * 60 + 58) * 60_000 + 30_000, severity: "normal", active: false },
  ],
};

function view(...parts: Part[]): SessionView {
  return parts.reduce((v, part, i) => applyEvent(v, { type: "event", sessionId: "s", seq: i + 1, part }), emptySession());
}
const result = (id: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheCreationTokens = 0): Part => ({
  type: "turn_result",
  id,
  durationMs: 1,
  isError: false,
  usage: { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens },
});
const bash = (id: string, input: object, status: "running" | "done"): Part => ({ type: "tool_call", id, toolUseId: id, tool: "Bash", input, status });

it("formats tokens with k and M, countdowns like the Claude Code status line", () => {
  expect([453, 1000, 241_100, 54_400_000, 1_000_000].map(tokens)).toEqual(["453", "1.0k", "241.1k", "54.4M", "1.0M"]);
  expect(countdown(38 * 60_000 + 5)).toBe("38m");
  expect(countdown((4 * 60 + 38) * 60_000)).toBe("4hr 38m");
  expect(countdown(((2 * 24 + 14) * 60 + 58) * 60_000)).toBe("2d 14hr 58m");
  expect(countdown(-5)).toBe("0m");
});

it("sums the session's turn results: In = uncached input + cache writes, Cached = cache reads", () => {
  expect(totals(view())).toBeUndefined();
  expect(totals(view(result("r1", 100, 20, 1000, 50), result("r2", 10, 5, 2000)))).toEqual({ input: 160, output: 25, cached: 3000 });
});

it("lists running background Bash calls only", () => {
  const v = view(
    bash("a", { command: "npm run dev", run_in_background: true }, "running"),
    bash("b", { command: "ls", run_in_background: true }, "done"),
    bash("c", { command: "sleep 5" }, "running"),
  );
  expect(backgroundShells(v).map((c) => c.id)).toEqual(["a"]);
});

let unmount = () => {};
afterEach(() => (unmount(), vi.useRealTimers()));

type Props = Parameters<typeof StatusBar>[0];
async function render(p: Partial<Props>) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const props: Props = { view: view(), model: "Opus 5.5", mode: "default", modes: ["default", "acceptEdits", "plan"], onMode: () => {}, plan: null, ...p };
  await act(async () => root.render(<StatusBar {...props} />));
  unmount = () => (root.unmount(), el.remove());
  const text = () => [...el.querySelectorAll("[data-field]")].map((f) => `${f.getAttribute("data-field")}=${f.textContent}`);
  return { el, text, rerender: (n: Partial<Props>) => act(async () => root.render(<StatusBar {...props} {...n} />)) };
}

it("shows every field like the Claude Code status line", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
  const v = view(
    { type: "context_usage", id: "context_usage", usage },
    result("r1", 241_000, 453, 54_400_000, 100),
    bash("a", { command: "npm run dev", run_in_background: true }, "running"),
  );
  const git: GitStatus = { branch: "main", added: 3, removed: 1 };
  const { text } = await render({ view: v, plan, mode: "acceptEdits", git: async () => git });
  expect(text()).toEqual([
    "model=Model: Opus 5.5",
    "ctx=Ctx: 241.1k",
    "branch=main",
    "diff=(+3,-1)",
    "in=In: 241.1k",
    "out=Out: 453",
    "cached=Cached: 54.4M",
    "ctx-used=Ctx Used: 24.1%",
    "session=Session: 1.0%",
    "session-reset=Reset: 4hr 38m",
    "weekly=Weekly: 18.0%",
    "weekly-reset=Weekly Reset: 2d 14hr 58m",
    // The chooser's chevron (Base UI icon text in jsdom) is hidden by CSS.
    "mode=accept edits on▼",
    "shells=1 shell",
  ]);
});

it("hides fields without data: no usage, no turn, no plan limits, no git repo, default mode, no shells", async () => {
  const { text } = await render({ git: async () => null });
  expect(text()).toEqual(["model=Model: Opus 5.5"]);
});

it("counts reset times down live", async () => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setInterval", "clearInterval"] });
  const { text } = await render({ plan });
  expect(text()).toContain("session-reset=Reset: 4hr 38m");
  await act(async () => vi.advanceTimersByTime(60_000));
  expect(text()).toContain("session-reset=Reset: 4hr 37m");
});

it("refreshes git after each turn", async () => {
  const git = vi.fn(async (): Promise<GitStatus> => ({ branch: "main", added: git.mock.calls.length, removed: 0 }));
  const { text, rerender } = await render({ git, view: { ...view(), state: "running" } });
  expect(text()).toContain("diff=(+1,-0)");
  await rerender({ git, view: { ...view(), state: "idle" } });
  expect(text()).toContain("diff=(+2,-0)");
});

it("click opens the details: context breakdown, plan usage, permission mode chooser, background shells", async () => {
  const v = view({ type: "context_usage", id: "context_usage", usage }, bash("a", { command: "npm run dev", description: "Start dev server", run_in_background: true }, "running"));
  const onMode = vi.fn();
  const { el } = await render({ view: v, plan, mode: "plan", onMode });
  const click = (field: string) => act(async () => el.querySelector<HTMLElement>(`[data-field="${field}"]`)!.click());
  await click("ctx-used");
  expect(document.querySelector('[data-testid="context-breakdown"]')).not.toBeNull();
  await click("session");
  expect(document.querySelector('[data-testid="plan-usage"]')).not.toBeNull();
  await click("shells");
  expect(document.querySelector('[data-testid="shells"]')?.textContent).toContain("Start dev server");
  await act(async () => el.querySelector<HTMLElement>('[data-testid="status-mode"]')!.click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === "Edit automatically")!;
  await act(async () => option.click());
  expect(onMode).toHaveBeenCalledWith("acceptEdits");
});

it("narrow screens keep model, ctx used and session percent; the rest is hidden below sm", async () => {
  const v = view({ type: "context_usage", id: "context_usage", usage }, result("r1", 1, 1, 1));
  const { el } = await render({ view: v, plan });
  const narrow = [...el.querySelectorAll("[data-field]")].filter((f) => !f.className.includes("max-sm:hidden")).map((f) => f.getAttribute("data-field"));
  expect(narrow).toEqual(["model", "ctx-used", "session"]);
});
