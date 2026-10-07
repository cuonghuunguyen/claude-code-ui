// Tab grouping setting (docs/spec.md "Layout"): how the titlebar strip groups open tabs; kept per browser.
import type { Worktree } from "@claude-ui/protocol";
import { projectCwd, projectOf } from "./sessions.ts";
import { projectName } from "./tabs.ts";

export type TabGrouping = "project" | "worktree" | "none";
export const TAB_GROUPINGS: { value: TabGrouping; label: string }[] = [
  { value: "project", label: "By project" },
  { value: "worktree", label: "By worktree" },
  { value: "none", label: "None" },
];

/** Group of a tab: `key` (the strip's group and collapse key, "" = no chip), chip `label`, `sub` (tooltip headline "<project> · <branch>" in worktree grouping), `color` (cwd whose avatar color the chip takes). */
export type TabGroup = { key: string; label: string; sub?: string; color: string };

export function tabGroup(cwd: string | undefined, mode: TabGrouping, worktrees: Record<string, Worktree[]> = {}): TabGroup {
  if (!cwd || mode === "none") return { key: "", label: "", color: "" };
  const c = projectCwd(cwd);
  const project = projectOf(c, worktrees);
  if (mode === "project") return { key: project, label: projectName(project), color: project };
  const w = Object.values(worktrees)
    .flat()
    .find((x) => x.path === c);
  return { key: c, label: projectName(c), sub: w && `${projectName(project)} · ${w.branch ?? projectName(c)}`, color: project };
}

const KEY = "claude-ui.tabGrouping";

export function loadTabGrouping(): TabGrouping {
  try {
    const v = localStorage.getItem(KEY);
    return v === "worktree" || v === "none" ? v : "project";
  } catch {
    return "project";
  }
}

export function saveTabGrouping(g: TabGrouping) {
  try {
    if (g === "project") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, g);
  } catch {
    // Storage blocked: the choice lasts for this page.
  }
}
