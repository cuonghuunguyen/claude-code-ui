// The skills dialog on OpenCode 1 (docs/spec.md "Config dialogs"): the list is `GET /skill`, the state of a skill is OpenCode's `permission.skill` rule for it
// (allow = On, ask = Ask, deny = Off; `GET /skill` lists a denied skill too). A state change is written by the daemon into the project config file
// (opencode-config-file.ts), then the folder is reloaded when no session of it is busy.
import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { SkillRow, SkillState, SkillsResult, SkillsSetStateResult } from "@claude-ui/protocol";
import { EngineError, type EngineConfig } from "./engine-catalogue.ts";
import { ConfigFileError, editProjectFile, readProjectValue } from "./opencode-config-file.ts";
import { brokenState } from "./opencode-engine.ts";
import type { OpenCodeServer } from "./opencode-server.ts";

/** The longest a read waits for OpenCode before the dialog gets an error to retry (the read itself is never cut off). */
const WAIT_MS = 3000;
const ACTION: Record<string, SkillState> = { allow: "on", ask: "ask", deny: "off" };
const RULE: Partial<Record<SkillState, string>> = { on: "allow", ask: "ask", off: "deny" };

type SkillInfo = { name: string; description?: string; location: string };

const fail = (code: string, message: string) => new EngineError(code, message);

/** OpenCode's wildcard: `*` any text, `?` one character, the whole name must match. */
const matches = (pattern: string, name: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s").test(name);

/**
 * The state of skill `name` under a merged `permission` config: OpenCode's default is allow, then a top-level `*` (or one string for every tool), then the
 * `skill` rules in file order, the last matching one wins.
 */
export function skillState(permission: unknown, name: string): SkillState {
  let state: SkillState = "on";
  const base = typeof permission === "string" ? permission : (permission as { "*"?: unknown } | undefined)?.["*"];
  if (typeof base === "string" && ACTION[base]) state = ACTION[base]!;
  const rules = permission !== null && typeof permission === "object" ? (permission as { skill?: unknown }).skill : undefined;
  if (typeof rules === "string") return ACTION[rules] ?? state;
  if (rules !== null && typeof rules === "object")
    for (const [pattern, action] of Object.entries(rules)) if (typeof action === "string" && ACTION[action] && matches(pattern, name)) state = ACTION[action]!;
  return state;
}

/** Where a skill comes from, by its file: built into OpenCode, in the project, in OpenCode's global folder, else outside both (`~/.claude/skills`, `~/.agents/skills`). */
function sourceOf(location: string, cwd: string): string {
  if (location === "<built-in>") return "built-in";
  const inside = (dir: string) => location.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  if (inside(cwd)) return "project";
  if (inside(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode"))) return "user";
  return "external";
}

export function createOpenCodeSkillsConfig(o: { server: OpenCodeServer; repair(cwd: string): Promise<boolean>; /** Reloads the folder after a save: true when done, false when it waits for the folder's sessions to be idle (docs/spec.md "Config dialogs"). */ reload?(cwd: string): Promise<boolean>; waitMs?: number }): EngineConfig["skills"] {
  const { server } = o;
  const waitMs = o.waitMs ?? WAIT_MS;
  /** States saved while a session of the folder was busy: OpenCode keeps the old rules until the folder is reloaded, so the list shows these meanwhile. */
  const pending = new Map<string, Map<string, SkillState>>();

  /** One read of OpenCode, never cut off (a cold MCP load can hold the folder), reloaded once when the folder is in the broken state. */
  const read = <T>(cwd: string, path: string): Promise<T> => {
    const get = () => server.request<T>(path, { directory: cwd, timeoutMs: 0 });
    return get().catch(async (err) => (brokenState(err) && (await o.repair(cwd)) ? get() : Promise.reject(err)));
  };
  /** The answer, or an error to retry when OpenCode takes longer than `waitMs`. */
  const within = async <T>(p: Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(fail("opencode_loading", "OpenCode is still loading this folder. Try again in a moment.")), waitMs)))]);
    } finally {
      clearTimeout(timer);
    }
  };

  async function list(cwd: string): Promise<SkillsResult> {
    const [found, { permission }] = await within(Promise.all([read<SkillInfo[]>(cwd, "/skill"), read<{ permission?: unknown }>(cwd, "/config")]));
    const saved = pending.get(cwd);
    const rows: SkillRow[] = found.map((s) => {
      const state = skillState(permission, s.name);
      // A saved state OpenCode does not show yet wins; once it shows it (the folder was reloaded) the entry is dropped.
      if (saved?.get(s.name) === state) saved.delete(s.name);
      return { name: s.name, displayName: s.name, description: s.description ?? "", source: sourceOf(s.location, cwd), state: saved?.get(s.name) ?? state, advertised: true };
    });
    if (saved && !saved.size) pending.delete(cwd);
    return { skills: rows };
  }

  async function setState(cwd: string, name: string, state: SkillState): Promise<SkillsSetStateResult> {
    const action = RULE[state];
    if (!action) throw fail("invalid_input", `OpenCode has no ${state} state for a skill.`);
    const { skills: known } = await list(cwd);
    if (!known.some((s) => s.name === name)) throw fail("bad_request", `Unknown skill: ${name}`);
    const permission = readProjectValue(cwd, ["permission"]);
    if (typeof permission === "string") throw fail("invalid_input", "opencode.json sets one permission for every tool; set skill rules there by hand.");
    const rules = readProjectValue(cwd, ["permission", "skill"]);
    // One action for every skill becomes the `*` rule, so the rule of this skill can follow it.
    if (typeof rules === "string") editProjectFile(cwd, ["permission", "skill"], { "*": rules });
    // The last matching rule wins: drop the exact rule of the skill, then add it at the end. On needs no rule when no other rule is left that is not allow.
    editProjectFile(cwd, ["permission", "skill", name], undefined);
    let explicit = true;
    if (state === "on") {
      const merged = await within(read<{ permission?: unknown }>(cwd, "/config")).then((c) => c.permission, () => undefined);
      const rest = merged !== null && typeof merged === "object" ? { ...(merged as object), skill: Object.fromEntries(Object.entries(((merged as { skill?: unknown }).skill as object | undefined) ?? {}).filter(([k]) => k !== name)) } : merged;
      explicit = merged === undefined || skillState(rest, name) !== "on";
    }
    if (explicit) editProjectFile(cwd, ["permission", "skill", name], action);
    const disposed = await (o.reload ?? o.repair)(cwd);
    if (!disposed) pending.set(cwd, (pending.get(cwd) ?? new Map()).set(name, state));
    else pending.get(cwd)?.delete(name);
    return { ...(await list(cwd)), confirmed: disposed };
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
