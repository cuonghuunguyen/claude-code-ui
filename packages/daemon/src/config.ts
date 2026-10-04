// Config dialogs (docs/spec.md "Config dialogs", same as the VS Code extension): live operations as control requests on the
// session's query or a config query held open per project cwd; config writes through the SDK-bundled Claude Code CLI.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { query as sdkQuery, type McpServerStatus, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { ClientMessage, ConfigScope, McpAddConfig, McpServerInfo } from "@claude-ui/protocol";
import { openQuery, THROWAWAY_TIMEOUT_MS, withoutApiKeys } from "./session.ts";

/** One-shot CLI call in `cwd`; resolves with its exit code and output (never rejects on a non-zero exit). */
export type CliRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A config query unused this long is closed (the extension keeps its CLI per panel; one OAuth flow must stay on one query). */
export const CONFIG_HOLD_MS = 30_000;
const CLI_TIMEOUT_MS = 30_000;

/** Error with the wire `code` the daemon replies. */
export class ConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Control requests of the CLI that `sdk.d.ts` 0.3.285 does not declare (present in `sdk.mjs` 0.3.285 and the bundled CLI 2.1.285,
 * used by the VS Code extension 2.1.283). A CLI without one answers "Unsupported control request subtype", shown as the error.
 */
type ExtraQuery = Query & {
  mcpAuthenticate(name: string, redirectUri?: string): Promise<{ authUrl?: string; requiresUserAction: boolean }>;
  mcpClearAuth(name: string): Promise<unknown>;
  mcpSubmitOAuthCallbackUrl(name: string, callbackUrl: string): Promise<unknown>;
};

/** The Claude Code binary the SDK runs (same version as the sessions); `CLAUDE_UI_CLAUDE_BIN` overrides it. */
export function claudeBin() {
  if (process.env.CLAUDE_UI_CLAUDE_BIN) return process.env.CLAUDE_UI_CLAUDE_BIN;
  const require = createRequire(import.meta.url);
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  // The SDK's own order: glibc first unless the system has no glibc.
  const glibc = !!(process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  const names = process.platform === "linux" ? (glibc ? [base, `${base}-musl`] : [`${base}-musl`, base]) : [base];
  for (const n of names)
    try {
      return require.resolve(`${n}/claude${process.platform === "win32" ? ".exe" : ""}`);
    } catch {
      // Not installed for this platform.
    }
  throw new Error("the Agent SDK's Claude Code binary is not installed; set CLAUDE_UI_CLAUDE_BIN");
}

/** execFile of the bundled CLI without API keys (ADR 0002), 30 s timeout, 10 MB output. Arguments may hold secrets: never logged. */
export const runCli: CliRunner = (args, cwd) =>
  new Promise((resolve, reject) =>
    execFile(claudeBin(), args, { cwd, env: withoutApiKeys(process.env), timeout: CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err?.killed) return reject(new ConfigError("cli_timeout", "Claude CLI timed out after 30s"));
      if (err && typeof err.code !== "number") return reject(new ConfigError("cli_failed", err.message));
      resolve({ code: err ? (err.code as number) : 0, stdout, stderr });
    }),
  );

const firstLine = (t: string) => t.trim().split("\n")[0]!.trim();

const SCOPES: ConfigScope[] = ["local", "user", "project"];
const NAME = /^[A-Za-z0-9_-]+$/;
const isStrings = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === "string");

/** `claude mcp add` arguments, as the extension builds them; throws `bad_request` for values the form would not send. */
export function mcpAddArgs(name: unknown, scope: unknown, config: unknown): string[] {
  const bad = (m: string) => new ConfigError("bad_request", m);
  // After "--": a name like "-x" is not read as an option.
  if (typeof name !== "string" || !NAME.test(name)) throw bad("Names can only contain letters, numbers, hyphens, and underscores.");
  if (!SCOPES.includes(scope as ConfigScope)) throw bad("scope must be local, user or project");
  const c = config as McpAddConfig;
  if (typeof c !== "object" || c === null) throw bad("config required");
  if (c.transport === "stdio") {
    if (typeof c.command !== "string" || !c.command.trim()) throw bad("Command is required.");
    if (!isStrings(c.args) || !isStrings(c.env) || c.env.some((e) => e.indexOf("=") <= 0)) throw bad("Environment variables must be KEY=value.");
    return ["mcp", "add", "--scope", scope as string, "--transport", "stdio", ...c.env.flatMap((e) => ["--env", e]), "--", name, c.command, ...c.args];
  }
  if (c.transport === "http" || c.transport === "sse") {
    if (typeof c.url !== "string" || !c.url.trim()) throw bad("URL is required.");
    if (!isStrings(c.headers) || c.headers.some((h) => h.indexOf(":") <= 0)) throw bad('Headers must be "Header-Name: value".');
    return ["mcp", "add", "--scope", scope as string, "--transport", c.transport, ...c.headers.flatMap((h) => ["--header", h]), "--", name, c.url];
  }
  throw bad("transport must be stdio, http or sse");
}

/** What reaches the browser: no headers, env or args (they may hold tokens), tools by name and annotations only. */
function toInfo(s: McpServerStatus): McpServerInfo {
  const c = s.config as { type?: string; command?: string; url?: string };
  return {
    name: s.name,
    status: s.status,
    ...(s.scope !== undefined && { scope: s.scope }),
    ...(s.source !== undefined && { source: s.source }),
    ...(s.error !== undefined && { error: s.error }),
    ...(s.serverInfo && { serverInfo: { name: s.serverInfo.name, version: s.serverInfo.version } }),
    config: { type: c.type ?? "stdio", ...(c.command !== undefined && { command: c.command }), ...(c.url !== undefined && { url: c.url }) },
    ...(s.tools && { tools: s.tools.map((t) => ({ name: t.name, ...(t.annotations?.readOnly && { readOnly: true }), ...(t.annotations?.destructive && { destructive: true }) })) }),
  };
}

/** Rejects after the throwaway timeout: a hung CLI must not hang the dialog. */
const timed = <T,>(p: Promise<T>) => {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new ConfigError("cli_timeout", `no answer from the CLI within ${THROWAWAY_TIMEOUT_MS} ms`)), THROWAWAY_TIMEOUT_MS)))]).finally(() => clearTimeout(t));
};

export type McpRequest = Extract<ClientMessage, { type: `mcp.${string}` }>;

/**
 * `cli`: runs the CLI (tests inject a fake). `holdMs`: config query hold. `onChanged`: after a config write in `cwd`
 * (the daemon broadcasts `config.changed`).
 */
export function createConfig(opts: { query?: typeof sdkQuery; cli?: CliRunner; holdMs?: number; onChanged: (kind: "mcp", cwd: string) => void }) {
  const cli = opts.cli ?? runCli;
  const holdMs = opts.holdMs ?? CONFIG_HOLD_MS;
  // One config query per project cwd: OAuth state lives in its CLI process, so a flow's requests must reach the same one.
  // ponytail: not in the one-at-a-time throwaway queue (it would block context usage reads for the whole hold); one per open project dialog.
  const held = new Map<string, { q: Query; timer?: NodeJS.Timeout }>();
  // Config type of each listed server by cwd and name: the CLI drops claude.ai connectors from its status for a moment while
  // it reloads (after a toggle), and Authenticate still has to know one.
  // ponytail: never pruned; a few short strings per server ever listed.
  const types = new Map<string, string>();
  const drop = (cwd: string, q: Query) => {
    const h = held.get(cwd);
    if (h?.q !== q) return;
    clearTimeout(h.timer);
    held.delete(cwd);
    q.close();
  };
  function configQuery(cwd: string) {
    let h = held.get(cwd);
    if (!h) {
      const q = openQuery(opts.query, { cwd, persistSession: false });
      h = { q };
      held.set(cwd, h);
      // Its CLI exited (crash): the next request starts a new one.
      void (async () => {
        try {
          for await (const _ of q);
        } catch {
          // Ended by close() or a crash; either way it is gone.
        }
        drop(cwd, q);
      })();
    }
    const hold = h;
    clearTimeout(hold.timer);
    hold.timer = setTimeout(() => drop(cwd, hold.q), holdMs);
    return hold.q;
  }

  async function write(args: string[], cwd: string) {
    const r = await cli(args, cwd);
    if (r.code !== 0) throw new ConfigError("cli_failed", firstLine(r.stderr) || firstLine(r.stdout) || `claude exited with code ${r.code}`);
    opts.onChanged("mcp", cwd);
    return {};
  }

  /** Handles one `mcp.*` request for `cwd` (checked by the caller); `live`: the session's running query, if any. */
  async function mcp(msg: McpRequest, cwd: string, live?: Query): Promise<unknown> {
    if (msg.type === "mcp.add") return write(mcpAddArgs(msg.name, msg.scope, msg.config), cwd);
    if (msg.type === "mcp.remove") {
      if (typeof msg.name !== "string" || !NAME.test(msg.name)) throw new ConfigError("bad_request", "invalid server name");
      if (!SCOPES.includes(msg.scope)) throw new ConfigError("bad_request", "scope must be local, user or project");
      return write(["mcp", "remove", "--scope", msg.scope, "--", msg.name], cwd);
    }
    if (msg.type !== "mcp.list" && typeof msg.name !== "string") throw new ConfigError("bad_request", "name required");
    const q = (live ?? configQuery(cwd)) as ExtraQuery;
    const call = async <T,>(p: () => Promise<T>) => {
      try {
        return await timed(p());
      } catch (e) {
        if (!live && e instanceof ConfigError && e.code === "cli_timeout") drop(cwd, q);
        throw e;
      } finally {
        // The hold counts from the last answer.
        if (!live && held.get(cwd)?.q === q) configQuery(cwd);
      }
    };
    const status = () => call(() => q.mcpServerStatus());
    const remember = (list: McpServerStatus[]) => list.forEach((s) => s.config && types.set(`${cwd}\0${s.name}`, s.config.type ?? "stdio"));
    const servers = async () => {
      const list = (await status()).filter((s) => s.source !== "sdk" && s.config);
      remember(list);
      return { servers: list.map(toInfo) };
    };
    const typeOf = async (name: string) => {
      remember(await status());
      const type = types.get(`${cwd}\0${name}`);
      if (!type) throw new ConfigError("not_found", `Server "${name}" not found`);
      return type;
    };
    switch (msg.type) {
      case "mcp.list":
        return servers();
      case "mcp.toggle":
        if (typeof msg.enabled !== "boolean") throw new ConfigError("bad_request", "enabled must be a boolean");
        await call(() => q.toggleMcpServer(msg.name, msg.enabled));
        return servers();
      case "mcp.reconnect":
        await call(() => q.reconnectMcpServer(msg.name));
        return servers();
      case "mcp.authenticate": {
        const type = await typeOf(msg.name);
        // The extension opens an organization URL; without the org ID the connectors page (owner decision, GH-42 question 4).
        if (type === "claudeai-proxy") return { authUrl: "https://claude.ai/customize/connectors", requiresUserAction: true };
        if (type !== "http" && type !== "sse") throw new ConfigError("not_supported", `Server type "${type}" does not support authentication`);
        const r = await call(() => q.mcpAuthenticate(msg.name));
        return { ...(r.authUrl && { authUrl: r.authUrl }), requiresUserAction: !!r.requiresUserAction };
      }
      case "mcp.oauthCallback":
        if (typeof msg.callbackUrl !== "string" || !msg.callbackUrl.trim()) throw new ConfigError("bad_request", "callbackUrl required");
        await call(() => q.mcpSubmitOAuthCallbackUrl(msg.name, msg.callbackUrl.trim()));
        return {};
      case "mcp.clearAuth": {
        const type = await typeOf(msg.name);
        if (type === "claudeai-proxy") throw new ConfigError("not_supported", "Cannot clear authentication for claudeai-proxy servers (uses session cookies)");
        if (type !== "http" && type !== "sse") throw new ConfigError("not_supported", `Server type "${type}" does not support authentication`);
        await call(() => q.mcpClearAuth(msg.name));
        return {};
      }
    }
  }

  return { mcp };
}
