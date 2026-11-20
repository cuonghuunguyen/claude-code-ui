// Project overrides in the web app (docs/spec.md "Project settings"): lookup, whole-map writes and the draft defaults. The daemon applies the
// Permission mode, Claude account, inline task model and local history itself; the new-session tab reads Engine, model and effort here.
import { LOCAL_SIDE, type Effort, type Engine, type ProjectOverrides, type Settings, type Worktree } from "@claude-ui/protocol";
import { projectOf } from "./sessions.ts";

export type OverrideMap = Settings["projects"]["overrides"];

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** Side id of a folder: `local` unless it lives on a Side. */
export const sideOfCwd = (cwdSides: Record<string, string>, cwd: string) => own(cwdSides, cwd) ?? LOCAL_SIDE;

/** The overrides that apply to `cwd`: its own entry, else the entry of its Project when it is a Worktree (same order as the daemon). */
export function overridesOf(all: OverrideMap | undefined, cwdSides: Record<string, string>, cwd: string | undefined, worktrees: Record<string, Worktree[]> = {}): ProjectOverrides {
  if (!cwd) return {};
  const at = (c: string) => own(own(all, sideOfCwd(cwdSides, c)), c);
  return at(cwd) ?? at(projectOf(cwd, worktrees)) ?? {};
}

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
 * Engine, model and effort of the new-session tab. `picked`: what the user chose in the tab. Model and effort of the Project apply only for
 * the Project's own Engine (its override, else the global one): another Engine has its own models and effort levels.
 */
export function draftStart(o: ProjectOverrides, globalEngine: Engine, picked: { engine?: Engine; model?: string; effort?: Effort }): { engine: Engine; model: string; effort: Effort } {
  const engine = picked.engine ?? o.engine ?? globalEngine;
  const same = engine === (o.engine ?? globalEngine);
  return { engine, model: picked.model ?? (same ? o.model : undefined) ?? "default", effort: picked.effort ?? (same ? o.effort : undefined) ?? "default" };
}
