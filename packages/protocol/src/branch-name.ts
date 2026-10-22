// Branch-name rules of the Create worktree modal (docs/spec.md "Worktrees", GH-447), shared by the daemon and the web app.
import { worktreeNameError } from "./wire.ts";

/** Longest normalized name (Name rule). */
export const BRANCH_NAME_MAX = 80;
/** Longest branch the daemon accepts (git allows more; a folder name must still fit its 64-character rule). */
export const BRANCH_MAX = 200;
/** Summary part of a Ticket branch name. */
export const SUMMARY_MAX = 50;
export const DEFAULT_BRANCH_TEMPLATE = "{type}/{key}-{summary}";

/** Each `/` separated part: no leading or trailing `-` or `.`, no `.lock` suffix; empty parts dropped. */
const tidy = (s: string) =>
  s
    .split("/")
    .map((p) => p.replace(/^[-.]+/, "").replace(/(\.lock)+$/, "").replace(/[-.]+$/, ""))
    .filter(Boolean)
    .join("/");

/**
 * The Name rule: trim, lowercase, strip accents (NFKD), every character outside `a-z 0-9 . _ - /` becomes `-`, repeated `-`, `/`
 * and `.` collapse, no leading or trailing `-` `.` `/` (per part too), no `.lock` suffix, at most 80 characters. Empty: no name.
 * `keep`: a ticket key whose case stays (`PRJ-12`).
 */
export function normalizeBranchName(input: string, o: { keep?: string } = {}): string {
  let s = input
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9._\-/]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/\.{2,}/g, ".");
  s = tidy(s);
  if (s.length > BRANCH_NAME_MAX) s = tidy(s.slice(0, BRANCH_NAME_MAX));
  const key = o.keep && normalizeBranchName(o.keep);
  if (o.keep && key) s = s.replace(new RegExp(`(?<![a-z0-9])${key.replace(/[.]/g, "\\.")}(?![0-9])`, "g"), o.keep);
  return s;
}

/** The worktree folder of a branch: `/` becomes `-` (`feat/x` → `feat-x`). */
export const branchFolder = (branch: string) => branch.replaceAll("/", "-");

/** Quick checks of a new branch name before the daemon's `git check-ref-format --branch`; undefined when it may be valid. */
export function branchNameError(branch: string): string | undefined {
  if (!branch) return "Enter a branch name";
  if (branch.startsWith("-")) return "A branch name cannot start with -";
  if (branch.length > BRANCH_MAX) return `A branch name has at most ${BRANCH_MAX} characters`;
  const folder = worktreeNameError(branchFolder(branch));
  if (folder) return `Folder ${branchFolder(branch)}: ${folder}`;
}

export type TicketFields = { key: string; type: string; summary: string };
/** `{type}` of a ticket type: Bug → bugfix, Story/Task/New Feature → feature, other → empty. */
export function ticketTypeWord(type: string): string {
  const t = type.trim().toLowerCase();
  if (t === "bug") return "bugfix";
  if (t === "story" || t === "task" || t === "new feature") return "feature";
  return "";
}

/**
 * Branch name of a Ticket from a template (default `{type}/{key}-{summary}`): `{type}` per `ticketTypeWord` (empty drops the `/`
 * after it), `{key}` as is, `{summary}` through the Name rule cut to 50 characters; the result through the Name rule with the key's case kept.
 */
export function ticketBranchName(template: string, t: TicketFields): string {
  const type = ticketTypeWord(t.type);
  const summary = tidy(normalizeBranchName(t.summary).slice(0, SUMMARY_MAX));
  let s = type ? template.replaceAll("{type}", type) : template.replace(/\{type\}\/?/g, "");
  s = s.replaceAll("{key}", t.key).replaceAll("{summary}", summary);
  return normalizeBranchName(s, { keep: t.key });
}

const KEY = /^[A-Za-z][A-Za-z0-9_]+-\d+$/;
/** The Jira key a typed text or a pasted ticket URL names (`PRJ-123`, upper case); undefined when it names none. */
export function jiraKeyOf(text: string): string | undefined {
  const s = text.trim();
  if (KEY.test(s)) return s.toUpperCase();
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const sel = url.searchParams.get("selectedIssue");
  if (sel && KEY.test(sel)) return sel.toUpperCase();
  const parts = url.pathname.split("/").map(decodeURIComponent);
  const at = parts.indexOf("browse");
  if (at >= 0 && KEY.test(parts[at + 1] ?? "")) return parts[at + 1]!.toUpperCase();
  return undefined;
}

/** Jira Cloud (`*.atlassian.net`: email + API token, Basic) or else Data Center / Server (personal access token, Bearer). */
export function jiraIsCloud(base: string): boolean {
  try {
    return new URL(base).hostname.toLowerCase().endsWith(".atlassian.net");
  } catch {
    return false;
  }
}
