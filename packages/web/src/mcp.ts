// MCP servers dialog logic, same behaviour as the Claude Code VS Code extension, own texts.
import type { ConfigScope, McpAddConfig, McpServerInfo } from "@claude-ui/protocol";
import { t } from "./i18n.ts";

const ICONS: Record<string, string> = { connected: "✓", failed: "✗", "needs-auth": "⚠", pending: "◐", disabled: "○" };
const STATUSES = ["connected", "failed", "needs-auth", "pending", "disabled"] as const;
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
export const statusLabel = (status: string) => ((STATUSES as readonly string[]).includes(status) ? t(`session.mcp.status.${status as (typeof STATUSES)[number]}`) : status);

const SCOPE_ORDER = ["project", "local", "user", "claudeai", "managed", "enterprise"];
export const scopeLabel = (scope: string) =>
  scope === "claudeai" ? "claude.ai" : ["project", "local", "user", "managed", "enterprise"].includes(scope) ? t(`session.mcp.scope.${scope as "project"}`) : scope;

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
export const actionLabel = (a: McpAction, busy: boolean) => t(busy ? (`session.mcp.action.${a}Busy` as const) : (`session.mcp.action.${a}` as const));
/** The error banner when the daemon gives no reason. */
export const actionError = (a: McpAction | "remove" | "callback" | "add") => t(`session.mcp.error.${a}`);

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
  reconnect: (name: string) => t("session.mcp.result.reconnect", { name }),
  disable: (name: string) => t("session.mcp.result.disable", { name }),
  enable: (name: string) => t("session.mcp.result.enable", { name }),
  authenticate: () => t("session.mcp.result.authenticate"),
  clearAuth: (name: string) => t("session.mcp.result.clearAuth", { name }),
  remove: (name: string, scope: string) => t("session.mcp.result.remove", { name, scope }),
  add: (name: string, scope: string) => t("session.mcp.result.add", { name, scope }),
};

export const TRANSPORTS = [
  { value: "stdio", get label() { return t("session.mcp.transport.stdio"); }, get description() { return t("session.mcp.transport.stdioHint"); } },
  { value: "http", get label() { return t("session.mcp.transport.http"); }, get description() { return t("session.mcp.transport.httpHint"); } },
  { value: "sse", get label() { return t("session.mcp.transport.sse"); }, get description() { return t("session.mcp.transport.sseHint"); } },
] as const;
export type Transport = (typeof TRANSPORTS)[number]["value"];
export const SCOPES = [
  { value: "local", get label() { return t("session.mcp.scopeOption.local"); }, get description() { return t("session.mcp.scopeOption.localHint"); } },
  { value: "user", get label() { return t("session.mcp.scopeOption.user"); }, get description() { return t("session.mcp.scopeOption.userHint"); } },
  { value: "project", get label() { return t("session.mcp.scopeOption.project"); }, get description() { return t("session.mcp.scopeOption.projectHint"); } },
] as const satisfies readonly { value: ConfigScope; label: string; description: string }[];
export const projectScopeWarning = () => t("session.mcp.projectWarning");

export type AddForm = { name: string; transport: Transport; command: string; args: string; env: string; url: string; headers: string };

/** The add form's values as `mcp.add` takes them, or the first error, with line numbers. */
export function buildAdd(f: AddForm): { name: string; config: McpAddConfig } | { error: string } {
  const name = f.name.trim();
  if (name === "") return { error: t("session.mcp.form.nameEmpty") };
  if (/[^a-zA-Z0-9_-]/.test(name)) return { error: t("session.mcp.form.nameInvalid", { name }) };
  const lines = (t: string) => t.split("\n").map((l, i) => [l.trim(), i + 1] as const);
  if (f.transport === "stdio") {
    const command = f.command.trim();
    if (command === "") return { error: t("session.mcp.form.commandEmpty") };
    const env: string[] = [];
    for (const [l, n] of lines(f.env)) {
      if (!l) continue;
      const at = l.indexOf("=");
      const key = at >= 0 ? l.slice(0, at).trim() : "";
      if (!key) return { error: t("session.mcp.form.envLine", { line: n }) };
      env.push(`${key}=${l.slice(at + 1).trim()}`);
    }
    return { name, config: { transport: "stdio", command, args: lines(f.args).flatMap(([l]) => (l ? [l] : [])), env } };
  }
  const url = f.url.trim();
  if (url === "") return { error: t("session.mcp.form.urlEmpty") };
  const headers: string[] = [];
  for (const [l, n] of lines(f.headers)) {
    if (!l) continue;
    if (l.indexOf(":") <= 0) return { error: t("session.mcp.form.headerLine", { line: n }) };
    headers.push(l);
  }
  return { name, config: { transport: f.transport, url, headers } };
}

/** Palette "MCP servers" rows: needs-auth first, then by name (the extension's sortPriority). */
export const paletteOrder = (servers: McpServerInfo[]) =>
  [...servers].sort((a, b) => Number(b.status === "needs-auth") - Number(a.status === "needs-auth") || a.name.localeCompare(b.name));
