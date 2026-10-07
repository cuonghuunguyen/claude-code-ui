// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { GitStatus, Part } from "@claude-ui/protocol";
import { applyEvent, emptySession, type SessionView } from "./store.ts";
import { backgroundShells, StatusBar, tokens, totals } from "./status-bar.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

it("formats tokens with k and M", () => {
  expect([453, 1000, 241_100, 54_400_000, 1_000_000].map(tokens)).toEqual(["453", "1.0k", "241.1k", "54.4M", "1.0M"]);
});

it("sums the session's turn results: In = uncached input + cache writes, Cached = cache reads", () => {
  expect(totals(view())).toBeUndefined();
  expect(totals(view(result("r1", 100, 20, 1000, 50), result("r2", 10, 5, 2000)))).toMatchObject({ input: 160, output: 25, cached: 3000 });
});

it("also keeps uncached input, cache writes and the known cost for the context breakdown (OpenCode Context tab)", () => {
  const paid = (id: string, costUsd?: number): Part => ({ ...(result(id, 100, 20, 1000, 50) as Extract<Part, { type: "turn_result" }>), costUsd });
  expect(totals(view(paid("r1", 0.1), paid("r2", 0.025)))).toEqual({ input: 300, output: 40, cached: 2000, uncached: 200, cacheWrite: 100, cost: 0.125 });
  // No turn with a known cost (restored after a daemon restart): no cost.
  expect(totals(view(paid("r1")))!.cost).toBeUndefined();
  expect(totals(view(paid("r1")))!.costPartial).toBeUndefined();
  // Some turns without a cost: the sum is marked partial.
  expect(totals(view(paid("r1", 0.1), paid("r2")))).toMatchObject({ cost: 0.1, costPartial: true });
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
afterEach(() => unmount());

type Props = Parameters<typeof StatusBar>[0];
async function render(p: Partial<Props>) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const props: Props = { view: view(), ...p };
  await act(async () => root.render(<StatusBar {...props} />));
  unmount = () => (root.unmount(), el.remove());
  const text = () => [...el.querySelectorAll("[data-field]")].map((f) => `${f.getAttribute("data-field")}=${f.textContent}`);
  return { el, text, rerender: (n: Partial<Props>) => act(async () => root.render(<StatusBar {...props} {...n} />)) };
}

it("shows only branch, diff, In/Out/Cached and shells: no model, ctx, mode or plan field", async () => {
  const v = view(result("r1", 241_000, 453, 54_400_000, 100), bash("a", { command: "npm run dev", run_in_background: true }, "running"));
  const git: GitStatus = { branch: "main", added: 3, removed: 1 };
  const { text } = await render({ view: v, git: async () => git });
  expect(text()).toEqual(["branch=main", "diff=(+3,-1)", "in=In: 241.1k", "out=Out: 453", "cached=Cached: 54.4M", "shells=1 shell"]);
});

it("takes no row when no field has data (no git repo, no turn, no shells)", async () => {
  const { el } = await render({ git: async () => null });
  expect(el.querySelector('[data-testid="status-bar"]')).toBeNull();
});

it("keeps all its fields on every width (no sm-only hiding)", async () => {
  const { el } = await render({ view: view(result("r1", 1, 1, 1)), git: async () => ({ branch: "main", added: 0, removed: 0 }) });
  expect(el.innerHTML).not.toContain("max-sm:hidden");
});

it("refreshes git after each turn", async () => {
  const git = vi.fn(async (): Promise<GitStatus> => ({ branch: "main", added: git.mock.calls.length, removed: 0 }));
  const { text, rerender } = await render({ git, view: { ...view(), state: "running" } });
  expect(text()).toContain("diff=(+1,-0)");
  await rerender({ git, view: { ...view(), state: "idle" } });
  expect(text()).toContain("diff=(+2,-0)");
});

it("click on shells opens the list; the trigger keeps the visible text as accessible name (WCAG 2.5.3) and is at least 24px high (WCAG 2.5.8)", async () => {
  const v = view(bash("a", { command: "npm run dev", description: "Start dev server", run_in_background: true }, "running"));
  const { el } = await render({ view: v });
  const triggers = [...el.querySelectorAll<HTMLElement>("button")];
  expect(triggers.length).toBe(1);
  expect(triggers[0].className).toContain("min-h-6");
  expect(triggers[0].hasAttribute("aria-label")).toBe(false);
  const t = el.querySelector('[data-field="shells"]')!;
  expect(document.getElementById(t.getAttribute("aria-describedby")!)?.textContent).toBe("Background shells, show list");
  await act(async () => (t as HTMLElement).click());
  expect(document.querySelector('[data-testid="shells"]')?.textContent).toContain("Start dev server");
});

it("totals add aux turn results of the unloaded region", () => {
  const v = { ...view(result("r2", 10, 5, 2000)), older: { before: "u2", pos: 9 }, aux: [{ part: result("r1", 100, 20, 1000, 50), pos: 3 }] };
  expect(totals(v)).toMatchObject({ input: 160, output: 25, cached: 3000 });
});
