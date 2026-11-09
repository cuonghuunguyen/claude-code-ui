// Find in files (Ctrl+Shift+F): the pure parts of the panel: search history, flat match list, highlight segments, prefill from a selection.
import { EditorView } from "@codemirror/view";
import { MAX_SEARCH_CHARS, type FsGrepResult } from "@claude-ui/protocol";

export const FIND_HISTORY_KEY = "claude-ui.findHistory";
export const MAX_FIND_HISTORY = 20;
export type FindEntry = { query: string; globs: string };

export function loadFindHistory(): FindEntry[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(FIND_HISTORY_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((e): e is FindEntry => !!e && typeof e.query === "string" && typeof e.globs === "string").slice(-MAX_FIND_HISTORY) : [];
  } catch {
    return [];
  }
}

export function saveFindHistory(h: FindEntry[]) {
  try {
    localStorage.setItem(FIND_HISTORY_KEY, JSON.stringify(h));
  } catch {
    // Storage blocked: the history lasts for this page.
  }
}

/** `e` goes last; a blank query is ignored and an equal pair moves to the end. */
export const pushFindHistory = (h: FindEntry[], e: FindEntry): FindEntry[] =>
  e.query.trim() ? [...h.filter((x) => x.query !== e.query || x.globs !== e.globs), e].slice(-MAX_FIND_HISTORY) : h;

export type MatchRow = { path: string; line: number; key: string };
/** The match lines of a result in display order (context lines are not rows). */
export const matchRows = (r: FsGrepResult | undefined): MatchRow[] => r?.files.flatMap((f) => f.lines.filter((l) => l.ranges).map((l) => ({ path: f.path, line: l.n, key: `${f.path}:${l.n}` }))) ?? [];

/** `text` split at the ranges: `hit` parts are the matches. */
export function lineSegments(text: string, ranges: [number, number][] | undefined): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [a, b] of ranges ?? []) {
    if (a < at || b > text.length) continue;
    if (a > at) out.push({ text: text.slice(at, a), hit: false });
    out.push({ text: text.slice(a, b), hit: true });
    at = b;
  }
  if (at < text.length || !out.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** The single-line selected text of the focused file editor or text field; undefined for none, a blank one, a line break or over MAX_SEARCH_CHARS. */
export function selectionQuery(el: Element | null = document.activeElement): string | undefined {
  let text: string | undefined;
  const cm = el?.closest(".cm-editor");
  if (cm instanceof HTMLElement) {
    const view = EditorView.findFromDOM(cm);
    const { from, to } = view?.state.selection.main ?? { from: 0, to: 0 };
    text = view?.state.sliceDoc(from, to);
  } else if ((el instanceof HTMLInputElement && el.type !== "password") || el instanceof HTMLTextAreaElement) {
    text = el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  }
  return text && text.trim() && !/[\r\n]/.test(text) && text.length <= MAX_SEARCH_CHARS ? text : undefined;
}
