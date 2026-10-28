// Pure logic of the Clean up dialog (GH-377, docs/spec.md "Layout"): candidates, safety text, selection, filters, sequential run.
import type { SessionListItem, SessionState, Worktree, WorktreeBlock, WorktreeRemoveResult, WorktreeStatusResult } from "@claude-ui/protocol";
import { externalWorktree, repoOf } from "./sessions.ts";

const DAY = 86_400_000;

export type CleanupScope = { kind: "all" } | { kind: "project"; cwd: string } | { kind: "coordinator"; id: string; title: string };
export type WorktreeCandidate = { key: string; project: string; path: string; branch?: string; external: boolean; outsideRoots: boolean; locked: boolean; sessions: number; lastActivity?: number };
export type WorkerCandidate = { key: string; id: string; name: string; cwd: string; state: SessionState; lastActivity: number; /** The session that started it (a worker of a worker has a worker here). */ coordinatorId?: string; /** Path of its linked worktree candidate. */ worktree?: string };

export const BLOCK_TEXT: Record<WorktreeBlock, string> = {
  locked: "Locked (git worktree lock)",
  symlink: "The path is a symbolic link",
  outside_roots: "Outside the allowed roots",
  sessions_running: "A session there is running or needs input",
  removing: "Removal in progress",
  contains_worktree: "Contains another worktree",
};

export function cleanupCandidates(
  scope: CleanupScope,
  list: SessionListItem[],
  worktrees: Record<string, Worktree[]>,
  state: (s: SessionListItem) => SessionState,
): { worktrees: WorktreeCandidate[]; workers: WorkerCandidate[] } {
  const workerSessions = list.filter((s) => s.coordinatorId && (scope.kind !== "coordinator" || s.coordinatorId === scope.id));
  // One entry per repository: two added projects of it list the same worktrees.
  const repos = new Map<string, Worktree[]>();
  for (const [project, rows] of Object.entries(worktrees)) {
    if (scope.kind === "project" && project !== scope.cwd) continue;
    const main = repoOf(project, worktrees);
    if (!repos.has(main)) repos.set(main, rows);
  }
  const cwds = new Set(workerSessions.map((s) => s.cwd));
  const wts: WorktreeCandidate[] = [];
  for (const [main, rows] of repos) {
    for (const w of rows) {
      if (w.main || (scope.kind === "coordinator" && !cwds.has(w.path))) continue;
      const own = list.filter((s) => s.cwd === w.path);
      wts.push({
        key: `wt:${w.path}`,
        project: main,
        path: w.path,
        ...(w.branch && { branch: w.branch }),
        external: externalWorktree(rows, w),
        outsideRoots: !!w.outsideRoots,
        locked: !!w.locked,
        sessions: own.length,
        ...(own.length && { lastActivity: Math.max(...own.map((s) => s.lastActivity)) }),
      });
    }
  }
  const paths = new Set(wts.map((w) => w.path));
  const inProject = (cwd: string) => {
    if (scope.kind !== "project") return true;
    const main = repoOf(scope.cwd, worktrees);
    return cwd === main || cwd === scope.cwd || (worktrees[scope.cwd] ?? []).some((w) => w.path === cwd);
  };
  const workers = workerSessions
    .filter((s) => inProject(s.cwd))
    .map((s): WorkerCandidate => ({ key: `wk:${s.id}`, id: s.id, name: s.workerName ?? s.title, cwd: s.cwd, state: state(s), lastActivity: s.lastActivity, ...(s.coordinatorId && { coordinatorId: s.coordinatorId }), ...(paths.has(s.cwd) && { worktree: s.cwd }) }));
  return { worktrees: wts, workers };
}

export type Row =
  | ({ kind: "worktree" } & WorktreeCandidate & { status?: WorktreeStatusResult; error?: string })
  | ({ kind: "worker" } & WorkerCandidate);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function rowSafety(r: Row): { safety: "safe" | "has_work" | "blocked" | "checking"; reason?: string } {
  if (r.kind === "worker") {
    if (r.state === "running") return { safety: "blocked", reason: "Running" };
    if (r.state === "needs_input") return { safety: "blocked", reason: "Needs input" };
    return { safety: "safe" };
  }
  if (r.outsideRoots) return { safety: "blocked", reason: BLOCK_TEXT.outside_roots };
  if (r.locked) return { safety: "blocked", reason: BLOCK_TEXT.locked };
  if (r.error) return { safety: "blocked", reason: r.error };
  const st = r.status;
  if (!st) return { safety: "checking" };
  if (st.safety === "blocked") return { safety: "blocked", reason: st.blocked ? BLOCK_TEXT[st.blocked] : "Blocked" };
  if (st.safety === "has_work") return { safety: "has_work", reason: `${plural(st.uncommitted, "file")}, ${plural(st.ahead, "commit")}` };
  // Squash or rebase merged: ahead, but the base already has the changes.
  if (st.mergedInto) return { safety: "safe", reason: `changes already in ${st.mergedInto} (squash/rebase merged)` };
  return { safety: "safe" };
}

/** Safe worktrees directly in `.claude/worktrees` and closed workers: everything else needs a tick. */
export function defaultSelection(rows: Row[]): Set<string> {
  const keys = new Set<string>();
  for (const r of rows) {
    const { safety } = rowSafety(r);
    if (r.kind === "worktree" ? safety === "safe" && !r.external : r.state === "closed" && safety !== "blocked") keys.add(r.key);
  }
  return keys;
}

export type Filter = { olderThan: 0 | 1 | 7 | 30; onlySafe: boolean };
export const activityOf = (r: Row) => (r.kind === "worker" ? r.lastActivity : Math.max(r.lastActivity ?? 0, r.status?.headTime ?? 0) || undefined);

/** Hides rows; unknown activity counts as old. */
export function filterRows(rows: Row[], f: Filter, now: number): Row[] {
  return rows.filter((r) => {
    if (f.onlySafe && rowSafety(r).safety !== "safe") return false;
    if (!f.olderThan) return true;
    const t = activityOf(r);
    return t === undefined || t < now - f.olderThan * DAY;
  });
}

export const confirmLabel = (n: number, m: number) => (m ? `Remove ${n} (${m} with unsaved work)` : `Remove ${n}`);

export type Item = { key: string; label: string; run: () => Promise<WorktreeRemoveResult | object> };
export type CleanupResult = { removed: string[]; skipped: { label: string; reason: string }[]; notes: string[] };

/** One request at a time: git and the daemon's session cleanup take one worktree at a time anyway. */
export async function runCleanup(items: Item[], onProgress: (done: number) => void = () => {}): Promise<CleanupResult> {
  const out: CleanupResult = { removed: [], skipped: [], notes: [] };
  let done = 0;
  for (const it of items) {
    try {
      const r = (await it.run()) as WorktreeRemoveResult;
      out.removed.push(it.label);
      if (r?.branchKept) out.notes.push(`Branch ${it.label} kept: ${r.branchKept}`);
      if (r?.ignoredDeleted) out.notes.push(`${it.label}: ${plural(r.ignoredDeleted, "ignored file")} deleted`);
    } catch (e) {
      out.skipped.push({ label: it.label, reason: (e as Error).message });
    }
    onProgress(++done);
  }
  return out;
}

export const summaryText = (r: CleanupResult) => `Removed ${r.removed.length}, skipped ${r.skipped.length}`;

export const rowLabel = (r: Row) => (r.kind === "worker" ? r.name : (r.branch ?? r.path.split(/[\\/]/).filter(Boolean).at(-1) ?? r.path));

/** Workers first (their sessions leave the worktree), then worktrees. */
export function cleanupItems(rows: Row[], selected: Set<string>, opts: { deleteBranch: Set<string> }, request: <T>(m: { type: "worker.remove"; sessionId: string } | { type: "worktree.remove"; cwd: string; path: string; expectSafe: boolean; expect: { uncommitted: number; ahead: number; ignored?: number }; deleteBranch: boolean }) => Promise<T>): Item[] {
  const ticked = rows.filter((r) => selected.has(r.key));
  // A worker with workers below it is refused by the daemon: remove the deepest first (depth along coordinatorId among the rows).
  const up = new Map(rows.flatMap((r) => (r.kind === "worker" && r.coordinatorId ? [[r.id, r.coordinatorId] as const] : [])));
  const depth = (id: string) => {
    let d = 0;
    for (let cur = id; up.has(cur) && d < 20; d++) cur = up.get(cur)!;
    return d;
  };
  const workers = [...ticked].sort((a, b) => (b.kind === "worker" ? depth(b.id) : 0) - (a.kind === "worker" ? depth(a.id) : 0)).flatMap((r): Item[] => (r.kind === "worker" ? [{ key: r.key, label: r.name, run: () => request({ type: "worker.remove", sessionId: r.id }) }] : []));
  const wts = ticked.flatMap((r): Item[] =>
    r.kind === "worktree"
      ? [{ key: r.key, label: rowLabel(r), run: () => request({ type: "worktree.remove", cwd: r.project, path: r.path, expectSafe: r.status?.safety === "safe", expect: { uncommitted: r.status?.uncommitted ?? 0, ahead: r.status?.ahead ?? 0, ...(r.status?.ignored !== undefined && { ignored: r.status.ignored }) }, deleteBranch: opts.deleteBranch.has(r.key) && !!r.status?.branchMerged }) }]
      : [],
  );
  return [...workers, ...wts];
}
