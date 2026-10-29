// Shells list (GH-442; Claude Code /tasks): the shown session's background shells.
import { isBackgroundShell, type ToolStatus } from "@claude-ui/protocol";
import { wholeParts, type SessionView, type ToolCall } from "./store.ts";

export const isRunningShell = (c: ToolCall) => c.status === "pending" || c.status === "running";

/** Background shells of the session (any status, subagent runs included): running first, then the rest; newest first in each group. */
export function shellsOf(v: SessionView): ToolCall[] {
  const all = wholeParts(v).filter((p): p is ToolCall => isBackgroundShell(p)).reverse();
  return [...all.filter(isRunningShell), ...all.filter((c) => !isRunningShell(c))];
}

/** Claude Code's task states. */
export const SHELL_STATUS: Record<ToolStatus, string> = { pending: "Running", running: "Running", done: "Completed", error: "Failed", denied: "Failed", stopped: "Killed" };

export const shellInput = (c: ToolCall) => c.input as { command?: string; description?: string };
