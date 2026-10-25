// Popup viewer targets (docs/spec.md "Session view UX"): what a card or a palette command opens.
import { planOfCall, type Part } from "@claude-ui/protocol";
import { createContext, useCallback, useRef } from "react";
import type { SessionView, ToolCall } from "./store.ts";
import { pendingPermission, wholeParts } from "./store.ts";
import { editFiles } from "./tools.ts";

/** `line`: first line to show (a Read's offset). `call`: the Edit/Write call whose diff shows. */
export type ViewerTarget = { kind: "file"; path: string; line?: number } | { kind: "diff"; call: ToolCall } | { kind: "plan"; plan: string } | { kind: "changes" };

/** A file target opens the file dialog; every other target opens the popup viewer. */
export const isFileTarget = (t: ViewerTarget): t is Extract<ViewerTarget, { kind: "file" }> => t.kind === "file";

/** What a tool card opens; undefined: no open button (other tools, input still streaming). `plan`: an ExitPlanMode call's plan (planOfPart), else its `input.plan`. */
export function cardTarget(call: ToolCall, plan?: string): ViewerTarget | undefined {
  const i = (call.input ?? {}) as Record<string, unknown>;
  if (call.tool === "Read" && typeof i.file_path === "string" && i.file_path) return { kind: "file", path: i.file_path, line: typeof i.offset === "number" && i.offset > 1 ? i.offset : undefined };
  if ((call.tool === "Edit" || call.tool === "Write") && editFiles(call.tool, call.input)) return { kind: "diff", call };
  const p = plan || i.plan;
  if (call.tool === "ExitPlanMode" && typeof p === "string" && p) return { kind: "plan", plan: p };
  return undefined;
}

/** The plan shown for the approval request of call `toolUseId`: the CLI's own read of its plan file when the call ran (daemon: Session.planField). */
function requestPlan(parts: readonly Part[], toolUseId: string): string | undefined {
  for (let n = parts.length - 1; n >= 0; n--) {
    const p = parts[n]!;
    if (p.type !== "permission_request" || p.tool !== "ExitPlanMode" || p.toolUseId !== toolUseId) continue;
    const plan = p.plan || (p.input as { plan?: unknown } | null)?.plan;
    if (typeof plan === "string" && plan) return plan;
  }
  return undefined;
}

/**
 * The plan of the ExitPlanMode call at `parts[at]`, the one rule of the Plan pane, the plan card and the approval panel: the plan of the call's approval
 * request (the CLI read its plan file when the call ran, after an Edit of the same message), else the plan-file fold (planOfCall; a restored session has no request).
 */
function planAt(view: SessionView, parts: readonly Part[], at: number): string | undefined {
  const call = parts[at];
  if (call?.type !== "tool_call" || call.tool !== "ExitPlanMode") return undefined;
  return requestPlan(parts, call.toolUseId) ?? planOfCall(parts, at, view.planDirs);
}

/** The plan of the ExitPlanMode call `call` in the session (planAt over the loaded parts and aux). */
export function planOfPart(view: SessionView, call: ToolCall): string | undefined {
  if (call.tool !== "ExitPlanMode") return undefined;
  const parts = wholeParts(view);
  return planAt(view, parts, parts.findIndex((p) => p.id === call.id));
}

/** The newest ExitPlanMode call whose plan is known, with the plan: its own `input.plan`, else the plan file the model wrote (Claude Code 2.1.294 calls it with an empty input). Loaded parts and aux. */
function findPlan(view: SessionView): { call?: ToolCall; plan: string } | undefined {
  const parts = wholeParts(view);
  for (let n = parts.length - 1; n >= 0; n--) {
    const p = parts[n];
    if (p?.type !== "tool_call" || p.tool !== "ExitPlanMode") continue;
    const plan = planAt(view, parts, n);
    if (plan) return { call: p, plan };
  }
  // The approval request carried the plan while the call did not (and no plan file Write was seen).
  for (let n = parts.length - 1; n >= 0; n--) {
    const p = parts[n];
    const plan = p?.type === "permission_request" && p.tool === "ExitPlanMode" ? p.plan || (p.input as { plan?: unknown } | null)?.plan : undefined;
    if (typeof plan === "string" && plan) return { plan };
  }
  return undefined;
}
export const latestPlanCall = (view: SessionView): ToolCall | undefined => findPlan(view)?.call;

/** The newest ExitPlanMode plan of the session, undefined when none. */
export const latestPlan = (view: SessionView): string | undefined => findPlan(view)?.plan;

/** The plan approval waits for an answer. */
export const planWaiting = (view: SessionView): boolean => pendingPermission(view)?.tool === "ExitPlanMode";

/** "Open in tab" of the plan card and the plan permission panel; absent = no button (Focus page). */
export const PlanTabContext = createContext<(() => void) | undefined>(undefined);

/** The file path an Edit/Write call targets. */
export const callPath = (call: ToolCall) => ((call.input as { file_path?: unknown } | null)?.file_path as string | undefined) ?? "";

/** Opens the popup viewer; undefined (default) = no open buttons (Focus page, tests without a provider). */
export type OpenViewer = (t: ViewerTarget, opener?: HTMLElement | null) => void;
export const ViewerContext = createContext<OpenViewer | undefined>(undefined);

export type ViewerState = { target: ViewerTarget; sessionId: string; cwd: string; opener: HTMLElement | null };

/**
 * A callback of stable identity (it is the ViewerContext value: a new one per App render would re-render every tool card)
 * that opens the viewer for the latest shown session. `opener`: the clicked element (Safari and Firefox on macOS do not
 * focus a button on click); without it the focused element.
 */
export function useOpenViewer(shown: { id: string; cwd: string } | undefined, set: (v: ViewerState) => void): OpenViewer {
  const latest = useRef({ shown, set });
  latest.current = { shown, set };
  return useCallback((target, opener) => {
    const { shown, set } = latest.current;
    if (shown) set({ target, sessionId: shown.id, cwd: shown.cwd, opener: opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null) });
  }, []);
}
