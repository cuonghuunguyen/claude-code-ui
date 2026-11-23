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
  /** Listed for authors, the element itself comes with a later slice of the theme chain (slots). Not rendered yet. */
  reserved?: true;
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
  loader: { reserved: true },
  "done-icon": { reserved: true },
};

export const PARTS: readonly AddonPart[] = PART_NAMES.map((name) => ({ name, since: "1.5", ...META[name] }));
