// The config dialogs on OpenCode 2 (docs/spec.md "Config dialogs", GH-864): MCP servers, skills and plugins. Reads go to OpenCode 2's routes; saved changes are written by the
// daemon into the project config file (opencode-config-file.ts: OpenCode 2 reads the OpenCode 1 shape too, and a file that already uses its own keys keeps them).
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import type { McpAddConfig, McpListResult, McpServerInfo } from "@claude-ui/protocol";
import { DAEMON_SERVER } from "./daemon-mcp.ts";
import { EngineError, type EngineConfig } from "./engine-catalogue.ts";
import { ConfigFileError, editFileAt, editProjectFile, projectDocs, shapeOf, writeTarget, fileShape } from "./opencode-config-file.ts";
import { MCP_WAIT_MS, NAME, mapStatus, pairs } from "./opencode-config-mcp.ts";
import type { OpenCodeServer } from "./opencode-server.ts";

export const fail = (code: string, message: string) => new EngineError(code, message);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** OpenCode's folder of the user's own config. */
export const userConfigDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");
export const inside = (file: string, dir: string) => file.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** What the config modules need of the OpenCode 2 side. */
export type Config2Deps = {
  server: OpenCodeServer;
  /** Reloads the folder after a saved change: true when done, false when it waits for the folder's sessions to be idle (folder-reload.ts). */
  reload(cwd: string, kind: "skills" | "plugins"): Promise<boolean>;
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
function projectServers(cwd: string): Map<string, { file: string; shape: "v1" | "v2" }[]> {
  const out = new Map<string, { file: string; shape: "v1" | "v2" }[]>();
  for (const { file, data } of projectDocs(cwd)) {
    const shape = shapeOf(data);
    const mcp = data.mcp;
    const servers = isObject(mcp) ? (shape === "v2" ? mcp.servers : mcp) : undefined;
    if (isObject(servers)) for (const n of Object.keys(servers)) out.set(n, [...(out.get(n) ?? []), { file, shape }]);
  }
  return out;
}

export function createOpenCode2McpConfig(o: Config2Deps): EngineConfig["mcp"] {
  const { server } = o;
  const waitMs = o.waitMs ?? MCP_WAIT_MS;
  type Row = { name: string; status: { status: string; error?: string }; integrationID?: string };
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

  async function list(cwd: string): Promise<McpListResult> {
    // A failed read of the documents gives no type, command or scope; never an unhandled rejection.
    const docs = doc(cwd).then((d) => d, () => undefined);
    const project = projectServers(cwd);
    const first = await raced(read(cwd), waitMs);
    let rows: Row[];
    if (first === "late") {
      // Without OpenCode's answer in time: the project's servers as pending (the dialog polls).
      rows = [...project.keys()].map((name) => ({ name, status: { status: "pending" } }));
    } else rows = first.value;
    const d = await raced(docs, waitMs);
    const documented = d === "late" || !d.value ? [] : d.value;
    /** The highest-priority document that defines the server. */
    const defined = (name: string) => documented.find((x) => x.info.mcp?.servers?.[name]);
    const servers: McpServerInfo[] = rows
      .filter((r) => !daemonServer(r.name))
      .map((r) => {
        const owner = defined(r.name);
        const c = owner?.info.mcp?.servers?.[r.name];
        const scope = project.has(r.name) ? "project" : owner ? (owner.path ? "user" : "dynamic") : "dynamic";
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

  async function add(cwd: string, name: string, config: McpAddConfig) {
    named(name);
    if (config.transport === "sse") throw fail("unsupported", "OpenCode has no SSE transport. Use HTTP.");
    // The keys of `mcp` that are no server in an OpenCode 2 file.
    if (name === "servers" || name === "timeout") throw fail("invalid_input", `${name} is a reserved name in OpenCode 2. Choose another server name.`);
    if (projectServers(cwd).has(name)) throw fail("already_exists", `A server named ${name} already exists in this project's opencode.json.`);
    const entry =
      config.transport === "stdio"
        ? { type: "local", command: [config.command, ...config.args], ...(config.env.length && { environment: pairs(config.env, "=") }) }
        : { type: "remote", url: config.url, ...(config.headers.length && { headers: pairs(config.headers, ":") }) };
    const target = writeTarget(cwd);
    editProjectFile(cwd, fileShape(target) === "v2" ? ["mcp", "servers", name] : ["mcp", name], entry);
    await call((c) => c.experimental.mcp.add({ server: name, location: location(cwd), config: entry as never }));
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
          if (msg.scope !== "project") throw fail("invalid_input", "OpenCode servers are saved in the project's opencode.json: use the Project scope.");
          await add(cwd, msg.name, msg.config);
          return await list(cwd);
        case "mcp.remove": {
          named(msg.name);
          const files = projectServers(cwd).get(msg.name);
          if (msg.scope !== "project" || !files) throw fail("invalid_input", `${msg.name} is not defined in this project's opencode.json. Remove it where it is defined.`);
          for (const f of files) editFileAt(f.file, f.shape === "v2" ? ["mcp", "servers", msg.name] : ["mcp", msg.name], undefined);
          // A server that is not running (disabled, failed) answers 404: it is gone either way.
          await call((c) => c.experimental.mcp.remove({ server: msg.name, location: location(cwd) }).catch(() => undefined));
          return await list(cwd);
        }
        case "mcp.authenticate":
        case "mcp.oauthCallback":
        case "mcp.clearAuth":
          throw fail("unsupported", "OpenCode 2 signs MCP servers in through its integrations. Sign in with OpenCode's own app.");
      }
    } catch (e) {
      if (e instanceof ConfigFileError) throw fail(e.code, e.message);
      throw e;
    }
  };
}
