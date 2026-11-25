// The config dialogs on OpenCode 2 (docs/spec.md "Config dialogs", GH-864): MCP servers, skills and plugins. Reads go to OpenCode 2's routes; saved changes are written by the
// daemon into the project config file (opencode-config-file.ts: OpenCode 2 reads the OpenCode 1 shape too, and a file that already uses its own keys keeps them).
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenCodeClient } from "@opencode/client";
import type { InstalledPlugin, McpAddConfig, McpAuthResult, McpListResult, McpServerInfo, PluginsListResult, PluginUpdateResult, PluginWriteResult, SkillRow, SkillsResult, SkillsSetStateResult, SkillState } from "@claude-ui/protocol";
import { DAEMON_SERVER } from "./daemon-mcp.ts";
import { EngineError, type EngineConfig } from "./engine-catalogue.ts";
import { ConfigFileError, displayPath, docsOf, editFileAt, editFiles, editLists, editProjectFile, editProjectList, fileShape, globalDir, globalFiles, globalWriteTarget, projectDocs, readProjectValue, shapeOf, writeTarget } from "./opencode-config-file.ts";
import { MCP_WAIT_MS, NAME, mapStatus, pairs } from "./opencode-config-mcp.ts";
import { canon, inPluginFolder, normalize, REMOVE_GAP, specOf } from "./opencode-config-plugins.ts";
import { matches } from "./opencode-config-skills.ts";
import type { Agent2 } from "./opencode2-engine.ts";
import type { OpenCodeServer } from "./opencode-server.ts";

export const fail = (code: string, message: string) => new EngineError(code, message);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** OpenCode's folder of the user's own config. */
export const userConfigDir = globalDir;
export const inside = (file: string, dir: string) => file.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The agent lists of the OpenCode 2 engine (the skills' states are the default agent's rules). */
export type AgentSource = { agents(cwd: string): Promise<Agent2[]>; defaultAgent(cwd: string): Promise<string>; forgetAgents(cwd: string): void };
/** What the config modules need of the OpenCode 2 side. */
export type Config2Deps = {
  server: OpenCodeServer;
  /** Reloads the folder after a saved change: true when done, false when it waits for the folder's sessions to be idle (folder-reload.ts). */
  reload(cwd: string, kind: "skills" | "plugins" | "mcp"): Promise<boolean>;
  waitMs?: number;
};

/** The documents of OpenCode's merged config for a folder (`GET /api/config`), lowest priority first; a directory entry is no document. */
type Doc = { path?: string; info: { mcp?: { servers?: Record<string, { type?: string; command?: string[]; url?: string; disabled?: boolean }> }; permissions?: { action: string; resource: string; effect: string }[]; plugins?: unknown[] } };
export const documents = async (client: OpenCodeClient, cwd: string): Promise<Doc[]> =>
  ((await client.config.get({ location: { directory: cwd } })) as unknown as { type: string; path?: string; info?: unknown }[]).filter((d) => d.type === "document" && isObject(d.info)) as unknown as Doc[];

/** The daemon's own servers in OpenCode (`orchestration-<id>`, `claude-ui-<id>`): never listed. */
const daemonServer = (name: string) => name.startsWith(`${DAEMON_SERVER}-`) || name.startsWith("orchestration-");

/** Waits for `p` at most `ms`; `p` itself is never cut off. "late": still running. */
const raced = async <T>(p: Promise<T>, ms: number): Promise<{ value: T } | "late"> => {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), ms)));
  p.catch(() => {});
  try {
    return await Promise.race([p.then((value) => ({ value })), late]);
  } finally {
    clearTimeout(timer);
  }
};

/** The names of the servers the project's config files define (OpenCode 1 keys `mcp.<n>` or OpenCode 2 keys `mcp.servers.<n>` per file), with the files that hold each. */
const projectServers = (cwd: string) => serversIn(projectDocs(cwd));
/** The same for the user's global config files (`$OPENCODE_CONFIG` included). A file that does not parse shows no servers. */
function globalServers(): Map<string, { file: string; shape: "v1" | "v2" }[]> {
  try {
    return serversIn(docsOf(globalFiles()));
  } catch {
    return new Map();
  }
}
function serversIn(docs: { file: string; data: Record<string, unknown> }[]): Map<string, { file: string; shape: "v1" | "v2" }[]> {
  const out = new Map<string, { file: string; shape: "v1" | "v2" }[]>();
  for (const { file, data } of docs) {
    const shape = shapeOf(data);
    const mcp = data.mcp;
    const servers = isObject(mcp) ? (shape === "v2" ? mcp.servers : mcp) : undefined;
    if (isObject(servers)) for (const n of Object.keys(servers)) out.set(n, [...(out.get(n) ?? []), { file, shape }]);
  }
  return out;
}

/** The entry of server `name` in the project file that defines it (OpenCode 1 or 2 shape). */
function fileEntry(cwd: string, project: Map<string, { file: string; shape: "v1" | "v2" }[]>, name: string): { type?: string; command?: string[]; url?: string } | undefined {
  const shape = project.get(name)?.at(-1)?.shape;
  const v = shape && readProjectValue(cwd, shape === "v2" ? ["mcp", "servers", name] : ["mcp", name]);
  return isObject(v) ? (v as { type?: string; command?: string[]; url?: string }) : undefined;
}
/** The entry of server `name` in the highest global file that defines it. */
function globalEntry(user: Map<string, { file: string; shape: "v1" | "v2" }[]>, name: string): { type?: string; command?: string[]; url?: string } | undefined {
  const at = user.get(name)?.at(-1);
  if (!at) return undefined;
  const mcp = docsOf([at.file])[0]!.data.mcp;
  const v = isObject(mcp) ? (at.shape === "v2" ? (isObject(mcp.servers) ? mcp.servers[name] : undefined) : mcp[name]) : undefined;
  return isObject(v) ? (v as { type?: string; command?: string[]; url?: string }) : undefined;
}

export function createOpenCode2McpConfig(o: Config2Deps): EngineConfig["mcp"] {
  const { server } = o;
  const waitMs = o.waitMs ?? MCP_WAIT_MS;
  type Row = { name: string; status: { status: string; error?: string }; integrationID?: string };
  /** The sign-in attempt of each server being signed in (one at a time), by `<folder>\0<name>`. OpenCode 2 has no MCP sign-in route: it signs a server in through the OAuth attempt of its integration (as the provider login). */
  const attempts = new Map<string, { integrationID: string; attemptID: string }>();
  /** `GET /api/mcp` of a folder in flight: concurrent reads share it. */
  const reads = new Map<string, Promise<Row[]>>();
  const read = (cwd: string): Promise<Row[]> => {
    let hit = reads.get(cwd);
    if (!hit) {
      hit = server
        .client()
        .then((c) => c.mcp.list({ location: { directory: cwd } }))
        .then((r) => r.data as unknown as Row[])
        .finally(() => reads.delete(cwd));
      reads.set(cwd, hit);
    }
    return hit;
  };
  const doc = async (cwd: string) => (await server.client().then((c) => documents(c, cwd))).reverse();

  /** The server's row (with its `integrationID`). */
  const rowOf = async (cwd: string, name: string) => (await read(cwd)).find((r) => r.name === name);
  /** The OAuth method of an integration, as the integration list of the folder has it (a folder OpenCode has not loaded yet lists none for a moment). */
  async function oauthMethod(cwd: string, integrationID: string): Promise<string> {
    const c = await server.client();
    for (const stop = Date.now() + 5000; ; await sleep(250)) {
      const all = (await c.integration.list({ location: { directory: cwd } })).data as unknown as { id: string; methods: { type: string; id?: string }[] }[];
      const m = all.find((i) => i.id === integrationID)?.methods.find((x) => x.type === "oauth" && x.id);
      if (m) return m.id!;
      if (all.length || Date.now() >= stop) throw fail("unsupported", "OpenCode 2 offers no sign-in for this server.");
    }
  }
  /** The attempts of the folder are asked once (the dialog polls the list while it waits): a completed one reconnects the server, an ended one is dropped. */
  async function pollAttempts(cwd: string): Promise<boolean> {
    let changed = false;
    for (const [key, a] of [...attempts]) {
      if (!key.startsWith(`${cwd}\0`)) continue;
      const name = key.slice(cwd.length + 1);
      const s = await server.client().then((c) => c.integration.oauth.status({ integrationID: a.integrationID, attemptID: a.attemptID, location: { directory: cwd } })).then((r) => (r.data as unknown as { status: string }).status, () => "failed");
      if (s === "pending") continue;
      attempts.delete(key);
      changed = true;
      if (s === "complete") await server.client().then((c) => c.experimental.mcp.connect({ server: name, location: { directory: cwd } })).catch(() => {});
    }
    return changed;
  }
  async function authenticate(cwd: string, name: string): Promise<McpAuthResult> {
    const row = await rowOf(cwd, name);
    if (!row?.integrationID) throw fail("unsupported", "OpenCode 2 offers no sign-in for this server.");
    const key = `${cwd}\0${name}`;
    const c = await server.client();
    const old = attempts.get(key);
    attempts.delete(key);
    if (old) await c.integration.oauth.cancel({ integrationID: old.integrationID, attemptID: old.attemptID, location: { directory: cwd } }).catch(() => {});
    const methodID = await oauthMethod(cwd, row.integrationID);
    const r = (await c.integration.oauth.connect({ integrationID: row.integrationID, location: { directory: cwd }, methodID })).data as unknown as { attemptID: string; url?: string };
    if (!r.url) throw fail("login_failed", "OpenCode gave no sign-in page for this server.");
    attempts.set(key, { integrationID: row.integrationID, attemptID: r.attemptID });
    return { requiresUserAction: true, authUrl: r.url };
  }
  /** The code of the page that opened after the sign-in: the `code` of the pasted address, or the pasted code itself. */
  async function finish(cwd: string, name: string, pasted: string) {
    const a = attempts.get(`${cwd}\0${name}`);
    if (!a) throw fail("login_failed", "The sign-in expired. Start it again.");
    let code: string | null = pasted.trim();
    try {
      code = new URL(code).searchParams.get("code");
    } catch {
      // Not an address: the code itself.
    }
    if (!code) throw fail("invalid_input", "The pasted address has no code. Paste the address of the page that opened after you signed in.");
    try {
      await server.client().then((c) => c.integration.oauth.complete({ integrationID: a.integrationID, attemptID: a.attemptID, location: { directory: cwd }, code: code! }));
    } catch (e) {
      throw fail("login_failed", (e as { body?: { message?: string } }).body?.message ?? (e as Error).message);
    }
    attempts.delete(`${cwd}\0${name}`);
    await server.client().then((c) => c.experimental.mcp.connect({ server: name, location: { directory: cwd } })).catch(() => {});
  }
  /** Signs the server out: its credentials go, then it connects again (and asks for the sign-in). */
  async function clearAuth(cwd: string, name: string) {
    const row = await rowOf(cwd, name);
    if (!row?.integrationID) throw fail("unsupported", "OpenCode 2 offers no sign-in for this server.");
    const c = await server.client();
    const all = (await c.integration.list({ location: { directory: cwd } })).data as unknown as { id: string; connections: { type: string; id?: string }[] }[];
    for (const x of all.find((i) => i.id === row.integrationID)?.connections ?? []) if (x.type === "credential" && x.id) await c.credential.remove({ credentialID: x.id });
    await c.experimental.mcp.disconnect({ server: name, location: { directory: cwd } }).catch(() => {});
    await c.experimental.mcp.connect({ server: name, location: { directory: cwd } }).catch(() => {});
  }

  async function list(cwd: string): Promise<McpListResult> {
    if (attempts.size) await pollAttempts(cwd).catch(() => false);
    // A failed read of the documents gives no type, command or scope; never an unhandled rejection.
    const docs = doc(cwd).then((d) => d, () => undefined);
    const project = projectServers(cwd);
    const user = globalServers();
    const first = await raced(read(cwd), waitMs);
    let rows: Row[];
    if (first === "late") {
      // Without OpenCode's answer in time: the project's servers as pending (the dialog polls).
      rows = [...new Set([...project.keys(), ...user.keys()])].map((name) => ({ name, status: { status: "pending" } }));
    } else rows = first.value;
    const d = await raced(docs, waitMs);
    const documented = d === "late" || !d.value ? [] : d.value;
    /** The highest-priority document that defines the server. */
    const defined = (name: string) => documented.find((x) => x.info.mcp?.servers?.[name]);
    const servers: McpServerInfo[] = rows
      .filter((r) => !daemonServer(r.name))
      .map((r) => {
        const owner = defined(r.name);
        // OpenCode's documents are read again only by a reload: a server just added is taken from the project's own file.
        const c = owner?.info.mcp?.servers?.[r.name] ?? fileEntry(cwd, project, r.name) ?? globalEntry(user, r.name);
        const scope = project.has(r.name) ? "project" : user.has(r.name) ? "user" : owner ? (owner.path ? "user" : "dynamic") : "dynamic";
        const s = r.status.status;
        return {
          name: r.name,
          status: mapStatus(s),
          scope,
          ...(r.status.error && { error: r.status.error }),
          ...(c && { config: { type: c.type === "remote" ? "http" : "stdio", ...(c.command?.[0] && { command: c.command[0] }), ...(c.url && { url: c.url }) } }),
        };
      });
    return { servers };
  }

  const call = async (f: (c: OpenCodeClient) => Promise<unknown>) => void (await raced(server.client().then(f), waitMs));
  const location = (cwd: string) => ({ directory: cwd });
  const named = (name: string) => {
    if (!NAME.test(name)) throw fail("invalid_input", `Not a server name: ${name}`);
    return name;
  };

  async function add(cwd: string, name: string, config: McpAddConfig, scope: "project" | "user") {
    named(name);
    if (config.transport === "sse") throw fail("unsupported", "OpenCode has no SSE transport. Use HTTP.");
    // The keys of `mcp` that are no server in an OpenCode 2 file.
    if (name === "servers" || name === "timeout") throw fail("invalid_input", `${name} is a reserved name in OpenCode 2. Choose another server name.`);
    if (scope === "project" && projectServers(cwd).has(name)) throw fail("already_exists", `A server named ${name} already exists in this project's opencode.json.`);
    if (scope === "user" && globalServers().has(name)) throw fail("already_exists", `A server named ${name} already exists in ${displayPath(globalWriteTarget())}.`);
    const entry =
      config.transport === "stdio"
        ? { type: "local", command: [config.command, ...config.args], ...(config.env.length && { environment: pairs(config.env, "=") }) }
        : { type: "remote", url: config.url, ...(config.headers.length && { headers: pairs(config.headers, ":") }) };
    if (scope === "user") {
      const target = globalWriteTarget();
      editFiles(globalFiles(), target, fileShape(target) === "v2" ? ["mcp", "servers", name] : ["mcp", name], entry);
    } else {
      const target = writeTarget(cwd);
      editProjectFile(cwd, fileShape(target) === "v2" ? ["mcp", "servers", name] : ["mcp", name], entry);
    }
    await call((c) => c.experimental.mcp.add({ server: name, location: location(cwd), config: entry as never }));
    // Other locations read the global file at the next reload (pending while a session runs).
    if (scope === "user") await o.reload(cwd, "mcp");
  }

  return async (msg, cwd) => {
    try {
      switch (msg.type) {
        case "mcp.list":
          return await list(cwd);
        case "mcp.toggle": {
          named(msg.name);
          // Saved in every project file that defines the server (it survives a reload), then applied at once. OpenCode 2 drops an entry that holds only `disabled`, so a server
          // of another scope is switched at runtime only (until OpenCode restarts).
          for (const f of projectServers(cwd).get(msg.name) ?? []) editFileAt(f.file, f.shape === "v2" ? ["mcp", "servers", msg.name, "disabled"] : ["mcp", msg.name, "enabled"], f.shape === "v2" ? !msg.enabled : msg.enabled);
          await call((c) => (msg.enabled ? c.experimental.mcp.connect : c.experimental.mcp.disconnect)({ server: msg.name, location: location(cwd) }));
          return await list(cwd);
        }
        case "mcp.reconnect": {
          named(msg.name);
          await call(async (c) => {
            await c.experimental.mcp.disconnect({ server: msg.name, location: location(cwd) });
            await c.experimental.mcp.connect({ server: msg.name, location: location(cwd) });
          });
          return await list(cwd);
        }
        case "mcp.add":
          if (msg.scope !== "project" && msg.scope !== "user") throw fail("invalid_input", "OpenCode servers are saved in the project's opencode.json or in ~/.config/opencode/opencode.json: use the Project or User scope.");
          await add(cwd, msg.name, msg.config, msg.scope);
          return await list(cwd);
        case "mcp.remove": {
          named(msg.name);
          const files = msg.scope === "user" ? globalServers().get(msg.name) : projectServers(cwd).get(msg.name);
          if ((msg.scope !== "project" && msg.scope !== "user") || !files) throw fail("invalid_input", msg.scope === "user" ? `${msg.name} is not defined in ${displayPath(globalWriteTarget())}.` : `${msg.name} is not defined in this project's opencode.json. Remove it where it is defined.`);
          for (const f of files) editFileAt(f.file, f.shape === "v2" ? ["mcp", "servers", msg.name] : ["mcp", msg.name], undefined);
          // A server that is not running (disabled, failed) answers 404: it is gone either way.
          await call((c) => c.experimental.mcp.remove({ server: msg.name, location: location(cwd) }).catch(() => undefined));
          if (msg.scope === "user") await o.reload(cwd, "mcp");
          return await list(cwd);
        }
        case "mcp.authenticate":
          named(msg.name);
          return await authenticate(cwd, msg.name);
        case "mcp.oauthCallback":
          named(msg.name);
          await finish(cwd, msg.name, msg.callbackUrl);
          return {};
        case "mcp.clearAuth":
          named(msg.name);
          await clearAuth(cwd, msg.name);
          return await list(cwd);
      }
    } catch (e) {
      if (e instanceof ConfigFileError) throw fail(e.code, e.message);
      throw e;
    }
  };
}

// ---- Skills ----

const WAIT_MS = 3000;
const ACTION: Record<string, SkillState> = { allow: "on", ask: "ask", deny: "off" };
const RULE: Partial<Record<SkillState, "allow" | "ask" | "deny">> = { on: "allow", ask: "ask", off: "deny" };
type Rule = { action: string; resource: string; effect: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The state of skill `name` under OpenCode 2's rules (the default agent's, config rules included): the last rule matching action `skill` and the name wins, none = ask. */
export function skillState2(rules: readonly Rule[], name: string): SkillState {
  let state: SkillState = "ask";
  for (const r of rules) if (ACTION[r.effect] && matches(r.action, "skill") && matches(r.resource, name)) state = ACTION[r.effect]!;
  return state;
}

/** Where a skill comes from, by its path: built into OpenCode (`skill://`), in the project, in OpenCode's own folder, else outside both (`~/.claude/skills`, `~/.agents/skills`). */
const sourceOf = (path: string, cwd: string) => (path.startsWith("skill://") ? "built-in" : inside(path, cwd) ? "project" : inside(path, userConfigDir()) ? "user" : "external");

/** The longest the list waits for the reloaded folder to show a saved change (a reload answers empty lists for a moment, 2.3.0). */
const SHOW_MS = 5000;

export function createOpenCode2SkillsConfig(o: Config2Deps & { engine: AgentSource }): EngineConfig["skills"] {
  const waitMs = o.waitMs ?? WAIT_MS;
  /** States saved while the folder could not be reloaded: OpenCode keeps the old rules until it is, so the list shows these meanwhile. */
  const pending = new Map<string, Map<string, SkillState>>();
  const within = async <T>(p: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    p.catch(() => {});
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(fail("opencode_loading", "OpenCode is still loading this folder. Try again in a moment.")), waitMs)))]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** The rows as OpenCode has them now. `fresh`: the agent list is asked again (the cached one may predate a reload). */
  async function read(cwd: string, fresh: boolean): Promise<SkillRow[]> {
    if (fresh) o.engine.forgetAgents(cwd);
    const [found, agents, first] = await within(Promise.all([o.server.client().then((c) => c.skill.list({ location: { directory: cwd } })).then((r) => r.data), o.engine.agents(cwd), o.engine.defaultAgent(cwd)]));
    const rules = (agents.find((a) => a.id === first)?.permissions ?? []) as Rule[];
    return found.map((s) => ({ name: s.name, displayName: s.name, description: s.description ?? "", source: sourceOf(s.path, cwd), state: skillState2(rules, s.name), advertised: true }));
  }
  /** The rows with the states saved but not shown yet; a state OpenCode shows is dropped from the memory. */
  async function list(cwd: string): Promise<SkillsResult> {
    const saved = pending.get(cwd);
    const rows = await read(cwd, !!saved);
    for (const r of rows) {
      if (saved?.get(r.name) === r.state) saved.delete(r.name);
    }
    if (saved && !saved.size) pending.delete(cwd);
    return { skills: rows.map((r) => ({ ...r, state: saved?.get(r.name) ?? r.state })) };
  }

  /** Writes the rule of one skill: the exact-name rule of every project file goes, then the new one is appended to the winning file in its own keys. */
  function writeRule(cwd: string, name: string, effect: "allow" | "ask" | "deny") {
    const permission = readProjectValue(cwd, ["permission"]);
    if (typeof permission === "string") throw fail("invalid_input", "opencode.json sets one permission for every tool; set skill rules there by hand.");
    // One action for every skill (an OpenCode 1 key) becomes the `*` rule, so the rule of this skill can follow it.
    const rules = readProjectValue(cwd, ["permission", "skill"]);
    if (typeof rules === "string") editProjectFile(cwd, ["permission", "skill"], { "*": rules });
    editProjectFile(cwd, ["permission", "skill", name], undefined);
    editProjectList(cwd, ["permissions"], { drop: (item) => isObject(item) && item.action === "skill" && item.resource === name });
    if (fileShape(writeTarget(cwd)) === "v2") editProjectList(cwd, ["permissions"], { append: { action: "skill", resource: name, effect } });
    else editProjectFile(cwd, ["permission", "skill", name], effect);
  }

  async function setState(cwd: string, name: string, state: SkillState): Promise<SkillsSetStateResult> {
    const effect = RULE[state];
    if (!effect) throw fail("invalid_input", `OpenCode has no ${state} state for a skill.`);
    if (!(await read(cwd, false)).some((s) => s.name === name)) throw fail("bad_request", `Unknown skill: ${name}`);
    writeRule(cwd, name, effect);
    const reloaded = await o.reload(cwd, "skills");
    let shown = false;
    if (reloaded) {
      for (const stop = Date.now() + SHOW_MS; !shown && Date.now() < stop; ) {
        shown = (await read(cwd, true).catch(() => [])).find((s) => s.name === name)?.state === state;
        if (!shown) await sleep(250);
      }
    }
    if (shown) pending.get(cwd)?.delete(name);
    else pending.set(cwd, (pending.get(cwd) ?? new Map()).set(name, state));
    return { ...(await list(cwd)), confirmed: shown };
  }

  return async (msg, cwd) => {
    try {
      return msg.type === "skills.list" ? await list(cwd) : await setState(cwd, msg.name, msg.state);
    } catch (e) {
      if (e instanceof ConfigFileError) throw fail(e.code, e.message);
      throw e;
    }
  };
}

// ---- Plugins ----

/** The spec of a plugin list entry: a string, `[spec, options]` (OpenCode 1) or `{package, options}` (OpenCode 2). */
const specOf2 = (entry: unknown): string | undefined => (isObject(entry) && typeof entry.package === "string" ? entry.package : specOf(entry));
const WRITTEN: PluginWriteResult = { reload: { reloaded: 0, failed: [], errorCount: 0 } };

export function createOpenCode2PluginsConfig(o: Config2Deps): EngineConfig["plugins"] {
  const waitMs = o.waitMs ?? WAIT_MS;
  type Row = { id?: string; source: { type: string; target?: string; version?: string; path?: string; outdated?: boolean; updating?: boolean }; state: { status: string; error?: string } };
  const read = async (cwd: string): Promise<Row[]> => {
    let timer: NodeJS.Timeout | undefined;
    const p = o.server.client().then((c) => c.plugin.list({ location: { directory: cwd } })).then((r) => r.data as unknown as Row[]);
    p.catch(() => {});
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(fail("opencode_loading", "OpenCode is still loading this folder. Try again in a moment.")), waitMs)))]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** The entries of the plugin lists of the project files (`plugin`, OpenCode 1; `plugins`, OpenCode 2) by identity, as OpenCode reports them. */
  const projectSpecs = (cwd: string) => new Set(projectDocs(cwd).flatMap(({ file, data }) => [data.plugin, data.plugins].flatMap((l) => (Array.isArray(l) ? l.flatMap((e) => specOf2(e) ?? []) : [])).map((x) => canon(x, dirname(file)))));
  const idOf = (r: Row) => (r.source.type === "package" ? r.source.target : r.source.type === "local" && r.source.path ? (r.source.path.startsWith("file://") ? r.source.path : pathToFileURL(r.source.path).href) : undefined);

  async function list(cwd: string): Promise<PluginsListResult> {
    const rows = await read(cwd);
    const project = projectSpecs(cwd);
    const installed: InstalledPlugin[] = rows.flatMap((r) => {
      const id = idOf(r);
      if (!id) return [];
      const failed = r.state.status === "failed";
      return [{ id, ...(r.source.version && { version: r.source.version }), scope: project.has(id) ? "project" : inPluginFolder(id, cwd) ? "folder" : "user", enabled: !failed, ...(failed && { description: `Failed to load: ${r.state.error ?? "unknown error"}` }), updatable: r.source.type === "package" && !!r.source.outdated && !r.source.updating } satisfies InstalledPlugin];
    });
    return { installed, available: [], marketplaces: [] };
  }

  /** After a reload OpenCode lists no plugin for a moment: waits until `done` holds for the list (or the time is up) so the dialog's next read is right. */
  async function settle(cwd: string, done: (ids: string[]) => boolean) {
    for (const stop = Date.now() + SHOW_MS; Date.now() < stop; await sleep(250)) if (done((await read(cwd).catch(() => [])).flatMap((r) => idOf(r) ?? []))) return;
  }

  async function install(cwd: string, typed: string): Promise<PluginWriteResult> {
    const spec = typed.trim();
    if (!spec) throw fail("invalid_input", "Type an npm package or a path.");
    if (/\s/.test(spec)) throw fail("invalid_input", "A plugin is one npm package or one path, without spaces.");
    const entry = normalize(spec, cwd);
    const id = canon(entry, dirname(writeTarget(cwd)));
    if (projectSpecs(cwd).has(id) || (await list(cwd)).installed.some((p) => p.id === id)) throw fail("already_exists", `${entry} is already in the plugin list.`);
    editProjectList(cwd, [fileShape(writeTarget(cwd)) === "v2" ? "plugins" : "plugin"], { append: entry });
    if (!(await o.reload(cwd, "plugins"))) return { ...WRITTEN, applied: false };
    await settle(cwd, (ids) => ids.includes(id));
    return WRITTEN;
  }

  async function uninstall(cwd: string, id: string, scope: string | undefined): Promise<PluginWriteResult> {
    if (scope !== undefined && scope !== "project" && scope !== "user") throw fail("invalid_input", REMOVE_GAP);
    const drop = (item: unknown, file: string) => canon(specOf2(item) ?? "", dirname(file)) === id || specOf2(item) === id;
    const done = scope === "user" ? [...editLists(globalFiles(), globalWriteTarget(), ["plugin"], { drop }), ...editLists(globalFiles(), globalWriteTarget(), ["plugins"], { drop })] : [...editProjectList(cwd, ["plugin"], { drop }), ...editProjectList(cwd, ["plugins"], { drop })];
    if (!done.length) throw fail("invalid_input", REMOVE_GAP);
    if (!(await o.reload(cwd, "plugins"))) return { ...WRITTEN, applied: false };
    await settle(cwd, (ids) => !ids.includes(id));
    return WRITTEN;
  }

  /** Updates a package plugin OpenCode reports as outdated (`POST /api/plugin/update`), then reloads the folder so the new version loads and waits until the list no longer calls it outdated. */
  async function update(cwd: string, id: string): Promise<PluginUpdateResult> {
    const row = (await read(cwd)).find((r) => r.source.type === "package" && r.source.target === id);
    if (!row) return { outcome: "failed", kind: "not_installed", message: `${id} is not installed.` };
    if (!row.source.outdated) return { outcome: "ok", message: `${id} is already up to date.` };
    try {
      await o.server.client().then((c) => c.plugin.update({ targets: [id] }));
    } catch (e) {
      return { outcome: "failed", kind: "other", message: (e as { body?: { message?: string } }).body?.message ?? (e as Error).message };
    }
    if (await o.reload(cwd, "plugins")) {
      for (const stop = Date.now() + SHOW_MS; Date.now() < stop; await sleep(250)) {
        const rows = await read(cwd).catch(() => []);
        if (rows.some((r) => r.source.target === id && !r.source.outdated && !r.source.updating)) break;
      }
    }
    return { outcome: "ok" };
  }

  return async (msg, cwd) => {
    try {
      switch (msg.type) {
        case "plugins.list":
          return await list(cwd);
        case "plugins.update":
          return await update(cwd, msg.pluginId);
        case "plugins.install":
          return await install(cwd, msg.pluginId);
        case "plugins.uninstall":
          return await uninstall(cwd, msg.pluginId, msg.scope);
        default:
          throw fail("unsupported", "OpenCode 2 plugins are installed or uninstalled here. They have no switch or marketplace in this dialog.");
      }
    } catch (e) {
      if (e instanceof ConfigFileError) throw fail(e.code, e.message);
      throw e;
    }
  };
}
