// MCP servers dialog logic, same behaviour as the Claude Code VS Code extension, own texts.
import type { ConfigScope, McpAddConfig, McpServerInfo } from "@claude-ui/protocol";

const ICONS: Record<string, string> = { connected: "✓", failed: "✗", "needs-auth": "⚠", pending: "◐", disabled: "○" };
const LABELS: Record<string, string> = { connected: "Connected", failed: "Failed", "needs-auth": "Needs Auth", pending: "Connecting…", disabled: "Disabled" };
/** A sign-in page the dialog may open: https, or http on this machine (a local OAuth server); never javascript:, data: or file:. */
export function safeAuthUrl(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

export const statusIcon = (status: string) => ICONS[status] ?? "?";
export const statusLabel = (status: string) => LABELS[status] ?? status;

const SCOPE_ORDER = ["project", "local", "user", "claudeai", "managed", "enterprise"];
const SCOPE_LABELS: Record<string, string> = { project: "Project", local: "Local", user: "User", claudeai: "claude.ai", managed: "Managed", enterprise: "Enterprise" };
export const scopeLabel = (scope: string) => SCOPE_LABELS[scope] ?? scope;

/** Servers by scope ("other" without one), groups in the extension's order then unknown scopes, names sorted; `filter` matches names. */
export function groupServers(servers: McpServerInfo[], filter = ""): [string, McpServerInfo[]][] {
  const q = filter.trim().toLowerCase();
  const by = new Map<string, McpServerInfo[]>();
  for (const s of servers) {
    if (q && !s.name.toLowerCase().includes(q)) continue;
    const scope = s.scope ?? "other";
    by.set(scope, [...(by.get(scope) ?? []), s]);
  }
  for (const list of by.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const known = SCOPE_ORDER.flatMap((s) => (by.has(s) ? [[s, by.get(s)!] as [string, McpServerInfo[]]] : []));
  return [...known, ...[...by].filter(([s]) => !SCOPE_ORDER.includes(s))];
}

export type McpAction = "reconnect" | "clearAuth" | "disable" | "authenticate" | "enable";
export const ACTION_LABEL: Record<McpAction, [label: string, busy: string]> = {
  reconnect: ["Reconnect", "Reconnecting…"],
  clearAuth: ["Clear authentication", "Clearing…"],
  disable: ["Disable", "Disabling…"],
  authenticate: ["Authenticate", "Authenticating…"],
  enable: ["Enable", "Enabling…"],
};
/** The error banner when the daemon gives no reason. */
export const ACTION_ERROR: Record<McpAction | "remove" | "callback" | "add", string> = {
  reconnect: "Failed to reconnect",
  clearAuth: "Failed to clear authentication",
  disable: "Failed to disable server",
  authenticate: "Authentication failed",
  enable: "Failed to enable server",
  remove: "Failed to remove server",
  callback: "Failed to submit callback URL",
  add: "Failed to add server",
};

const canAuth = (s: McpServerInfo) => ["sse", "http", "claudeai-proxy"].includes(s.config?.type ?? "");

/** Buttons for the server's status; `waiting`: an OAuth flow of it waits for the browser (the waiting block replaces its actions). */
export function actionsFor(s: McpServerInfo, waiting = false): McpAction[] {
  const auth: McpAction[] = canAuth(s) ? ["authenticate"] : [];
  switch (s.status) {
    case "connected":
      return ["reconnect", ...(s.config?.type === "sse" || s.config?.type === "http" ? (["clearAuth"] as const) : []), "disable"];
    case "needs-auth":
      return waiting ? [] : [...auth, "disable"];
    case "failed":
      return waiting ? [] : [...auth, "reconnect", "disable"];
    case "disabled":
      return ["enable"];
    default:
      return [];
  }
}

/** Remove only for servers saved in a scope `claude mcp remove` writes (not claude.ai, managed, enterprise, plugin or dynamic ones). */
export const canRemove = (s: McpServerInfo): s is McpServerInfo & { scope: ConfigScope } =>
  (s.scope === "local" || s.scope === "user" || s.scope === "project") && s.source !== "plugin";

/** Error text of a server: tags stripped, first line, at most 200 characters. */
export function errorLine(error: string) {
  let t = error;
  for (let prev = ""; prev !== t; ) (prev = t), (t = t.replace(/<[^>]+>/g, ""));
  const line = t.split("\n")[0] ?? t;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/** Text of a success banner. */
export const resultText = {
  reconnect: (n: string) => `Reconnected to ${n}`,
  disable: (n: string) => `Disabled ${n}`,
  enable: (n: string) => `Enabled ${n}`,
  authenticate: () => "Authenticated successfully",
  clearAuth: (n: string) => `Cleared authentication for ${n}`,
  remove: (n: string, scope: string) => `${n} removed from the ${scope} config. Sessions already running still use it until they restart.`,
  add: (n: string, scope: string) => `${n} saved to the ${scope} config. New sessions will load it.`,
};

export const TRANSPORTS = [
  { value: "stdio", label: "Local command (stdio)", description: "Starts a local process" },
  { value: "http", label: "HTTP (remote)", description: "Remote server at a URL" },
  { value: "sse", label: "SSE (remote, legacy)", description: "Legacy remote transport; use HTTP when possible" },
] as const;
export type Transport = (typeof TRANSPORTS)[number]["value"];
export const SCOPES = [
  { value: "local", label: "Local", description: "Only you, only this project" },
  { value: "user", label: "User", description: "You, in every project" },
  { value: "project", label: "Project", description: "Everyone on this project, via .mcp.json" },
] as const satisfies readonly { value: ConfigScope; label: string; description: string }[];
export const PROJECT_SCOPE_WARNING =
  "Written to .mcp.json, so everyone who opens this project gets this server. IDE sessions start project servers without asking first. Without an open folder, the file goes to your home directory.";

export type AddForm = { name: string; transport: Transport; command: string; args: string; env: string; url: string; headers: string };

/** The add form's values as `mcp.add` takes them, or the first error, with line numbers. */
export function buildAdd(f: AddForm): { name: string; config: McpAddConfig } | { error: string } {
  const name = f.name.trim();
  if (name === "") return { error: "Enter a server name." };
  if (/[^a-zA-Z0-9_-]/.test(name)) return { error: `${name} is not a valid name: use only letters, digits, - and _.` };
  const lines = (t: string) => t.split("\n").map((l, i) => [l.trim(), i + 1] as const);
  if (f.transport === "stdio") {
    const command = f.command.trim();
    if (command === "") return { error: "Enter a command." };
    const env: string[] = [];
    for (const [l, n] of lines(f.env)) {
      if (!l) continue;
      const at = l.indexOf("=");
      const key = at >= 0 ? l.slice(0, at).trim() : "";
      if (!key) return { error: `Line ${n}: write environment variables as KEY=value.` };
      env.push(`${key}=${l.slice(at + 1).trim()}`);
    }
    return { name, config: { transport: "stdio", command, args: lines(f.args).flatMap(([l]) => (l ? [l] : [])), env } };
  }
  const url = f.url.trim();
  if (url === "") return { error: "Enter a URL." };
  const headers: string[] = [];
  for (const [l, n] of lines(f.headers)) {
    if (!l) continue;
    if (l.indexOf(":") <= 0) return { error: `Line ${n}: write headers as Name: value.` };
    headers.push(l);
  }
  return { name, config: { transport: f.transport, url, headers } };
}

/** Palette "MCP servers" rows: needs-auth first, then by name (the extension's sortPriority). */
export const paletteOrder = (servers: McpServerInfo[]) =>
  [...servers].sort((a, b) => Number(b.status === "needs-auth") - Number(a.status === "needs-auth") || a.name.localeCompare(b.name));
