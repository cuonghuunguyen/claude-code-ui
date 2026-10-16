// Last time each tab was the shown tab (GH-378 "Close tabs not used for…", auto-close), per browser.
const KEY = "claude-ui.tab-used";
export type Used = Record<string, number>;

const parse = (raw: string | null): Used => {
  try {
    const v = JSON.parse(raw ?? "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])));
  } catch {
    return {};
  }
};

export function loadUsed(): Used {
  try {
    return parse(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

/** Merges with the stored stamps (max per id of the kept ids): two windows of one browser do not erase each other's. */
export function saveUsed(u: Used): void {
  try {
    const stored = parse(localStorage.getItem(KEY));
    const merged: Used = {};
    for (const [id, t] of Object.entries(u)) merged[id] = Math.max(t, stored[id] ?? 0);
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // Blocked storage: the stamps restart on the next load.
  }
}

export const stampUsed = (u: Used, ids: (string | undefined)[], now: number): Used => {
  const next = { ...u };
  for (const id of ids) if (id) next[id] = now;
  return next;
};

export function seedUsed(u: Used, tabs: string[], now: number): Used {
  const missing = tabs.filter((id) => u[id] === undefined);
  return missing.length ? { ...u, ...Object.fromEntries(missing.map((id) => [id, now])) } : u;
}

export function pruneUsed(u: Used, keep: ReadonlySet<string>): Used {
  const drop = Object.keys(u).filter((id) => !keep.has(id));
  return drop.length ? Object.fromEntries(Object.entries(u).filter(([id]) => keep.has(id))) : u;
}
