// Logs each decision to the server log and toasts the user on a block or a limit. Both are
// best-effort: a logging/toast failure must never affect the decision already made.
import type { OpencodeClient } from "./types.ts";

export interface DecisionLog {
  sessionID: string;
  permission: string;
  /** What the classifier said, or why nothing was decided. */
  verdict: "allow" | "block" | "ask" | "none" | "deferred";
  /** What happened to the ask: replied, already answered by someone else, or the reply failed. */
  outcome?: "replied" | "already-answered" | "failed";
  reason: string;
  ms: number;
}

export async function logDecision(client: OpencodeClient, log: DecisionLog): Promise<void> {
  const warn = log.verdict === "none" || log.verdict === "deferred" || log.verdict === "ask" || log.outcome === "failed";
  try {
    await client.app.log({
      body: {
        service: "auto-mode",
        level: warn ? "warn" : "info",
        message: `${log.verdict}${log.outcome && log.outcome !== "replied" ? ` (${log.outcome})` : ""} ${log.permission} (${log.ms}ms)${log.reason ? `: ${log.reason}` : ""}`,
        extra: { sessionID: log.sessionID, permission: log.permission, verdict: log.verdict, outcome: log.outcome, reason: log.reason, ms: log.ms },
      },
    });
  } catch {
    // best-effort
  }
}

export async function toast(client: OpencodeClient, message: string, variant: "info" | "success" | "warning" | "error"): Promise<void> {
  try {
    await client.tui.showToast({ body: { title: "auto mode", message, variant } });
  } catch {
    // best-effort
  }
}
