// Clean up tabs (GH-378): rule-based bulk close over tab + session facts. Pure; App builds the facts.
import type { SessionState } from "@claude-ui/protocol";
import { NEW_TAB } from "./tabs.ts";

export type CleanupRule = "idle" | "finished" | "archived" | "unused1h" | "unused1d" | "unused7d" | "workers";
export const CLEANUP_RULES: CleanupRule[] = ["idle", "finished", "archived", "unused1h", "unused1d", "unused7d", "workers"];
export const RULE_LABEL: Record<CleanupRule, string> = {
  idle: "Close idle tabs",
  finished: "Close finished tabs",
  archived: "Close tabs of archived or deleted sessions",
  unused1h: "Close tabs not used for 1 hour",
  unused1d: "Close tabs not used for 1 day",
  unused7d: "Close tabs not used for 7 days",
  workers: "Close worker tabs",
};
export const UNUSED_MS = { unused1h: 3_600_000, unused1d: 86_400_000, unused7d: 604_800_000 } as const;

export type KeepReason = "active" | "pinned" | "running" | "needs_input" | "unread" | "draft";
const REASON_ORDER: KeepReason[] = ["pinned", "running", "needs_input", "unread", "draft"]; // "active" never shown
const REASON_WORD: Record<KeepReason, string> = { active: "active", pinned: "pinned", running: "running", needs_input: "needs input", unread: "unread", draft: "draft" };

export type TabFacts = {
  id: string;
  /** shownState(view) ?? list state; undefined = unknown (no view, not listed). */
  state?: SessionState;
  unread: boolean;
  draft: boolean;
  /** Listed in session.list (true for NEW_TAB). */
  listed: boolean;
  archived: boolean;
  worker: boolean;
  transcript: boolean;
  /** Queued prompts or a scheduled continue: counts as running. */
  busy: boolean;
  /** claude-ui.tab-used stamp (ms); undefined = never stamped. */
  lastUsed?: number;
};
export type CleanupContext = { activeId?: string; pinned: ReadonlySet<string>; listLoaded: boolean; now: number };

export function keepReason(f: TabFacts, c: CleanupContext): KeepReason | undefined {
  if (f.id === c.activeId) return "active";
  if (c.pinned.has(f.id)) return "pinned";
  if (f.state === "running" || f.busy) return "running";
  if (f.state === "needs_input") return "needs_input";
  if (f.unread) return "unread";
  if (f.draft) return "draft";
  return undefined;
}

export function matchesRule(rule: CleanupRule, f: TabFacts, c: CleanupContext): boolean {
  const isNew = f.id === NEW_TAB;
  switch (rule) {
    case "idle":
      return isNew || f.state === "idle" || f.state === "closed" || f.state === "error";
    case "finished":
      return !isNew && f.state === "idle" && f.transcript && !f.unread && !f.busy;
    case "archived":
      return !isNew && (f.archived || (c.listLoaded && !f.listed));
    case "workers":
      return !isNew && f.worker;
    default:
      return f.lastUsed !== undefined && c.now - f.lastUsed >= UNUSED_MS[rule];
  }
}

/** Tab ids to close in strip order: rule matches and no keep reason. `scope`: only these ids (Clean up group). */
export function cleanupTargets(rule: CleanupRule, facts: TabFacts[], c: CleanupContext, scope?: ReadonlySet<string>): string[] {
  return facts.filter((f) => (!scope || scope.has(f.id)) && matchesRule(rule, f, c) && !keepReason(f, c)).map((f) => f.id);
}

export type CleanupMenu = { items: { rule: CleanupRule; label: string; count: number }[]; kept: { count: number; text: string } };
/** Counts per rule (all CLEANUP_RULES, also 0) and the kept line for `scope` (default all). kept = tabs in scope with a keep reason other than "active"; text "" when 0. */
export function cleanupMenu(facts: TabFacts[], c: CleanupContext, scope?: ReadonlySet<string>): CleanupMenu {
  const items = CLEANUP_RULES.map((rule) => ({ rule, label: RULE_LABEL[rule], count: cleanupTargets(rule, facts, c, scope).length }));
  const reasons = facts.filter((f) => !scope || scope.has(f.id)).map((f) => keepReason(f, c));
  const kept = reasons.filter((r): r is KeepReason => !!r && r !== "active");
  const words = REASON_ORDER.filter((r) => kept.includes(r)).map((r) => REASON_WORD[r]);
  return { items, kept: { count: kept.length, text: kept.length ? `${kept.length} kept: ${words.join("/")}` : "" } };
}

export type AutoClose = "off" | "1h" | "1d";
export const AUTO_CLOSE: { value: AutoClose; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "1h", label: "1 hour" },
  { value: "1d", label: "1 day" },
];
export const AUTO_CLOSE_EVERY_MS = 15 * 60_000;
const AUTO_MS = { "1h": UNUSED_MS.unused1h, "1d": UNUSED_MS.unused1d } as const;

/** Idle rule ∧ no keep reason ∧ lastUsed set and older than the setting; [] for "off". */
export function autoCloseTargets(facts: TabFacts[], c: CleanupContext, after: AutoClose): string[] {
  if (after === "off") return [];
  return cleanupTargets("idle", facts, c).filter((id) => {
    const t = facts.find((f) => f.id === id)!.lastUsed;
    return t !== undefined && c.now - t >= AUTO_MS[after];
  });
}
/** True when a run is due: never ran, or last run ≥ AUTO_CLOSE_EVERY_MS ago. */
export const autoCloseDue = (now: number, lastRun: number | undefined) => lastRun === undefined || now - lastRun >= AUTO_CLOSE_EVERY_MS;

const KEY = "claude-ui.tabAutoClose";
export function loadAutoClose(): AutoClose {
  try {
    const v = localStorage.getItem(KEY);
    return v === "1h" || v === "1d" ? v : "off";
  } catch {
    return "off";
  }
}
export function saveAutoClose(v: AutoClose): void {
  try {
    if (v === "off") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    // Blocked storage: the setting lasts until the page reloads.
  }
}
