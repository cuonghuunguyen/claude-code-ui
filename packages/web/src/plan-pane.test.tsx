// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { Part } from "@claude-ui/protocol";
import { applyEvent, emptySession } from "./store.ts";
import { PlanPane } from "./plan-pane.tsx";
import { PlanTabContext } from "./viewer.ts";
import { ToolCard } from "./tool-card.tsx";
import { ViewerContext } from "./viewer.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as never;

const planCall = (id: string, plan: string): Part => ({ type: "tool_call", id, toolUseId: id, tool: "ExitPlanMode", input: { plan }, status: "done" });
const perm = (settled = false): Part => ({ type: "permission_request", id: "perm", requestId: "r", toolUseId: "p1", tool: "ExitPlanMode", input: { plan: "x" }, suggestions: [], settled }) as Part;
const view = (parts: Part[]) => parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s1", seq: i + 1, part }), emptySession());

function mount(node: React.ReactNode) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  act(() => root.render(node));
  return { el, root, rerender: (n: React.ReactNode) => act(() => root.render(n)), unmount: () => (act(() => root.unmount()), el.remove()) };
}

describe("PlanPane", () => {
  it("shows the newest plan markdown and updates when a newer plan arrives", () => {
    const m = mount(<PlanPane view={view([planCall("a", "# Old plan")])} label="Plan" onGoToRequest={() => {}} />);
    expect(m.el.querySelector('[data-testid="plan-pane"]')!.getAttribute("aria-label")).toBe("Plan");
    expect(m.el.textContent).toContain("Old plan");
    m.rerender(<PlanPane view={view([planCall("a", "# Old plan"), planCall("b", "# Newer plan")])} label="Plan" onGoToRequest={() => {}} />);
    expect(m.el.textContent).toContain("Newer plan");
    expect(m.el.textContent).not.toContain("Old plan");
    m.unmount();
  });

  it('shows "Waiting for your answer" and Go to request while the plan approval is pending; no approve buttons', () => {
    const go = vi.fn();
    const m = mount(<PlanPane view={view([planCall("a", "# P"), perm()])} label="Plan" onGoToRequest={go} />);
    expect(m.el.querySelector('[data-testid="plan-waiting"]')!.textContent).toContain("Waiting for your answer");
    act(() => m.el.querySelector<HTMLButtonElement>('[data-testid="plan-go-to-request"]')!.click());
    expect(go).toHaveBeenCalledTimes(1);
    expect(m.el.textContent).not.toMatch(/Yes|Allow|Deny|Approve/);
    m.rerender(<PlanPane view={view([planCall("a", "# P"), perm(true)])} label="Plan" onGoToRequest={go} />);
    expect(m.el.querySelector('[data-testid="plan-waiting"]')).toBeNull();
    m.unmount();
  });

  it('shows "No plan in this session yet." without a plan and "Loading plan…" without a view', () => {
    const m = mount(<PlanPane view={view([])} label="Plan" onGoToRequest={() => {}} />);
    expect(m.el.querySelector('[data-testid="plan-empty"]')!.textContent).toBe("No plan in this session yet.");
    m.rerender(<PlanPane view={undefined} label="Plan" onGoToRequest={() => {}} />);
    expect(m.el.textContent).toBe("Loading plan…");
    m.unmount();
  });
});

describe("ExitPlanMode card: Open in tab", () => {
  it("shows Open in tab only inside a PlanTabContext and calls it", () => {
    const call = planCall("a", "# P") as Extract<Part, { type: "tool_call" }>;
    const card = <ToolCard call={call} />;
    const bare = mount(<ViewerContext value={() => {}}>{card}</ViewerContext>);
    expect(bare.el.querySelector('[data-testid="plan-open-tab"]')).toBeNull();
    bare.unmount();
    const open = vi.fn();
    const m = mount(
      <ViewerContext value={() => {}}>
        <PlanTabContext value={open}>{card}</PlanTabContext>
      </ViewerContext>,
    );
    const btn = m.el.querySelector<HTMLButtonElement>('[data-testid="plan-open-tab"]')!;
    expect(btn.getAttribute("aria-label")).toBe("Open plan in tab");
    expect(btn.className).toContain("pointer-coarse:size-11");
    act(() => btn.click());
    expect(open).toHaveBeenCalledTimes(1);
    m.unmount();
  });
});
