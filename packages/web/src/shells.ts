// Shells list (GH-442; Claude Code /tasks): the shown session's background shells.
import { isBackgroundShell, type Part, type ToolStatus } from "@claude-ui/protocol";
import { t } from "./i18n.ts";
import { wholeParts, type SessionView, type ToolCall } from "./store.ts";

export const isRunningShell = (c: ToolCall) => c.status === "pending" || c.status === "running";

/** `text`: a bash mode shell (GH-485): its output is the part's own, no file read. */
export type Shell = ToolCall & { text?: string };

export const bashShell = (b: Extract<Part, { type: "bash" }>): Shell => ({
  type: "tool_call", id: b.id, toolUseId: b.id, tool: "Bash", input: { command: b.command }, status: b.status === "running" ? "running" : b.status,
  ...(b.exitCode !== undefined && { exitCode: b.exitCode }), text: [b.stdout, b.stderr].filter(Boolean).join("\n"),
});

/** Background shells of the session (any status, subagent runs and bash mode commands moved to the background included): running first, then the rest; newest first in each group. */
export function shellsOf(v: SessionView): Shell[] {
  const all = wholeParts(v).flatMap((p): Shell[] => (isBackgroundShell(p) ? [p] : p.type === "bash" && p.shell ? [bashShell(p)] : [])).reverse();
  return [...all.filter(isRunningShell), ...all.filter((c) => !isRunningShell(c))];
}

/** Claude Code's task states. */
export const shellStatus = (s: ToolStatus): string => t(s === "pending" || s === "running" ? "files.shell.running" : s === "done" ? "files.shell.completed" : s === "stopped" ? "files.shell.killed" : "files.shell.failed");

export const shellInput = (c: ToolCall) => c.input as { command?: string; description?: string };
