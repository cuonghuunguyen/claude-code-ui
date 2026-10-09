// Guided tour state (docs/spec.md "First-use guide"): the first-use decision, the per-browser state and the pure rules the tour follows.
// Per browser (localStorage), like tab grouping and keybindings; nothing reaches the daemon.

export type ChapterState = "pending" | "done" | "skipped" | "offered";
export type ChapterId = "basics" | "session";
export type GuideState = {
  v: 1;
  /** "new": first use, the tour starts by itself. "existing": offered in Settings > Guide and the palette only. */
  origin: "new" | "existing";
  basics: ChapterState;
  session: ChapterState;
  /** Step id of an interrupted chapter: a reload resumes there. */
  step?: string;
};

/** Actions a step may offer as a button. */
export type GuideActions = { openProject: () => void; openShortcuts: () => void };
/** What the tour needs from the app. `keyOf` is the only way it gets key text. */
export type GuideHost = GuideActions & {
  /** Key spec ("mod+k") of a command id, undefined when it has none. */
  keyOf: (commandId: string) => string | undefined;
  openSettings: () => void;
  closeDrawer?: () => void;
};

export const GUIDE_KEY = "claude-ui.guide";
/** The only keys that do not make a browser non-fresh (written on every page load or by pairing). */
const FRESH_IGNORED = new Set(["claude-ui.token", "claude-ui.theme"]);

let freshBrowser = false;

/** Call first thing in main.tsx, before anything writes a `claude-ui.*` key. Storage that throws: not fresh. */
export function takeFirstUseSnapshot(storage: Pick<Storage, "length" | "key"> = localStorage): boolean {
  try {
    freshBrowser = true;
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith("claude-ui.") && !FRESH_IGNORED.has(k)) freshBrowser = false;
    }
  } catch {
    freshBrowser = false;
  }
  return freshBrowser;
}

export const wasFreshBrowser = () => freshBrowser;
/** Tests only: set the snapshot. */
export const setFreshBrowser = (v: boolean) => void (freshBrowser = v);

const EXISTING: GuideState = { v: 1, origin: "existing", basics: "offered", session: "offered" };
const NEW: GuideState = { v: 1, origin: "new", basics: "pending", session: "pending" };
const CHAPTER = (v: unknown): v is ChapterState => v === "pending" || v === "done" || v === "skipped" || v === "offered";

/** Absent value: undefined. A corrupt one is absent only in a fresh browser, else "existing" (no surprise tour after a bad write). */
export function parseGuide(raw: string | null, fresh: boolean): GuideState | undefined {
  if (raw === null) return undefined;
  try {
    const o = JSON.parse(raw) as Partial<GuideState> | null;
    if (o && o.v === 1 && (o.origin === "new" || o.origin === "existing") && CHAPTER(o.basics) && CHAPTER(o.session) && (o.step === undefined || typeof o.step === "string"))
      return { v: 1, origin: o.origin, basics: o.basics, session: o.session, ...(o.step && { step: o.step }) };
  } catch {
    // Falls through: corrupt.
  }
  return fresh ? undefined : { ...EXISTING };
}

export function loadGuide(fresh = freshBrowser, storage: Pick<Storage, "getItem"> = localStorage): GuideState | undefined {
  try {
    return parseGuide(storage.getItem(GUIDE_KEY), fresh);
  } catch {
    return undefined;
  }
}

export function saveGuide(state: GuideState, storage: Pick<Storage, "setItem"> = localStorage) {
  try {
    storage.setItem(GUIDE_KEY, JSON.stringify(state));
  } catch {
    // Storage blocked: the state lasts for this page (the owner keeps it in memory).
  }
}

/** The state to write once per browser, after the first session list: a fresh browser on a daemon with no projects starts the tour. */
export const decideFirstUse = (fresh: boolean, projectCount: number): GuideState => (fresh && projectCount === 0 ? { ...NEW } : { ...EXISTING });

/** The chapter to start by itself now, if any. `session`: a session tab shows and is idle. */
export function autoChapter(s: GuideState, ctx: { session: boolean }): ChapterId | undefined {
  if (s.basics === "pending") return "basics";
  if (s.session === "pending" && s.basics !== "skipped" && ctx.session) return "session";
  return undefined;
}

/** Next/Done on the last step: a Basics run that carried the session chapter finishes both. */
export function finishRun(s: GuideState, chapters: ChapterId[]): GuideState {
  const { step: _, ...rest } = s;
  return { ...rest, ...(chapters.includes("basics") && { basics: "done" as const }), ...(chapters.includes("session") && { session: "done" as const }) };
}

/** Skip tour, Esc, Close: both chapters, for good. */
export function skipGuide(s: GuideState): GuideState {
  const { step: _, ...rest } = s;
  return { ...rest, basics: "skipped", session: "skipped" };
}

/** "Restart guide" / "Show guide": both chapters pending again, from the first step. */
export function restartGuide(s: GuideState): GuideState {
  const { step: _, ...rest } = s;
  return { ...rest, basics: "pending", session: "pending" };
}

export const withStep = (s: GuideState, step: string): GuideState => ({ ...s, step });

/** Another browser tab of this profile wrote done/skipped for what this one is showing. */
export const settled = (s: GuideState | undefined) => !!s && s.basics !== "pending" && s.session !== "pending";

// ---- anchors and placement ----

/** On screen: laid out (not display:none, not in [hidden]) and touching the viewport (a closed drawer is translated off). */
export function isVisible(el: Element, view = { width: innerWidth, height: innerHeight }): boolean {
  if (el.closest("[hidden]") || !el.getClientRects().length) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < view.width && r.top < view.height;
}

/** The first visible element of the first candidate selector that has one; undefined = show the step centered. */
export function resolveAnchor(candidates: string[], visible: (el: Element) => boolean = isVisible, root: ParentNode = document): HTMLElement | undefined {
  for (const sel of candidates) {
    const el = [...root.querySelectorAll<HTMLElement>(sel)].find((e) => visible(e));
    if (el) return el;
  }
  return undefined;
}

export type Rect = { left: number; top: number; width: number; height: number };
export type Side = "top" | "bottom" | "left" | "right";
export const GUTTER = 16;
const ARROW = 8;

/** Popover position beside `anchor`: the preferred side, flipped when it does not fit, then bottom/top, clamped to a 16px gutter. */
export function placePopover(anchor: Rect, size: { width: number; height: number }, view: { width: number; height: number }, prefer: Side): { left: number; top: number; side: Side } {
  const gap = ARROW + 4;
  const room: Record<Side, number> = {
    left: anchor.left - GUTTER,
    right: view.width - GUTTER - (anchor.left + anchor.width),
    top: anchor.top - GUTTER,
    bottom: view.height - GUTTER - (anchor.top + anchor.height),
  };
  const need = (s: Side) => (s === "left" || s === "right" ? size.width : size.height) + gap;
  const opposite: Record<Side, Side> = { left: "right", right: "left", top: "bottom", bottom: "top" };
  const side = [prefer, opposite[prefer], "bottom", "top"].find((s) => room[s as Side] >= need(s as Side)) as Side | undefined ?? prefer;
  const clamp = (v: number, size_: number, max: number) => Math.max(GUTTER, Math.min(v, max - GUTTER - size_));
  const cx = anchor.left + anchor.width / 2;
  const cy = anchor.top + anchor.height / 2;
  if (side === "left") return { side, left: clamp(anchor.left - gap - size.width, size.width, view.width), top: clamp(cy - size.height / 2, size.height, view.height) };
  if (side === "right") return { side, left: clamp(anchor.left + anchor.width + gap, size.width, view.width), top: clamp(cy - size.height / 2, size.height, view.height) };
  if (side === "top") return { side, left: clamp(cx - size.width / 2, size.width, view.width), top: clamp(anchor.top - gap - size.height, size.height, view.height) };
  return { side, left: clamp(cx - size.width / 2, size.width, view.width), top: clamp(anchor.top + anchor.height + gap, size.height, view.height) };
}
