// Known projects (docs/spec.md "Projects"): session cwds plus directories opened in the web app, minus removed ones.
// Opened and removed projects are kept in a small file in the config dir; the transcripts stay the only session store (ADR 0001).
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/** cwd → when it was opened / removed (ms). */
type Stored = { opened: Record<string, number>; removed: Record<string, number> };

/** Without `file` the list lives in memory only (tests). */
export function createProjects({ file, now = Date.now }: { file?: string; now?: () => number } = {}) {
  let data: Stored = { opened: {}, removed: {} };
  if (file)
    try {
      const read = JSON.parse(readFileSync(file, "utf8"));
      // A hand-edited file of another shape counts as empty.
      data = { opened: map(read?.opened), removed: map(read?.removed) };
    } catch (e) {
      // A truncated file (crash in an older version's write) only loses the list; it must not stop the daemon.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
    }
  // Temp file + rename: a crash during the write leaves the old file, never a truncated one.
  const save = () => file && (writeFileSync(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 }), renameSync(`${file}.tmp`, file));

  return {
    open(cwd: string) {
      cwd = trim(cwd);
      data.opened[cwd] = now();
      delete data.removed[cwd];
      save();
    },
    /** Hides the project from the list; its files and transcripts stay. A session newer than the removal shows it again. */
    remove(cwd: string) {
      cwd = trim(cwd);
      delete data.opened[cwd];
      data.removed[cwd] = now();
      save();
    },
    /** Project cwds, newest activity first (last session, or when it was opened). */
    list(sessions: { cwd: string; lastActivity: number }[]) {
      const latest = new Map(Object.entries(data.opened));
      for (const s of sessions) {
        const cwd = trim(s.cwd);
        if (s.lastActivity > (data.removed[cwd] ?? -Infinity)) latest.set(cwd, Math.max(latest.get(cwd) ?? -Infinity, s.lastActivity));
      }
      return [...latest].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
    },
  };
}

const map = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {});

/** "/p/x/" and "/p/x" are one project. */
export const trim = (cwd: string) => cwd.replace(/(.)\/+$/, "$1");

export type Projects = ReturnType<typeof createProjects>;
