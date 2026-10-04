// Added projects (docs/spec.md "Projects"): only directories the user added in the web app (or that a session of this app started in).
// Kept in a small file in the config dir; the transcripts stay the only session store (ADR 0001).
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * cwd → when it was added / removed (ms). `seeded`: the one-time upgrade from the old rule (every transcript cwd listed) ran.
 * `removed` only matters before that: a seed does not bring back a project removed under the old rule.
 */
type Stored = { opened: Record<string, number>; removed: Record<string, number>; seeded: boolean };

/** Without `file` the list lives in memory only (tests). */
export function createProjects({ file, now = Date.now }: { file?: string; now?: () => number } = {}) {
  let data: Stored = { opened: {}, removed: {}, seeded: false };
  if (file)
    try {
      const read = JSON.parse(readFileSync(file, "utf8"));
      // A hand-edited file of another shape counts as empty.
      data = { opened: map(read?.opened), removed: map(read?.removed), seeded: read?.seeded === true };
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
    has: (cwd: string) => trim(cwd) in data.opened,
    /** Hides the project from the list; its files and transcripts stay. */
    remove(cwd: string) {
      cwd = trim(cwd);
      delete data.opened[cwd];
      data.removed[cwd] = now();
      save();
    },
    /** False until `seed` ran (on a daemon with no `seeded` mark in its file). */
    get seeded() {
      return data.seeded;
    },
    /** Upgrade from "every transcript cwd is a project": adds the cwds of sessions that have saved claude-ui state, once. */
    seed(sessions: { cwd: string; lastActivity: number }[]) {
      for (const s of sessions) {
        const cwd = trim(s.cwd);
        if (s.lastActivity > (data.removed[cwd] ?? -Infinity)) data.opened[cwd] ??= s.lastActivity;
      }
      data.seeded = true;
      save();
    },
    /** Added project cwds, newest activity first (last session, or when it was added). */
    list(sessions: { cwd: string; lastActivity: number }[]) {
      const latest = new Map(Object.entries(data.opened));
      for (const s of sessions) {
        const cwd = trim(s.cwd);
        if (cwd in data.opened) latest.set(cwd, Math.max(latest.get(cwd)!, s.lastActivity));
      }
      return [...latest].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
    },
    /** Cwds with sessions that are not added, newest activity first: the suggestions of the Open project dialog. */
    recent(sessions: { cwd: string; lastActivity: number }[]) {
      const by = new Map<string, { cwd: string; sessionCount: number; lastActivity: number }>();
      for (const s of sessions) {
        const cwd = trim(s.cwd);
        if (cwd in data.opened) continue;
        const r = by.get(cwd) ?? { cwd, sessionCount: 0, lastActivity: -Infinity };
        r.sessionCount++;
        r.lastActivity = Math.max(r.lastActivity, s.lastActivity);
        by.set(cwd, r);
      }
      return [...by.values()].sort((a, b) => b.lastActivity - a.lastActivity);
    },
  };
}

const map = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {});

/** "/p/x/" and "/p/x" are one project. */
export const trim = (cwd: string) => cwd.replace(/(.)\/+$/, "$1");

export type Projects = ReturnType<typeof createProjects>;
