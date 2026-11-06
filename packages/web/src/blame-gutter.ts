// Annotate (GH-564): the CodeMirror gutter of a blame. Markers follow edits (no re-blame while typing); the host re-blames on save.
import { Compartment, RangeSet, StateEffect, StateField } from "@codemirror/state";
import { gutter, GutterMarker } from "@codemirror/view";
import type { BlameEntry } from "./blame.ts";

class Mark extends GutterMarker {
  constructor(
    readonly e: BlameEntry,
    readonly open: (hash: string) => void,
  ) {
    super();
  }
  eq(o: Mark) {
    return o.e === this.e;
  }
  toDOM() {
    const { e, open } = this;
    const el = document.createElement("span");
    el.textContent = e.label;
    el.title = e.title;
    // Only the first line of a run is a control (one tab stop per commit run).
    if (!e.label) return el;
    el.className = e.hash ? "cm-blame-mark" : "cm-blame-mark cm-blame-none";
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", e.aria);
    if (!e.hash) return (el.setAttribute("aria-disabled", "true"), el);
    const go = () => open(e.hash!);
    el.addEventListener("click", go);
    el.addEventListener("keydown", (ev) => (ev.key === "Enter" || ev.key === " ") && (ev.preventDefault(), go()));
    return el;
  }
}

const setBlame = StateEffect.define<RangeSet<GutterMarker>>();
const blameField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update: (v, tr) => {
    for (const f of tr.effects) if (f.is(setBlame)) return f.value;
    return tr.docChanged ? v.map(tr.changes) : v;
  },
});
const gutterExt = gutter({ class: "cm-blame", markers: (v) => v.state.field(blameField) });
/** Module-level: a parked editor state holds its compartments. */
export const blameC = new Compartment();
/** In the editor's base extensions. */
export const blameBase = [blameField, blameC.of([])];
/** The effects that show `entries` (null: hide the gutter and drop the markers). `open` gets the commit hash of a clicked or activated marker. */
export function blameEffects(doc: { lines: number; line(n: number): { from: number } }, entries: BlameEntry[] | null, open: (hash: string) => void) {
  const set = entries ? RangeSet.of(entries.slice(0, doc.lines).map((e, i) => new Mark(e, open).range(doc.line(i + 1).from)), true) : RangeSet.empty;
  return [blameC.reconfigure(entries ? gutterExt : []), setBlame.of(set)];
}
