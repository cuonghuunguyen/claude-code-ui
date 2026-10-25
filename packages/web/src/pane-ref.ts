// Pane refs (GH-395, docs/spec.md "Titlebar tabs"): strip/tab ids of non-session panes, `plan:<session uuid>`. Sessions stay bare uuids.
export type PaneKind = "plan"; // 2/8+: "files" | "graph" | "terminal" | "file" | "artifact"
export type PaneRef = { kind: PaneKind; owner: string };

// Lowercase only, like the session ids the daemon makes: tabs compare ids as exact strings, so one session has one ref.
const REF = /^(plan):([0-9a-f-]{36})$/;

/** undefined for sessions, the new-session and focus tabs, and junk. */
export function parseRef(id: string | undefined): PaneRef | undefined {
  const m = id === undefined ? null : REF.exec(id);
  return m ? { kind: m[1] as PaneKind, owner: m[2]! } : undefined;
}
export const refOf = (r: PaneRef): string => `${r.kind}:${r.owner}`;
export const isPaneRef = (id: unknown): id is string => typeof id === "string" && parseRef(id) !== undefined;
/** The owner session of a ref; the id itself for anything else. */
export const ownerOf = (id: string): string => parseRef(id)?.owner ?? id;
export const kindOf = (id: string): PaneKind | undefined => parseRef(id)?.kind;
export const KIND_LABEL: Record<PaneKind, string> = { plan: "Plan" };
/** Split view (4/8 widens it): no pane kind may be in a split yet. */
export const splittable = (_id: string): boolean => false;
/** "Plan · <title>". */
export const paneTabTitle = (kind: PaneKind, ownerTitle: string): string => `${KIND_LABEL[kind]} · ${ownerTitle}`;
