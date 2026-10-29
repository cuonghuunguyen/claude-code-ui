// Pane refs (GH-395/396, docs/spec.md "Titlebar tabs"): strip/tab ids of non-session panes, `plan:<session uuid>`, `files:<session uuid>`, `graph:<session uuid>`, `terminal:<session uuid>` (GH-397). Sessions stay bare uuids.
export type PaneKind = "plan" | "files" | "graph" | "terminal"; // 4/8+: "file" | "artifact"
export type PaneRef = { kind: PaneKind; owner: string };

// Lowercase only, like the session ids the daemon makes: tabs compare ids as exact strings, so one session has one ref.
const REF = /^(plan|files|graph|terminal):([0-9a-f-]{36})$/;

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
export const KIND_LABEL: Record<PaneKind, string> = { plan: "Plan", files: "Files", graph: "Git graph", terminal: "Terminal" };
/** Kinds whose identity is the owner's folder (design §1.3): one tab per project folder. */
export const PER_CWD: readonly PaneKind[] = ["files", "graph", "terminal"];
/** What "already open" compares: `<kind>@<cwd>` for per-folder kinds with a known cwd, else the ref. */
export function identityOf(ref: string, cwdOf: (owner: string) => string | undefined): string {
  const r = parseRef(ref);
  const cwd = r && PER_CWD.includes(r.kind) ? cwdOf(r.owner) : undefined;
  return r && cwd !== undefined ? `${r.kind}@${cwd}` : ref;
}
/** The open tab of the same identity as `refOf({kind, owner})`, else that new ref. */
export function paneTabFor(tabs: readonly string[], kind: PaneKind, owner: string, cwdOf: (owner: string) => string | undefined): string {
  const ref = refOf({ kind, owner });
  const id = identityOf(ref, cwdOf);
  return tabs.find((t) => kindOf(t) === kind && identityOf(t, cwdOf) === id) ?? ref;
}
/** Split view (4/8 widens it): no pane kind may be in a split yet. */
export const splittable = (_id: string): boolean => false;
/** "Plan · <title>", "Files · <project>". */
export const paneTabTitle = (kind: PaneKind, ownerTitle: string): string => `${KIND_LABEL[kind]} · ${ownerTitle}`;
