import { delimiter } from "node:path";
import { parseArgs } from "node:util";

export const HELP = `Usage: claude-ui [options]
       claude-ui update    install the latest version; the next start runs it
       claude-ui <command> [command options]    talk to the running daemon on this machine

Commands:
  status                       daemon up, version, port, session counts
  open [sessionId] [--print]   open claude-ui (or one session) in the browser; --print prints the link
                               (without a session id the link holds the token)
  sessions, ls                 list sessions [--project <dir>] [--state <state>] [--archived]
  projects                     list projects
  workers                      list orchestration workers by coordinator
Command options: --json (machine output), --port <n> (default: PORT, the running daemon, 4280),
  --token-file <path> (default: CLAUDE_UI_TOKEN_FILE, <config dir>/token). Exit codes: 0 ok, 1 daemon
  error, 2 usage, 3 daemon not running or no token.

Options (a flag overrides its environment variable):
  --port <n>          port                                   (PORT, default 4280)
  --roots <paths>     allowlisted directories, separated like PATH
                                                             (CLAUDE_UI_ROOTS, default: home directory)
  --hostname <name>   HTTPS name of a private VPN proxy, e.g. tailscale serve
                                                             (CLAUDE_UI_HOSTNAME)
  --tailscale         serve on your tailnet with tailscale serve and print its https link
                                                             (CLAUDE_UI_TAILSCALE=1)
  --lan               also listen on the local network, plain HTTP: the token is
                      readable on the network; no browser push, Copy or app install
                                                             (CLAUDE_UI_LAN=1)
  --allow-bypass      offer the "Bypass permissions" mode    (CLAUDE_UI_ALLOW_BYPASS=1)
  --no-update-check   do not check npm for a newer version   (CLAUDE_UI_UPDATE_CHECK=0)
  --no-os-notify      no desktop notification on this machine when no browser
                      is subscribed to push                  (CLAUDE_UI_OS_NOTIFY=0)
  -v, --version       print the version
  -h, --help          print this help
`;

/** Printed under a usage error; the full HELP is for `--help`. */
export const USAGE_HINT = "Usage: claude-ui [options] | claude-ui update | claude-ui status|open|sessions|projects|workers [options]\nRun claude-ui --help for the options.";

/** Printed under the pairing URL of an HTTPS start (--tailscale, --hostname): installing the app needs HTTPS. */
export const PHONE_HINT = "Phone: open the link, then Install app (Android Chrome) or Share > Add to Home Screen (iOS Safari); on iOS paste the link into the app's pairing field.";

/** `side`: run as a WSL side of a Windows daemon (sides.ts): wire protocol over stdio, no HTTP. Not in HELP: the Windows daemon starts it. */
export type Cli = { kind: "run"; port: number; roots: string[]; hostname: string | undefined; lan: boolean; allowBypass: boolean; idleCloseMinutes: number; tailscale?: true; side?: boolean; updateCheck?: false; osNotify?: false } | { kind: "update" } | { kind: "client"; cmd: ClientCmd; json: boolean; port?: number; tokenFile?: string; sessionId?: string; print?: true; project?: string; state?: string; archived?: true } | { kind: "help" } | { kind: "version" } | { kind: "error"; message: string };

export type ClientCmd = "status" | "open" | "sessions" | "projects" | "workers";
const CLIENT_CMDS: Record<string, ClientCmd> = { status: "status", open: "open", sessions: "sessions", ls: "sessions", projects: "projects", workers: "workers" };
/** Command names kept for later slices: an error now, so no script depends on them meaning something else. */
const RESERVED = ["new", "send", "tail", "interrupt", "doctor", "logs", "stop"];
const STATES = ["idle", "running", "needs_input", "error", "closed"];
const CLIENT_FLAGS: Record<ClientCmd, string[]> = { status: [], open: ["print"], sessions: ["project", "state", "archived"], projects: [], workers: [] };

/**
 * Whether `argv` starts the daemon: everything but a known client command, a reserved name or `update` as the first word, or help or version.
 * Not strict on flags: an older launcher stays installed while a newer daemon (with flags it does not know) runs under it.
 */
export const isDaemonRun = (argv: string[]) => !(NOT_A_START.includes(argv[0] ?? "") || argv.some((a) => ["-h", "-v", "--help", "--version"].includes(a)));
const NOT_A_START = [...Object.keys(CLIENT_CMDS), ...RESERVED, "update"];
const DAEMON_ONLY = ["lan", "roots", "hostname", "tailscale", "allow-bypass", "no-update-check", "no-os-notify", "side"];

export function parseCli(argv: string[], env: NodeJS.ProcessEnv, home: string): Cli {
  let values;
  let positionals: string[];
  try {
    const r = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { "no-update-check": { type: "boolean" }, "no-os-notify": { type: "boolean" }, port: { type: "string" }, roots: { type: "string" }, hostname: { type: "string" }, tailscale: { type: "boolean" }, lan: { type: "boolean" }, "allow-bypass": { type: "boolean" }, json: { type: "boolean" }, "token-file": { type: "string" }, print: { type: "boolean" }, project: { type: "string" }, state: { type: "string" }, archived: { type: "boolean" }, side: { type: "boolean" }, version: { type: "boolean", short: "v" }, help: { type: "boolean", short: "h" } },
    });
    values = r.values;
    positionals = r.positionals;
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
  const word = positionals[0];
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  const cmd = word === undefined ? undefined : CLIENT_CMDS[word];
  if (word !== undefined && word !== "update" && !cmd) return { kind: "error", message: RESERVED.includes(word) ? `'${word}' is not implemented yet` : `unknown command '${word}'` };
  if (cmd) {
    const extra = positionals.slice(cmd === "open" ? 2 : 1);
    if (extra.length) return { kind: "error", message: `unexpected argument '${extra[0]}'` };
    const bad = ["print", "project", "state", "archived"].find((f) => (values as Record<string, unknown>)[f] !== undefined && !CLIENT_FLAGS[cmd].includes(f));
    if (bad) return { kind: "error", message: `--${bad} does not apply to '${word}'` };
    const daemonOnly = DAEMON_ONLY.find((f) => (values as Record<string, unknown>)[f] !== undefined);
    if (daemonOnly) return { kind: "error", message: `--${daemonOnly} starts the daemon; it does not apply to '${word}'` };
    if (values.state !== undefined && !STATES.includes(values.state)) return { kind: "error", message: `invalid state: ${values.state} (${STATES.join(", ")})` };
    if (values.port !== undefined && (!/^\d+$/.test(values.port) || Number(values.port) > 65535)) return { kind: "error", message: `invalid port: ${values.port}` };
    return {
      kind: "client",
      cmd,
      json: values.json ?? false,
      ...(values.port !== undefined && { port: Number(values.port) }),
      ...(values["token-file"] !== undefined && { tokenFile: values["token-file"] }),
      ...(cmd === "open" && positionals[1] !== undefined && { sessionId: positionals[1] }),
      ...(values.print && { print: true as const }),
      ...(values.project !== undefined && { project: values.project }),
      ...(values.state !== undefined && { state: values.state }),
      ...(values.archived && { archived: true as const }),
    };
  }
  if (positionals.length > 1) return { kind: "error", message: `unexpected argument '${positionals.at(-1)}'` };
  const clientOnly = ["json", "token-file", "print", "project", "state", "archived"].find((f) => (values as Record<string, unknown>)[f] !== undefined);
  if (clientOnly) return { kind: "error", message: `--${clientOnly} applies to a command (status, open, sessions, projects, workers)` };
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
