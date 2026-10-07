// Lane layout of the commit graph (docs/spec.md "Layout"): own code, no graph library.
export const LANE_COLORS = 8;
/** A line waiting for commit `hash`. */
export type Lane = { hash: string; color: number };
/** `next`: the next color index. */
export type GraphState = { lanes: Lane[]; next: number };
/** `input`: lanes entering the row from above; `output`: lanes leaving it below; `edges[k]`: the output index the edge to `parents[k]` ends in. */
export type GraphRow = { col: number; color: number; input: Lane[]; output: Lane[]; parents: string[]; edges: number[] };
export const emptyGraph = (): GraphState => ({ lanes: [], next: 0 });

/** Rows for one page, continuing `state`; returns the state for the next page. Pure: inputs are not mutated. */
export function layoutPage(commits: { hash: string; parents: string[] }[], state: GraphState): { rows: GraphRow[]; state: GraphState } {
  let lanes = state.lanes;
  let next = state.next;
  const rows: GraphRow[] = [];
  for (const c of commits) {
    const input = lanes;
    let col = input.findIndex((l) => l.hash === c.hash);
    let color: number;
    const tip = col < 0;
    if (tip) {
      col = input.length;
      color = next++ % LANE_COLORS;
    } else color = input[col]!.color;
    const output: Lane[] = [];
    const edges: number[] = [];
    // The first parent always gets its own lane (another lane may already wait for it: a fork; both end at that parent's row).
    let first = -1;
    input.forEach((l, i) => {
      // Lanes waiting for this commit end at its node; the first one continues to the first parent.
      if (l.hash !== c.hash) output.push(l);
      else if (i === col && c.parents[0]) first = output.push({ hash: c.parents[0], color }) - 1;
    });
    if (tip && c.parents[0]) first = output.push({ hash: c.parents[0], color }) - 1;
    c.parents.forEach((p, k) => {
      if (k === 0) return void edges.push(first);
      let at = output.findIndex((l) => l.hash === p);
      if (at < 0) at = output.push({ hash: p, color: next++ % LANE_COLORS }) - 1;
      edges.push(at);
    });
    rows.push({ col, color, input, output, parents: c.parents, edges });
    lanes = output;
  }
  return { rows, state: { lanes, next } };
}
