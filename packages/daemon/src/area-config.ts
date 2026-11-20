// Area: the project configuration panels of a working directory: MCP servers, plugins, marketplaces and skills.
import { statSync } from "node:fs";
import type { ConfigTypes } from "./areas.ts";
import { EngineError } from "./engine-catalogue.ts";
import { ConfigError, type McpRequest, type SkillsRequest } from "./config.ts";
import type { DaemonContext } from "./daemon-context.ts";
import type { Area, Connection, Handlers, Msg, Respond } from "./dispatch.ts";
import type { PluginsRequest } from "./plugins.ts";

export type ConfigAreaContext = Pick<DaemonContext, "allowed" | "missingInRoots" | "config" | "plugins" | "commandCache" | "sessions" | "catalogues">;

export function createConfigArea(ctx: ConfigAreaContext, conn: Pick<Connection, "sameHost">): Area<ConfigTypes> {
  const { allowed, missingInRoots, config, plugins, commandCache, sessions, catalogues } = ctx;
  const request = async (msg: Msg<"mcp.list" | "mcp.toggle" | "mcp.reconnect" | "mcp.authenticate" | "mcp.oauthCallback" | "mcp.clearAuth" | "mcp.add" | "mcp.remove" | "plugins.list" | "plugins.install" | "plugins.uninstall" | "plugins.setEnabled" | "plugins.update" | "plugins.reload" | "plugins.restart" | "marketplace.list" | "marketplace.add" | "marketplace.remove" | "marketplace.update" | "skills.list" | "skills.setState">, res: Respond) => {
    if (missingInRoots(msg.cwd))
      return res.fail("bad_cwd", `Working directory not found: ${msg.cwd}. If this session's folder was deleted, re-open the project and try again.`);
    const cwd = allowed(msg.cwd);
    if (!cwd || !statSync(cwd).isDirectory()) return res.fail("cwd_not_allowed", `not a directory inside the allowlisted roots: ${msg.cwd}`);
    if (!msg.type.startsWith("mcp.") && !msg.type.startsWith("skills."))
      try {
        const r = await plugins.handle(msg as PluginsRequest, cwd);
        if (!msg.type.endsWith(".list")) commandCache.clear();
        return res.reply(r);
      } catch (e) {
        return res.fail(e instanceof ConfigError ? e.code : "plugins_failed", (e as Error).message);
      }
    // The session's running query when it runs in that project; otherwise the project's config query.
    const s = "sessionId" in msg && typeof msg.sessionId === "string" ? sessions.get(msg.sessionId) : undefined;
    // The Engine of the request: the live session's, else the one the client shows, else Claude (an older client). Only OpenCode answers config requests besides Claude.
    const engine = (s ? s.info().engine : undefined) ?? ("engine" in msg ? msg.engine : undefined) ?? "claude";
    if (engine !== "claude" && msg.type.startsWith("mcp."))
      try {
        const c = catalogues.byName(engine)?.config;
        if (!c) return res.fail("config_unsupported", `The ${engine} engine has no MCP servers dialog.`);
        return res.reply(await c.mcp(msg as Parameters<typeof c.mcp>[0], cwd, { local: conn.sameHost }));
      } catch (e) {
        return res.fail(e instanceof EngineError || e instanceof ConfigError ? e.code : "mcp_failed", (e as Error).message);
      }
    try {
      const live = s?.cwd === cwd ? s.claudeQuery() : undefined;
      const r = msg.type.startsWith("skills.") ? await config.skills(msg as SkillsRequest, cwd, live) : await config.mcp(msg as McpRequest, cwd, live);
      if (msg.type === "skills.setState") commandCache.clear();
      return res.reply(r);
    } catch (e) {
      return res.fail(e instanceof ConfigError ? e.code : msg.type.startsWith("skills.") ? "skills_failed" : "mcp_failed", (e as Error).message);
    }
  };

  const handlers: Handlers<ConfigTypes> = {
    "mcp.list": request,
    "mcp.toggle": request,
    "mcp.reconnect": request,
    "mcp.authenticate": request,
    "mcp.oauthCallback": request,
    "mcp.clearAuth": request,
    "mcp.add": request,
    "mcp.remove": request,
    "plugins.list": request,
    "plugins.install": request,
    "plugins.uninstall": request,
    "plugins.setEnabled": request,
    "plugins.update": request,
    "plugins.reload": request,
    "plugins.restart": request,
    "marketplace.list": request,
    "marketplace.add": request,
    "marketplace.remove": request,
    "marketplace.update": request,
    "skills.list": request,
    "skills.setState": request,
  };
  return { handlers };
}
