// GH-707: the payload of a file tree drag onto a prompt box (docs/spec.md "Files tab").
export const ENTRIES_DRAG_TYPE = "application/x-claude-ui-entries";
export type DragEntry = { path: string; isDir: boolean };

/** Dragover can read `types` only, never the data. */
export const isEntriesDrag = (dt: Pick<DataTransfer, "types">) => Array.from(dt.types ?? []).includes(ENTRIES_DRAG_TYPE);

/** The dragged entries; undefined for missing, malformed or empty data. */
export function readEntriesDrag(dt: Pick<DataTransfer, "getData">): DragEntry[] | undefined {
  try {
    const d: unknown = JSON.parse(dt.getData(ENTRIES_DRAG_TYPE));
    if (!Array.isArray(d) || !d.length) return undefined;
    if (!d.every((x) => x && typeof x.path === "string" && typeof x.isDir === "boolean")) return undefined;
    return d.map((x) => ({ path: x.path, isDir: x.isDir }));
  } catch {
    return undefined;
  }
}

/** What a drag of `row` carries (VS Code): a selection of 2+ that holds the row, in tree order; else the row alone. */
export function dragEntries(row: string, selection: ReadonlySet<string>, visible: DragEntry[]): DragEntry[] {
  const own = visible.find((e) => e.path === row);
  if (!selection.has(row) || selection.size < 2) return own ? [own] : [{ path: row, isDir: false }];
  return visible.filter((e) => selection.has(e.path));
}
