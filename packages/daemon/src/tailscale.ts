import type { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Rejects with err.code "ENOENT" when the file is missing, err.stderr otherwise. */
export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>;

/** CLI candidates in order: PATH first, then the OS install path. */
export function cliCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") return ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
  // Install path first: Windows looks in the current directory before PATH for a bare name.
  if (platform === "win32") return [`${env.ProgramFiles ?? "C:\\Program Files"}\\Tailscale\\tailscale.exe`, "tailscale"];
  return ["tailscale"];
}

export function installHint(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return "Tailscale is not installed: https://tailscale.com/download/mac (the CLI is inside the app)";
  if (platform === "win32") return "Tailscale is not installed: https://tailscale.com/download/windows";
  const linux = "Tailscale is not installed: curl -fsSL https://tailscale.com/install.sh | sh, then sudo tailscale up and sudo tailscale set --operator=$USER";
  return env.WSL_DISTRO_NAME ? `Tailscale is not installed in this WSL distro. ${linux.replace("Tailscale is not installed: ", "")}\nOr run claude-ui on Windows: it reaches WSL projects too (README Windows with WSL).` : linux;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});

/** status --json -> hostname or the error message (next step). */
export function readStatus(json: unknown): { hostname: string } | { error: string } {
  const j = obj(json);
  const state = String(j.BackendState ?? "");
  if (state === "NeedsMachineAuth") return { error: "Tailscale is NeedsMachineAuth: approve this machine in the Tailscale admin console" };
  if (state !== "Running") return { error: `Tailscale is ${state || "not running"}: run "tailscale up" or connect in the Tailscale app` };
  const dns = String(obj(j.Self).DNSName ?? "").replace(/\.$/, "");
  const domains = j.CertDomains;
  if (!dns || !Array.isArray(domains) || domains.length === 0) return { error: "Enable MagicDNS and HTTPS certificates: https://login.tailscale.com/admin/dns" };
  return { hostname: dns };
}

/** serve status --json for `host`:443 -> "free" | "ours" (already proxies to the port) | error message (funnel on, other target). */
export function readServe(json: unknown, host: string, port: number): "free" | "ours" | { error: string } {
  const j = obj(json);
  const key = `${host}:443`;
  // Foreground serve/funnel sessions (the CLI default) keep their config under Foreground, one sub-config per session.
  const fg = Object.values(obj(j.Foreground)).map(obj);
  if ([j, ...fg].some((c) => obj(c.AllowFunnel)[key])) return { error: `Tailscale Funnel is on for ${key} (public internet). Turn it off: tailscale funnel --https=443 off (or stop the tailscale funnel/serve command running in a terminal)` };
  // A foreground session ends with its command, so even one that proxies to our port is not ours.
  if (fg.some((c) => Object.keys(obj(obj(c.Web)[key])).length || obj(c.TCP)["443"])) return { error: `https://${host} is served by a foreground tailscale serve/funnel command (tailscale serve status). Stop that command first` };
  const web = obj(obj(j.Web)[key]);
  if (!Object.keys(web).length && !obj(j.TCP)["443"]) return "free";
  const proxy = String(obj(obj(web.Handlers)["/"]).Proxy ?? "").replace(/\/$/, "");
  if (proxy === `http://127.0.0.1:${port}` || proxy === `http://localhost:${port}`) return "ours";
  return { error: `https://${host} already serves something else (tailscale serve status). Free it: tailscale serve --https=443 off` };
}

/** Finds the CLI (first candidate that does not ENOENT on `status --json`), then checks status and serve config. */
export async function tailscalePreflight(o: { port: number; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; exec: Exec }): Promise<{ cli: string; hostname: string; serve: boolean } | { error: string }> {
  let cli: string | undefined;
  let statusOut = "";
  for (const c of cliCandidates(o.platform, o.env)) {
    try {
      statusOut = (await o.exec(c, ["status", "--json"])).stdout;
      cli = c;
      break;
    } catch (e) {
      const err = e as { code?: string; stderr?: string; message?: string };
      if (err.code === "ENOENT") continue;
      const msg = (err.stderr || err.message || "").toString().trim();
      return { error: `${msg}\nStart Tailscale (Linux: sudo systemctl start tailscaled; Windows/macOS: open the Tailscale app)` };
    }
  }
  if (!cli) return { error: installHint(o.platform, o.env) };
  let status;
  try {
    status = readStatus(JSON.parse(statusOut));
  } catch {
    return { error: "could not read the output of tailscale status --json" };
  }
  if ("error" in status) return status;
  let served;
  try {
    served = readServe(JSON.parse((await o.exec(cli, ["serve", "status", "--json"])).stdout || "{}"), status.hostname, o.port);
  } catch (e) {
    return { error: `tailscale serve status failed: ${((e as { stderr?: string }).stderr || (e as Error).message).toString().trim()}` };
  }
  if (typeof served === "object") return served;
  return { cli, hostname: status.hostname, serve: served === "free" };
}

/** Runs `tailscale serve` as its child and kills it when its stdin closes or it gets SIGINT, SIGTERM or SIGHUP: the daemon holds the pipe, so even a SIGKILLed daemon leaves no serve behind.
 * POSIX kills the child's process group: macOS /usr/local/bin/tailscale is a sh wrapper without exec, so killing only the wrapper orphans the real serve.
 * Windows has no groups: `taskkill /T /F` ends the child and its children (a `.cmd` shim runs the real binary as a child). Also used for `opencode serve` (opencode-server.ts). */
export const SERVE_WATCHER = `const [cli, ...a] = process.argv.slice(1);
const posix = process.platform !== "win32";
// cmd.exe gets its "/c" line verbatim (opencode-server.ts invocation): Node's own quoting would break the outer quotes.
const c = require("node:child_process").spawn(cli, a, { stdio: ["ignore", "inherit", "inherit"], windowsHide: true, detached: posix, windowsVerbatimArguments: !posix && ["cmd", "cmd.exe"].includes(require("node:path").win32.basename(cli).toLowerCase()) });
const stop = () => { try { if (posix) return void process.kill(-c.pid); } catch {} if (posix) return c.kill(); require("node:child_process").spawnSync("taskkill", ["/T", "/F", "/PID", String(c.pid)], { windowsHide: true }); };
process.stdin.on("close", stop).resume();
// Ctrl+C or a closed terminal signals the watcher too (same foreground group), but not the detached serve: stop it before exiting.
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => (stop(), process.exit(1)));
c.on("exit", (code, sig) => (code === null && console.error("the process was ended by " + sig), process.exit(code ?? 1)));
c.on("error", (e) => (console.error(e.message), process.exit(1)));`;

/** Spawns the foreground serve (its config lives only while the process runs, which ends with this daemon); returns stop(). */
export function startServe(o: { cli: string; port: number; spawn: typeof nodeSpawn; log: (line: string) => void; platform: NodeJS.Platform }): { stop: () => void } {
  const child = o.spawn(process.execPath, ["-e", SERVE_WATCHER, o.cli, "serve", "--https=443", `http://127.0.0.1:${o.port}`], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env, TAILSCALE_BE_CLI: "1" } });
  let stopped = false;
  const lastErr: string[] = [];
  createInterface({ input: child.stdout! }).on("line", (l) => o.log(`tailscale serve: ${l}`));
  createInterface({ input: child.stderr! }).on("line", (l) => {
    lastErr.push(l);
    if (lastErr.length > 5) lastErr.shift();
    o.log(`tailscale serve: ${l}`);
  });
  child.on("error", (e) => o.log(`tailscale serve failed to start: ${e.message}`));
  child.on("exit", (code) => {
    if (stopped) return;
    const err = lastErr.join("\n");
    o.log(`tailscale serve exited (code ${code}); claude-ui keeps running on localhost.${err ? `\n${err}` : ""}${o.platform === "linux" && /denied/i.test(err) ? "\nRun once: sudo tailscale set --operator=$USER" : ""}`);
  });
  return { stop: () => ((stopped = true), void child.stdin!.end()) };
}
