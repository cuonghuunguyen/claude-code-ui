// What the e2e steps see of the Hub inside the throwaway SSH host (ADR 0009: one Hub per machine). Pure Node, no Playwright import.
// A Hub is a node process running `cli.js` that is not the bridge (`side --attach`) and not `update`; the pgrep pattern `[c]li.js` never matches its own shell.
import { execFileSync } from "node:child_process";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const run = (cmd: string, args: string[]) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};
export const inHost = (container: string, script: string) => run("docker", ["exec", container, "sh", "-c", script]);

/** The PIDs of the Hubs of the host (not the bridges), sorted. */
export const hubPids = (container: string): string[] =>
  inHost(container, "pgrep -af '[c]li.js'")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/ (side|update)( |$)/.test(l.replace(/^\d+ /, "")))
    .map((l) => l.split(" ")[0]!)
    .sort();
