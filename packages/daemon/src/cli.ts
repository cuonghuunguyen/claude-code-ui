import { delimiter } from "node:path";
import { parseArgs } from "node:util";

export const HELP = `Usage: claude-ui [options]
       claude-ui update    install the latest version; the next start runs it

Options (a flag overrides its environment variable):
  --port <n>          port                                   (PORT, default 4280)
  --roots <paths>     allowlisted directories, separated like PATH
                                                             (CLAUDE_UI_ROOTS, default: home directory)
  --hostname <name>   HTTPS name of a private VPN proxy, e.g. tailscale serve
                                                             (CLAUDE_UI_HOSTNAME)
  --tailscale         serve on your tailnet with tailscale serve and print its https link
                                                             (CLAUDE_UI_TAILSCALE=1)
  --lan               also listen on the local network, plain HTTP: the token is
                      readable on the network; no browser push or Copy (CLAUDE_UI_LAN=1)
  --allow-bypass      offer the "Bypass permissions" mode    (CLAUDE_UI_ALLOW_BYPASS=1)
  --no-update-check   do not check npm for a newer version   (CLAUDE_UI_UPDATE_CHECK=0)
  --no-os-notify      no desktop notification on this machine when no browser
                      is subscribed to push                  (CLAUDE_UI_OS_NOTIFY=0)
  -v, --version       print the version
  -h, --help          print this help
`;

/** `side`: run as a WSL side of a Windows daemon (sides.ts): wire protocol over stdio, no HTTP. Not in HELP: the Windows daemon starts it. */
export type Cli = { kind: "run"; port: number; roots: string[]; hostname: string | undefined; lan: boolean; allowBypass: boolean; idleCloseMinutes: number; tailscale?: true; side?: boolean; updateCheck?: false; osNotify?: false } | { kind: "update" } | { kind: "help" } | { kind: "version" } | { kind: "error"; message: string };

export function parseCli(argv: string[], env: NodeJS.ProcessEnv, home: string): Cli {
  let values;
  let positionals: string[];
  try {
    const r = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { "no-update-check": { type: "boolean" }, "no-os-notify": { type: "boolean" }, port: { type: "string" }, roots: { type: "string" }, hostname: { type: "string" }, tailscale: { type: "boolean" }, lan: { type: "boolean" }, "allow-bypass": { type: "boolean" }, side: { type: "boolean" }, version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" } },
    });
    values = r.values;
    positionals = r.positionals;
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (positionals.length > 1 || (positionals[0] !== undefined && positionals[0] !== "update")) return { kind: "error", message: `unexpected argument '${positionals.at(-1)}'` };
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  if (positionals[0] === "update") return { kind: "update" };
  const rawPort = values.port ?? env.PORT ?? "4280";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65535) return { kind: "error", message: `invalid port: ${rawPort}` };
  const hostname = values.hostname ?? env.CLAUDE_UI_HOSTNAME;
  const tailscale = values.tailscale ?? env.CLAUDE_UI_TAILSCALE === "1";
  if (tailscale && hostname) return { kind: "error", message: "--tailscale sets the hostname itself; drop --hostname / CLAUDE_UI_HOSTNAME" };
  const rawIdle = env.CLAUDE_UI_IDLE_CLOSE_MINUTES ?? "10";
  if (!/^\d+$/.test(rawIdle)) return { kind: "error", message: `invalid CLAUDE_UI_IDLE_CLOSE_MINUTES: ${rawIdle}` };
  return {
    kind: "run",
    port,
    roots: (values.roots ?? env.CLAUDE_UI_ROOTS ?? home).split(delimiter).filter(Boolean),
    hostname,
    lan: values.lan ?? env.CLAUDE_UI_LAN === "1",
    allowBypass: values["allow-bypass"] ?? env.CLAUDE_UI_ALLOW_BYPASS === "1",
    ...(tailscale && { tailscale: true as const }),
    idleCloseMinutes: Number(rawIdle),
    ...(values.side && { side: true }),
    ...((values["no-update-check"] || env.CLAUDE_UI_UPDATE_CHECK === "0") && { updateCheck: false as const }),
    ...((values["no-os-notify"] || env.CLAUDE_UI_OS_NOTIFY === "0") && { osNotify: false as const }),
  };
}
