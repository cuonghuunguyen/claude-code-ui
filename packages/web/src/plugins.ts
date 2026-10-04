// Manage Plugins dialog logic and texts, copied from the Claude Code VS Code extension 2.1.283 (docs/spec.md "Config dialogs: plugins").
import type { AvailablePlugin, ConfigScope, MarketplaceInfo, McpServerInfo, PluginUpdateFailure } from "@claude-ui/protocol";

/** `name` of `name@marketplace`. */
export const pluginName = (id: string) => (id.includes("@") ? id.slice(0, id.lastIndexOf("@")) : id);
export const marketplaceOf = (id: string) => (id.includes("@") ? id.slice(id.lastIndexOf("@") + 1) : id);

/** "1.2k", "3m" (the extension's `yX5`). */
export function formatInstalls(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** Search over name, description and marketplace, most installed first. */
export function filterAvailable(list: AvailablePlugin[], query: string) {
  const q = query.trim().toLowerCase();
  const hits = q ? list.filter((p) => p.name.toLowerCase().includes(q) || p.description?.toLowerCase().includes(q) || p.marketplaceName.toLowerCase().includes(q)) : list;
  return [...hits].sort((a, b) => b.installCount - a.installCount);
}

export function marketplaceText(m: MarketplaceInfo) {
  switch (m.source) {
    case "github":
      return `GitHub: ${m.repo}`;
    case "git":
      return `Git: ${m.url}`;
    case "url":
      return `URL: ${m.url}`;
    case "directory":
      return `Directory: ${m.path}`;
    case "file":
      return `File: ${m.path}`;
    case "npm":
      return `npm: ${m.package}`;
    default:
      return m.source;
  }
}

/** Link of a marketplace row: its GitHub repo or an http(s) URL. */
export function marketplaceLink(m: MarketplaceInfo) {
  if (m.source === "github") return `https://github.com/${m.repo}`;
  if ((m.source === "url" || m.source === "git") && m.url && /^https?:\/\//i.test(m.url)) return m.url;
  return undefined;
}

/** Chip of a plugin's MCP server: its status row by `name` or `plugin:<plugin>:<server>`, and the tooltip. */
export function chipOf(pluginId: string, server: string, servers: McpServerInfo[]) {
  const s = servers.find((x) => x.name === server || x.name === `plugin:${pluginName(pluginId)}:${server}`);
  return { status: s?.status ?? "unknown", title: s ? `${server}: ${s.status}${s.error ? ` - ${s.error}` : ""}` : `${server}: not loaded` };
}

/** Notice after an update that needed no reload (the CLI's result line). */
export function updateNotice(pluginId: string, message: string) {
  const p = pluginName(pluginId);
  if (message.startsWith("Skipped")) return `${p} was not updated because another plugin needs the version it has.`;
  if (/ — version shown may be stale\.$/.test(message)) return `${p} may already be at the latest version; the marketplace couldn't be checked.`;
  return `${p} is already at the latest version.`;
}

export type FailureAction = "retry" | "enableAndUpdate" | "refreshList" | "refreshMarketplace" | "copy";
/** The extension's update failure dialog per kind: title, message, actions (first = primary) and close label. */
export function failureDialog(kind: PluginUpdateFailure, pluginId: string): { title: string; message: string; actions: { label: string; action: FailureAction }[]; close: string } {
  const p = pluginName(pluginId);
  const retry = { label: "Try again", action: "retry" as const };
  const copy = { label: "Copy error", action: "copy" as const };
  switch (kind) {
    case "timeout":
      return { title: `Updating ${p} is taking too long`, message: "It didn't finish in the time allowed.", actions: [retry], close: "Cancel" };
    case "policy":
      return { title: `${p} can't be updated here`, message: "Your organization's settings block updating this plugin.", actions: [], close: "OK" };
    case "disabled":
      return { title: `${p} is turned off`, message: "Turn it on to update it.", actions: [{ label: "Turn on and update", action: "enableAndUpdate" }], close: "Cancel" };
    case "needs_consent":
      return { title: `${p} installs by running a command on your machine`, message: "It can't be accepted from here yet.", actions: [], close: "OK" };
    case "not_installed":
      return { title: `${p} is no longer installed here`, message: "The list is out of date.", actions: [{ label: "Refresh list", action: "refreshList" }], close: "Cancel" };
    case "not_found":
      return {
        title: `${p} isn't in your copy of ${marketplaceOf(pluginId)}`,
        message: "Refresh the marketplace, then try the update again.",
        actions: [{ label: "Refresh the marketplace and retry", action: "refreshMarketplace" }],
        close: "Cancel",
      };
    case "network":
      return { title: `Something went wrong while updating ${p}`, message: "The marketplace could not be reached.", actions: [retry, copy], close: "Cancel" };
    default:
      return { title: `Something went wrong while updating ${p}`, message: "The update did not finish.", actions: [retry, copy], close: "Cancel" };
  }
}

export const TRUST_WARNING =
  "Make sure you trust a plugin before installing, updating, or using it. Anthropic does not control what MCP servers, files, or other software are included in plugins and cannot verify that they will work as intended or that they won't change.";

export const INSTALL_SCOPES: { scope: ConfigScope; label: string; description: string }[] = [
  { scope: "user", label: "Install for you", description: "Available in all your projects" },
  { scope: "project", label: "Install for this project", description: "Shared with all collaborators" },
  { scope: "local", label: "Install locally", description: "Only for you, only in this repo" },
];
