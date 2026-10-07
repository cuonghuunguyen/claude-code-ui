import { constants } from "node:os";

/**
 * Leaves the reason of a daemon exit in the log. Uses the monitor event, so Node's own policy stays: an uncaught exception, and an unhandled rejection
 * (Node 15+ raises it as one), still end the process with code 1 after the line is written. A swallowed fault would leave the daemon in an unknown state.
 */
export function logExit(proc: Pick<NodeJS.Process, "on">, log: (line: string) => void) {
  proc.on("uncaughtExceptionMonitor", (err, origin) => log(`claude-ui daemon: ${origin}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
  proc.on("exit", (code) => log(`claude-ui daemon: exit, code ${code}`));
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
/** SIGINT, SIGTERM, SIGHUP: `cleanup`, then exit 128 + the signal number (as a shell reports it). Through exit, so the exit line is logged. */
export function exitOnSignal(proc: Pick<NodeJS.Process, "once" | "exit">, cleanup: () => void = () => {}) {
  for (const s of SIGNALS) proc.once(s, () => { try { cleanup(); } finally { proc.exit(128 + constants.signals[s]); } });
}
