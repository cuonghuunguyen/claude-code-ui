// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import type { ContextUsage } from "@claude-ui/protocol";
import { ContextMeter } from "./context-meter.tsx";
import { applyEvent, emptySession, timeline } from "./store.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const usage: ContextUsage = {
  totalTokens: 25815,
  maxTokens: 1000000,
  percentage: 3,
  categories: [
    { name: "System tools", tokens: 5161, kind: "used" },
    { name: "Messages", tokens: 20654, kind: "used" },
    { name: "Autocompact buffer", tokens: 33000, kind: "buffer" },
    { name: "Free space", tokens: 941185, kind: "free" },
  ],
};

let unmount = () => {};
afterEach(() => unmount());

async function render(u: ContextUsage) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<ContextMeter usage={u} />));
  unmount = () => (root.unmount(), el.remove());
  return { el, rerender: (n: ContextUsage) => act(async () => root.render(<ContextMeter usage={n} />)) };
}

it("shows used / max tokens and percent, full numbers in its label", async () => {
  const { el } = await render(usage);
  const meter = el.querySelector<HTMLElement>('[data-testid="context-meter"]')!;
  expect(meter.textContent).toBe("25.8K / 1M · 3%");
  expect(meter.getAttribute("aria-label")).toBe("Context window: 25,815 of 1,000,000 tokens (3%), show breakdown");
});

it("click shows the per-category breakdown: tokens and share of the window, used categories in the bar", async () => {
  const { el } = await render(usage);
  await act(async () => el.querySelector<HTMLElement>('[data-testid="context-meter"]')!.click());
  const pop = document.querySelector<HTMLElement>('[data-testid="context-breakdown"]')!;
  expect(pop.textContent).toContain("25,815 / 1,000,000 tokens · 3%");
  const rows = [...pop.querySelectorAll("li")].map((li) => li.textContent);
  expect(rows).toEqual(["System tools5,1610.5%", "Messages20,6542.1%", "Autocompact buffer33,0003.3%", "Free space941,18594.1%"]);
  // Buffer and free space are not used: no bar segment.
  expect([...pop.querySelectorAll('[data-testid="context-bar"] > span')].map((s) => s.getAttribute("title"))).toEqual(["System tools", "Messages"]);
});

it("bar classifies categories by SDK kind, not by English name", async () => {
  const renamed = { ...usage, categories: [{ name: "Messages", tokens: 20654, kind: "used" as const }, { name: "Unused window", tokens: 941185, kind: "free" as const }] };
  const { el } = await render(renamed);
  await act(async () => el.querySelector<HTMLElement>('[data-testid="context-meter"]')!.click());
  expect([...document.querySelectorAll('[data-testid="context-bar"] > span')].map((s) => s.getAttribute("title"))).toEqual(["Messages"]);
});

it("a category keeps its colour when another category is absent (colour by name, not list position)", async () => {
  const colors = async (u: ContextUsage) => {
    const { el } = await render(u);
    await act(async () => el.querySelector<HTMLElement>('[data-testid="context-meter"]')!.click());
    const got = Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-testid="context-bar"] > span')].map((s) => [s.title, s.style.background]));
    unmount();
    return got;
  };
  const withMcp = { ...usage, categories: [{ name: "MCP tools", tokens: 900, kind: "used" as const }, ...usage.categories] };
  const a = await colors(usage);
  const b = await colors(withMcp);
  expect(b["Messages"]).toBe(a["Messages"]);
  expect(b["System tools"]).toBe(a["System tools"]);
  expect(new Set(Object.values(b)).size).toBe(3);
});

it("ring draws track and progress with the OpenCode ring tokens", async () => {
  const { el } = await render(usage);
  const [track, progress] = el.querySelectorAll("circle");
  expect(track!.getAttribute("class")).toContain("stroke-ring-track");
  expect(progress!.getAttribute("class")).toContain("stroke-ring-progress");
});

it("follows a new usage (next turn, compaction)", async () => {
  const { el, rerender } = await render(usage);
  await rerender({ ...usage, totalTokens: 3760, percentage: 0 });
  expect(el.querySelector('[data-testid="context-meter"]')!.textContent).toBe("3.8K / 1M · 0%");
});

it("the store keeps the latest context_usage part outside the timeline", () => {
  let s = emptySession();
  s = applyEvent(s, { type: "event", sessionId: "s", seq: 1, part: { type: "context_usage", id: "context_usage", usage } });
  s = applyEvent(s, { type: "event", sessionId: "s", seq: 2, part: { type: "context_usage", id: "context_usage", usage: { ...usage, percentage: 4 } } });
  expect(s.contextUsage?.percentage).toBe(4);
  expect(timeline(s)).toEqual([]);
  expect(s.lastSeq).toBe(2);
});

it("the breakdown shows OpenCode's Context tab stats (input, output, cache read/write tokens, total cost) in 12px text", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const stats = { input: 1250, output: 300, cached: 5000, uncached: 1200, cacheWrite: 50, cost: 0.1234 };
  await act(async () => root.render(<ContextMeter usage={usage} stats={stats} />));
  unmount = () => (root.unmount(), el.remove());
  await act(async () => el.querySelector<HTMLElement>('[data-testid="context-meter"]')!.click());
  const pop = document.querySelector<HTMLElement>('[data-testid="context-breakdown"]')!;
  const stat = [...pop.querySelectorAll('[data-testid="context-stats"] > div')].map((d) => d.textContent);
  expect(stat).toEqual(["Input tokens1,200", "Output tokens300", "Cache tokens (read/write)5,000 / 50", "Total cost$0.12"]);
  expect(pop.querySelector("li")!.className).toContain("text-[12px]");
  // A sum that misses some turns' cost says it is a lower bound.
  await act(async () => root.render(<ContextMeter usage={usage} stats={{ ...stats, costPartial: true }} />));
  expect([...pop.querySelectorAll('[data-testid="context-stats"] > div')].at(-1)!.textContent).toBe("Total cost≥ $0.12");
});

it("hover or focus shows OpenCode's context tooltip: tokens used / max, usage, cost (the narrow toolbar shows only the ring and percent)", async () => {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(<ContextMeter usage={usage} stats={{ input: 0, output: 0, cached: 0, uncached: 0, cacheWrite: 0, cost: 0.5 }} />));
  unmount = () => (root.unmount(), el.remove());
  const meter = el.querySelector<HTMLElement>('[data-testid="context-meter"]')!;
  const tip = document.getElementById(meter.getAttribute("aria-describedby")!)!;
  expect(tip.getAttribute("role")).toBe("tooltip");
  expect([...tip.children].map((r) => r.textContent)).toEqual(["Tokens25,815 / 1,000,000", "Usage3%", "Cost$0.50"]);
  // Shown on hover and keyboard focus, hidden while the breakdown is open; no native title on top of it.
  expect(tip.className).toMatch(/group-hover:/);
  expect(tip.className).toMatch(/group-has-focus-visible:/);
  expect(meter.hasAttribute("title")).toBe(false);
});
