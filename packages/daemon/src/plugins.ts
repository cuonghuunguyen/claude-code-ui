// Manage Plugins dialog (docs/spec.md "Config dialogs: plugins", same as the VS Code extension 2.1.283): `claude plugin …` through
// the CLI runner in the project cwd; after each write the daemon reloads plugins in every live query and broadcasts config.changed.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  AvailablePlugin,
  ClientMessage,
  ConfigScope,
  InstalledPlugin,
  MarketplaceInfo,
  PluginUpdateFailure,
  PluginUpdateResult,
  ReloadResult,
} from "@claude-ui/protocol";
import { ConfigError, type CliRunner } from "./config.ts";

export type PluginsRequest = Extract<ClientMessage, { type: `plugins.${string}` | `marketplace.${string}` }>;

const SCOPES: ConfigScope[] = ["user", "project", "local"];
const UPDATE_SCOPES = ["user", "project", "local", "managed"];
/** Marketplace part of ids the extension never updates: `--plugin-dir` plugins, skills folders, claude.ai synced plugins, builtins. */
const NOT_UPDATABLE = ["inline", "skills-dir", "synced", "builtin"];
const OFFICIAL_REPO = "anthropics/claude-plugins-official";

type RawInstalled = { id: string; version?: string; scope: string; enabled?: boolean; installPath?: string; projectPath?: string | null };
type RawAvailable = { pluginId: string; name: string; description?: string; marketplaceName: string; source?: unknown; installCount?: number };
type RawMarketplace = { name: string; source: string; repo?: string; url?: string; path?: string; package?: string };

const marketplaceOf = (id: string) => (id.includes("@") ? id.slice(id.lastIndexOf("@") + 1) : undefined);
const official = (m: RawMarketplace) => m.source === "github" && m.repo === OFFICIAL_REPO;

/** The extension's rule (`RA0`): a marketplace plugin installed at user, project, local or managed scope of this project. */
export const updatable = (p: { id: string; scope: string }) => {
  const m = marketplaceOf(p.id);
  return m !== undefined && !NOT_UPDATABLE.includes(m) && UPDATE_SCOPES.includes(p.scope);
};

/** GitHub tree URL of a marketplace-relative plugin source (`./plugins/x`), as the extension links it; none otherwise. */
export function sourceUrl(m: RawMarketplace | undefined, source: unknown) {
  if (!m || typeof source !== "string" || !source.startsWith("./")) return undefined;
  const path = source.slice(2);
  if (m.source === "github") return `https://github.com/${m.repo}/tree/main/${path}`;
  if (m.source === "git" && m.url?.startsWith("https://github.com/")) return `${m.url.replace(/\.git$/, "")}/tree/main/${path}`;
  return undefined;
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? v : undefined;
  } catch {
    return undefined;
  }
};
/** Server names of an MCP config file: `{mcpServers: {...}}` or the servers map itself (both occur in plugins). */
const serversOf = (v: Record<string, unknown> | undefined) => {
  const m = v && typeof v.mcpServers === "object" && v.mcpServers ? (v.mcpServers as object) : v;
  return m ? Object.keys(m) : [];
};

/** Description and MCP server names from the installed copy (read only): `plugin.json` (inline map or file paths) and `.mcp.json`. */
export function manifestOf(installPath: string | undefined) {
  if (!installPath) return {};
  const manifest = readJson(join(installPath, ".claude-plugin", "plugin.json"));
  const decl = manifest?.mcpServers;
  const files = typeof decl === "string" ? [decl] : Array.isArray(decl) ? decl.filter((x) => typeof x === "string") : [];
  const names = new Set([
    ...(decl && typeof decl === "object" && !Array.isArray(decl) ? Object.keys(decl) : []),
    ...files.flatMap((f) => serversOf(readJson(resolve(installPath, f)))),
    ...serversOf(readJson(join(installPath, ".mcp.json"))),
  ]);
  return {
    ...(typeof manifest?.description === "string" && { description: manifest.description }),
    ...(names.size && { mcpServers: [...names] }),
  };
}

/** `claude plugin list --json --available` and `marketplace list --json` for `cwd`, shaped for the dialog. */
export function toList(raw: { installed: RawInstalled[]; available: RawAvailable[] }, rawMarkets: RawMarketplace[], cwd: string) {
  const here = resolve(cwd);
  // Local and project rows of other projects are not this project's plugins (the CLI lists every project's).
  const installed: InstalledPlugin[] = raw.installed
    .filter((p) => !p.projectPath || resolve(p.projectPath) === here)
    .map((p) => ({
      id: p.id,
      ...(p.version !== undefined && { version: p.version }),
      scope: p.scope,
      enabled: p.enabled !== false,
      ...(p.projectPath && { projectPath: p.projectPath }),
      ...manifestOf(p.installPath),
      updatable: updatable(p),
    }));
  const ids = new Set(installed.map((p) => p.id));
  const markets = new Map(rawMarkets.map((m) => [m.name, m]));
  const available: AvailablePlugin[] = raw.available
    .filter((a) => !ids.has(a.pluginId))
    .map((a) => {
      const m = markets.get(a.marketplaceName);
      const url = sourceUrl(m, a.source);
      return {
        pluginId: a.pluginId,
        name: a.name,
        ...(a.description && { description: a.description }),
        marketplaceName: a.marketplaceName,
        official: !!m && official(m),
        ...(url && { sourceUrl: url }),
        installCount: a.installCount ?? 0,
      };
    });
  return { installed, available, marketplaces: rawMarkets.map(toMarketplace) };
}

const toMarketplace = (m: RawMarketplace): MarketplaceInfo => ({
  name: m.name,
  source: m.source,
  ...(m.repo !== undefined && { repo: m.repo }),
  ...(m.url !== undefined && { url: m.url }),
  ...(m.path !== undefined && { path: m.path }),
  ...(m.package !== undefined && { package: m.package }),
  official: official(m),
});

/** The `--json` result line of a plugin command, if it printed one. */
function resultLine(stdout: string): { outcome?: string; message?: string; failureCode?: string } | undefined {
  for (const line of stdout.trim().split("\n").reverse())
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object") return v;
    } catch {
      // A human line ("Installing plugin …").
    }
  return undefined;
}

/** The CLI's error: the `--json` message, else the first stderr line without its "✘ Failed to … plugin "x": " prefix. */
function errorOf(r: { code: number; stdout: string; stderr: string }) {
  const line = r.stderr.trim().split("\n")[0]?.trim() ?? "";
  return resultLine(r.stdout)?.message || line.replace(/^[✘✗×]\s*Failed to [^:]*:\s*/, "") || `claude exited with code ${r.code}`;
}

/** The extension's update failure kinds (`bX5`): the CLI's failureCode first, else its message patterns. */
export function failureKind(message: string, failureCode?: string): PluginUpdateFailure {
  if (failureCode === "not_found") return "not_found";
  if (failureCode === "not_installed" || failureCode === "not_installed_at_scope") return "not_installed";
  if (failureCode === "command_source_refused") return "needs_consent";
  if (failureCode?.includes("policy") || failureCode === "managed_name_locked") return "policy";
  if (
    /^(?:Plugin "[^"]*" is blocked by your organization's policy|Plugin "[^"]*" is from marketplace "[^"]*", which is blocked by your organization's policy|Command-sourced plugins are disabled by your organization's managed settings|"[^"]*" fetches its archive through a (?:marketplace-declared )?headersHelper command(?: that was not run)?[,:] .*(?:your organization's managed settings|not yet verified|consented))/.test(
      message,
    )
  )
    return "policy";
  if (/^\S+ is disabled, so the command that installs it was not run\./.test(message)) return "disabled";
  if (
    /^(?:Aborted — the headersHelper command was not confirmed|This (?:update|install) would run a headersHelper command for "|The headersHelper command for "[^"]*" changed since it was shown|The archive URL for "[^"]*" changed since its headersHelper command was shown|\S+ is installed by running a command on this machine \(`|\S+'s marketplace entry now installs it by running a command on this machine \(`|\S+'s marketplace entry changed while it was being installed \(it now declares `|\S+'s marketplace changed the command that installs it, or how its output is used \(now `)/.test(
      message,
    )
  )
    return "needs_consent";
  if (/^Plugin "[^"]*" is not installed(?: at scope |$)/.test(message)) return "not_installed";
  if (/^(?:Plugin "[^"]*" not found$|Plugin source not found at |Plugin "[^"]*" is not in the locally cached marketplace catalog)/.test(message)) return "not_found";
  if (/^(?:Failed to clone repository: |Failed to (?:fetch|download) |fetch failed|getaddrinfo |connect E[A-Z]+ )/.test(message)) return "network";
  return "other";
}

/** The extension's test (`EA0`): an update that changed nothing needs no reload. */
const unchanged = (message: string) => /^[^\s"]+ is already at the latest version (?:\(|satisfying )/.test(message) || /^Skipped — /.test(message);

/** A plugin id or marketplace name as the dialog sends it; after "--" so "-x" is no option, but never empty or multi-line. */
function arg(v: unknown, what: string) {
  if (typeof v !== "string" || !v.trim() || /[\n\r\0]/.test(v)) throw new ConfigError("bad_request", `${what} required`);
  return v.trim();
}

/**
 * `cli`: runs the CLI. `reload`: `reloadPlugins()` in every live query. `restart`: closes a session's live query.
 * `onChanged`: after a write in `cwd` (the daemon drops held config queries and broadcasts `config.changed`).
 */
export function createPlugins(opts: { cli: CliRunner; reload: () => Promise<ReloadResult>; restart: (sessionId: string) => void; onChanged: (cwd: string, reload?: ReloadResult) => void }) {
  const json = async (args: string[], cwd: string) => {
    const r = await opts.cli(args, cwd);
    if (r.code !== 0) throw new ConfigError("cli_failed", errorOf(r));
    try {
      return JSON.parse(r.stdout);
    } catch {
      throw new ConfigError("cli_failed", `unexpected output of claude ${args.slice(0, 3).join(" ")}`);
    }
  };
  const marketplaces = (cwd: string): Promise<RawMarketplace[]> => json(["plugin", "marketplace", "list", "--json"], cwd);
  /** Runs a write; then reloads (when it changes what sessions load) and tells every connection. */
  async function write(args: string[], cwd: string, reload: boolean) {
    const r = await opts.cli(args, cwd);
    if (r.code !== 0) throw new ConfigError("cli_failed", errorOf(r));
    const result = reload ? await opts.reload() : undefined;
    opts.onChanged(cwd, result);
    return result;
  }

  async function handle(msg: PluginsRequest, cwd: string): Promise<unknown> {
    switch (msg.type) {
      case "plugins.list": {
        const [raw, markets] = await Promise.all([json(["plugin", "list", "--json", "--available"], cwd), marketplaces(cwd)]);
        return toList(raw, markets, cwd);
      }
      case "marketplace.list":
        return { marketplaces: (await marketplaces(cwd)).map(toMarketplace) };
      case "plugins.install": {
        const id = arg(msg.pluginId, "pluginId");
        if (!SCOPES.includes(msg.scope)) throw new ConfigError("bad_request", "scope must be user, project or local");
        try {
          return { reload: await write(["plugin", "install", "--scope", msg.scope, "--json", "-y", "--", id], cwd, true) };
        } catch (e) {
          // The extension's notices for a plugin that is installed already or no longer in its marketplace.
          const name = id.includes("@") ? id.slice(0, id.lastIndexOf("@")) : id;
          if (e instanceof ConfigError && /already installed/i.test(e.message)) throw new ConfigError("cli_failed", `Plugin "${name}" is already installed.`);
          if (e instanceof ConfigError && /not found in marketplace/i.test(e.message)) throw new ConfigError("cli_failed", `Plugin "${name}" not found in the marketplace.`);
          throw e;
        }
      }
      case "plugins.uninstall": {
        // Without --scope the CLI uninstalls from user scope and refuses a local or project plugin.
        const scope = SCOPES.includes(msg.scope as ConfigScope) ? ["--scope", msg.scope as string] : [];
        return { reload: await write(["plugin", "uninstall", ...scope, "--json", "-y", "--", arg(msg.pluginId, "pluginId")], cwd, true) };
      }
      case "plugins.setEnabled":
        if (typeof msg.enabled !== "boolean") throw new ConfigError("bad_request", "enabled must be a boolean");
        // No --scope: the CLI finds the scope that enables it, as the extension does.
        return { reload: await write(["plugin", msg.enabled ? "enable" : "disable", "--json", "--", arg(msg.pluginId, "pluginId")], cwd, true) };
      case "plugins.update": {
        const id = arg(msg.pluginId, "pluginId");
        if (!UPDATE_SCOPES.includes(msg.scope)) throw new ConfigError("bad_request", "scope must be user, project, local or managed");
        let r;
        try {
          r = await opts.cli(["plugin", "update", "--scope", msg.scope, "--json", "-y", "--", id], cwd);
        } catch (e) {
          if (e instanceof ConfigError && e.code === "cli_timeout") return { outcome: "failed", kind: "timeout", message: e.message } satisfies PluginUpdateResult;
          throw e;
        }
        const line = resultLine(r.stdout);
        if (r.code !== 0 || line?.outcome === "failed") {
          const message = errorOf(r);
          return { outcome: "failed", kind: failureKind(message, line?.failureCode), message } satisfies PluginUpdateResult;
        }
        const message = line?.message ?? r.stdout.trim().split("\n").at(-1)?.replace(/^[✔√]\s*/, "");
        const reload = !message || !unchanged(message) ? await opts.reload() : undefined;
        opts.onChanged(cwd, reload);
        return { outcome: "ok", ...(message && { message }), ...(reload && { reload }) } satisfies PluginUpdateResult;
      }
      case "plugins.reload": {
        const reload = await opts.reload();
        opts.onChanged(cwd, reload);
        return reload;
      }
      case "plugins.restart":
        opts.restart(arg(msg.sessionId, "sessionId"));
        return {};
      case "marketplace.add":
        await write(["plugin", "marketplace", "add", "--", arg(msg.source, "source")], cwd, false);
        return {};
      case "marketplace.remove":
        // Its plugins are uninstalled with it.
        return { reload: await write(["plugin", "marketplace", "remove", "--", arg(msg.name, "name")], cwd, true) };
      case "marketplace.update":
        await write(["plugin", "marketplace", "update", "--", arg(msg.name, "name")], cwd, false);
        return {};
    }
  }

  return { handle };
}
