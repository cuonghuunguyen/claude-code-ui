// Pane refs (GH-395/396, docs/spec.md "Titlebar tabs"): strip/tab ids of non-session panes, `plan:<session uuid>`, `files:<session uuid>`, `graph:<session uuid>`, `terminal:<session uuid>` (GH-397). Sessions stay bare uuids.
export type PaneKind = "plan" | "files" | "graph" | "terminal" | "file"; // "file" (GH-399): one file as a tab, `file:<uuid>:<absolute path>`; 6/8: "artifact"
export type PaneRef = { kind: PaneKind; owner: string; /** Kind "file". */ path?: string };

// Lowercase only, like the session ids the daemon makes: tabs compare ids as exact strings, so one session has one ref.
const REF = /^(plan|files|graph|terminal):([0-9a-f-]{36})$/;
// The path may hold colons (`C:\\a`), so it is everything after the owner.
const FILE_REF = /^file:([0-9a-f-]{36}):([\s\S]+)$/;

/** undefined for sessions, the new-session and focus tabs, and junk. */
export function parseRef(id: string | undefined): PaneRef | undefined {
  const m = id === undefined ? null : REF.exec(id);
  if (m) return { kind: m[1] as PaneKind, owner: m[2]! };
  const f = id === undefined ? null : FILE_REF.exec(id);
  return f ? { kind: "file", owner: f[1]!, path: f[2]! } : undefined;
}
export const refOf = (r: PaneRef): string => (r.kind === "file" ? fileRef(r.owner, r.path ?? "") : `${r.kind}:${r.owner}`);
export const fileRef = (owner: string, path: string): string => `file:${owner}:${path}`;
export const pathOf = (id: string): string | undefined => parseRef(id)?.path;
/** An item: a tab of its own that has no kind home in a dock (a file; artifacts join in GH-400). */
export const isItem = (id: string | undefined): boolean => kindOf(id ?? "") === "file";
export const isPaneRef = (id: unknown): id is string => typeof id === "string" && parseRef(id) !== undefined;
/** The owner session of a ref; the id itself for anything else. */
export const ownerOf = (id: string): string => parseRef(id)?.owner ?? id;
export const kindOf = (id: string): PaneKind | undefined => parseRef(id)?.kind;
export const KIND_LABEL: Record<PaneKind, string> = { plan: "Plan", files: "Files", graph: "Git graph", terminal: "Terminal", file: "File" };
/** Kinds whose identity is the owner's folder (design §1.3): one tab per project folder. */
export const PER_CWD: readonly PaneKind[] = ["files", "graph", "terminal"];
/** What "already open" compares: `<kind>@<cwd>` for per-folder kinds with a known cwd, else the ref. */
export function identityOf(ref: string, cwdOf: (owner: string) => string | undefined): string {
  const r = parseRef(ref);
  if (r?.kind === "file") return `file@${r.path}`;
  const cwd = r && PER_CWD.includes(r.kind) ? cwdOf(r.owner) : undefined;
  return r && cwd !== undefined ? `${r.kind}@${cwd}` : ref;
}
/** The open tab of the same identity as `refOf({kind, owner})`, else that new ref. */
export function paneTabFor(tabs: readonly string[], kind: PaneKind, owner: string, cwdOf: (owner: string) => string | undefined, path?: string): string {
  const ref = refOf({ kind, owner, path });
  const id = identityOf(ref, cwdOf);
  return tabs.find((t) => kindOf(t) === kind && identityOf(t, cwdOf) === id) ?? ref;
}
/** Split view (R7): every pane kind but Git graph, which needs the whole area. */
export const splittable = (id: string): boolean => {
  const k = kindOf(id);
  return k !== undefined && k !== "graph";
};
/** "Plan · <title>", "Files · <project>". */
export const paneTabTitle = (kind: PaneKind, ownerTitle: string): string => `${KIND_LABEL[kind]} · ${ownerTitle}`;
