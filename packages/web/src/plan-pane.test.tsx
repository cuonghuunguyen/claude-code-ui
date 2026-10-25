// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createAdapter, type Part } from "@claude-ui/protocol";
import { PermissionPanel } from "./permission.tsx";
import { applyEvent, emptySession } from "./store.ts";
import { PlanPane } from "./plan-pane.tsx";
import { PlanTabContext, planOfPart } from "./viewer.ts";
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
    m.rerender(<PlanPane view={undefined} failed label="Plan" onGoToRequest={() => {}} />);
    expect(m.el.querySelector('[data-testid="plan-failed"]')!.textContent).toBe("Could not load this session.");
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

describe("A plan Edit in the same message as ExitPlanMode (the CLI filled input.plan before the Edit ran)", () => {
  const recorded = () => {
    const adapter = createAdapter();
    const lines = readFileSync(`${import.meta.dirname}/../../protocol/test/fixtures/plan-file-same-message.jsonl`, "utf8").trim().split("\n");
    return lines.flatMap((l) => adapter.convert(JSON.parse(l) as never));
  };
  // The daemon's request: the CLI's input (empty) and the fold as display data.
  const request = { type: "permission_request", id: "perm", requestId: "r", toolUseId: "toolu_plan_exit", tool: "ExitPlanMode", input: {}, plan: "# Plan\n\n1. Create hello.txt with the content hi.\n2. ZEBRA-7731 verify hello.txt.", suggestions: [], settled: false } as Part;
  const shown = (parts: Part[]) => {
    const v = view(parts);
    const call = [...v.parts.values()].find((p) => p.type === "tool_call" && p.tool === "ExitPlanMode") as Extract<Part, { type: "tool_call" }>;
    const pane = mount(<PlanPane view={v} label="Plan" onGoToRequest={() => {}} />);
    const card = mount(<ToolCard call={call} plan={planOfPart(v, call)} awaiting />);
    const out = { pane: pane.el.textContent!, card: card.el.querySelector('[data-testid="plan"]')?.textContent ?? "" };
    pane.unmount();
    card.unmount();
    return out;
  };

  it("the Plan pane, the plan card and the approval panel show the revised plan once the Edit's result is in (live, in event order, and restored)", () => {
    const parts = recorded();
    const resultAt = parts.findIndex((p) => p.type === "tool_result" && p.toolUseId === "toolu_plan_edit");
    expect(resultAt).toBeGreaterThan(parts.findIndex((p) => p.type === "tool_call" && p.tool === "ExitPlanMode"));
    // Live: the Edit's result arrives after the ExitPlanMode tool_use, then the approval request.
    for (const at of [parts.length, parts.length + 1]) {
      const live = [...parts, request].slice(0, at);
      const { pane, card } = shown(live);
      expect(pane).toContain("ZEBRA-7731");
      expect(card).toContain("ZEBRA-7731");
      expect(pane).not.toContain("Verify: read hello.txt.");
      expect(card).not.toContain("Verify: read hello.txt.");
    }
    // The CLI's request (its input: the plan file read when the call ran) comes before the Edit's result: every view shows the request's plan.
    const fresh = { ...request, input: { plan: (request as { plan: string }).plan, planFilePath: "/home/user/.claude/plans/plan-only-write-a-quiet-fox.md" } } as Part;
    const early = [...parts.slice(0, resultAt), fresh];
    expect(early.some((p) => p.type === "tool_call" && p.tool === "Edit" && p.status === "running")).toBe(true);
    for (const v of [shown(early), shown([...early, ...parts.slice(resultAt)])]) {
      expect(v.pane).toContain("ZEBRA-7731");
      expect(v.card).toContain("ZEBRA-7731");
    }
    const panel = mount(<PermissionPanel part={{ ...request, input: { plan: "# Plan\n\n2. Verify: read hello.txt." } } as never} onRespond={() => {}} />);
    expect(panel.el.textContent).toContain("ZEBRA-7731");
    expect(panel.el.textContent).not.toContain("Verify: read hello.txt.");
    panel.unmount();
  });
});
