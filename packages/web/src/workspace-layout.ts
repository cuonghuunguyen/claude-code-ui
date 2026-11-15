// Workspace layout (CONTEXT.md): the tabs of this browser window with their order, pins, split, Docked sessions, closed-tab stack and active tab, and the rules between them.
// Plain TypeScript, no React, no DOM: `step` is a pure function (state + intent -> state + effects), `createWorkspaceLayout` holds the current state and persists it.
// App dispatches intents and performs the effects; the URL hash and the React state are adapters on top.
import { type ClosedTab, loadClosed, popClosed, pushClosed, restoreClosed, restoreMany, saveClosed } from "./closed-tabs.ts";
import { type Docked, dock, dockedIn, loadDocked, neighbourAfterDock, saveDocked, stripTabs, subscribeDocked, undock } from "./docked-sessions.ts";
import type { DockArea } from "./layout.ts";
import { isPaneRef, ownerOf } from "./pane-ref.ts";
import { type Split, type SplitDir, followSplit, isSession, loadSplit, nextAfterClose, placeIn, saveSplit, splitTo, switchRuns } from "./split.ts";
import { FOCUS_TAB, NEW_TAB, closeMany, closeTab, insertPaneTab, loadPinned, loadTabs, moveGroup, moveGroupTo, moveTabIn, openTab, replaceTab, runFromHash, runHash, savePinned, saveTabs, setPinned, tabFromHash, tabHash } from "./tabs.ts";

export type WorkspaceState = {
  /** Stored tab order (`claude-ui.tabs`); docked ids included. */
  tabs: string[];
  pinned: string[];
  /** Active tab: a session id, a pane ref, NEW_TAB, FOCUS_TAB or none. */
  active: string | undefined;
  /** Subagent view of the active tab. */
  run: string | undefined;
  /** Already followed (`followSplit` applied after every step). */
  split: Split | undefined;
  docked: Docked;
  /** The docked session each dock area has selected (not stored). */
  dockSel: Partial<Record<DockArea, string>>;
  /** The subagent run a docked session shows. */
  dockRun: Record<string, string | undefined>;
  /** React key of a session tab: a /clear moves it to the session the tab follows to, so its prompt box stays mounted. */
  tabKeys: Record<string, string>;
  /** A session a tab followed to after /clear, until its subscribe reply: the session it replaced. */
  heirOf: Record<string, string>;
  closed: ClosedTab[];
  /** lg (>= 1024px): docks and the strip filter apply. */
  wide: boolean;
};

export type WorkspaceIntent =
  | { type: "open"; id: string | undefined; fromUrl?: boolean }
  | { type: "url"; tab: string | undefined; run: string | undefined }
  | { type: "openPane"; ref: string }
  | { type: "created"; id: string }
  | { type: "heir"; from: string; to: string }
  | { type: "heirReplied"; id: string }
  | { type: "close"; id: string }
  | { type: "closeMany"; ids: string[] }
  | { type: "restore"; id: string; show: boolean }
  | { type: "undoClose"; parts: { entries: ClosedTab[]; wasActive?: string }[] }
  | { type: "reopen" }
  | { type: "pin"; id: string; on: boolean }
  | { type: "move"; from: string; to: string }
  | { type: "moveGroup"; key: string; by: -1 | 1 }
  | { type: "moveGroupTo"; from: string; to: string }
  | { type: "reorder"; tabs: string[] }
  | { type: "split"; id: string; dir: SplitDir; before?: boolean }
  | { type: "placeInSplit"; id: string; at: number }
  | { type: "focusSplit"; id: string; fromUrl?: boolean }
  | { type: "joinSplits" }
  | { type: "resizeSplit"; ratio: number }
  | { type: "showRun"; session: string; run: string | undefined }
  | { type: "dock"; id: string; area: DockArea }
  | { type: "undock"; id: string }
  | { type: "pickDocked"; area: DockArea; id: string | undefined }
  | { type: "undockAll" }
  | { type: "setDocked"; docked: Docked }
  | { type: "forget"; id: string; deleted: boolean }
  | { type: "dropOwners"; owners: string[] }
  | { type: "wide"; on: boolean };

export type WorkspaceEffect =
  /** A tab shows it: hold. `explicit`: an open by the user (App adds the project when the view or list row is missing). */
  | { type: "show"; id: string; explicit?: true }
  /** A pane tab shows from its owner's view. */
  | { type: "ensure"; id: string }
  /** A closed tab of a live session (or one with a pane tab left). */
  | { type: "background"; id: string }
  | { type: "drop"; id: string }
  /** Write the URL hash; `hash` undefined: `location.pathname + location.search`. */
  | { type: "url"; hash: string | undefined; push?: true }
  /** A tab was added by an open (the recommendations check). */
  | { type: "tabOpened" }
  /** A docked session was selected: open its area; side also ends a maximized bottom panel. */
  | { type: "revealDock"; area: DockArea }
  /** The shown session no longer exists (not deleted on purpose): "session no longer exists" error. */
  | { type: "sessionGone" };

/** What the module asks App, read at dispatch time. */
export type WorkspaceHost = {
  /** The measured session area has room for both splits of `split`. */
  splitFits(split: Split): boolean;
  /** Tab group key. */
  groupOf(id: string): string;
  /** A listed owner, and a pane kind whose home is main (or the New session tab). */
  exists(id: string): boolean;
  /** The owner session is listed with a state other than closed/error. */
  live(owner: string): boolean;
  /** Group keys are final: a drag reorder respects groups. */
  grouped(): boolean;
  /** A fresh React key. */
  newKey(): string;
  /** Performs one effect (the store only; `step` never calls it). */
  perform(e: WorkspaceEffect): void;
};

/** Per-intent answers; only the fields of the intent that was dispatched are set. */
export type StepResult = {
  /** `split`, `placeInSplit`: the split changed and its tab is the active one. */
  applied?: boolean;
  /** `closeMany`: the tabs that closed, with their old index, in the order of `ids`. */
  closed?: ClosedTab[];
  /** `undoClose`: the tabs that came back. */
  restored?: string[];
  /** `reopen`: the tab that came back. */
  reopened?: string;
  /** `undockAll`: the docked map before. */
  prevDocked?: Docked;
};

export type Step = { state: WorkspaceState; effects: WorkspaceEffect[]; result: StepResult };

/** What the tabs bar shows: wide without the docked ids, narrow the whole list. */
export const stripOf = (s: Pick<WorkspaceState, "tabs" | "docked" | "wide">) => stripTabs(s.tabs, s.docked, s.wide);
/** The docked ids of `area` in strip order; none on a narrow screen. */
export const dockedHere = (s: Pick<WorkspaceState, "tabs" | "docked" | "wide">, area: DockArea) => (s.wide ? dockedIn(s.tabs, s.docked, area) : []);
/** Would Split right / down of `id` find a partner (`outside`: `id` may be a tab a drop just opened, not in the strip yet)? */
export const canSplit = (s: WorkspaceState, id: string, dir: SplitDir, before?: boolean, outside = false) => {
  const strip = stripOf(s);
  return !!splitTo(s.split, outside && !strip.includes(id) ? [...strip, id] : strip, s.active, id, dir, before);
};
/** Showing `id` in split `at` of the shown split would leave it without a session. */
export const placeRefused = (split: Split, id: string, at: number) => !placeIn(split, id, at).ids.some(isSession);
/** The tab Reopen closed tab would bring back. */
export const reopenable = (s: Pick<WorkspaceState, "closed" | "tabs">, exists: (id: string) => boolean) => popClosed(s.closed, exists, s.tabs).tab;

const sameList = <T>(a: readonly T[], b: readonly T[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));
const sameDocked = (a: Docked, b: Docked) => {
  const k = Object.keys(a);
  return a === b || (k.length === Object.keys(b).length && k.every((x) => a[x] === b[x]));
};
/** `r` without the entry of `id`; the same object when it has none. */
const without = <T>(r: Record<string, T>, id: string) => (id in r ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== id)) : r);

/** One step in progress: a copy of the state the rules write to, and the effects they emit in today's call order. */
type Draft = { s: WorkspaceState; fx: WorkspaceEffect[]; result: StepResult; host: WorkspaceHost; tabs0: string[] };

const setTabs = (d: Draft, tabs: string[]) => {
  if (!sameList(d.s.tabs, tabs)) d.s.tabs = tabs;
};
const splitOn = (d: Draft) => d.s.wide && !!d.s.split && d.s.split.ids.includes(d.s.active!) && d.host.splitFits(d.s.split);

/** Shows docked session `id` in its dock. */
function selectDocked(d: Draft, id: string) {
  const a = d.s.docked[id];
  if (!a) return;
  if (d.s.dockSel[a] !== id) d.s.dockSel = { ...d.s.dockSel, [a]: id };
  d.fx.push({ type: "revealDock", area: a });
}

/** Makes `t` the active tab of split `s`: the subagent view of each tab goes with it, the hash follows. */
function enter(d: Draft, s: Split, t: string, fromUrl: boolean) {
  const cur = d.s.active;
  const sw = cur === t ? { runs: s.runs, run: d.s.run } : switchRuns(s.runs, cur, d.s.run, t);
  d.s.split = { ...s, runs: sw.runs };
  d.s.active = t;
  d.s.run = sw.run;
  if (!fromUrl) d.fx.push({ type: "url", hash: sw.run ? runHash(t, sw.run) : tabHash(t) });
}

function focusSplit(d: Draft, id: string, fromUrl: boolean) {
  const s = d.s.split;
  if (!s || !s.ids.includes(id) || id === d.s.active) return;
  enter(d, s, id, fromUrl);
}

/** Opens or focuses a tab; `undefined` shows no tab. `tabs0`: the tabs before the step, which decide whether the tab is new. */
function open(d: Draft, id: string | undefined, fromUrl = false) {
  if (id && d.s.wide && d.s.docked[id]) return selectDocked(d, id);
  const sp = d.s.split;
  if (id && sp && splitOn(d) && id !== d.s.active && sp.ids.includes(id)) return focusSplit(d, id, fromUrl);
  d.s.active = id;
  if (!fromUrl) d.s.run = undefined;
  if (!id) return;
  if (id === FOCUS_TAB) {
    if (!fromUrl) d.fx.push({ type: "url", hash: tabHash(id) });
    return;
  }
  const fresh = !d.tabs0.includes(id);
  setTabs(d, openTab(d.s.tabs, id));
  if (fresh) d.fx.push({ type: "tabOpened" });
  if (!fromUrl) d.fx.push({ type: "url", hash: tabHash(id) });
  if (isPaneRef(id)) return void d.fx.push({ type: "ensure", id: ownerOf(id) });
  if (id !== NEW_TAB) d.fx.push({ type: "show", id, explicit: true });
}

/** The tab that took over after a close; none: the hash goes. A docked session stays but no strip tab: the New session tab shows, so the docks (which hang off a shown tab) stay on screen. */
function activate(d: Draft, next: string | undefined) {
  if (!next && d.s.wide && d.tabs0.some((t) => d.s.docked[t])) next = NEW_TAB;
  if (next === d.s.active) return;
  open(d, next);
  if (!next) d.fx.push({ type: "url", hash: undefined });
}

/** What closing a session tab leaves behind: its place on the closed stack, and its subscription (live: followed in the background; else dropped). */
function release(d: Draft, id: string, left: string[]) {
  if (id === NEW_TAB) return;
  d.s.closed = pushClosed(d.s.closed, id, d.tabs0.indexOf(id));
  const o = ownerOf(id);
  const live = d.host.live(o);
  if (isPaneRef(id)) {
    // A live owner stays followed by the list; a tab of the owner (or another pane tab) keeps its view.
    if (!live && !left.some((t) => ownerOf(t) === o)) d.fx.push({ type: "drop", id: o });
    return;
  }
  // A pane tab of this session stays: its view keeps following in the background.
  d.fx.push(live || left.some((t) => isPaneRef(t) && ownerOf(t) === id) ? { type: "background", id } : { type: "drop", id });
}

/** A group move computed on the visible strip, written back into the strip's slots: docked ids keep their positions and never join a group. */
function onStrip(d: Draft, f: (strip: string[]) => string[]) {
  const { tabs, docked, wide } = d.s;
  const m = f(stripTabs(tabs, docked, wide));
  let i = 0;
  setTabs(d, tabs.map((x) => (wide && docked[x] ? x : m[i++]!)));
}

function apply(d: Draft, i: WorkspaceIntent) {
  const { s, host } = d;
  switch (i.type) {
    case "open":
      return open(d, i.id, i.fromUrl);
    case "url":
      if (i.tab) open(d, i.tab, true);
      s.run = i.run;
      return;
    case "openPane":
      setTabs(d, insertPaneTab(s.tabs, i.ref, host.groupOf));
      return open(d, i.ref);
    case "created":
      setTabs(d, replaceTab(s.tabs, NEW_TAB, i.id));
      return open(d, i.id);
    case "heir": {
      const { from, to } = i;
      if (s.tabs.includes(from)) {
        s.tabKeys = { ...s.tabKeys, [to]: s.tabKeys[from] ?? from, [from]: host.newKey() };
        s.heirOf = { ...s.heirOf, [to]: from };
      }
      // A pinned tab stays pinned on the session it goes on in.
      if (s.pinned.includes(from) && !s.pinned.includes(to)) s.pinned = s.pinned.map((x) => (x === from ? to : x));
      if (s.tabs.includes(from)) setTabs(d, replaceTab(s.tabs, from, to));
      // A docked session goes on docked.
      const area = s.docked[from];
      if (area) {
        s.docked = dock(undock(s.docked, from), to, area);
        s.dockSel = Object.fromEntries(Object.entries(s.dockSel).map(([a, v]) => [a, v === from ? to : v]));
        if (from in s.dockRun) s.dockRun = Object.fromEntries(Object.entries(s.dockRun).map(([k, v]) => [k === from ? to : k, v]));
      }
      if (d.s.active !== from) return;
      return open(d, to);
    }
    case "heirReplied":
      s.heirOf = without(s.heirOf, i.id);
      return;
    case "close": {
      const strip = stripOf(s);
      const r = closeTab(strip, i.id, s.active);
      // Closing the active split's tab: the next tab is one outside the splits, else the other split's tab (the split ends).
      const next = s.split && splitOn(d) && i.id === s.active ? nextAfterClose(strip, i.id, s.split) : r.active;
      const left = s.tabs.filter((t) => t !== i.id);
      setTabs(d, left);
      release(d, i.id, left);
      return activate(d, next);
    }
    case "closeMany": {
      const ids = i.ids;
      d.result.closed = ids.filter((id) => d.tabs0.includes(id)).map((id) => ({ id, at: d.tabs0.indexOf(id) }));
      const r = closeMany(stripOf(s), ids, s.active);
      const left = s.tabs.filter((t) => !ids.includes(t));
      setTabs(d, left);
      for (const id of d.tabs0.filter((t) => ids.includes(t))) release(d, id, left);
      return activate(d, r.active);
    }
    case "restore": {
      if (!host.exists(i.id)) return;
      const r = restoreClosed(s.closed, s.tabs, i.id);
      s.closed = r.stack;
      setTabs(d, r.tabs);
      // Back in place; it becomes the shown tab only if it was the one shown when it closed.
      if (i.show) return open(d, i.id);
      if (!isPaneRef(i.id)) d.fx.push({ type: "show", id: i.id });
      return;
    }
    case "undoClose": {
      let stack = s.closed;
      let tabs = s.tabs;
      const restored: string[] = [];
      let shown: string | undefined;
      // Latest set first, each on the list the previous step produced.
      for (const p of [...i.parts].reverse()) {
        const r = restoreMany(stack, tabs, p.entries, host.exists);
        stack = r.stack;
        tabs = r.tabs;
        restored.push(...r.restored);
        if (p.wasActive && r.restored.includes(p.wasActive)) shown = p.wasActive;
      }
      s.closed = stack;
      setTabs(d, tabs);
      d.result.restored = restored;
      for (const id of restored) if (id !== NEW_TAB && !isPaneRef(id) && id !== shown) d.fx.push({ type: "show", id });
      if (shown) open(d, shown);
      return;
    }
    case "reopen": {
      const r = popClosed(s.closed, host.exists, s.tabs);
      s.closed = r.rest;
      if (!r.tab) return;
      const { id, at } = r.tab;
      if (!s.tabs.includes(id)) setTabs(d, [...s.tabs.slice(0, at), id, ...s.tabs.slice(at)]);
      d.result.reopened = id;
      return open(d, id);
    }
    case "pin": {
      if (i.id === NEW_TAB || i.id === FOCUS_TAB || !s.tabs.includes(i.id)) return;
      const r = setPinned(s.tabs, s.pinned, i.id, i.on, host.groupOf);
      setTabs(d, r.tabs);
      s.pinned = r.pinned;
      return;
    }
    case "move":
      return setTabs(d, moveTabIn(s.tabs, host.grouped() ? host.groupOf : () => "", i.from, i.to, new Set(s.pinned)));
    case "moveGroup":
      return onStrip(d, (strip) => moveGroup(strip, host.groupOf, i.key, i.by));
    case "moveGroupTo":
      return onStrip(d, (strip) => moveGroupTo(strip, host.groupOf, i.from, i.to));
    case "reorder": {
      // Only a reordering of the tabs there are: a list from an earlier render may differ.
      if (i.tabs.length === s.tabs.length && [...i.tabs].sort().join("\n") === [...s.tabs].sort().join("\n")) setTabs(d, i.tabs);
      return;
    }
    case "split": {
      // A tab that a drop just opened (a moved pane, an undocked session) may be outside the strip.
      const strip = stripOf(s);
      const r = splitTo(s.split, strip.includes(i.id) ? strip : [...strip, i.id], s.active, i.id, i.dir, i.before);
      if (!r) return;
      enter(d, r.split, i.id, false);
      d.result.applied = true;
      return;
    }
    case "placeInSplit": {
      if (!s.split) return open(d, i.id);
      enter(d, placeIn(s.split, i.id, i.at), i.id, false);
      d.result.applied = true;
      return;
    }
    case "focusSplit":
      return focusSplit(d, i.id, !!i.fromUrl);
    case "joinSplits":
      s.split = undefined;
      return;
    case "resizeSplit":
      if (s.split) s.split = { ...s.split, ratio: i.ratio };
      return;
    case "showRun":
      if (s.wide && s.docked[i.session]) s.dockRun = { ...s.dockRun, [i.session]: i.run };
      else {
        d.fx.push({ type: "url", hash: runHash(i.session, i.run), push: true });
        s.run = i.run;
      }
      return;
    case "dock": {
      if (!s.wide || !s.tabs.includes(i.id)) return;
      const inSplit = !!s.split?.ids.includes(i.id);
      const here = i.id === s.active || inSplit;
      const next = here ? neighbourAfterDock(s.tabs, s.docked, i.id) : undefined;
      if (inSplit) s.split = undefined;
      s.docked = dock(s.docked, i.id, i.area);
      selectDocked(d, i.id);
      if (here) activate(d, next);
      return;
    }
    case "undock":
      s.dockRun = without(s.dockRun, i.id);
      s.docked = undock(s.docked, i.id);
      return open(d, i.id);
    case "pickDocked":
      if (s.dockSel[i.area] !== i.id) s.dockSel = { ...s.dockSel, [i.area]: i.id };
      return;
    case "undockAll":
      d.result.prevDocked = s.docked;
      if (Object.keys(s.docked).length) s.docked = {};
      if (Object.keys(s.dockSel).length) s.dockSel = {};
      return;
    case "setDocked":
      if (!sameDocked(s.docked, i.docked)) s.docked = i.docked;
      return;
    case "forget": {
      const id = i.id;
      // Its pane tabs go with it (its file tabs go back to Files through App's effect on the tabs).
      const strip0 = stripOf(s);
      setTabs(d, s.tabs.filter((t) => ownerOf(t) !== id));
      s.heirOf = without(s.heirOf, id);
      s.tabKeys = without(s.tabKeys, id);
      const h = s.active;
      if (h && ownerOf(h) === id) {
        // Deleted like a closed tab: its neighbour becomes active.
        const next = i.deleted ? closeMany(strip0, strip0.filter((t) => ownerOf(t) === id), h).active : undefined;
        if (next) return open(d, next);
        s.active = undefined;
        d.fx.push({ type: "url", hash: undefined });
        if (!i.deleted) d.fx.push({ type: "sessionGone" });
      }
      return;
    }
    case "dropOwners": {
      const gone = new Set(i.owners);
      if (!gone.size) return;
      setTabs(d, s.tabs.filter((t) => !gone.has(ownerOf(t))));
      if (gone.has(ownerOf(s.active ?? ""))) {
        open(d, undefined);
        d.fx.push({ type: "url", hash: undefined });
      }
      return;
    }
    case "wide":
      s.wide = i.on;
      return;
  }
}

/** The invariants every step ends with. */
function normalize(d: Draft, prev: WorkspaceState) {
  const s = d.s;
  // 1. A pin ends with its tab.
  if (s.pinned.some((id) => !s.tabs.includes(id))) s.pinned = s.pinned.filter((id) => s.tabs.includes(id));
  // 2. A docked entry whose tab this step removed is forgotten (the map is shared: another window's entries are kept).
  const gone = prev.tabs.filter((t) => !s.tabs.includes(t));
  if (gone.length) s.docked = gone.reduce(undock, s.docked);
  // 3. A docked session is never the active tab: one that is (a link to it on page load, a narrow window widened) shows in its dock and the main area takes its strip neighbour.
  const a = s.active;
  if (s.wide && a && s.docked[a] && s.tabs.includes(a)) {
    selectDocked(d, a);
    activate(d, stripOf(s)[0]);
  }
  // 4. The split follows the active tab and the open tabs.
  s.split = followSplit(s.split, s.active, stripOf(s));
}

/** All the rules: the next state, the effects to perform in order, and the answers of the intent. Never calls the host's `perform`. */
export function step(state: WorkspaceState, intent: WorkspaceIntent, host: WorkspaceHost): Step {
  const d: Draft = { s: { ...state }, fx: [], result: {}, host, tabs0: state.tabs };
  apply(d, intent);
  normalize(d, state);
  const next = (Object.keys(state) as (keyof WorkspaceState)[]).every((k) => d.s[k] === state[k]) ? state : d.s;
  return { state: next, effects: d.fx, result: d.result };
}

/** Persists the slices a step changed. */
export type Persist = (prev: WorkspaceState, next: WorkspaceState) => void;
export const persistToStorage: Persist = (prev, next) => {
  if (prev.tabs !== next.tabs) saveTabs(next.tabs);
  if (prev.pinned !== next.pinned) savePinned(next.pinned);
  if (prev.split !== next.split) saveSplit(next.split);
  if (prev.docked !== next.docked) saveDocked(next.docked);
  if (prev.closed !== next.closed) saveClosed(next.closed);
};

/** Initial state: the stored slices and the URL hash (`#<session>/agent/<run>`). */
export function loadWorkspace(hash: string, wide: boolean): WorkspaceState {
  const active = tabFromHash(hash);
  const stored = loadTabs();
  const tabs = active && active !== FOCUS_TAB ? openTab(stored, active) : stored;
  const pinned = loadPinned();
  const docked = loadDocked();
  const s: WorkspaceState = { tabs, pinned: pinned.some((id) => !tabs.includes(id)) ? pinned.filter((id) => tabs.includes(id)) : pinned, active, run: runFromHash(hash) || undefined, split: loadSplit(), docked, dockSel: {}, dockRun: {}, tabKeys: {}, heirOf: {}, closed: loadClosed(), wide };
  return { ...s, split: followSplit(s.split, active, stripOf(s)) };
}

export type WorkspaceLayout = ReturnType<typeof createWorkspaceLayout>;

/** The store App holds: the current state (always fresh, also in a closure of an earlier render), `dispatch`, persistence, change listeners. */
export function createWorkspaceLayout(host: WorkspaceHost, initial: WorkspaceState, persist: Persist = persistToStorage) {
  let state = initial;
  const listeners = new Set<() => void>();
  // The first page load writes what it loaded (the tab of the URL hash joins the stored list); the docked map is only written by a change.
  persist({ ...initial, tabs: [], pinned: [], split: undefined, closed: [] }, initial);
  /** Runs the intent; the state is committed and listeners are told before the effects are performed, so an effect reads the new state. */
  function dispatch(intent: WorkspaceIntent): StepResult {
    const prev = state;
    const r = step(prev, intent, host);
    if (r.state !== prev) {
      state = r.state;
      persist(prev, state);
      listeners.forEach((l) => l());
    }
    for (const e of r.effects) host.perform(e);
    return r.result;
  }
  return {
    get: () => state,
    dispatch,
    onChange(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    /** Follows the docked map of other windows (and this one's own writes, which change nothing). Returns the unsubscribe. */
    watchDocked() {
      const sync = () => void dispatch({ type: "setDocked", docked: loadDocked() });
      sync();
      return subscribeDocked(sync);
    },
  };
}
