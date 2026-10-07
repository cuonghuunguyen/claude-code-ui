// Manage Plugins dialog logic and texts, same behaviour as the Claude Code VS Code extension (own texts) (docs/spec.md "Config dialogs: plugins").
import type { AvailablePlugin, ConfigScope, MarketplaceInfo, McpServerInfo, PluginUpdateFailure } from "@claude-ui/protocol";

/** `name` of `name@marketplace`. */
/** The sessions whose last plugin reload failed, after a `config.changed`: one that reloaded replaces the set (a success clears the banner); `undefined`: no reload ran. */
export const nextReloadFailed = (failed: Set<string>, reloadFailed: string[] | undefined) => (reloadFailed ? new Set(reloadFailed) : failed);

export const pluginName = (id: string) => (id.includes("@") ? id.slice(0, id.lastIndexOf("@")) : id);
export const marketplaceOf = (id: string) => (id.includes("@") ? id.slice(id.lastIndexOf("@") + 1) : id);

/** "1.2k", "3m". */
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
  if (message.startsWith("Skipped")) return `${p} kept its version: another plugin depends on it.`;
  if (/ — version shown may be stale\.$/.test(message)) return `${p} looks up to date, but the marketplace could not be reached to confirm.`;
  return `${p} is up to date.`;
}

export type FailureAction = "retry" | "enableAndUpdate" | "refreshList" | "refreshMarketplace" | "copy";
/** Update failure dialog per kind: title, message, actions (first = primary) and close label. */
export function failureDialog(kind: PluginUpdateFailure, pluginId: string): { title: string; message: string; actions: { label: string; action: FailureAction }[]; close: string } {
  const p = pluginName(pluginId);
  const retry = { label: "Try again", action: "retry" as const };
  const copy = { label: "Copy error", action: "copy" as const };
  switch (kind) {
    case "timeout":
      return { title: `${p} update timed out`, message: "The update did not complete in time.", actions: [retry], close: "Cancel" };
    case "policy":
      return { title: `Updating ${p} is not allowed`, message: "A policy from your organization prevents this update.", actions: [], close: "OK" };
    case "disabled":
      return { title: `${p} is disabled`, message: "Enable it first, then update.", actions: [{ label: "Enable and update", action: "enableAndUpdate" }], close: "Cancel" };
    case "needs_consent":
      return { title: `${p} would run a command on your machine to install`, message: "Approving that is not supported in this UI yet.", actions: [], close: "OK" };
    case "not_installed":
      return { title: `${p} is not installed anymore`, message: "The plugin list is stale.", actions: [{ label: "Reload list", action: "refreshList" }], close: "Cancel" };
    case "not_found":
      return {
        title: `${marketplaceOf(pluginId)} (local copy) has no ${p}`,
        message: "Update the marketplace and retry.",
        actions: [{ label: "Update marketplace and retry", action: "refreshMarketplace" }],
        close: "Cancel",
      };
    case "network":
      return { title: `Could not update ${p}`, message: "The marketplace is unreachable.", actions: [retry, copy], close: "Cancel" };
    default:
      return { title: `Could not update ${p}`, message: "The update stopped before it finished.", actions: [retry, copy], close: "Cancel" };
  }
}

export const TRUST_WARNING =
  "Install, update and use only plugins you trust. Plugins can bring MCP servers, files and other software that Anthropic does not review, and their behaviour can change at any time.";

export const INSTALL_SCOPES: { scope: ConfigScope; label: string; description: string }[] = [
  { scope: "user", label: "Install for you", description: "You, in every project" },
  { scope: "project", label: "Install for this project", description: "Everyone on this project" },
  { scope: "local", label: "Install locally", description: "Only you, only this project" },
];
