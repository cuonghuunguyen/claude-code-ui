// Optimistic prompts (GH-133): shown at once on send, until the daemon's user_text echo is in the view.
import { shownState, type SessionView } from "./store.ts";
import { NEW_TAB } from "./tabs.ts";

/**
 * `after`: the last part id of the view at send. Only user prompts after it count as echoes, so an older page prepended
 * by transcript paging (GH-137) is not mistaken for the echo. When that id is gone from the order (the view was replaced),
 * the whole order counts: at worst the bubble hides early, it never shows twice.
 * `baseline`: the earlier identical pending prompts (their echoes come first).
 * `sentAt`: the safety net for an echo that never matches by text.
 */
export type Pending = { key: string; text: string; images: string[]; after?: string; baseline: number; sentAt: number; sessionId?: string };

/** An entry whose echo did not match by text is given up on after this long, once the view holds more user prompts than expected. */
export const STALE_MS = 30_000;

let seq = 0;
/** Local key (no crypto.randomUUID: missing on plain http from another machine). */
export const pendingKey = () => `pending-${++seq}`;

/** Top-level user_text parts of the view after `after`; `match` narrows them to the ones with this text and image count. */
function userTexts(view: SessionView | undefined, match?: { text: string; images: string[] }, after?: string): number {
  if (!view) return 0;
  const from = after === undefined ? 0 : view.order.indexOf(after) + 1; // not found: 0, the whole order
  let n = 0;
  for (let i = from; i < view.order.length; i++) {
    const p = view.parts.get(view.order[i]!)!;
    if (p.type === "user_text" && !p.parentId && (!match || (p.text === match.text && p.images.length === match.images.length))) n++;
  }
  return n;
}

/** Top-level user_text parts of the view after `after` with this text and image count. */
export const echoes = (view: SessionView | undefined, text: string, images: string[], after?: string) => userTexts(view, { text, images }, after);

/** Appends a pending prompt; its baseline counts the earlier pending prompts with the same text. */
export function addPending(
  list: Pending[] | undefined,
  view: SessionView | undefined,
  p: { key: string; text: string; images: string[] },
  now = Date.now(),
): Pending[] {
  const earlier = (list ?? []).filter((q) => q.text === p.text && q.images.length === p.images.length).length;
  return [...(list ?? []), { ...p, after: view?.order.at(-1), baseline: earlier, sentAt: now }];
}

/**
 * The turn that followed the prompt is over without an echo: the view is idle and holds a turn_result (or turn_interrupted) after the anchor.
 * Every prompt that reaches the daemon is echoed (`Session.prompt` emits user_text first, slash commands included), so this
 * is a net, e.g. for a `/clear` whose user_text a rewind removed. Not while the anchor is unknown (a replaced view).
 */
const TURN_END = new Set(["turn_result", "turn_interrupted"]);
function ended(view: SessionView | undefined, after: string | undefined): boolean {
  if (!view || (shownState(view) ?? "idle") !== "idle") return false;
  const from = after === undefined ? 0 : view.order.indexOf(after) + 1;
  if (after !== undefined && from === 0) return false;
  // The turn's end, not any output: a terminal CLI turn found by the daemon's sync arrives as output while the view is idle, before the prompt.
  return view.order.slice(from).some((id) => TURN_END.has(view.parts.get(id)!.type));
}

/** The pending prompts whose echo is not in the view yet and whose turn has not ended (render these). */
export function unechoed(list: Pending[] | undefined, view: SessionView | undefined): Pending[] {
  if (!list?.length) return [];
  return list.filter((p) => echoes(view, p.text, p.images, p.after) <= p.baseline && !ended(view, p.after));
}

/**
 * Drops echoed entries of session keys (not NEW_TAB) and empty keys; the same object when nothing changes.
 * Safety net: an entry older than STALE_MS is dropped when the view holds more user prompts than the ones before it plus its own,
 * even though no text matched (the daemon changed the text).
 */
export function pruneEchoed(all: Record<string, Pending[]>, views: Record<string, SessionView | undefined>, now = Date.now()): Record<string, Pending[]> {
  let changed = false;
  const next: Record<string, Pending[]> = {};
  for (const [k, list] of Object.entries(all)) {
    const open = unechoed(list, views[k]);
    const keep = k === NEW_TAB ? list : open.filter((p) => now - p.sentAt <= STALE_MS || userTexts(views[k], undefined, p.after) <= list.indexOf(p));
    if (keep.length !== list.length) changed = true;
    if (keep.length) next[k] = keep;
    else changed = true;
  }
  return changed ? next : all;
}

/** Removes one pending prompt (its request was rejected). */
export function dropPending(all: Record<string, Pending[]>, k: string, key: string): Record<string, Pending[]> {
  if (!all[k]) return all;
  const gone = all[k].find((p) => p.key === key);
  // Later identical prompts counted this one's echo in their baseline: it will not come.
  const list = all[k]
    .filter((p) => p !== gone)
    .map((p) => (gone && all[k]!.indexOf(p) > all[k]!.indexOf(gone) && p.text === gone.text && p.images.length === gone.images.length ? { ...p, baseline: Math.max(0, p.baseline - 1) } : p));
  const { [k]: _, ...rest } = all;
  return list.length ? { ...rest, [k]: list } : rest;
}

/** Moves the NEW_TAB entries to the created session. */
export function movePending(all: Record<string, Pending[]>, to: string): Record<string, Pending[]> {
  const { [NEW_TAB]: list, ...rest } = all;
  return list ? { ...rest, [to]: list } : all;
}

/** One pass, early exit: a prompt of the user is in the view, and neither a turn end nor an error. */
function firstTurnUnderway(v: SessionView): boolean {
  if (v.state === "error" || v.state === "closed") return false;
  let prompted = false;
  for (const id of v.order) {
    const p = v.parts.get(id)!;
    if (TURN_END.has(p.type)) return false;
    if (p.type === "user_text" && !p.parentId) prompted = true;
  }
  return prompted;
}

/**
 * Session ids whose first turn is under way: a pending prompt (also the NEW_TAB one's created session), or a user_text in the view
 * with no turn end yet and no error. Their placeholder title is about to be replaced; once the turn is over or failed it is final.
 */
export function promptedIds(all: Record<string, Pending[]>, views: Record<string, SessionView | undefined>): Set<string> {
  const ids = new Set<string>();
  for (const [k, list] of Object.entries(all)) {
    const id = k === NEW_TAB ? list[0]?.sessionId : k;
    if (id && list.length) ids.add(id);
  }
  for (const [id, v] of Object.entries(views)) if (v && firstTurnUnderway(v)) ids.add(id);
  return ids;
}

const DEFAULT_TITLES = new Set(["New session", "Untitled"]);
/** The title is still a placeholder although a prompt was sent: the SDK title arrives with the transcript. */
export const titleLoading = (title: string, prompted: boolean) => prompted && DEFAULT_TITLES.has(title);
