// Project overrides of global settings (ADR 0013, docs/spec.md "Project settings"): the lookup the daemon's readers share.
// Only `overrides.local` counts: it holds this daemon's own Projects (the Hub puts a Side's entries there when it syncs, `sideSettings`).
import { basename, dirname } from "node:path";
import { LOCAL_SIDE, type ProjectOverrides, type Settings } from "@claude-ui/protocol";
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
/** The overrides of the Project a file belongs to: the nearest folder above it that is a Project or a Worktree of one. */
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
