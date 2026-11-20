// The MCP servers dialog on OpenCode 1 (docs/spec.md "Config dialogs"): reads and runtime actions go to OpenCode's `/mcp` routes, saved changes are written
// into the project config file by the daemon (opencode-config-file.ts; `PATCH /config` writes a file OpenCode does not read).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import type { McpAddConfig, McpAuthResult, McpListResult, McpServerInfo } from "@claude-ui/protocol";
import { EngineError, type EngineConfig } from "./engine-catalogue.ts";
import { ConfigFileError, editProjectFile, projectKeys } from "./opencode-config-file.ts";
import { brokenState } from "./opencode-engine.ts";
import type { OpenCodeServer } from "./opencode-server.ts";

/** The longest a read or an action waits before the dialog gets the servers as pending (the dialog polls while one is pending). */
export const MCP_WAIT_MS = 3000;
/** The longest `mcp.authenticate` waits for OpenCode on the local flow: it answers when the sign-in redirect arrived, which the dialog polls for. */
const AUTH_WAIT_MS = 1500;
const NAME = /^[a-zA-Z0-9_-]+$/;

type McpConfig = { type?: string; command?: string[]; url?: string; enabled?: boolean };
type Status = Record<string, { status: string; error?: string }>;

const fail = (code: string, message: string) => new EngineError(code, message);

/** Names of the servers the user's global OpenCode config defines (scope `user`). */
function globalNames(): Set<string> {
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
  const names = new Set<string>();
  for (const f of ["opencode.json", "opencode.jsonc"]) {
    const file = join(dir, f);
    if (!existsSync(file)) continue;
    try {
      const mcp = (parse(readFileSync(file, "utf8"), [], { allowTrailingComma: true }) as { mcp?: Record<string, unknown> } | undefined)?.mcp;
      if (mcp && typeof mcp === "object") for (const n of Object.keys(mcp)) names.add(n);
    } catch {
      // An unreadable global file: its servers show as dynamic.
    }
  }
  return names;
}

const mapStatus = (s: string) => (s === "needs_auth" || s === "needs_client_registration" ? "needs-auth" : s);

/** Header lines "Name: value" and env lines "KEY=value" of the add form as the objects OpenCode takes. */
const pairs = (lines: string[], sep: string) =>
  Object.fromEntries(
    lines.flatMap((l) => {
      const at = l.indexOf(sep);
      return at > 0 ? [[l.slice(0, at).trim(), l.slice(at + sep.length).trim()] as const] : [];
    }),
  );

export function createOpenCodeMcpConfig(o: { server: OpenCodeServer; repair(cwd: string): Promise<boolean>; hidden(name: string): boolean; waitMs?: number }): EngineConfig["mcp"] {
  const { server } = o;
  const waitMs = o.waitMs ?? MCP_WAIT_MS;
  /** `GET /mcp` of a folder in flight: concurrent reads share it (the request is never aborted, so they would pile up on a slow OpenCode). */
  const reads = new Map<string, Promise<Status>>();
  /** Servers removed from the file while a session of the folder was busy (no dispose yet): hidden until OpenCode stops listing them. */
  const removed = new Map<string, Set<string>>();

  const read = (cwd: string): Promise<Status> => {
    const hit = reads.get(cwd);
    if (hit) return hit;
    const get = () => server.request<Status>("/mcp", { directory: cwd, timeoutMs: 0 });
    const run = get()
      .catch(async (err) => (brokenState(err) && (await o.repair(cwd)) ? get() : Promise.reject(err)))
      .finally(() => reads.delete(cwd));
    reads.set(cwd, run);
    return run;
  };
  /** Waits for `p` at most `waitMs`; `p` itself is never cut off. "late": still running. */
  const raced = async <T>(p: Promise<T>, ms = waitMs): Promise<{ value: T } | "late"> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), ms)));
    p.catch(() => {});
    try {
      const v = await Promise.race([p.then((value) => ({ value })), late]);
      return v;
    } finally {
      clearTimeout(timer);
    }
  };
  const call = (cwd: string, path: string, method = "POST", body?: unknown) => server.request<unknown>(path, { method, directory: cwd, timeoutMs: 0, ...(body !== undefined && { body }) });
  const mcpPath = (name: string, rest: string) => {
    if (!NAME.test(name)) throw fail("invalid_input", `Not a server name: ${name}`);
    return `/mcp/${encodeURIComponent(name)}${rest}`;
  };

  async function list(cwd: string): Promise<McpListResult> {
    // Never cut off (a cold MCP load may hold it too), never an unhandled rejection: a failed read gives no type or command.
    const config = server.request<{ mcp?: Record<string, McpConfig> }>("/config", { directory: cwd, timeoutMs: 0 }).then((c) => c.mcp ?? {}, () => undefined);
    const first = await raced(read(cwd));
    let defined: Record<string, McpConfig> = {};
    let status: Status;
    if (first === "late") {
      const c = await raced(config);
      if (c === "late" || !c.value) throw fail("opencode_loading", "OpenCode is still loading this folder. Try again in a moment.");
      defined = c.value;
      status = Object.fromEntries(Object.entries(defined).map(([name, m]) => [name, { status: m.enabled === false ? "disabled" : "pending" }]));
    } else {
      status = first.value;
      defined = (await config) ?? {};
    }
    const project = projectKeys(cwd, ["mcp"]);
    const user = globalNames();
    const gone = removed.get(cwd);
    if (gone) {
      for (const n of [...gone]) if (!(n in status)) gone.delete(n);
      if (!gone.size) removed.delete(cwd);
    }
    const servers: McpServerInfo[] = Object.entries(status)
      .filter(([name]) => !o.hidden(name) && !gone?.has(name))
      .map(([name, s]) => {
        const c = defined[name];
        return {
          name,
          status: mapStatus(s.status),
          scope: project.has(name) ? "project" : user.has(name) ? "user" : "dynamic",
          ...(s.error && { error: s.error }),
          ...(c && { config: { type: c.type === "remote" ? "http" : "stdio", ...(c.command?.[0] && { command: c.command[0] }), ...(c.url && { url: c.url }) } }),
        };
      });
    return { servers };
  }

  /** The list after an action whose answer may take long: late = the servers as pending. */
  const after = async (cwd: string, applied?: boolean): Promise<McpListResult> => ({ ...(await list(cwd)), ...(applied === false && { applied }) });

  const ownProject = (cwd: string, name: string) => projectKeys(cwd, ["mcp"]).has(name);

  async function add(cwd: string, name: string, config: McpAddConfig) {
    if (!NAME.test(name)) throw fail("invalid_input", `Not a server name: ${name}`);
    if (config.transport === "sse") throw fail("unsupported", "OpenCode has no SSE transport. Use HTTP.");
    if (ownProject(cwd, name)) throw fail("already_exists", `A server named ${name} already exists in this project's opencode.json.`);
    const entry =
      config.transport === "stdio"
        ? { type: "local", command: [config.command, ...config.args], ...(config.env.length && { environment: pairs(config.env, "=") }) }
        : { type: "remote", url: config.url, ...(config.headers.length && { headers: pairs(config.headers, ":") }) };
    editProjectFile(cwd, ["mcp", name], entry);
    removed.get(cwd)?.delete(name);
    await raced(call(cwd, "/mcp", "POST", { name, config: entry }));
  }

  const handler: EngineConfig["mcp"] = async (msg, cwd, ctx) => {
    try {
      switch (msg.type) {
        case "mcp.list":
          return await list(cwd);
        case "mcp.toggle": {
          // Saved first (it survives a reload of the folder), then applied at once. A user-scope server gets a project override that holds only `enabled`.
          const path = mcpPath(msg.name, msg.enabled ? "/connect" : "/disconnect");
          editProjectFile(cwd, ["mcp", msg.name, "enabled"], msg.enabled);
          await raced(call(cwd, path));
          return await list(cwd);
        }
        case "mcp.reconnect": {
          await raced(call(cwd, mcpPath(msg.name, "/disconnect")).then(() => call(cwd, mcpPath(msg.name, "/connect"))));
          return await list(cwd);
        }
        case "mcp.add":
          if (msg.scope !== "project") throw fail("invalid_input", "OpenCode servers are saved in the project's opencode.json: use the Project scope.");
          await add(cwd, msg.name, msg.config);
          return await list(cwd);
        case "mcp.remove": {
          if (msg.scope !== "project" || !ownProject(cwd, msg.name)) throw fail("invalid_input", `${msg.name} is not defined in this project's opencode.json. Remove it where it is defined.`);
          editProjectFile(cwd, ["mcp", msg.name], undefined);
          removed.set(cwd, (removed.get(cwd) ?? new Set()).add(msg.name));
          await raced(call(cwd, mcpPath(msg.name, "/disconnect")).catch(() => {}));
          return await after(cwd, await o.repair(cwd));
        }
        case "mcp.authenticate": {
          if (ctx.local) {
            // A browser on this machine: OpenCode opens the sign-in tab itself and its redirect completes the flow (the dialog polls).
            const done = await raced(call(cwd, mcpPath(msg.name, "/auth/authenticate")), AUTH_WAIT_MS);
            return done === "late" ? ({ requiresUserAction: true, opened: true } satisfies McpAuthResult) : ({ requiresUserAction: false } satisfies McpAuthResult);
          }
          // Another machine: the redirect cannot reach OpenCode's port, so the dialog opens the page and the user pastes the redirect URL.
          const done = await raced(call(cwd, mcpPath(msg.name, "/auth")));
          if (done === "late") throw fail("opencode_loading", "OpenCode is still loading this folder. Try again in a moment.");
          const r = done.value as { authorizationUrl?: string };
          return { requiresUserAction: true, ...(r.authorizationUrl && { authUrl: r.authorizationUrl }) } satisfies McpAuthResult;
        }
        case "mcp.oauthCallback": {
          let code: string | null = null;
          try {
            code = new URL(msg.callbackUrl).searchParams.get("code");
          } catch {
            // Not a URL.
          }
          if (!code) throw fail("invalid_input", "The pasted address has no code. Paste the address of the page that opened after you signed in.");
          const sent = await raced(call(cwd, mcpPath(msg.name, "/auth/callback"), "POST", { code }));
          if (sent === "late") throw fail("opencode_loading", "OpenCode is still loading this folder. Try again in a moment.");
          return {};
        }
        case "mcp.clearAuth": {
          await raced(call(cwd, mcpPath(msg.name, "/auth"), "DELETE"));
          return await after(cwd, await o.repair(cwd));
        }
      }
    } catch (e) {
      if (e instanceof ConfigFileError) throw fail(e.code, e.message);
      throw e;
    }
  };
  return handler;
}
