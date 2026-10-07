// Added projects (docs/spec.md "Projects"): only directories the user added in the web app (or that a session of this app started in).
// Kept in a small file in the config dir; the transcripts stay the only session store (ADR 0001).
import { createJsonFile } from "./json-file.ts";

/**
 * cwd → when it was added / removed (ms). `seeded`: the one-time upgrade from the old rule (every transcript cwd listed) ran.
 * `removed` only matters before that: a seed does not bring back a project removed under the old rule.
 */
type Stored = { opened: Record<string, number>; removed: Record<string, number>; seeded: boolean };

/** Without `file` the list lives in memory only (tests). Changes throw when the save fails (the change stays in memory). */
export function createProjects({ file, now = Date.now }: { file?: string; now?: () => number } = {}) {
  // Daemons of one user share the file (json-file.ts): each change applies to the latest list.
  const store = createJsonFile<Stored>(
    file,
    // A hand-edited file of another shape counts as empty. A corrupt file at start counts as seeded: a file existed, so the upgrade ran.
    (r, corrupt) => ({ opened: map((r as Stored)?.opened), removed: map((r as Stored)?.removed), seeded: corrupt === true || (r as Stored)?.seeded === true }),
    "projects",
  );

  return {
    open(cwd: string) {
      cwd = trim(cwd);
      store.change((d) => {
        d.opened[cwd] = now();
        delete d.removed[cwd];
      });
    },
    has: (cwd: string) => trim(cwd) in store.get().opened,
    /** Hides the project from the list; its files and transcripts stay. */
    remove(cwd: string) {
      cwd = trim(cwd);
      store.change((d) => {
        delete d.opened[cwd];
        d.removed[cwd] = now();
      });
    },
    /** False until `seed` ran (on a daemon with no `seeded` mark in its file). */
    get seeded() {
      return store.get().seeded;
    },
    /** Upgrade from "every transcript cwd is a project": adds the cwds of sessions that have saved claude-ui state, once. */
    seed(sessions: { cwd: string; lastActivity: number }[]) {
      store.change((d) => {
        for (const s of sessions) {
          const cwd = trim(s.cwd);
          if (s.lastActivity > (d.removed[cwd] ?? -Infinity)) d.opened[cwd] ??= s.lastActivity;
        }
        d.seeded = true;
      });
    },
    /** Added project cwds, newest activity first (last session, or when it was added). */
    list(sessions: { cwd: string; lastActivity: number }[]) {
      const data = store.get();
      const latest = new Map(Object.entries(data.opened));
      for (const s of sessions) {
        const cwd = trim(s.cwd);
        if (cwd in data.opened) latest.set(cwd, Math.max(latest.get(cwd)!, s.lastActivity));
      }
      return [...latest].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
    },
    /** Cwds with sessions that are not added, newest activity first: the suggestions of the Open project dialog. */
    recent(sessions: { cwd: string; lastActivity: number }[]) {
      const data = store.get();
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
