// Create worktree modal logic (GH-447, docs/spec.md "Worktrees"): Branch source choice, branch rows, Base picker options.
import { jiraKeyOf, pullRequestOf, type BranchRow, type PullRequestLink } from "@claude-ui/protocol";

export type Source = "ticket" | "branch" | "name";
export const SOURCES: { id: Source; title: string }[] = [
  { id: "ticket", title: "Ticket" },
  { id: "branch", title: "Branch" },
  { id: "name", title: "Name" },
];
const SOURCE_KEY = "claude-ui.worktreeSource";
/** The last Branch source used in this browser, if any. */
export function storedSource(): Source | undefined {
  try {
    const v = localStorage.getItem(SOURCE_KEY);
    if (v === "ticket" || v === "branch" || v === "name") return v;
  } catch {}
  return undefined;
}
/** The last Branch source used in this browser; first time: Ticket when Jira is set up, else Name. */
export const loadSource = (jira: boolean): Source => storedSource() ?? (jira ? "ticket" : "name");
export function saveSource(s: Source) {
  try {
    localStorage.setItem(SOURCE_KEY, s);
  } catch {}
}

export const branchKind = (r: BranchRow) => (r.local && r.remote ? "Local · Remote" : r.local ? "Local" : "Remote");
/** What `worktree.create {checkout}` gets: the local branch when there is one, else the remote one. */
export const checkoutRef = (r: BranchRow) => (r.local ? `refs/heads/${r.name}` : r.remote!);
const remoteLabel = (ref: string) => ref.replace(/^refs\/remotes\//, "");

/** Rows whose name holds every typed word (any case). */
export function filterBranches(rows: BranchRow[], text: string): BranchRow[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? rows.filter((r) => words.every((w) => r.name.toLowerCase().includes(w))) : rows;
}

/** What the Branch filter or Ticket search holds: a pull request link, a Jira key or ticket link, or words. */
export type Paste = { kind: "pr"; url: string; link: PullRequestLink } | { kind: "key"; key: string } | { kind: "words" };
export function pasteOf(text: string): Paste {
  const t = text.trim();
  const link = t ? pullRequestOf(t) : undefined;
  if (link) return { kind: "pr", url: t, link };
  const key = t ? jiraKeyOf(t) : undefined;
  return key ? { kind: "key", key } : { kind: "words" };
}

/** Rows whose name holds the ticket key as a whole word, any case. */
export const branchesWithKey = (rows: BranchRow[], key: string): BranchRow[] => rows.filter((r) => branchWithKey([r], key));

/** Base picker: local branches, then remote branches (full refs as values). */
export function baseOptions(rows: BranchRow[]): { value: string; label: string }[] {
  return [
    ...rows.filter((r) => r.local).map((r) => ({ value: `refs/heads/${r.name}`, label: r.name })),
    ...rows.filter((r) => r.remote).map((r) => ({ value: r.remote!, label: remoteLabel(r.remote!) })),
  ];
}

/** A branch whose name holds the ticket key as a whole word (`PRJ-12` not in `prj-120`), any case. */
export function branchWithKey(rows: BranchRow[], key: string): BranchRow | undefined {
  const k = key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^a-z0-9])${k}(?![0-9])`, "i");
  return rows.find((r) => re.test(r.name));
}

/** The folder name of a worktree path (`in worktree <name>`). */
export const folderOf = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
