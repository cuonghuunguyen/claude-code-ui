// Stable parts of the app UI for addon themes (docs/site/features/addon-parts.md, docs/spec.md "Addon themes and CSS").
// A part is an element the app marks with `data-part="<name>"` next to its `data-testid`. `data-testid` is a test hook and may change; a part name may not.
// A part is removed only after one minor release in which it is marked `deprecated`.

/** Bump when a part is added, renamed or removed. */
export const PARTS_VERSION = 1;

/** Every part name, in documentation order. `PartName` is derived from it, so a typed `data-part` value or a typo in a lookup fails to compile. */
export const PART_NAMES = [
  "titlebar",
  "sidebar",
  "session-item",
  "session-search",
  "group-toggle",
  "day-header",
  "work-area",
  "session-area",
  "session-header",
  "tab",
  "focus-tab",
  "terminal-tab",
  "side-panel",
  "files-panel",
  "file-tree",
  "graph-panel",
  "terminal",
  "user-message",
  "assistant-text",
  "thinking",
  "tool-card",
  "permission-panel",
  "question-panel",
  "plan-window",
  "prompt-box",
  "prompt-toolbar",
  "markdown-toolbar",
  "send",
  "context-meter",
  "context-bar",
  "status-bar",
  "focus-page",
  "focus-row",
  "focus-queue",
  "toast-region",
  "scroll-to-bottom",
  "palette",
  "commit-message",
  "changed-file",
  "file-diff",
  "loader",
  "done-icon",
  "backdrop",
] as const;
export type PartName = (typeof PART_NAMES)[number];

export type AddonPart = {
  name: PartName;
  /** App version (major.minor) that first had the part. */
  since: string;
  /** Attributes on the part element that carry its state, with the values they take. Documented per part; existing attributes are reused. */
  states?: string[];
  /** Set (to the release that removes it) while the part is on its way out. */
  deprecated?: string;
};

const SESSION_STATE = "data-state=running|needs_input|idle|error|closed";
/** What differs from the default (`since` 1.5, no states). A key that is not a part name does not compile. */
const META: { [K in PartName]?: Omit<AddonPart, "name" | "since"> } = {
  "session-item": { states: [SESSION_STATE] },
  "session-area": { states: ["data-phase=thinking|waiting|idle", "data-just-finished (1200 ms after thinking -> idle)"] },
  "focus-page": { states: ["data-focus-opened (1200 ms after it opens)"] },
  tab: { states: ["data-state=new|running|needs_input|unread|idle", "data-active"] },
  "tool-card": { states: ["data-status=pending|running|done|error|denied|stopped"] },
  "plan-window": { states: ["data-level=ok|warning|limit"] },
  send: { states: ["data-state=idle|running|needs_input|disconnected"] },
};

export const PARTS: readonly AddonPart[] = PART_NAMES.map((name) => ({ name, since: "1.5", ...META[name] }));

/** Effect targets of `ui.effect` v1 (docs/spec.md "Addon effects"): `window` and the parts that do not scroll with content. A part inside a scrolling list (messages, sessions, files) is not one yet. */
export const EFFECT_TARGETS = [
  "window",
  "titlebar",
  "sidebar",
  "work-area",
  "session-area",
  "session-header",
  "side-panel",
  "files-panel",
  "graph-panel",
  "terminal",
  "permission-panel",
  "question-panel",
  "prompt-box",
  "prompt-toolbar",
  "send",
  "context-meter",
  "status-bar",
  "focus-page",
  "scroll-to-bottom",
] as const satisfies readonly (PartName | "window")[];
export type EffectTarget = (typeof EFFECT_TARGETS)[number];
/** Most effects per addon manifest; most frames per addon at a time; most `bleed` px. */
export const MAX_EFFECTS = 8;
export const MAX_EFFECT_FRAMES = 3;
export const MAX_EFFECT_BLEED = 64;
/** A `data-*` attribute name an effect may name in `when` (`attr:<name>`) and `watch`. */
export const EFFECT_ATTR = /^data-[a-z][a-z0-9-]{0,40}$/;

/** The public state attributes of an effect target, the only ones the host reads for an effect: the `states` of the part (`window`: those on `<html>`). Empty for a name that is no target. */
export function effectAttrs(target: string): string[] {
  if (target === "window") return ["data-phase"];
  if (!(EFFECT_TARGETS as readonly string[]).includes(target)) return [];
  return (META[target as PartName]?.states ?? []).map((s) => /^(data-[a-z-]+)/.exec(s)![1]!);
}
