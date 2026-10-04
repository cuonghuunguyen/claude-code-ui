// Config dialogs (docs/spec.md "Config dialogs", same as the VS Code extension): live operations as control requests on the
// session's query or a config query held open per project cwd; config writes through the SDK-bundled Claude Code CLI.
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { query as sdkQuery, type McpServerStatus, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { ClientMessage, ConfigKind, ConfigScope, McpAddConfig, McpServerInfo, SkillHandles, SkillRow, SkillsResult, SkillsSetStateResult } from "@claude-ui/protocol";
import { openQuery, THROWAWAY_TIMEOUT_MS, withoutApiKeys } from "./session.ts";

/** One-shot CLI call in `cwd` (`stdin`: written to it, for `edit-skill-overrides`); resolves with its exit code and output (never rejects on a non-zero exit). */
/** `timeoutMs`: default 30 s; commands that fetch from git pass more. */
export type CliRunner = (args: string[], cwd: string, stdin?: string, timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/** A config query unused this long is closed (the extension keeps its CLI per panel; one OAuth flow must stay on one query). */
export const CONFIG_HOLD_MS = 30_000;
const CLI_TIMEOUT_MS = 30_000;
/** After a skill state write: reads of the dialog, 1 s apart, until the row shows the new state (the extension polls the same way). */
const SKILLS_POLLS = 5;
const SKILLS_POLL_MS = 1000;

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
  getSkillsDialog(): Promise<{ skills: RawSkill[] }>;
};
/** A `get_skills_dialog` row as the CLI 2.1.285 sends it. */
type RawSkill = { name: string; display_name: string; description: string; source: string; tokens: number; state: string; locked_by?: string; advertised: boolean; handles?: SkillHandles };

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

export const timeoutMessage = (ms: number) => `Claude CLI timed out after ${ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1000} s`}`;

/** execFile of the bundled CLI without API keys (ADR 0002), 30 s timeout unless asked, 10 MB output. Arguments may hold secrets: never logged. */
export const runCli: CliRunner = (args, cwd, stdin, timeoutMs = CLI_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    // Set when the daemon itself was started from a Claude Code session: `edit-skill-overrides` then refuses ("cannot be changed from an editor started inside a Claude Code session").
    const { CLAUDE_CODE_CHILD_SESSION: _child, ...env } = withoutApiKeys(process.env);
    const child = execFile(claudeBin(), args, { cwd, env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err?.killed) return reject(new ConfigError("cli_timeout", timeoutMessage(timeoutMs)));
      if (err && typeof err.code !== "number") return reject(new ConfigError("cli_failed", err.message));
      resolve({ code: err ? (err.code as number) : 0, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

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
    config: { type: c.type ?? "stdio", ...(c.command !== undefined && { command: c.command }), ...(c.url !== undefined && { url: redactUrl(c.url) }) },
    ...(s.tools && { tools: s.tools.map((t) => ({ name: t.name, ...(t.annotations?.readOnly && { readOnly: true }), ...(t.annotations?.destructive && { destructive: true }) })) }),
  };
}

/** Query-string values and a password in a server URL may be tokens: `***` in their place; an unparsable URL loses its query. */
function redactUrl(url: string) {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    // Not via searchParams: it would re-encode the keys.
    u.search = u.search.replace(/=[^&]*/g, "=***");
    return u.href;
  } catch {
    return url.replace(/\?.*/s, "");
  }
}

/** Rejects after the throwaway timeout: a hung CLI must not hang the dialog. */
export const timed = <T,>(p: Promise<T>) => {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new ConfigError("cli_timeout", `no answer from the CLI within ${THROWAWAY_TIMEOUT_MS} ms`)), THROWAWAY_TIMEOUT_MS)))]).finally(() => clearTimeout(t));
};

export type McpRequest = Extract<ClientMessage, { type: `mcp.${string}` }>;
export type SkillsRequest = Extract<ClientMessage, { type: `skills.${string}` }>;

const SKILL_STATES = ["on", "name-only", "user-invocable-only", "off"];
const toSkill = (s: RawSkill): SkillRow => ({
  name: s.name,
  displayName: s.display_name,
  description: s.description,
  source: s.source,
  tokens: s.tokens,
  state: s.state,
  ...(s.locked_by !== undefined && { lockedBy: s.locked_by }),
  advertised: s.advertised,
  ...(s.handles && { handles: s.handles }),
});

/**
 * `cli`: runs the CLI (tests inject a fake). `holdMs`: config query hold. `onChanged`: after a config write in `cwd`
 * (the daemon broadcasts `config.changed`).
 */
export function createConfig(opts: { query?: typeof sdkQuery; cli?: CliRunner; holdMs?: number; pollMs?: number; onChanged: (kind: ConfigKind, cwd: string) => void }) {
  const cli = opts.cli ?? runCli;
  const pollMs = opts.pollMs ?? SKILLS_POLL_MS;
  const holdMs = opts.holdMs ?? CONFIG_HOLD_MS;
  // One config query per project cwd: OAuth state lives in its CLI process, so a flow's requests must reach the same one.
  // ponytail: not in the one-at-a-time throwaway queue (it would block context usage reads for the whole hold); one per open project dialog.
  const held = new Map<string, { q: Query; timer?: NodeJS.Timeout }>();
  // The query of a project whose OAuth flow waits for its callback. A config write replaces the held query, but not this
  // one: it runs until the flow ends or the hold passes, so another tab's add/remove does not end the flow.
  const flows = new Map<string, { q: Query; timer?: NodeJS.Timeout }>();
  // Config type of each listed server by cwd and name: the CLI drops claude.ai connectors from its status for a moment while
  // it reloads (after a toggle), and Authenticate still has to know one.
  // ponytail: never pruned; a few short strings per server ever listed.
  const types = new Map<string, string>();
  const drop = (cwd: string, q: Query) => {
    const h = held.get(cwd);
    if (flows.get(cwd)?.q === q && h?.q !== q) {
      // Detached by a config write: only the flow's end or its hold closes it.
      clearTimeout(flows.get(cwd)!.timer);
      flows.delete(cwd);
      return q.close();
    }
    if (h?.q !== q) return;
    clearTimeout(h.timer);
    held.delete(cwd);
    if (flows.get(cwd)?.q === q) flows.delete(cwd);
    q.close();
  };
  /** A detached flow query is used: its hold counts from now. */
  const flowHold = (cwd: string) => {
    const f = flows.get(cwd);
    if (!f) return;
    clearTimeout(f.timer);
    f.timer = setTimeout(() => drop(cwd, f.q), holdMs);
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
    // The held query read its config at start; the next list needs a fresh one. One with a waiting OAuth flow lives on, detached.
    const h = held.get(cwd);
    if (h && flows.get(cwd)?.q === h.q) held.delete(cwd);
    else if (h) drop(cwd, h.q);
    opts.onChanged("mcp", cwd);
    return {};
  }

  /** The query a dialog request goes to (the session's live one, else `flow`, else the project's config query) and a `call` that bounds each answer. */
  function access(cwd: string, live?: Query, flow?: Query) {
    const q = (live ?? flow ?? configQuery(cwd)) as ExtraQuery;
    const call = async <T,>(p: () => Promise<T>) => {
      try {
        return await timed(p());
      } catch (e) {
        if (!live && e instanceof ConfigError && e.code === "cli_timeout") drop(cwd, q);
        throw e;
      } finally {
        // The hold counts from the last answer.
        if (!live && held.get(cwd)?.q === q) configQuery(cwd);
        else if (!live && flows.get(cwd)?.q === q) flowHold(cwd);
      }
    };
    return { q, call };
  }

  /** Handles one `skills.*` request for `cwd` (checked by the caller); `live`: the session's running query, if any. */
  async function skills(msg: SkillsRequest, cwd: string, live?: Query): Promise<SkillsResult | SkillsSetStateResult> {
    const { q, call } = access(cwd, live);
    // A CLI without the request ("Unsupported control request subtype") shows commands only, as the extension does.
    const list = async () => {
      try {
        return (await call(() => q.getSkillsDialog())).skills.map(toSkill);
      } catch (e) {
        if (/unsupported control request/i.test((e as Error).message)) return [];
        throw e;
      }
    };
    if (msg.type === "skills.list") return { skills: await list() };
    if (typeof msg.name !== "string" || !msg.name) throw new ConfigError("bad_request", "name required");
    if (!SKILL_STATES.includes(msg.state)) throw new ConfigError("bad_request", "state must be on, name-only, user-invocable-only or off");
    const r = await cli(["edit-skill-overrides", "--json"], cwd, JSON.stringify({ name: msg.name, state: msg.state, handles: msg.handles ?? {} }));
    if (r.code !== 0) throw new ConfigError("cli_failed", firstLine(r.stderr) || firstLine(r.stdout) || `claude exited with code ${r.code}`);
    // The running query re-reads its skills; the change is saved either way, so a failed reload only delays the confirmation.
    await call(() => q.reloadSkills()).catch(() => {});
    let rows: SkillRow[] = [];
    let confirmed = false;
    for (let i = 0; i < SKILLS_POLLS && !confirmed; i++) {
      if (i) await new Promise((r) => setTimeout(r, pollMs));
      rows = await list();
      confirmed = rows.find((s) => s.name === msg.name)?.state === msg.state;
    }
    opts.onChanged("skills", cwd);
    return { skills: rows, confirmed };
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
    const flow = flows.get(cwd);
    // The callback belongs to the query that started the flow.
    const { q, call } = access(cwd, live, msg.type === "mcp.oauthCallback" ? flow?.q : undefined);
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
        if (!live && r.requiresUserAction) {
          const old = flows.get(cwd);
          if (old && old.q !== q && held.get(cwd)?.q !== old.q) drop(cwd, old.q);
          flows.set(cwd, held.get(cwd) ?? { q });
        }
        return { ...(r.authUrl && { authUrl: r.authUrl }), requiresUserAction: !!r.requiresUserAction };
      }
      case "mcp.oauthCallback":
        if (typeof msg.callbackUrl !== "string" || !msg.callbackUrl.trim()) throw new ConfigError("bad_request", "callbackUrl required");
        await call(() => q.mcpSubmitOAuthCallbackUrl(msg.name, msg.callbackUrl.trim()));
        // The flow is over; a detached query has nothing left to do.
        if (!live && flow && held.get(cwd)?.q !== flow.q) drop(cwd, flow.q);
        flows.delete(cwd);
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

  /** After a plugin write: plugins are user-wide, so every held config query has a stale view. */
  const dropAll = () => [...held].forEach(([cwd, h]) => drop(cwd, h.q));

  return { mcp, skills, dropAll };
}
