// Project overrides in the web app (docs/spec.md "Project settings"): lookup, whole-map writes and the draft defaults. The daemon applies the
// Permission mode, Claude account, inline task model and local history itself; the new-session tab reads Engine, model and effort here.
import { LOCAL_SIDE, type Effort, type Engine, type LastUsed, type ProjectOverrides, type Settings, type SettingsResult, type Worktree } from "@claude-ui/protocol";
import type { Request } from "./client.ts";
import { projectOf } from "./sessions.ts";

export type OverrideMap = Settings["projects"]["overrides"];

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** Side id of a folder: `local` unless it lives on a Side. */
export const sideOfCwd = (cwdSides: Record<string, string>, cwd: string) => own(cwdSides, cwd) ?? LOCAL_SIDE;

/** The Project entry that applies to `cwd` (its own, else its Project's when it is a Worktree; same order as the daemon) with the folder that holds it. */
function entryOf(all: OverrideMap | undefined, cwdSides: Record<string, string>, cwd: string | undefined, worktrees: Record<string, Worktree[]> = {}): { cwd: string; overrides: ProjectOverrides } | undefined {
  if (!cwd) return undefined;
  const at = (c: string) => {
    const overrides = own(own(all, sideOfCwd(cwdSides, c)), c);
    return overrides && { cwd: c, overrides };
  };
  return at(cwd) ?? at(projectOf(cwd, worktrees));
}

/** The overrides that apply to `cwd`: its own entry, else the entry of its Project when it is a Worktree (same order as the daemon). */
export const overridesOf = (all: OverrideMap | undefined, cwdSides: Record<string, string>, cwd: string | undefined, worktrees: Record<string, Worktree[]> = {}): ProjectOverrides => entryOf(all, cwdSides, cwd, worktrees)?.overrides ?? {};

/** What the account of a Session depends on: the Claude account setting, the saved token accounts and the Project overrides. */
export type AccountView = { overrides: OverrideMap | undefined; cwdSides: Record<string, string>; worktrees?: Record<string, Worktree[]>; account: string; accounts: { id: string }[] };

/**
 * The Claude account a Session in `cwd` runs on (GH-900), by the daemon's rule: the key is the setting value (`""` Default, `"cli"`, a token
 * account id; an unknown id counts as `""`), no Default/CLI merging. A Side Session keeps the Hub's account. `project` is the folder whose entry sets
 * the account, only when an override does.
 */
export function accountScopeOf(v: AccountView, cwd: string | undefined): { key: string; project?: string } {
  const key = (a: string) => (a === "" || a === "cli" || v.accounts.some((x) => x.id === a) ? a : "");
  const entry = cwd && sideOfCwd(v.cwdSides, cwd) === LOCAL_SIDE ? entryOf(v.overrides, v.cwdSides, cwd, v.worktrees) : undefined;
  return entry?.overrides.account === undefined ? { key: key(v.account) } : { key: key(entry.overrides.account), project: entry.cwd };
}

export const accountKeyOf = (v: AccountView, cwd: string | undefined) => accountScopeOf(v, cwd).key;

/** The field value `undefined` unsets it. Returns the whole next map (a patch replaces the map), empty groups, Projects and Sides pruned. */
export function setOverride(all: OverrideMap | undefined, side: string, cwd: string, change: { [K in keyof ProjectOverrides]?: ProjectOverrides[K] | undefined }): OverrideMap {
  const prev = own(own(all, side), cwd) ?? {};
  const next: Record<string, unknown> = { ...prev };
  for (const [key, value] of Object.entries(change)) {
    if (value !== null && typeof value === "object") {
      const group = Object.fromEntries(Object.entries({ ...(prev as Record<string, Record<string, unknown>>)[key], ...value }).filter(([, v]) => v !== undefined));
      if (Object.keys(group).length) next[key] = group;
      else delete next[key];
    } else if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const sides = Object.fromEntries(Object.entries(all ?? {}).map(([s, projects]) => [s, { ...projects }]));
  const projects = sides[side] ?? (sides[side] = {});
  if (Object.keys(next).length) projects[cwd] = next as ProjectOverrides;
  else delete projects[cwd];
  if (!Object.keys(projects).length) delete sides[side];
  return sides;
}

/**
 * The request that saves `change` of one Project (GH-903). `projectPatch` (the daemon advertises it): only this Project's entry, so another
 * browser's save of a different Project is never undone; an older daemon only takes the whole map.
 */
export function overridesRequest(all: OverrideMap | undefined, side: string, cwd: string, change: Parameters<typeof setOverride>[3], projectPatch: boolean | undefined): Request {
  const overrides = setOverride(all, side, cwd, change);
  if (!projectPatch) return { type: "settings.set", patch: { projects: { overrides } } };
  return { type: "settings.project", side, cwd, overrides: own(overrides[side], cwd) ?? null };
}

/** The last choice of the Project of `cwd` (Settings `projects.lastUsed`): its own entry, else its Project's when it is a Worktree. */
export function lastUsedOf(all: Settings["projects"]["lastUsed"], cwdSides: Record<string, string>, cwd: string | undefined, worktrees: Record<string, Worktree[]> = {}): LastUsed | undefined {
  if (!cwd) return undefined;
  const at = (c: string) => own(own(all, sideOfCwd(cwdSides, c)), c);
  return at(cwd) ?? at(projectOf(cwd, worktrees));
}

/**
 * Engine, model and effort of the new-session tab, each: picked in the tab, else the Project's override, else the Project's last choice
 * (`last`), else the global Engine and Default. Model and effort belong to an Engine and apply only when the resulting Engine is theirs:
 * the override's are of the override's Engine (else the global one), the last choice's of its Engine. An override of model or effort without
 * an Engine keeps the global Engine over the last choice's, so the override applies.
 */
export function draftStart(o: ProjectOverrides, globalEngine: Engine, picked: { engine?: Engine; model?: string; effort?: Effort }, last?: LastUsed): { engine: Engine; model: string; effort: Effort } {
  const projectEngine = o.engine ?? globalEngine;
  const pinned = o.engine !== undefined || o.model !== undefined || o.effort !== undefined;
  const engine = picked.engine ?? (pinned ? projectEngine : (last?.engine ?? globalEngine));
  const same = engine === projectEngine;
  const lastSame = !!last && engine === last.engine;
  const of = <K extends "model" | "effort">(k: K) => picked[k] ?? (same ? o[k] : undefined) ?? (lastSame ? last![k] : undefined);
  return { engine, model: of("model") ?? "default", effort: of("effort") ?? "default" };
}

/** The origin (scheme, host, port) a Jira token belongs to; "" for no URL or one that is not a URL. */
export function jiraOriginOf(url: string): string {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

/** The Jira connection of a Project: each field its entry sets (an empty string is no value) over the global one, as the Hub resolves it. `cwd` is the Project's own folder. */
export function jiraOf(all: OverrideMap | undefined, side: string, cwd: string, global: Settings["jira"]): Settings["jira"] {
  const o = own(own(all, side), cwd)?.jira;
  return { ...global, ...(o?.url && { url: o.url }), ...(o?.email && { email: o.email }), ...(o?.jql && { jql: o.jql }), ...(o?.template && { template: o.template }) };
}

/** A token is saved for the origin of `url`. An older daemon reports only its one global token. */
export const jiraTokenFor = (r: Pick<SettingsResult, "jiraToken" | "jiraTokens">, url: string) => (r.jiraTokens ? r.jiraTokens.includes(jiraOriginOf(url)) : !!r.jiraToken);
