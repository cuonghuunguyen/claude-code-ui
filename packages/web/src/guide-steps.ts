// The guided tour's steps (docs/spec.md "First-use guide"): data only. The tour component resolves anchors and renders; nothing here knows key text,
// a step names command ids (`keys`) and the host maps them to key specs.
import { t, type Key } from "./i18n.ts";
import type { ChapterId, GuideActions, Side } from "./guide.ts";

export type GuideStep = {
  id: string;
  chapter: ChapterId;
  /** Filter applied when a run starts. */
  needs?: "git";
  /** Candidate selectors, first one that is visible wins; none visible = shown centered, no cutout. */
  anchors: string[];
  /** Used instead when the anchors are not visible, with its own body ("Show the side panel…"). */
  alt?: { anchors: string[]; body: string; keys?: string[] };
  /** Below md (the sidebar is a closed drawer): replaces anchors, and optionally the body and keys. */
  narrow?: { anchors?: string[]; body?: string; keys?: string[] };
  title: string;
  /** `**bold**` is supported. */
  body: string;
  /** Command ids whose keys the step shows (`GuideHost.keyOf`); `keyNames` labels them when there are several. */
  keys?: string[];
  keyNames?: string[];
  /** One button next to Next, by action name. */
  action?: { label: string; run: keyof GuideActions };
  /** Preferred popover side. */
  side?: Side;
};

/** What decides which steps a run has and how they read. */
export type GuideCtx = { session: boolean; git: boolean; narrow: boolean };

const cmd = (id: string) => `[data-command="${id}"]`;
const tid = (id: string) => `[data-testid="${id}"]`;

const DEFS: StepDef[] = [
  {
    id: "welcome",
    chapter: "basics",
    anchors: [],
    title: "app.guide.welcome.title",
    body: "app.guide.welcome.body",
  },
  {
    id: "project",
    chapter: "basics",
    anchors: [tid("empty-open-project"), tid("open-project"), tid("new-open-project")],
    narrow: { anchors: [tid("open-drawer")], body: "app.guide.project.narrow" },
    title: "app.guide.project.title",
    body: "app.guide.project.body",
    side: "right",
  },
  {
    id: "new-session",
    chapter: "basics",
    anchors: [cmd("session.new")],
    title: "app.guide.new-session.title",
    body: "app.guide.new-session.body",
    keys: ["session.new"],
    side: "bottom",
  },
  {
    id: "sidebar",
    chapter: "basics",
    anchors: [cmd("sidebar.toggle")],
    narrow: { anchors: [tid("open-drawer")], body: "app.guide.sidebar.narrow", keys: [] },
    title: "app.guide.sidebar.title",
    body: "app.guide.sidebar.body",
    keys: ["sidebar.toggle"],
    side: "bottom",
  },
  {
    id: "palette",
    chapter: "basics",
    anchors: [],
    title: "app.guide.palette.title",
    body: "app.guide.palette.body",
    keys: ["palette.open"],
  },
  {
    id: "basics-end",
    chapter: "basics",
    anchors: [],
    title: "app.guide.basics-end.title",
    body: "app.guide.basics-end.body",
    action: { label: "app.guide.basics-end.action", run: "openProject" },
  },
  // Chapter "Your session": needs a shown session (a non-draft session tab).
  {
    id: "tabs",
    chapter: "session",
    anchors: [tid("tab-strip")],
    narrow: { anchors: [tid("tab-switcher")], body: "app.guide.tabs.narrow", keys: [] },
    title: "app.guide.tabs.title",
    body: "app.guide.tabs.body",
    keys: ["tab.next", "tab.close"],
    keyNames: ["app.guide.keyName.next", "app.guide.keyName.close"],
    side: "bottom",
  },
  {
    id: "files",
    chapter: "session",
    anchors: [cmd("pane.files")],
    alt: { anchors: [cmd("panel.toggle")], body: "app.guide.altPanel", keys: ["panel.toggle"] },
    title: "app.guide.files.title",
    body: "app.guide.files.body",
    keys: ["pane.files"],
    side: "left",
  },
  {
    id: "changes",
    chapter: "session",
    anchors: [cmd("pane.changes")],
    alt: { anchors: [cmd("panel.toggle")], body: "app.guide.altPanel", keys: ["panel.toggle"] },
    title: "app.guide.changes.title",
    body: "app.guide.changes.body",
    keys: ["pane.changes"],
    side: "left",
  },
  {
    id: "graph",
    chapter: "session",
    needs: "git",
    anchors: [cmd("pane.graph")],
    alt: { anchors: [cmd("panel.toggle")], body: "app.guide.altPanel", keys: ["panel.toggle"] },
    title: "app.guide.graph.title",
    body: "app.guide.graph.body",
    keys: ["pane.graph"],
    side: "left",
  },
  {
    id: "terminal",
    chapter: "session",
    anchors: [cmd("terminal.toggle"), tid("pane-terminal")],
    title: "app.guide.terminal.title",
    body: "app.guide.terminal.body",
    keys: ["terminal.toggle"],
    side: "left",
  },
  {
    id: "replay",
    chapter: "session",
    anchors: [cmd("settings.open")],
    title: "app.guide.replay.title",
    body: "app.guide.replay.body",
    side: "right",
  },
  {
    id: "shortcuts",
    chapter: "session",
    anchors: [],
    title: "app.guide.shortcuts.title",
    body: "app.guide.shortcuts.body",
    keys: ["shortcuts.open"],
    action: { label: "app.guide.shortcuts.action", run: "openShortcuts" },
  },
];

/** A step as written below: the texts are catalog keys; `STEPS` reads them in the current language each time (getters). */
type StepDef = Omit<GuideStep, "title" | "body" | "alt" | "narrow" | "action" | "keyNames"> & {
  title: Key;
  body: Key;
  alt?: { anchors: string[]; body: Key; keys?: string[] };
  narrow?: { anchors?: string[]; body?: Key; keys?: string[] };
  keyNames?: Key[];
  action?: { label: Key; run: keyof GuideActions };
};

const localize = (d: StepDef): GuideStep => ({
  ...d,
  get title() {
    return t(d.title);
  },
  get body() {
    return t(d.body);
  },
  alt: d.alt && {
    ...d.alt,
    get body() {
      return t(d.alt!.body);
    },
  },
  narrow: d.narrow && {
    ...d.narrow,
    get body() {
      return d.narrow!.body && t(d.narrow!.body);
    },
  },
  get keyNames() {
    return d.keyNames?.map((k) => t(k));
  },
  action: d.action && {
    ...d.action,
    get label() {
      return t(d.action!.label);
    },
  },
});

export const STEPS: GuideStep[] = DEFS.map(localize);

const byId = new Map(STEPS.map((s) => [s.id, s]));
export const stepById = (id: string) => byId.get(id);

/**
 * The steps of one run, fixed when it starts. Basics with a session already shown carries on into "Your session":
 * its end card is dropped, so "Step i of N" counts the whole run.
 */
export function stepsFor(chapter: ChapterId, ctx: GuideCtx): GuideStep[] {
  const own = STEPS.filter((s) => s.chapter === chapter && (s.needs !== "git" || ctx.git));
  return chapter === "basics" && ctx.session ? [...own.filter((s) => s.id !== "basics-end"), ...stepsFor("session", ctx)] : own;
}

/** The chapters a run covers, for what to mark done at its end. */
export const chaptersOf = (ids: string[]): ChapterId[] => [...new Set(ids.flatMap((id) => stepById(id)?.chapter ?? []))];

export type ResolvedStep = GuideStep & { keys: string[] };

/** The step as it reads at the current width. */
export function adapt(step: GuideStep, narrow: boolean): ResolvedStep {
  const n = narrow ? step.narrow : undefined;
  return { ...step, anchors: n?.anchors ?? step.anchors, body: n?.body ?? step.body, keys: n?.keys ?? step.keys ?? [] };
}
