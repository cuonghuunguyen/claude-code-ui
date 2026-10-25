// The repository a project's Changes pane shows (docs/spec.md "Repository selector"): per browser, per project, `rel` relative to the owner cwd.
import { useCallback, useSyncExternalStore } from "react";
import { repoTree, type GitRepo, type GitReposResult, type Worktree } from "@claude-ui/protocol";
import { baseName, repoDir } from "./paths.ts";
import { projectOf } from "./sessions.ts";

/** A repository the git panes read: `path` the canonical top for requests, `dir` the same top spelled from the session cwd for row paths. */
export type RepoTarget = { path: string; dir: string };

const KEY = "claude-ui.repoChoice";
export const REPO_CHOICE_MAX = 200;
// Storage blocked: the choices last while the page is open.
let memory: Record<string, string> | undefined;
// A write failed (quota): memory is newer than the stored value.
let writeFailed = false;
const listeners = new Set<() => void>();

/** Insertion order = write order; only string values are kept. */
function readAll(): Record<string, string> {
  if (writeFailed && memory) return memory;
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return memory ?? {};
  }
}

/** Tests: forgets what this page kept in memory. */
export function forgetRepoChoices(): void {
  memory = undefined;
  writeFailed = false;
}

export function getRepoChoice(projectKey: string): string | undefined {
  return readAll()[projectKey];
}

export function setRepoChoice(projectKey: string, rel: string): void {
  const all = readAll();
  delete all[projectKey];
  all[projectKey] = rel;
  for (const k of Object.keys(all)) {
    if (Object.keys(all).length <= REPO_CHOICE_MAX) break;
    delete all[k];
  }
  memory = all;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
    writeFailed = false;
  } catch {
    // See `writeFailed`.
    writeFailed = true;
  }
  listeners.forEach((l) => l());
}

export function subscribeRepoChoice(l: () => void): () => void {
  listeners.add(l);
  // Another tab of this browser changed a choice.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    // The other tab's successful write is newer than what a failed write kept here.
    writeFailed = false;
    memory = undefined;
    l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

/** The stored `rel` of the project; re-renders when it is written here or in another tab. */
export function useRepoChoice(projectKey: string | undefined): string | undefined {
  return useSyncExternalStore(
    subscribeRepoChoice,
    () => (projectKey ? getRepoChoice(projectKey) : undefined),
    () => undefined,
  );
}

/** The stored choice if listed and readable, else own, else the first root, else any readable entry. */
export function resolveRepoChoice(list: GitRepo[], stored: string | undefined): GitRepo | undefined {
  const usable = (r: GitRepo) => !r.outsideRoots;
  return (
    (stored !== undefined ? list.find((r) => r.rel === stored && usable(r)) : undefined) ??
    list.find((r) => r.kind === "main" && usable(r)) ??
    repoTree(list).find(usable) ??
    list.find(usable)
  );
}

/** The repository's name in Graph result lines: its path relative to the cwd, or its folder name for the own repository (also one above the cwd). */
export const repoLabel = (r: GitRepo): string => (r.rel && !r.rel.startsWith("..") ? r.rel : baseName(r.path));

/** The selector shows for 2+ repositories, or when the own repository is not listed (a lone nested one is still a choice). */
export const selectorVisible = (list: GitRepo[]): boolean => list.length > 0 && (list.length >= 2 || !list.some((r) => r.kind === "main"));

/** The key of a pane's remembered choice: the owner cwd's project. None until the worktree list is known (a linked worktree would key under its own path). */
export const repoProjectKey = (cwd: string | undefined, worktrees: Record<string, Worktree[]>, listLoaded: boolean): string | undefined => (cwd && listLoaded ? projectOf(cwd, worktrees) : undefined);

/** `git.repos` of the pane's cwd; `projectKey` keys the remembered choice (the owner session's project). */
export type RepoList = { list: GitRepo[] | null | undefined; truncated?: GitReposResult["truncated"]; projectKey: string };

/**
 * The selected repository of a pane. `target`: undefined while the list is unknown (the pane asks `git.status` itself), null without a
 * usable repository, else where git requests go. Never writes: an unresolvable stored choice is kept.
 */
export function useSelectedRepo(repos: RepoList | undefined, cwd: string): { repo?: GitRepo; target: RepoTarget | null | undefined; choose: (rel: string) => void } {
  const stored = useRepoChoice(repos?.projectKey);
  const key = repos?.projectKey;
  const choose = useCallback((rel: string) => key !== undefined && setRepoChoice(key, rel), [key]);
  const list = repos?.list;
  if (!list) return { target: undefined, choose };
  const repo = resolveRepoChoice(list, stored);
  return { repo, target: repo ? { path: repo.path, dir: repoDir(cwd, repo.rel) } : null, choose };
}
