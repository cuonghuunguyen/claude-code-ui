// Shared folders of a worker (docs/spec.md "Permission tiers"): the real target of a `worktree.symlinkDirectories` entry of a
// worktree the daemon created. A worker writes its scratch files there (e.g. `development-docs/GH-1/`), in the main checkout.
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { worktreeSettings } from "./git.ts";
import { denied, gitControl, mainCheckoutOf } from "./risk-tier.ts";

export type SharedDir = {
  /** The entry as the settings name it, `/` separated: the link is `<cwd>/<rel>`. */
  rel: string;
  /** The real folder in the main checkout. */
  real: string;
  /** Its path relative to the main checkout, `/` separated (the entry itself may be a symlink in the main checkout). */
  target: string;
};

const defaultClaudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/**
 * The shared folders of `cwd`, when all hold:
 * - `cwd` is `<main>/.claude/worktrees/<name>` made by the daemon (mainCheckoutOf);
 * - the entry is listed in `worktree.symlinkDirectories` of the settings the daemon used to create it (they sit under `.claude`,
 *   which a low Write never reaches);
 * - `<cwd>/<entry>` is a symlink (a junction on Windows) whose real path is the real path of `<main>/<entry>`, inside `<main>`
 *   and not `<main>` itself.
 * A tracked folder is excluded by the caller (RepoSafety.trackedShared). Any error: none.
 */
export function sharedLinks(cwd: string, claudeDir = defaultClaudeDir()): SharedDir[] {
  try {
    const main = mainCheckoutOf(cwd);
    if (!main) return [];
    const list = worktreeSettings(claudeDir, main).symlinkDirectories;
    if (!Array.isArray(list)) return [];
    const realMain = realpathSync(main);
    const realCwd = realpathSync(cwd);
    const out: SharedDir[] = [];
    for (const d of list) {
      try {
        if (typeof d !== "string" || !d || isAbsolute(d) || /^([\\/]|[A-Za-z]:)/.test(d) || d.split(/[\\/]/).includes("..")) continue;
        const link = join(realCwd, d);
        if (!lstatSync(link).isSymbolicLink()) continue;
        const real = realpathSync(join(main, d));
        const rel = relative(realMain, real);
        if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
        if (realpathSync(link) !== real) continue;
        // The entry name and the real target both: a link `cfg` to `<main>/.claude` must not share the agent config. A target that
        // holds the worktree itself (`.claude`) would share every worktree.
        const names = [...d.split(/[\\/]/), ...rel.split(sep)];
        if (names.some((seg) => denied(seg) || gitControl(seg))) continue;
        const inner = relative(real, realCwd);
        if (inner === "" || (!inner.startsWith("..") && !isAbsolute(inner))) continue;
        const entry = d.split(/[\\/]/).filter(Boolean).join("/");
        if (!out.some((o) => o.real === real)) out.push({ rel: entry, real, target: rel.split(sep).join("/") });
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

/** The real folders of the shared folders of `cwd` (see sharedLinks). */
export const sharedDirs = (cwd: string, claudeDir?: string): string[] => sharedLinks(cwd, claudeDir).map((s) => s.real);

/** Whether `p` is `dir` or below it. */
export const under = (dir: string, p: string) => {
  const rel = relative(dir, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..");
};
