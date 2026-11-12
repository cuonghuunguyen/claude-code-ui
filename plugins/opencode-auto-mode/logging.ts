// Logs each decision to the server log and toasts the user on a block or a limit. Both are
// best-effort: a logging/toast failure must never affect the decision already made.
import type { OpencodeClient } from "./types.ts";

export interface DecisionLog {
  sessionID: string;
  permission: string;
  verdict: "allow" | "block" | "none";
  reason: string;
  ms: number;
}

export async function logDecision(client: OpencodeClient, log: DecisionLog): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: "auto-mode",
        level: log.verdict === "none" ? "warn" : "info",
        message: `${log.verdict} ${log.permission} (${log.ms}ms)${log.reason ? `: ${log.reason}` : ""}`,
        extra: { sessionID: log.sessionID, permission: log.permission, verdict: log.verdict, reason: log.reason, ms: log.ms },
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
