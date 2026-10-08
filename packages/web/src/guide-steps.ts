// The guided tour's steps (docs/spec.md "First-use guide"): data only. The tour component resolves anchors and renders; nothing here knows key text,
// a step names command ids (`keys`) and the host maps them to key specs.
import type { ChapterId, GuideActions, Side } from "./guide.ts";

export type GuideStep = {
  id: string;
  chapter: ChapterId;
  /** Filter applied when a run starts. */
  needs?: "git";
  /** Candidate selectors, first one that is visible wins; none visible = shown centered, no cutout. */
  anchors: string[];
  /** Used instead when the anchors are not visible, with its own body ("Show the side panel…"). */
  alt?: { anchors: string[]; body: string };
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

export const STEPS: GuideStep[] = [
  {
    id: "welcome",
    chapter: "basics",
    anchors: [],
    title: "Welcome to Claude UI",
    body: "A one-minute tour of projects, sessions, files, changes, git and the terminal. Press → or Next.",
  },
  {
    id: "project",
    chapter: "basics",
    anchors: [tid("empty-open-project"), tid("open-project"), tid("new-open-project")],
    narrow: { anchors: [tid("open-drawer")], body: "A project is a folder on this machine. Sessions run in it. Tap ☰, then **Add project**." },
    title: "Add a project",
    body: "A project is a folder on this machine. Sessions run in it, and its files, changes and git history show beside the chat.",
    side: "right",
  },
  {
    id: "new-session",
    chapter: "basics",
    anchors: [cmd("session.new")],
    title: "Start a session",
    body: "**+** opens a New session tab: pick the project, type a prompt, Enter sends. Each session is a tab.",
    keys: ["session.new"],
    side: "bottom",
  },
  {
    id: "sidebar",
    chapter: "basics",
    anchors: [cmd("sidebar.toggle")],
    narrow: { anchors: [tid("open-drawer")], body: "☰ opens projects and sessions.", keys: [] },
    title: "Your projects and sessions",
    body: "The sidebar lists projects and their sessions. Hide it to get room.",
    keys: ["sidebar.toggle"],
    side: "bottom",
  },
  {
    id: "palette",
    chapter: "basics",
    anchors: [],
    title: "Everything from the keyboard",
    body: "The command palette runs any command, opens sessions and searches messages.",
    keys: ["palette.open"],
  },
  {
    id: "basics-end",
    chapter: "basics",
    anchors: [],
    title: "You're set",
    body: "Open a session and we'll show files, changes, the git graph and the terminal.",
    action: { label: "Add project", run: "openProject" },
  },
];

const byId = new Map(STEPS.map((s) => [s.id, s]));
export const stepById = (id: string) => byId.get(id);

/** The steps of one run, fixed when it starts. */
export function stepsFor(chapter: ChapterId, ctx: GuideCtx): GuideStep[] {
  return STEPS.filter((s) => s.chapter === chapter && (s.needs !== "git" || ctx.git));
}

export type ResolvedStep = GuideStep & { keys: string[] };

/** The step as it reads at the current width. */
export function adapt(step: GuideStep, narrow: boolean): ResolvedStep {
  const n = narrow ? step.narrow : undefined;
  return { ...step, anchors: n?.anchors ?? step.anchors, body: n?.body ?? step.body, keys: n?.keys ?? step.keys ?? [] };
}
