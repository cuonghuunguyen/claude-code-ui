// @vitest-environment jsdom
// GH-684: an OpenCode session offers its agents (build, plan, custom) in a chooser of their own, next to the permission chooser.
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ALL_CAPABILITIES, type EngineCapabilities } from "@claude-ui/protocol";
import { agentLabel, nextAgent, PromptToolbar } from "./toolbar.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;
Element.prototype.scrollIntoView ??= () => {};

const OPENCODE: EngineCapabilities = { ...ALL_CAPABILITIES, permissionModes: ["default", "acceptEdits", "bypassPermissions"], agents: true, effort: false };
const AGENTS = [{ name: "build" }, { name: "plan", description: "Plans, does not edit" }, { name: "review", description: "Reviews code" }];
let unmount = () => {};
afterEach(() => unmount());

const phone = (on: boolean) => {
  const mm = window.matchMedia;
  window.matchMedia = ((q: string) => ({ matches: on && q.includes("40rem"), media: q, addEventListener() {}, removeEventListener() {} })) as never;
  return () => void (window.matchMedia = mm);
};

async function render(over: Partial<ComponentProps<typeof PromptToolbar>> = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  const props: ComponentProps<typeof PromptToolbar> = {
    models: [{ value: "default", displayName: "Default (recommended)", description: "" }],
    caps: OPENCODE,
    model: "default",
    onModel: () => {},
    effort: "default",
    onEffort: () => {},
    mode: "default",
    modes: ["default", "acceptEdits"],
    onMode: () => {},
    agent: "plan",
    agentList: AGENTS,
    onAgent: () => {},
    onAttach: () => {},
    state: "idle",
    hasInput: false,
    onSend: () => {},
    onStop: () => {},
    onFocusLost: () => {},
    ...over,
  };
  await act(async () => root.render(<PromptToolbar {...props} />));
  unmount = () => (root.unmount(), el.remove());
  return { el, $: (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`) };
}
const options = () => [...document.querySelectorAll<HTMLElement>("[role=option]")];

it("nextAgent wraps around and starts at the first for an unknown agent", () => {
  expect(nextAgent(["build", "plan", "review"], "build")).toBe("plan");
  expect(nextAgent(["build", "plan", "review"], "review")).toBe("build");
  expect(nextAgent(["build", "plan"], "gone")).toBe("build");
  expect(nextAgent([], "build")).toBe("build");
  expect(agentLabel("review")).toBe("Review");
});

it("an Engine with agents shows the agent chooser before the permission chooser", async () => {
  const { $ } = await render();
  const agent = $("agent-select")!;
  expect(agent.compareDocumentPosition($("mode-select")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(agent.textContent).toContain("Plan");
  expect(agent.getAttribute("aria-label")).toBe("Plan, Agent (Shift+Tab)");
  expect($("mode-select")!.getAttribute("aria-label")).not.toContain("Shift+Tab");
});

it("picking an agent calls onAgent; the options carry the agent's description", async () => {
  const onAgent = vi.fn();
  const { $ } = await render({ onAgent });
  await act(async () => $("agent-select")!.click());
  expect(options().map((o) => o.textContent)).toEqual(["Build", "Plan", "Review"]);
  expect(options().map((o) => o.getAttribute("title"))).toEqual([null, "Plans, does not edit", "Reviews code"]);
  await act(async () => options()[2]!.click());
  expect(onAgent).toHaveBeenCalledWith("review");
});

it("no agent chooser without the flag or without agents; the permission chooser keeps its shortcut then", async () => {
  const a = await render({ caps: { ...OPENCODE, agents: undefined } });
  expect(a.$("agent-select")).toBeNull();
  expect(a.$("mode-select")!.getAttribute("aria-label")).toContain("Shift+Tab");
  unmount();
  unmount();
  const c = await render({ caps: { ...OPENCODE, agents: undefined }, onAgent: undefined });
  expect(c.$("agent-select")).toBeNull();
});

it("GH-684: before the list arrives the chooser shows the current agent; after a failure it adds a Retry entry that asks again", async () => {
  const onRetryAgents = vi.fn();
  const onAgent = vi.fn();
  const a = await render({ agentList: undefined, agent: "build", onAgent });
  expect(a.$("agent-select")!.textContent).toContain("Build");
  await act(async () => a.$("agent-select")!.click());
  expect(options().map((o) => o.textContent)).toEqual(["Build"]);
  await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  unmount();
  const b = await render({ agentList: [], agent: "plan", agentsFailed: true, onRetryAgents, onAgent });
  expect(b.$("agent-select")!.textContent).toContain("Plan");
  await act(async () => b.$("agent-select")!.click());
  expect(options().map((o) => o.textContent)).toEqual(["Plan", "Retry loading agents"]);
  await act(async () => options()[1]!.click());
  expect(onRetryAgents).toHaveBeenCalledTimes(1);
  expect(onAgent).not.toHaveBeenCalled();
});

it("the permission chooser of an OpenCode session offers no Plan mode", async () => {
  const { $ } = await render();
  await act(async () => $("mode-select")!.click());
  expect(options().map((o) => o.textContent)).toEqual(["Ask before edits", "Edit automatically"]);
});

it("phone: the settings chip reads Agent · Mode · Model and its popover starts with the agent chooser", async () => {
  const back = phone(true);
  try {
    const { $ } = await render();
    expect($("agent-select")).toBeNull();
    const chip = $("session-settings")!;
    expect(chip.textContent).toMatch(/^Plan · Ask · Default model/);
    expect(chip.getAttribute("aria-label")!.startsWith(chip.textContent!)).toBe(true);
    expect(chip.getAttribute("aria-label")).toContain("agent Plan");
    await act(async () => chip.click());
    const popup = document.querySelector<HTMLElement>('[data-testid="session-settings-popup"]')!;
    const first = popup.querySelector<HTMLElement>("[data-testid]")!;
    expect(first.getAttribute("data-testid")).toBe("agent-select");
  } finally {
    back();
  }
});
