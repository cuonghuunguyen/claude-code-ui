// Popup viewer targets (docs/spec.md "Session view UX"): what a card or a palette command opens.
import { createContext, useCallback, useRef } from "react";
import type { SessionView, ToolCall } from "./store.ts";
import { pendingPermission, wholeParts } from "./store.ts";
import { editFiles } from "./tools.ts";

/** `line`: first line to show (a Read's offset). `call`: the Edit/Write call whose diff shows. */
export type ViewerTarget = { kind: "file"; path: string; line?: number } | { kind: "diff"; call: ToolCall } | { kind: "plan"; plan: string } | { kind: "changes" };

/** A file target opens the file dialog; every other target opens the popup viewer. */
export const isFileTarget = (t: ViewerTarget): t is Extract<ViewerTarget, { kind: "file" }> => t.kind === "file";

/** What a tool card opens; undefined: no open button (other tools, input still streaming). */
export function cardTarget(call: ToolCall): ViewerTarget | undefined {
  const i = (call.input ?? {}) as Record<string, unknown>;
  if (call.tool === "Read" && typeof i.file_path === "string" && i.file_path) return { kind: "file", path: i.file_path, line: typeof i.offset === "number" && i.offset > 1 ? i.offset : undefined };
  if ((call.tool === "Edit" || call.tool === "Write") && editFiles(call.tool, call.input)) return { kind: "diff", call };
  if (call.tool === "ExitPlanMode" && typeof i.plan === "string" && i.plan) return { kind: "plan", plan: i.plan };
  return undefined;
}

/** The newest ExitPlanMode call with a plan (loaded parts and aux), undefined when none. */
export function latestPlanCall(view: SessionView): ToolCall | undefined {
  const parts = wholeParts(view);
  for (let n = parts.length - 1; n >= 0; n--) {
    const p = parts[n];
    if (p?.type === "tool_call" && p.tool === "ExitPlanMode") {
      const plan = (p.input as { plan?: unknown } | null)?.plan;
      if (typeof plan === "string" && plan) return p;
    }
  }
  return undefined;
}

/** The newest ExitPlanMode plan of the session (loaded parts and aux), undefined when none. */
export const latestPlan = (view: SessionView): string | undefined => (latestPlanCall(view)?.input as { plan?: string } | undefined)?.plan;

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
