import { delimiter } from "node:path";
import { parseArgs } from "node:util";

export const HELP = `Usage: claude-ui [options]

Options (a flag overrides its environment variable):
  --port <n>          port on 127.0.0.1                      (PORT, default 4280)
  --roots <paths>     allowlisted directories, separated like PATH
                                                             (CLAUDE_UI_ROOTS, default: home directory)
  --hostname <name>   HTTPS name of a private VPN proxy, e.g. tailscale serve
                                                             (CLAUDE_UI_HOSTNAME)
  --allow-bypass      offer the "Bypass permissions" mode    (CLAUDE_UI_ALLOW_BYPASS=1)
  -v, --version       print the version
  -h, --help          print this help
`;

export type Cli = { kind: "run"; port: number; roots: string[]; hostname: string | undefined; allowBypass: boolean } | { kind: "help" } | { kind: "version" } | { kind: "error"; message: string };

export function parseCli(argv: string[], env: NodeJS.ProcessEnv, home: string): Cli {
  let values;
  try {
    const r = parseArgs({
      args: argv,
      options: { port: { type: "string" }, roots: { type: "string" }, hostname: { type: "string" }, "allow-bypass": { type: "boolean" }, version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" } },
    });
    values = r.values;
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const rawPort = values.port ?? env.PORT ?? "4280";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65535) return { kind: "error", message: `invalid port: ${rawPort}` };
  return {
    kind: "run",
    port,
    roots: (values.roots ?? env.CLAUDE_UI_ROOTS ?? home).split(delimiter).filter(Boolean),
    hostname: values.hostname ?? env.CLAUDE_UI_HOSTNAME,
    allowBypass: values["allow-bypass"] ?? env.CLAUDE_UI_ALLOW_BYPASS === "1",
  };
}
