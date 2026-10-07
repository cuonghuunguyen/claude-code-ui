// Changes tab view modes (docs/spec.md "Layout"): what the panel diffs (session changes, uncommitted work, work against a branch),
// the session scope filter and the default mode of Settings. All per browser, like the tab grouping.
import { useSyncExternalStore } from "react";

export type DiffMode = "session" | "uncommitted" | "branch";
export const DIFF_MODES: { value: DiffMode; label: string; git: boolean }[] = [
  { value: "session", label: "Session changes", git: false },
  { value: "uncommitted", label: "Uncommitted", git: true },
  { value: "branch", label: "Against branch", git: true },
];
export type DiffScope = "project" | "all";

const MODE_KEY = "claude-ui.diffMode";
const SCOPE_KEY = "claude-ui.diffScope";

export function loadDiffMode(): DiffMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "uncommitted" || v === "branch" ? v : "session";
  } catch {
    return "session";
  }
}

const listeners = new Set<() => void>();
// Storage blocked: the choice lasts while the page is open.
let memory: DiffMode | undefined;
export function saveDiffMode(m: DiffMode) {
  memory = m;
  try {
    if (m === "session") localStorage.removeItem(MODE_KEY);
    else localStorage.setItem(MODE_KEY, m);
  } catch {
    // See `memory`.
  }
  listeners.forEach((l) => l());
}
function readMode(): DiffMode {
  try {
    localStorage.getItem(MODE_KEY);
    return loadDiffMode();
  } catch {
    return memory ?? "session";
  }
}

export function loadDiffScope(): DiffScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "project" ? "project" : "all";
  } catch {
    return "all";
  }
}
export function saveDiffScope(s: DiffScope) {
  try {
    if (s === "all") localStorage.removeItem(SCOPE_KEY);
    else localStorage.setItem(SCOPE_KEY, s);
  } catch {
    // Storage blocked: the choice lasts while the panel is open.
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  // Another tab of this browser changed the default.
  const onStorage = (e: StorageEvent) => (e.key === MODE_KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
/** The Settings default; re-renders when it is saved here or in another tab. */
export const useDefaultDiffMode = (): DiffMode => useSyncExternalStore(subscribe, readMode, () => "session");

/** A panel's own choice per session, for this page only (a panel remounts on every session tab switch); `ref`: the branch compared. */
export const sessionDiffChoice = new Map<string, { mode: DiffMode; ref?: string }>();

/** The repository top of `cwd` from `GitDiff.prefix`: drops the prefix's segments from the end of cwd, keeping cwd's own spelling (drive letter, separators). */
export function repoRoot(cwd: string, prefix: string): string {
  const n = prefix.split("/").filter(Boolean).length;
  let root = cwd;
  for (let i = 0; i < n; i++) root = root.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
  return root || cwd.slice(0, 1);
}
