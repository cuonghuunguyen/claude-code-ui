// Where a worker can start (docs/spec.md "Orchestration"): the projects the user added on this daemon's side and their linked
// worktrees. Pure: every lookup is injected, so the rules are testable without git and a later start kind adds a `Resolved` case here.
import { basename, isAbsolute, sep } from "node:path";
import type { Worktree } from "@claude-ui/protocol";

export type TargetDeps = {
  /** Added project cwds of this daemon inside the roots, as stored (session.list `projects`). */
  projects: () => string[];
  /** session.list `worktrees[cwd]`: real paths, `outsideRoots` marked; undefined for a non-git project or a repo subfolder. */
  worktrees: (project: string) => Promise<Worktree[] | undefined>;
  /** Canonical path when it exists inside the roots. */
  allowed: (path: string) => string | undefined;
  /** Label of another side the path belongs to; undefined for own paths. */
  sideOf?: (path: string) => string | undefined;
  /** Path is (inside) a worktree being removed. */
  removing: (path: string) => boolean;
  isDir: (path: string) => boolean;
};
/** One worker_targets entry; `sessions` is added by orchestration.ts. */
export type Target = { project: string; projectPath: string; worktree?: string; path: string; branch?: string; main: boolean; locked?: true };
export type TargetInput = { cwd?: string; project?: string; repo?: string; worktree?: string; branch?: string; base?: string };
export type Resolved =
  | { kind: "cwd"; cwd: string; entry?: Target }
  | { kind: "main"; cwd: string; entry: Target }
  | { kind: "worktree"; cwd: string; entry: Target }
  | { kind: "new"; project: string; projectPath: string; branch: string; base?: string };
export type TargetErrorCode = "shape" | "unknown" | "ambiguous" | "outside" | "removing" | "other_side";
export class TargetError extends Error {
  constructor(
    message: string,
    readonly code: TargetErrorCode,
  ) {
    super(message);
  }
}

const MAX_NAMES = 30;
/** A name has no separator and is not absolute; anything else is a path. */
export const isPathInput = (s: string) => isAbsolute(s) || s.includes("/") || s.includes("\\");

/** Sync shape check; throws TargetError "shape". */
export function checkShape(a: TargetInput): void {
  const shape = (m: string) => {
    throw new TargetError(m, "shape");
  };
  if (a.repo !== undefined && a.project !== undefined) shape("repo is an alias of project: give one of them.");
  const proj = a.project ?? a.repo;
  const forms = (a.cwd !== undefined ? 1 : 0) + (a.worktree !== undefined ? 1 : 0) + (a.worktree === undefined && proj !== undefined ? 1 : 0);
  if (forms !== 1) shape("Give one target: cwd, project (alone, or with branch and optional base), or worktree (optionally with project).");
  if ((a.cwd !== undefined || a.worktree !== undefined) && (a.branch !== undefined || a.base !== undefined)) shape("branch and base go with project (or repo), not with cwd or worktree.");
  if (a.base !== undefined && a.branch === undefined) shape("base needs branch.");
}

type Entry = Target & { outsideRoots?: true; removing?: true };
const contains = (dir: string, p: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

const names = (xs: string[]) => [...new Set(xs)].slice(0, MAX_NAMES).join(", ") || "none";

async function allEntries(d: TargetDeps): Promise<Entry[]> {
  const own = d.projects().filter((p) => !d.sideOf?.(p));
  const projectPaths = new Set(own);
  const seen = new Set<string>();
  const out: Entry[] = [];
  const lists = await Promise.all(own.map((p) => d.worktrees(p)));
  for (const [i, projectPath] of own.entries()) {
    const project = basename(projectPath);
    const rows = lists[i];
    // The project's own row: the main checkout, or its own entry when the project is itself a linked worktree.
    const main = rows?.find((w) => w.path === projectPath || w.path === d.allowed(projectPath)) ?? rows?.find((w) => w.main);
    const base = { project, projectPath };
    const flags = (path: string) => ({ ...(d.removing(path) ? { removing: true as const } : {}) });
    if (!seen.has(projectPath)) {
      seen.add(projectPath);
      out.push({ ...base, path: projectPath, ...(main?.branch ? { branch: main.branch } : {}), main: true, ...(main?.locked ? { locked: true as const } : {}), ...flags(projectPath) });
    }
    for (const w of rows ?? []) {
      if (w.main || seen.has(w.path) || projectPaths.has(w.path)) continue;
      seen.add(w.path);
      out.push({
        ...base,
        worktree: basename(w.path),
        path: w.path,
        ...(w.branch ? { branch: w.branch } : {}),
        main: false,
        ...(w.locked ? { locked: true as const } : {}),
        ...(w.outsideRoots ? { outsideRoots: true as const } : {}),
        ...flags(w.path),
      });
    }
  }
  return out;
}

const listed = (es: Entry[]): Target[] => es.filter((e) => !e.outsideRoots && !e.removing).map(({ outsideRoots: _o, removing: _r, ...t }) => t);

/** The projects (own side) a name or path stands for; throws unknown/ambiguous/other_side/outside. */
function findProject(input: string, d: TargetDeps, es: Entry[]): { project: string; projectPath: string } {
  const projects = new Map(es.map((e) => [e.projectPath, e.project]));
  if (isPathInput(input)) {
    const other = d.sideOf?.(input);
    if (other) throw otherSide(input, other);
    const canon = d.allowed(input);
    const hit = canon === undefined ? undefined : [...projects].find(([p]) => (d.allowed(p) ?? p) === canon);
    if (!hit) throw new TargetError(`project is not a project inside the daemon's allowed roots: ${input}. The user adds projects in the web app.`, "unknown");
    return { project: hit[1], projectPath: hit[0] };
  }
  const hits = [...projects].filter(([, n]) => n === input);
  if (hits.length === 0) throw new TargetError(`No project named ${input} on this side. Projects: ${names([...projects.values()])}. worker_targets lists them; the user adds projects in the web app.`, "unknown");
  if (hits.length > 1) throw new TargetError(`Project name ${input} matches ${hits.length} projects: ${hits.map(([p]) => p).join(", ")}. Give its path.`, "ambiguous");
  return { project: hits[0]![1], projectPath: hits[0]![0] };
}

const otherSide = (path: string, side: string) =>
  new TargetError(`${path} is on ${side}: a coordinator starts workers on its own side only. Start the coordinator in a project on ${side} to run workers there.`, "other_side");

/** Own-side added projects and their linked worktrees inside the roots, not being removed. Main entry first per project. */
export async function listTargets(d: TargetDeps, filter?: { project?: string }): Promise<Target[]> {
  const es = await allEntries(d);
  if (filter?.project === undefined) return listed(es);
  const p = findProject(filter.project, d, es);
  return listed(es.filter((e) => e.projectPath === p.projectPath));
}

/** One target for worker_start; throws TargetError. No side effects. */
export async function resolveTarget(a: TargetInput, d: TargetDeps): Promise<Resolved> {
  const es = await allEntries(d);
  const usable = es.filter((e) => !e.outsideRoots && !e.removing);
  if (a.cwd !== undefined) {
    const other = d.sideOf?.(a.cwd);
    if (other) throw otherSide(a.cwd, other);
    const cwd = d.allowed(a.cwd);
    if (!cwd || !d.isDir(cwd)) throw new TargetError(`cwd is not a directory inside the daemon's allowed roots: ${a.cwd}`, "outside");
    if (d.removing(cwd)) throw new TargetError(`This worktree is being removed: ${cwd}`, "removing");
    const entry = usable.filter((e) => contains(e.path, cwd)).sort((x, y) => y.path.length - x.path.length)[0];
    return { kind: "cwd", cwd, ...(entry ? { entry: entry as Target } : {}) };
  }
  const proj = a.project ?? a.repo;
  if (a.worktree === undefined) {
    const p = findProject(proj!, d, es);
    if (a.branch !== undefined) return { kind: "new", ...p, branch: a.branch, ...(a.base !== undefined ? { base: a.base } : {}) };
    const main = es.find((e) => e.main && e.projectPath === p.projectPath)!;
    if (main.removing) throw new TargetError(`This worktree is being removed: ${main.path}`, "removing");
    return { kind: "main", cwd: main.path, entry: strip(main) };
  }
  const w = a.worktree;
  const scope = proj === undefined ? undefined : findProject(proj, d, es);
  const pool = es.filter((e) => !scope || e.projectPath === scope.projectPath);
  let hit: Entry;
  if (isPathInput(w)) {
    const other = d.sideOf?.(w);
    if (other) throw otherSide(w, other);
    const canon = d.allowed(w);
    if (!canon) throw new TargetError(`Worktree ${w} is outside the daemon's allowed roots or does not exist.`, "outside");
    const mainHit = es.find((e) => e.main && e.path === canon);
    if (mainHit) throw new TargetError(`${w} is the main checkout of project ${mainHit.project}: use project.`, "unknown");
    const found = es.find((e) => !e.main && e.path === canon);
    if (!found) throw new TargetError(`${w} is not a worktree of a project the user added. worker_targets lists them.`, "unknown");
    if (scope && found.projectPath !== scope.projectPath) throw new TargetError(`Worktree ${w} belongs to project ${found.project}, not ${scope.project}.`, "unknown");
    hit = found;
  } else {
    const linked = pool.filter((e) => !e.main);
    const named = linked.filter((e) => e.worktree === w);
    const hits = named.filter((e) => !e.outsideRoots && !e.removing);
    // Only an unlisted worktree has the name: say why it cannot be used.
    if (hits.length === 0 && named.length === 1) hits.push(named[0]!);
    if (hits.length === 0) throw new TargetError(`No worktree named ${w}${scope ? ` in project ${scope.project}` : ""}. Worktrees: ${names(linked.filter((e) => !e.outsideRoots && !e.removing).map((e) => e.worktree!))}. worker_targets lists them.`, "unknown");
    if (hits.length > 1) throw new TargetError(`Worktree name ${w} matches ${hits.length} worktrees: ${hits.map((e) => e.path).join(", ")}. Give project, or the path.`, "ambiguous");
    hit = hits[0]!;
  }
  if (hit.outsideRoots) throw new TargetError(`Worktree ${w} is outside the daemon's allowed roots: ${hit.path}.`, "outside");
  if (hit.removing) throw new TargetError(`Worktree ${w} is being removed: ${hit.path}.`, "removing");
  return { kind: "worktree", cwd: hit.path, entry: strip(hit) };
}

const strip = (e: Entry): Target => listed([{ ...e, outsideRoots: undefined, removing: undefined } as Entry])[0]!;

/** Card suffix: " in worktree w of project p" | " in project p" | " in a new worktree b of project p" | " in <cwd>". */
/** The folder the project config (agents, plugins) of a target comes from: the main checkout for a new branch, else the target folder. */
export const targetDir = (r: Resolved): string => (r.kind === "new" ? r.projectPath : r.cwd);

export function targetLabel(r: Resolved): string {
  switch (r.kind) {
    case "worktree":
      return ` in worktree ${r.entry.worktree} of project ${r.entry.project}`;
    case "main":
      return ` in project ${r.entry.project}`;
    case "new":
      return ` in a new worktree ${r.branch} of project ${r.project}`;
    case "cwd":
      if (!r.entry || r.entry.path !== r.cwd) return ` in ${r.cwd}`;
      return r.entry.main ? ` in project ${r.entry.project}` : ` in worktree ${r.entry.worktree} of project ${r.entry.project}`;
  }
}
