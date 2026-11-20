// Stable parts of the app UI for addon themes (docs/site/features/addon-parts.md, docs/spec.md "Addon themes and CSS").
// A part is an element the app marks with `data-part="<name>"` next to its `data-testid`. `data-testid` is a test hook and may change; a part name may not.
// A part is removed only after one minor release in which it is marked `deprecated`.

/** Bump when a part is added, renamed or removed. */
export const PARTS_VERSION = 1;

export type AddonPart = {
  name: string;
  /** App version (major.minor) that first had the part. */
  since: string;
  /** Attributes on the part element that carry its state, with the values they take. Documented per part; existing attributes are reused. */
  states?: string[];
  /** Set (to the release that removes it) while the part is on its way out. */
  deprecated?: string;
  /** Listed for authors, the element itself comes with a later slice of the theme chain (slots, background). Not rendered yet. */
  reserved?: true;
};

const S = "1.5";
const p = (name: string, states?: string[]): AddonPart => ({ name, since: S, ...(states && { states }) });
const SESSION_STATE = "data-state=running|needs_input|idle|error|closed";

export const PARTS: readonly AddonPart[] = [
  p("titlebar"),
  p("sidebar"),
  p("session-item", [SESSION_STATE]),
  p("session-search"),
  p("group-toggle"),
  p("day-header"),
  p("work-area"),
  p("session-area"),
  p("session-header"),
  p("tab", ["data-state=new|running|needs_input|unread|idle", "data-active"]),
  p("focus-tab"),
  p("terminal-tab"),
  p("side-panel"),
  p("files-panel"),
  p("file-tree"),
  p("graph-panel"),
  p("terminal"),
  p("user-message"),
  p("assistant-text"),
  p("thinking"),
  p("tool-card", ["data-status=pending|running|done|error|denied|stopped"]),
  p("permission-panel"),
  p("question-panel"),
  p("plan-window", ["data-level=ok|warning|limit"]),
  p("prompt-box"),
  p("prompt-toolbar"),
  p("markdown-toolbar"),
  p("send", ["data-state=idle|running|needs_input|disconnected"]),
  p("context-meter"),
  p("context-bar"),
  p("status-bar"),
  p("focus-page"),
  p("focus-row"),
  p("focus-queue"),
  p("toast-region"),
  p("scroll-to-bottom"),
  p("palette"),
  p("commit-message"),
  p("changed-file"),
  p("file-diff"),
  { ...p("loader"), reserved: true },
  { ...p("done-icon"), reserved: true },
  { ...p("backdrop"), reserved: true },
];
