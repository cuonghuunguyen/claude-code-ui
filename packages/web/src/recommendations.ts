// Recommendations (GH-518, docs/spec.md "Recommendations"): rules, gates and per-browser counters. Nothing reaches the daemon.
import { useSyncExternalStore } from "react";
import { DIFF_MODES, type DiffMode } from "./diff-mode.ts";
import { t } from "./i18n.ts";
import type { AutoClose } from "./tab-cleanup.ts";

export type RuleId = "jira" | "compactTabs" | "cleanupTabs" | "autoClose" | "diffMode" | "searchSessions" | "artifactsPane" | "contextBreakdown" | "push" | "keepAwake" | "middleClick" | "phoneSwipe";
type Facts = {
  jira: { ready: boolean };
  compactTabs: { compact: boolean; overflow: boolean; projects: number };
  cleanupTabs: { count: number };
  autoClose: { autoClose: AutoClose; n: number };
  diffMode: { mode: DiffMode; def: DiffMode; streak: number };
  searchSessions: { far: boolean; empty: boolean };
  artifactsPane: { artifacts: number; paneSeen: boolean };
  contextBreakdown: { visible: boolean; percent: number };
  push: { needed: boolean; pushOn: boolean; supported: boolean; secure: boolean; permission: NotificationPermission; local: boolean; desktopOn: boolean };
  keepAwake: { slept: boolean; supported: boolean; on: boolean };
  middleClick: { fine: boolean; n: number };
  phoneSwipe: { phone: boolean; n: number };
};
export type Rule<K extends RuleId> = {
  id: K;
  /** The owner action that evaluates it (doc only; the hook lives there). */
  trigger: string;
  surface: "toast" | "inline";
  /** Button label kind: Turn on (setting), Show me (feature), none (close only). */
  button: "turnOn" | "showMe" | "none";
  /** Ignores "another toast shows" (owner decision: auto-close stacks next to its cleanup's Undo toast). */
  stack?: true;
  when: (f: Facts[K]) => boolean;
  text: (f: Facts[K]) => string;
};

export const RULES: { [K in RuleId]: Rule<K> } = {
  jira: { id: "jira", trigger: "create-worktree-dialog: settings loaded", surface: "inline", button: "none", when: (f) => !f.ready, text: () => t("rec.jira") },
  compactTabs: { id: "compactTabs", trigger: "App: a tab opens", surface: "toast", button: "turnOn", when: (f) => !f.compact && f.overflow && f.projects >= 3, text: () => t("rec.compactTabs") },
  cleanupTabs: { id: "cleanupTabs", trigger: "App: a tab opens", surface: "toast", button: "showMe", when: (f) => f.count >= 15, text: (f) => t("rec.cleanupTabs", { count: f.count }) },
  autoClose: { id: "autoClose", trigger: "App: a cleanup closed tabs", surface: "toast", button: "turnOn", stack: true, when: (f) => f.autoClose === "off" && f.n >= 2, text: () => t("rec.autoClose") },
  diffMode: { id: "diffMode", trigger: "changes-panel: diff mode picked", surface: "toast", button: "turnOn", when: (f) => f.mode !== f.def && f.streak >= 3, text: (f) => t("rec.diffMode", { mode: DIFF_MODES.find((m) => m.value === f.mode)?.label ?? f.mode }) },
  searchSessions: { id: "searchSessions", trigger: "sidebar: the session list stopped scrolling", surface: "toast", button: "showMe", when: (f) => f.far && f.empty, text: () => t("rec.searchSessions") },
  artifactsPane: { id: "artifactsPane", trigger: "App: an artifact tab opened", surface: "toast", button: "showMe", when: (f) => f.artifacts >= 3 && !f.paneSeen, text: () => t("rec.artifactsPane") },
  contextBreakdown: { id: "contextBreakdown", trigger: "App: a turn ended", surface: "toast", button: "showMe", when: (f) => f.visible && f.percent > 50, text: () => t("rec.contextBreakdown") },
  push: { id: "push", trigger: "App: the page became visible", surface: "toast", button: "turnOn", when: (f) => f.needed && !f.pushOn && f.supported && f.secure && f.permission !== "denied" && !(f.local && f.desktopOn), text: () => t("rec.push") },
  keepAwake: { id: "keepAwake", trigger: "App: the page became visible or reconnected", surface: "toast", button: "turnOn", when: (f) => f.slept && f.supported && !f.on, text: () => t("rec.keepAwake") },
  middleClick: { id: "middleClick", trigger: "files: Open in tab", surface: "toast", button: "none", when: (f) => f.fine && f.n >= 2, text: () => t("rec.middleClick") },
  phoneSwipe: { id: "phoneSwipe", trigger: "tabs-bar: a neighbour tab picked", surface: "toast", button: "none", when: (f) => f.phone && f.n >= 3, text: () => t("rec.phoneSwipe") },
};

export const KEY = "claude-ui.recommendations";
export const PER_DAY = 5;
export const GAP_MS = 30 * 60_000;
export type RecState = { v: 1; off?: true; shown: RuleId[]; day?: string; dayCount: number; lastAt?: number; counts: Record<string, number>; streak?: { mode: string; n: number } };
const fresh = (): RecState => ({ v: 1, shown: [], dayCount: 0, counts: {} });
const MAX_COUNT = 99;

export function parseRec(raw: string | null): RecState {
  if (!raw) return fresh();
  try {
    const o = JSON.parse(raw) as Partial<RecState> | null;
    if (!o || typeof o !== "object" || o.v !== 1) return fresh();
    const counts: Record<string, number> = {};
    if (o.counts && typeof o.counts === "object") for (const [k, n] of Object.entries(o.counts)) if (Number.isInteger(n) && n >= 1 && n <= MAX_COUNT) counts[k] = n;
    const s: RecState = { v: 1, shown: Array.isArray(o.shown) ? [...new Set(o.shown.filter((x): x is RuleId => typeof x === "string" && Object.hasOwn(RULES, x)))] : [], dayCount: Number.isInteger(o.dayCount) && o.dayCount! >= 0 ? o.dayCount! : 0, counts };
    if (o.off === true) s.off = true;
    if (typeof o.day === "string") s.day = o.day;
    if (typeof o.lastAt === "number" && Number.isFinite(o.lastAt)) s.lastAt = o.lastAt;
    if (o.streak && typeof o.streak.mode === "string" && Number.isInteger(o.streak.n)) s.streak = { mode: o.streak.mode, n: o.streak.n };
    return s;
  } catch {
    return fresh();
  }
}

export const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export type Block = "off" | "shown" | "blocked" | "toast" | "page" | "day" | "gap";
/** Why a rule may not show now; undefined = it may. */
export function gate(s: RecState, id: RuleId, now: number, c: { pageShown: boolean; blocked: boolean; toast: boolean; skipToast: boolean }): Block | undefined {
  if (s.off) return "off";
  if (s.shown.includes(id)) return "shown";
  if (c.blocked) return "blocked";
  if (c.toast && !c.skipToast) return "toast";
  if (c.pageShown) return "page";
  if (s.day === localDay(now) && s.dayCount >= PER_DAY) return "day";
  if (s.lastAt !== undefined && now - s.lastAt < GAP_MS) return "gap";
  return undefined;
}
export function markShown(s: RecState, id: RuleId, now: number): RecState {
  const day = localDay(now);
  return { ...s, shown: [...s.shown, id], day, dayCount: s.day === day ? s.dayCount + 1 : 1, lastAt: now };
}
export const bump = (s: RecState, key: string): RecState => ({ ...s, counts: { ...s.counts, [key]: Math.min((s.counts[key] ?? 0) + 1, MAX_COUNT) } });
export const nextStreak = (s: RecState, mode: string): RecState => ({ ...s, streak: { mode, n: s.streak?.mode === mode ? s.streak.n + 1 : 1 } });

/** Sum of scroll distance within the last 10 s is at least 3 viewport heights. */
export function scrolledFar(samples: { t: number; top: number }[], now: number, height: number): boolean {
  if (height <= 0) return false;
  const s = samples.filter((x) => now - x.t <= 10_000);
  let sum = 0;
  for (let i = 1; i < s.length; i++) sum += Math.abs(s[i]!.top - s[i - 1]!.top);
  return sum >= 3 * height;
}

/** The focused element is the prompt box with text typed: never interrupt it. */
export function promptBusy(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLTextAreaElement && !!a.closest('[data-testid="prompt-box"]') && a.value.trim() !== "";
}

// Storage copies key-tips.ts: a failed write keeps the state in memory for this page.
let memory: RecState = fresh();
let memoryWins = false;
const listeners = new Set<() => void>();
let parsed: { raw: string | null; state: RecState } | undefined;

function load(): RecState {
  if (memoryWins) return memory;
  try {
    const raw = localStorage.getItem(KEY);
    if (parsed?.raw !== raw) parsed = { raw, state: parseRec(raw) };
    return parsed.state;
  } catch {
    return memory;
  }
}
function save(s: RecState) {
  memory = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    memoryWins = false;
  } catch {
    memoryWins = true;
  }
  listeners.forEach((l) => l());
}

let pageShown = false; // one recommendation per page load
type Host = { blocked: () => boolean; show: (text: string, button?: { label: string; run: () => void }) => void };
let host: Host | undefined;
export const setRecommendationHost = (h: Host | undefined) => void (host = h);
const toastShows = () => !!document.querySelector('[data-testid="toast-region"] :is([data-testid="toast"],[data-testid="update-toast"],[data-testid="stale-toast"])');

/** Evaluates rule `id` at its trigger. Toast surface: shows through the host and returns true. Inline surface: returns true, the caller renders the hint. Marked shown only when it shows. */
export function offer<K extends RuleId>(id: K, facts: Facts[K], run?: () => void, now = Date.now()): boolean {
  const rule = RULES[id] as Rule<K>;
  if (!rule.when(facts)) return false;
  if (gate(load(), id, now, { pageShown, blocked: !!host?.blocked(), toast: toastShows(), skipToast: !!rule.stack || rule.surface === "inline" })) return false;
  if (rule.surface === "toast" && !host) return false;
  save(markShown(load(), id, now));
  pageShown = true;
  if (rule.surface === "toast") host!.show(rule.text(facts), rule.button === "none" ? undefined : { label: t(rule.button === "turnOn" ? "rec.turnOn" : "rec.showMe"), run: run ?? (() => {}) });
  return true;
}

/** Counts one use of `key` (also while recommendations are off); returns the new count. */
export function count(key: string): number {
  const s = bump(load(), key);
  save(s);
  return s.counts[key]!;
}
export const seen = (key: string): number => load().counts[key] ?? 0;
/** Counts a pick of `mode` in a row; returns the length of the run. */
export function streak(mode: string): number {
  const s = nextStreak(load(), mode);
  save(s);
  return s.streak!.n;
}

export const tipMiddleClick = () => offer("middleClick", { fine: window.matchMedia?.("(pointer: fine)").matches ?? false, n: count("openInTab") });

export function setRecommendationsOn(on: boolean) {
  const { off: _, ...rest } = load();
  save(on ? rest : { ...rest, off: true });
}
function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => (e.key === KEY || e.key === null) && l();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
export const useRecommendationsOn = () => useSyncExternalStore(subscribe, () => !load().off, () => false);

/** Test seam. */
export const resetPageForTests = () => {
  pageShown = false;
  memory = fresh();
  memoryWins = false;
  parsed = undefined;
};
