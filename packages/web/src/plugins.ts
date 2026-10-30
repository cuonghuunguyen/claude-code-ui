// Manage Plugins dialog logic and texts, same behaviour as the Claude Code VS Code extension (own texts) (docs/spec.md "Config dialogs: plugins").
import type { AvailablePlugin, ConfigScope, MarketplaceInfo, McpServerInfo, PluginUpdateFailure } from "@claude-ui/protocol";
import { t } from "./i18n.ts";

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
      return t("session.plugins.marketplaceDirectory", { path: m.path ?? "" });
    case "file":
      return t("session.plugins.marketplaceFile", { path: m.path ?? "" });
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
  return { status: s?.status ?? "unknown", title: s ? (s.error ? t("session.plugins.chipError", { server, status: s.status, error: s.error }) : t("session.plugins.chip", { server, status: s.status })) : t("session.plugins.chipNotLoaded", { server }) };
}

/** Notice after an update that needed no reload (the CLI's result line). */
export function updateNotice(pluginId: string, message: string) {
  const p = pluginName(pluginId);
  if (message.startsWith("Skipped")) return t("session.plugins.noticeSkipped", { plugin: p });
  if (/ — version shown may be stale\.$/.test(message)) return t("session.plugins.noticeStale", { plugin: p });
  return t("session.plugins.noticeUpToDate", { plugin: p });
}

export type FailureAction = "retry" | "enableAndUpdate" | "refreshList" | "refreshMarketplace" | "copy";
/** Update failure dialog per kind: title, message, actions (first = primary) and close label. */
export function failureDialog(kind: PluginUpdateFailure, pluginId: string): { title: string; message: string; actions: { label: string; action: FailureAction }[]; close: string } {
  const p = pluginName(pluginId);
  const retry = { label: t("session.plugins.failure.retry"), action: "retry" as const };
  const copy = { label: t("session.plugins.failure.copy"), action: "copy" as const };
  const cancel = t("session.plugins.failure.cancel");
  const ok = t("session.plugins.failure.ok");
  const plugin = p;
  switch (kind) {
    case "timeout":
      return { title: t("session.plugins.failure.timeoutTitle", { plugin }), message: t("session.plugins.failure.timeoutMessage"), actions: [retry], close: cancel };
    case "policy":
      return { title: t("session.plugins.failure.policyTitle", { plugin }), message: t("session.plugins.failure.policyMessage"), actions: [], close: ok };
    case "disabled":
      return { title: t("session.plugins.failure.disabledTitle", { plugin }), message: t("session.plugins.failure.disabledMessage"), actions: [{ label: t("session.plugins.failure.enableAndUpdate"), action: "enableAndUpdate" }], close: cancel };
    case "needs_consent":
      return { title: t("session.plugins.failure.consentTitle", { plugin }), message: t("session.plugins.failure.consentMessage"), actions: [], close: ok };
    case "not_installed":
      return { title: t("session.plugins.failure.notInstalledTitle", { plugin }), message: t("session.plugins.failure.notInstalledMessage"), actions: [{ label: t("session.plugins.failure.reloadList"), action: "refreshList" }], close: cancel };
    case "not_found":
      return {
        title: t("session.plugins.failure.notFoundTitle", { marketplace: marketplaceOf(pluginId), plugin }),
        message: t("session.plugins.failure.notFoundMessage"),
        actions: [{ label: t("session.plugins.failure.updateMarketplace"), action: "refreshMarketplace" }],
        close: cancel,
      };
    case "network":
      return { title: t("session.plugins.failure.otherTitle", { plugin }), message: t("session.plugins.failure.networkMessage"), actions: [retry, copy], close: cancel };
    default:
      return { title: t("session.plugins.failure.otherTitle", { plugin }), message: t("session.plugins.failure.otherMessage"), actions: [retry, copy], close: cancel };
  }
}

export const trustWarning = () => t("session.plugins.trustWarning");

export const INSTALL_SCOPES: { scope: ConfigScope; label: string; description: string }[] = [
  { scope: "user", get label() { return t("session.plugins.scope.user"); }, get description() { return t("session.plugins.scope.userHint"); } },
  { scope: "project", get label() { return t("session.plugins.scope.project"); }, get description() { return t("session.plugins.scope.projectHint"); } },
  { scope: "local", get label() { return t("session.plugins.scope.local"); }, get description() { return t("session.plugins.scope.localHint"); } },
];
