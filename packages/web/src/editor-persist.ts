// Open editor tabs survive a reload (docs/spec.md "Editor tabs", GH-366): the tab list in localStorage (per browser), unsaved drafts in sessionStorage
// (this browser tab only). Every storage access is guarded: a blocked or full storage skips the write (the unload warning still guards unsaved edits).
import type { Tab } from "./files.ts";
import { isDirty } from "./files.ts";

const LIST_KEY = "claude-ui.editorTabs";
const DRAFTS_KEY = "claude-ui.editorDrafts";

export type SavedTab = { path: string; preview?: boolean; item?: boolean; outside?: boolean };
/** `mtime`: the disk version the draft is based on; `conflict`: a newer disk version was already seen (the draft must not overwrite it). */
export type SavedDrafts = Record<string, { draft: string; mtime: number; conflict?: true }>;
export type Saved = { tabs: SavedTab[]; active?: string; recent: string[]; drafts: SavedDrafts };
/** `write` returns false when the drafts could not be kept (full storage). */
export type EditorStorage = { load: () => Saved; write: (s: Saved) => boolean | void };

export const emptySaved = (): Saved => ({ tabs: [], recent: [], drafts: {} });

/** What to persist for the current tabs (dirty text tabs keep a draft; `recent`: most recently active first). */
export function toSaved(s: { tabs: Record<string, Tab>; activePath?: string; recent: string[] }): Saved {
  const tabs = Object.values(s.tabs).map((t): SavedTab => ({ path: t.path, ...(t.preview ? { preview: true } : {}), ...(t.item ? { item: true } : {}), ...(t.outside ? { outside: true } : {}) }));
  const drafts: SavedDrafts = {};
  for (const t of Object.values(s.tabs)) if (!t.media && isDirty(t)) drafts[t.path] = { draft: t.draft, mtime: t.mtime, ...(t.conflict ? { conflict: true as const } : {}) };
  return { tabs, active: s.activePath && s.tabs[s.activePath] ? s.activePath : undefined, recent: s.recent.filter((p) => s.tabs[p]), drafts };
}

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Junk or another version yields nothing. A draft whose path is missing from the list is appended as a tab. */
export function parseSaved(rawList: string | null, rawDrafts: string | null): Saved {
  const out = emptySaved();
  const parse = (raw: string | null): unknown => {
    try {
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  };
  const l = parse(rawList);
  if (obj(l) && l.v === 1 && Array.isArray(l.tabs)) {
    for (const t of l.tabs) {
      if (!obj(t) || typeof t.path !== "string" || out.tabs.some((x) => x.path === t.path)) continue;
      out.tabs.push({ path: t.path, ...(t.preview === true ? { preview: true } : {}), ...(t.item === true ? { item: true } : {}), ...(t.outside === true ? { outside: true } : {}) });
    }
    if (typeof l.active === "string") out.active = l.active;
    out.recent = strings(l.recent);
  }
  const d = parse(rawDrafts);
  if (obj(d)) {
    for (const [path, v] of Object.entries(d)) {
      if (!obj(v) || typeof v.draft !== "string" || typeof v.mtime !== "number") continue;
      out.drafts[path] = { draft: v.draft, mtime: v.mtime, ...(v.conflict === true ? { conflict: true as const } : {}) };
      if (!out.tabs.some((t) => t.path === path)) out.tabs.push({ path });
    }
  }
  return out;
}

type Area = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const areas = (): { local?: Area; session?: Area } => {
  const pick = (f: () => Area) => {
    try {
      return f();
    } catch {
      return undefined;
    }
  };
  return { local: pick(() => localStorage), session: pick(() => sessionStorage) };
};
const read = (a: Area | undefined, key: string) => {
  try {
    return a?.getItem(key) ?? null;
  } catch {
    return null;
  }
};
const put = (a: Area | undefined, key: string, value: string): boolean => {
  try {
    a?.setItem(key, value);
    return true;
  } catch {
    // Quota or blocked storage: skip. shortcut: no size cap, upgrade when quota errors show up.
    return false;
  }
};

export function loadSaved(): Saved {
  const { local, session } = areas();
  return parseSaved(read(local, LIST_KEY), read(session, DRAFTS_KEY));
}

/** False when the drafts did not fit: the older drafts key goes too, so a stale draft never restores as the current one. */
export function writeSaved(s: Saved): boolean {
  const { local, session } = areas();
  put(local, LIST_KEY, JSON.stringify({ v: 1, tabs: s.tabs, active: s.active, recent: s.recent }));
  if (put(session, DRAFTS_KEY, JSON.stringify(s.drafts))) return true;
  try {
    session?.removeItem(DRAFTS_KEY);
  } catch {
    // blocked storage
  }
  return false;
}

/** Unpaired: the tabs and drafts of this browser go with its token. */
export function clearSaved() {
  const { local, session } = areas();
  for (const [a, k] of [[local, LIST_KEY], [session, DRAFTS_KEY]] as const) {
    try {
      a?.removeItem(k);
    } catch {
      // blocked storage: nothing to clear
    }
  }
}
