// The Plugins dialog on OpenCode 1 (docs/spec.md "Config dialogs: plugins"). OpenCode has no plugin route: the list is the `plugin` list of its merged config
// (`GET /config`), and install and uninstall edit the `plugin` list of the project's opencode.json (opencode-config-file.ts), then dispose the folder so OpenCode loads it again.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import type { InstalledPlugin, PluginsListResult, PluginWriteResult } from "@claude-ui/protocol";
import { EngineError, type EngineConfig } from "./engine-catalogue.ts";
import { OPENCODE_CAPABILITIES } from "./opencode-engine.ts";
import { ConfigFileError, editProjectList, projectLists, writeTarget } from "./opencode-config-file.ts";
import type { OpenCodeServer } from "./opencode-server.ts";

/** The longest a list waits for OpenCode before it answers from the config files. */
const WAIT_MS = 3000;
const REMOVE_GAP = OPENCODE_CAPABILITIES.config!.gaps.pluginRemoveScope!;

const fail = (code: string, message: string) => new EngineError(code, message);
/** A list entry is the spec string or `[spec, options]`. */
const specOf = (entry: unknown): string | undefined => (typeof entry === "string" ? entry : Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined);
const specs = (list: unknown): string[] => (Array.isArray(list) ? list.flatMap((e) => specOf(e) ?? []) : []);

const globalDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode");

/** The plugins the user's global OpenCode config lists. */
function globalSpecs(): string[] {
  const dir = globalDir();
  const out: string[] = [];
  for (const file of [join(dir, "config.json"), join(dir, "opencode.json"), join(dir, "opencode.jsonc"), ...(process.env.OPENCODE_CONFIG ? [process.env.OPENCODE_CONFIG] : [])]) {
    if (!existsSync(file)) continue;
    try {
      out.push(...specs((parse(readFileSync(file, "utf8"), [], { allowTrailingComma: true }) as { plugin?: unknown } | undefined)?.plugin));
    } catch {
      // An unreadable global file: its plugins show only when OpenCode reports them.
    }
  }
  return out;
}

/** A `file://` plugin inside a `plugin` or `plugins` folder of the project or of the global OpenCode folder: found by OpenCode, not listed in a file. */
function inPluginFolder(spec: string, cwd: string): boolean {
  if (!spec.startsWith("file://")) return false;
  let file: string;
  try {
    file = fileURLToPath(spec);
  } catch {
    return false;
  }
  return [join(cwd, ".opencode"), globalDir()].some((base) =>
    ["plugin", "plugins"].some((d) => {
      const rel = relative(join(base, d), file);
      return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
    }),
  );
}

const RELATIVE = /^\.\.?\//;
/**
 * What the user typed as a spec: an npm name or a `file://` URL as it is; an absolute path as the `file://` URL OpenCode takes; a relative path (from the project folder)
 * relative to the file it is saved in (OpenCode resolves an entry against the folder of its config file, so `.opencode/opencode.json` needs another prefix), staying portable.
 */
function normalize(typed: string, cwd: string): string {
  if (RELATIVE.test(typed)) {
    const rel = relative(dirname(writeTarget(cwd)), resolve(cwd, typed)).split(sep).join("/");
    return rel.startsWith("..") ? rel : `./${rel}`;
  }
  if (/^(\/|~\/|[a-zA-Z]:[\\/])/.test(typed)) return pathToFileURL(typed.startsWith("~/") ? join(homedir(), typed.slice(2)) : typed).href;
  return typed;
}
/** The identity of a list entry: OpenCode reports a relative path as the absolute `file://` URL of the file next to the config file that lists it. */
const canon = (spec: string, base: string) => (RELATIVE.test(spec) ? pathToFileURL(resolve(base, spec)).href : spec);

const WRITTEN: PluginWriteResult = { reload: { reloaded: 0, failed: [], errorCount: 0 } };

export function createOpenCodePluginsConfig(o: { server: OpenCodeServer; repair(cwd: string): Promise<boolean>; /** As the skills config's `reload`. */ reload?(cwd: string): Promise<boolean>; waitMs?: number }): EngineConfig["plugins"] {
  const waitMs = o.waitMs ?? WAIT_MS;
  /** `GET /config` of a folder in flight: concurrent lists share it (it is never aborted: a cut-off read of a folder still loading can break the folder). */
  const reads = new Map<string, Promise<string[] | undefined>>();
  const read = (cwd: string) => {
    let hit = reads.get(cwd);
    if (!hit) {
      // A failed read is no list, never an unhandled rejection.
      hit = o.server
        .request<{ plugin?: unknown }>("/config", { directory: cwd, timeoutMs: 0 })
        .then((c) => specs(c.plugin), () => undefined)
        .finally(() => reads.delete(cwd));
      reads.set(cwd, hit);
    }
    return hit;
  };
  /** OpenCode's own list; without its answer in time, the plugins the config files list (the folder's own plugin files are then missing). */
  async function known(cwd: string): Promise<string[]> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), waitMs)));
    try {
      const own = await Promise.race([read(cwd), late]);
      if (own) return own;
    } finally {
      clearTimeout(timer);
    }
    return [...new Set([...projectLists(cwd, ["plugin"]).flatMap((l) => specs(l.items).map((x) => canon(x, dirname(l.file)))), ...globalSpecs()])];
  }

  async function list(cwd: string): Promise<PluginsListResult> {
    const all = await known(cwd);
    const project = new Set(projectLists(cwd, ["plugin"]).flatMap((l) => specs(l.items).map((x) => canon(x, dirname(l.file)))));
    const installed: InstalledPlugin[] = [...new Set(all)].map((id) => ({ id, scope: project.has(id) ? "project" : inPluginFolder(id, cwd) ? "folder" : "user", enabled: true, updatable: false }));
    return { installed, available: [], marketplaces: [] };
  }

  async function install(cwd: string, typed: string): Promise<PluginWriteResult> {
    const spec = typed.trim();
    if (!spec) throw fail("invalid_input", "Type an npm package or a path.");
    if (/\s/.test(spec)) throw fail("invalid_input", "A plugin is one npm package or one path, without spaces.");
    const entry = normalize(spec, cwd);
    if ((await known(cwd)).includes(canon(entry, dirname(writeTarget(cwd))))) throw fail("already_exists", `${entry} is already in the plugin list.`);
    editProjectList(cwd, ["plugin"], { append: entry });
    return { ...WRITTEN, ...((await (o.reload ?? o.repair)(cwd)) ? {} : { applied: false }) };
  }

  async function uninstall(cwd: string, id: string, scope: string | undefined): Promise<PluginWriteResult> {
    if (scope !== undefined && scope !== "project") throw fail("invalid_input", REMOVE_GAP);
    const done = editProjectList(cwd, ["plugin"], { drop: (item, file) => canon(specOf(item) ?? "", dirname(file)) === id || specOf(item) === id });
    if (!done.length) throw fail("invalid_input", REMOVE_GAP);
    return { ...WRITTEN, ...((await (o.reload ?? o.repair)(cwd)) ? {} : { applied: false }) };
  }

  return async (msg, cwd) => {
    try {
      switch (msg.type) {
        case "plugins.list":
          return await list(cwd);
        case "plugins.install":
          return await install(cwd, msg.pluginId);
        case "plugins.uninstall":
          return await uninstall(cwd, msg.pluginId, msg.scope);
        default:
          throw fail("unsupported", "OpenCode has no switch, update, marketplace or restart for a plugin. Install or uninstall changes the plugin list of opencode.json.");
      }
    } catch (e) {
      if (e instanceof ConfigFileError) throw fail(e.code, e.message);
      throw e;
    }
  };
}
