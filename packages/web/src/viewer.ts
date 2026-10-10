// Popup viewer targets (docs/spec.md "Session view UX"): what a card or a palette command opens.
import { createContext } from "react";
import type { SessionView, ToolCall } from "./store.ts";
import { wholeParts } from "./store.ts";
import { editFiles } from "./tools.ts";

/** `line`: first line to show (a Read's offset). `call`: the Edit/Write call whose diff shows. */
export type ViewerTarget = { kind: "file"; path: string; line?: number } | { kind: "diff"; call: ToolCall } | { kind: "plan"; plan: string } | { kind: "changes" };

/** What a tool card opens; undefined: no open button (other tools, input still streaming). */
export function cardTarget(call: ToolCall): ViewerTarget | undefined {
  const i = (call.input ?? {}) as Record<string, unknown>;
  if (call.tool === "Read" && typeof i.file_path === "string" && i.file_path) return { kind: "file", path: i.file_path, line: typeof i.offset === "number" && i.offset > 1 ? i.offset : undefined };
  if ((call.tool === "Edit" || call.tool === "Write") && editFiles(call.tool, call.input)) return { kind: "diff", call };
  if (call.tool === "ExitPlanMode" && typeof i.plan === "string" && i.plan) return { kind: "plan", plan: i.plan };
  return undefined;
}

/** The newest ExitPlanMode plan of the session (loaded parts and aux), undefined when none. */
export function latestPlan(view: SessionView): string | undefined {
  const parts = wholeParts(view);
  for (let n = parts.length - 1; n >= 0; n--) {
    const p = parts[n];
    if (p?.type === "tool_call" && p.tool === "ExitPlanMode") {
      const plan = (p.input as { plan?: unknown } | null)?.plan;
      if (typeof plan === "string" && plan) return plan;
    }
  }
  return undefined;
}

/** The file path an Edit/Write call targets. */
export const callPath = (call: ToolCall) => ((call.input as { file_path?: unknown } | null)?.file_path as string | undefined) ?? "";

/** Opens the popup viewer; undefined (default) = no open buttons (Focus page, tests without a provider). */
export const ViewerContext = createContext<((t: ViewerTarget) => void) | undefined>(undefined);
