// What the e2e steps see of the Hub inside the throwaway SSH host (ADR 0009: one Hub per machine). Pure Node, no Playwright import.
// A Hub is a node process running `cli.js` that is not the bridge (`side --attach`) and not `update`; the pgrep pattern `[c]li.js` never matches its own shell.
import { execFileSync } from "node:child_process";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Port of the Hub the user starts in the host (the attach-started Hub listens on any free port). */
export const USER_HUB_PORT = 4999;

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

export type HubFile = { port: number; pid: number; version: string; attach?: string; schema?: [number, number]; startedBy?: string };
/** `~/.config/claude-ui/daemon.json` of the host, or undefined. */
export const hubFile = (container: string): HubFile | undefined => {
  try {
    return JSON.parse(inHost(container, "cat ~/.config/claude-ui/daemon.json")) as HubFile;
  } catch {
    return undefined;
  }
};

/** Shell fragment: `node` and `cli.js` of the one install of the host (a bundle install carries its own node). */
const INSTALL = 'dir=$(ls -d ~/.local/share/claude-ui/side/*/ | head -n 1); dir=${dir%/}; cli="$dir/node_modules/claude-code-ui/dist/cli.js"; n=node; [ -x "$dir/node/bin/node" ] && n="$dir/node/bin/node"';

/** Starts a Hub of the installed build in the host: by the user (`--port 4999`, the PID in /tmp/e2e-user.pid) or as an attach does (`--port 0`, `CLAUDE_UI_STARTED_BY=attach`). `env`: extra variables. */
export function startHub(container: string, by: "user" | "attach", env = "") {
  const lead = by === "attach" ? `CLAUDE_UI_STARTED_BY=attach ${env}` : env;
  const args = by === "attach" ? "--no-open --port 0" : `--no-open --no-update-check --port ${USER_HUB_PORT}`;
  inHost(container, `${INSTALL}; ${lead} nohup "$n" "$cli" ${args} </dev/null >/tmp/e2e-${by}-hub.log 2>&1 & echo $! > /tmp/e2e-${by}-hub.pid`);
}

/** Ends every Hub of the host (TERM by PID) and waits until none runs. A Hub removes its own daemon.json and attach socket on exit. */
export async function endHubs(container: string) {
  for (const p of hubPids(container)) inHost(container, `kill -TERM ${p}`);
  const end = Date.now() + 30_000;
  while (hubPids(container).length && Date.now() < end) await sleep(500);
  for (const p of hubPids(container)) inHost(container, `kill -KILL ${p}`);
  await sleep(500);
}
