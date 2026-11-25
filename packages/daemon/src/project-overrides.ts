// Project overrides of global settings (ADR 0013, docs/spec.md "Project settings"): the lookup the daemon's readers share.
// Only `overrides.local` counts: it holds this daemon's own Projects (the Hub puts a Side's entries there when it syncs, `sideSettings`).
import { basename, dirname } from "node:path";
import { LOCAL_SIDE, type Engine, type ProjectOverrides, type ProjectRef, type Settings } from "@claude-ui/protocol";
import { gitDirsOf } from "./git.ts";

const own = (settings: Settings): Record<string, ProjectOverrides> => {
  const m = settings.projects.overrides;
  return Object.hasOwn(m, LOCAL_SIDE) ? m[LOCAL_SIDE]! : {};
};
const at = (m: Record<string, ProjectOverrides>, cwd: string) => (Object.hasOwn(m, cwd) ? m[cwd] : undefined);

/** The main checkout of `cwd` when it is a linked Worktree; undefined for the main checkout itself, a non-git or a bare repository. Never throws. */
function mainCheckoutOf(cwd: string): string | undefined {
  try {
    const dirs = gitDirsOf(cwd);
    // A linked Worktree's common dir is `<main>/.git`; a bare repository's is the repository itself, whose folder is no Project.
    return dirs && dirs.common !== dirs.own && basename(dirs.common) === ".git" ? dirname(dirs.common) : undefined;
  } catch {
    return undefined;
  }
}

/** The overrides of the Project at `cwd`: its own entry, else the one of its main checkout when `cwd` is a linked Worktree, else none. */
export function projectOverrides(settings: Settings, cwd: string): ProjectOverrides {
  const m = own(settings);
  if (!Object.keys(m).length) return {};
  const direct = at(m, cwd);
  if (direct) return direct;
  const main = mainCheckoutOf(cwd);
  return (main && at(m, main)) || {};
}

const DEPTH_MAX = 64;
/** The overrides of the Project a file belongs to: the nearest folder above it that has an override entry or is a Worktree of a folder that has one. */
export function projectOverridesOfFile(settings: Settings, file: string): ProjectOverrides {
  if (!Object.keys(own(settings)).length) return {};
  let dir = dirname(file);
  for (let i = 0; i < DEPTH_MAX; i++) {
    const o = projectOverrides(settings, dir);
    if (Object.keys(o).length) return o;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return {};
}

/** Settings `inlineTask` with the models of the parent Session's Project over the global ones. */
export function inlineTaskSettings(settings: Settings, cwd: string): Settings["inlineTask"] {
  const o = projectOverrides(settings, cwd).inlineTask;
  return { ...settings.inlineTask, ...(o?.model && { model: o.model }), ...(o?.openCodeModel && { openCodeModel: o.openCodeModel }) };
}

/** Settings `history` for one file: `enabled` of the file's Project over the global one. */
export function historySettings(settings: Settings, file: string): Settings["history"] {
  return { ...settings.history, enabled: projectOverridesOfFile(settings, file).history?.enabled ?? settings.history.enabled };
}

/** The overrides of the Project `ref` as the Hub keys them (Side id, then the Project's own folder). Nothing for a Worktree path: the caller sends its Project. */
const refOverrides = (settings: Settings, ref: ProjectRef | undefined): ProjectOverrides | undefined => {
  const m = settings.projects.overrides;
  if (!ref || !Object.hasOwn(m, ref.side)) return undefined;
  const side = m[ref.side]!;
  return Object.hasOwn(side, ref.cwd) ? side[ref.cwd] : undefined;
};

/** Settings `jira` for one Project (Hub): each field its overrides set (an empty string is not a value) over the global one. */
export function jiraSettings(settings: Settings, ref?: ProjectRef): Settings["jira"] {
  const o = refOverrides(settings, ref)?.jira;
  return { ...settings.jira, ...(o?.url && { url: o.url }), ...(o?.email && { email: o.email }), ...(o?.jql && { jql: o.jql }), ...(o?.template && { template: o.template }) };
}

/** The Jira URL the overrides of the Project `ref` set; undefined when it uses the global one. */
export const ownJiraUrl = (settings: Settings, ref: ProjectRef): string | undefined => refOverrides(settings, ref)?.jira?.url || undefined;

/** Every Jira URL origin in use: the global one ("" without URL) and those of all Project overrides on every Side. Saved tokens of other origins are dropped. */
export function jiraOriginsInUse(settings: Settings): string[] {
  const urls = [settings.jira.url, ...Object.values(settings.projects.overrides).flatMap((side) => Object.values(side).map((o) => o.jira?.url ?? ""))];
  return [...new Set(urls.filter((u, i) => i === 0 || u).map((u) => (u ? new URL(u).origin : "")))];
}

/** The commit message generator of the Project at `cwd` (GH-984): the fields its overrides set over the global `git.commitMessage*` ones. `model` is never blank. */
export function commitMessageSettings(settings: Settings, cwd: string): { engine: Engine; model: string; openCodeModel: string } {
  const o = projectOverrides(settings, cwd).commitMessage;
  const g = settings.git;
  return { engine: o?.engine ?? g.commitMessageEngine, model: o?.model || g.commitMessageModel || "haiku", openCodeModel: o?.openCodeModel || g.commitMessageOpenCodeModel };
}
