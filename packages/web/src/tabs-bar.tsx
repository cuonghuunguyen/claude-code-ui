// Titlebar tabs (OpenCode titlebar-tab-strip): avatar + title + close; middle click closes, drag reorders, overflow scrolls.
// Reorder without drag (WCAG 2.5.7): Alt+Shift+Arrow or Ctrl+Shift+PageUp/PageDown on a focused tab, or the tab context menu.
// Tabs form groups by project or by worktree (Settings > Tabs) behind a chip (name, count; click collapses; Alt+Shift+Left/Right on the chip moves the group); None or a single group: no chip. Compact tabs: every group is its chip (also one) and the chip opens a menu of its tabs.
// Below md the strip collapses into a switcher (a Select showing the active tab).
import { createContext, memo, use, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { ChevronDownIcon, CircleAlertIcon, CrosshairIcon, LoaderCircleIcon, PanelLeftIcon, PlusIcon, SquarePenIcon, XIcon } from "lucide-react";
import type { SessionState } from "@claude-ui/protocol";
import { cn, useStableProps } from "@/lib/utils";
import { TitleSkeleton } from "@/components/ui/skeleton";
import { FOCUS_TAB, NEW_TAB, avatarColor, closeTab, groupTabs, loadCollapsed, projectName, saveCollapsed, type AvatarColor } from "./tabs.ts";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { GHOST, ROW } from "./toolbar.tsx";
import { SideLabel } from "./sides.tsx";
import { ROW_SWIPE, mirror, opacityFor, swipe, type SwipeState } from "./swipe.ts";
import { ITEM, Items, POPUP, RenameInput, type SessionAction } from "./session-actions.tsx";

export type TabInfo = {
  title: string;
  cwd?: string;
  /** Group key (tab-grouping.ts tabGroup): "" = no group; falls back to `cwd` when unset. */
  group?: string;
  /** Chip text of the tab's group, its branch in worktree grouping, and the cwd whose avatar color the chip takes. */
  groupLabel?: string; groupSub?: string; groupColor?: string;
  /** "<project> · <branch>" of a session in a linked worktree: a tooltip line. */
  worktree?: string; state?: SessionState; unread: boolean; archived?: boolean;
  transcript?: boolean;
  /** Prompted but the SDK title is not there yet (GH-133): the title shows a skeleton. */
  titleLoading?: boolean;
};
type TabStatus = "new" | "running" | "needs_input" | "unread" | "idle";

const status = (id: string, t: TabInfo): TabStatus =>
  id === NEW_TAB ? "new" : t.state === "running" ? "running" : t.state === "needs_input" ? "needs_input" : t.unread ? "unread" : "idle";

const STATUS_LABEL: Record<TabStatus, string> = { new: "", running: "running", needs_input: "needs input", unread: "unread", idle: "" };

/** The states only the session header showed (GH-165): error and closed, noted in the switcher below md where the header row is gone. */
const stateNote = (t: TabInfo) => (t.state === "error" || t.state === "closed" ? t.state : "");

/** Avatar colors of the known projects (avatarColors), so no two of them look the same. */
export const AvatarColors = createContext(new Map<string, AvatarColor>());

/** 16px project initial on the project's color (OpenCode project-avatar-v2). */
export function ProjectAvatar({ cwd, unread }: { cwd: string; unread?: boolean }) {
  const c = avatarColor(cwd, use(AvatarColors));
  return (
    <span
      className="relative grid size-4 shrink-0 place-items-center rounded-sm bg-(--av) font-medium text-(--av-fg) text-[11px] leading-none tabular-nums shadow-[inset_0_0_0_0.5px_var(--border)]"
      style={{ "--av": `var(--avatar-${c})`, "--av-fg": `var(--avatar-${c}-fg)` } as CSSProperties}
      aria-hidden
    >
      {[...projectName(cwd)][0]?.toUpperCase()}
      {unread && <span data-dot="unread" className="-top-0.5 -right-0.5 absolute size-1.5 rounded-full bg-info ring-2 ring-background" />}
    </span>
  );
}

function TabIcon({ s, cwd }: { s: TabStatus; cwd?: string }) {
  if (s === "new") return <SquarePenIcon className="size-4 shrink-0 text-faint" aria-hidden />;
  if (s === "running") return <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-faint motion-reduce:animate-none" aria-hidden />;
  // Needs input gets its own shape, not only another dot colour than unread.
  if (s === "needs_input") return <CircleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />;
  if (!cwd) return <span className="size-4 shrink-0 rounded-[3px] border border-border" aria-hidden />;
  return <ProjectAvatar cwd={cwd} unread={s === "unread"} />;
}

const DRAG_TYPE = "application/x-claude-ui-tab";
const GROUP_DRAG_TYPE = "application/x-claude-ui-tab-group";
// Hover time before a compact chip opens its menu: short enough to feel direct, long enough that a pointer passing over a chip does not flash it.
const CHIP_HOVER_DELAY_MS = 100;

/**
 * Keeps the stored tab list grouped by project, also once the session cwds arrive (the strip draws groups; close, next tab and moves use this order).
 * It regroups only when `ready` (every tab's group key is final): on partial keys, unknown tabs of different projects form one group and the damaged order is persisted (GH-196).
 */
export function useGroupedTabs(tabs: string[], setTabs: (t: string[]) => void, cwdOf: (id: string) => string | undefined, ready = true) {
  const grouped = [...groupTabs(tabs, cwdOf).values()].flat();
  useEffect(() => {
    if (ready && grouped.some((id, i) => id !== tabs[i])) setTabs(grouped);
  });
}

export function TabsBar({
  tabs: given,
  activeId,
  info,
  onSelect,
  onClose,
  onSwipeClose,
  onMove,
  onMoveGroup,
  onMoveGroupTo,
  onCloseGroup,
  onNew,
  home,
  onHome,
  renaming,
  onAction,
  onRenamed,
  grouping = "project",
  focus,
  compact = false,
}: {
  /** The pinned Focus tab (docs/spec.md "Focus"), first in the strip and never closable; `count`: sessions waiting for the user. Absent: no Focus tab. */
  focus?: { count: number };
  tabs: string[];
  /** Selects the collapsed-state storage; group keys come from `info().group`. */
  grouping?: "project" | "worktree" | "none";
  /** Compact tabs (md and up): every group is its chip, the chip opens a menu of its tabs; the active tab stays after its chip. */
  compact?: boolean;
  activeId?: string;
  info: (id: string) => TabInfo;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** A row of the phone switcher closed by a left swipe or Delete (the list stays open); default `onClose`. The owner can offer Undo. */
  onSwipeClose?: (id: string) => void;
  onMove: (from: string, to: string) => void;
  /** Moves the group of a project one place left or right. */
  onMoveGroup: (cwd: string, by: -1 | 1) => void;
  /** Chip drag: the group of `from` takes the slot of the group of `to`. */
  onMoveGroupTo: (from: string, to: string) => void;
  /** Closes a group's tabs (chip menu, middle click, Delete on the chip): `key` is the group key, `ids` its tabs in strip order. The owner asks first for 2 or more. */
  onCloseGroup?: (key: string, ids: string[]) => void;
  onNew: () => void;
  /** Sidebar toggle (md and up), OpenCode's legacy-layout `sidebar` icon: aria-pressed while the sessions sidebar shows, no pressed fill.
   * Not OpenCode's `grid-plus`: that one opens its Home page, this one only shows and hides the sidebar. */
  home?: boolean;
  onHome?: () => void;
  /** Session tab that shows the title editor. */
  renaming?: string;
  onAction: (id: string, a: SessionAction) => void;
  onRenamed: (id: string, title: string | undefined) => void;
}) {
  const keyOf = (id: string) => {
    const t = info(id);
    return t.group ?? t.cwd ?? "";
  };
  const groups = [...groupTabs(given, keyOf)];
  const tabs = groups.flatMap(([, ids]) => ids);
  const named = groups.filter(([k]) => k).length;
  const chips = named > 1 || (compact && named > 0);
  // Collapsed groups are kept per grouping mode; a mode change loads that mode's set.
  const store = grouping === "worktree" ? "worktree" : "project";
  const [col, setCol] = useState(() => ({ mode: store, set: loadCollapsed(store) }));
  if (col.mode !== store) setCol({ mode: store, set: loadCollapsed(store) });
  const stored = col.mode === store ? col.set : loadCollapsed(store);
  // Compact: every group counts as collapsed; the stored set is left alone, so turning compact off brings back the user's own.
  // Memoised on the group keys: a new Set every render would re-run the reveal effect (observer, scrollIntoView) on every app render.
  const compactKeys = compact ? JSON.stringify(groups.map(([k]) => k).filter(Boolean)) : "";
  const collapsed = useMemo(() => (compact ? new Set<string>(JSON.parse(compactKeys || "[]")) : stored), [compact, compactKeys, stored]);
  const toggle = (cwd: string) => {
    const n = new Set(stored);
    if (n.delete(cwd)) return commit(n);
    n.add(cwd);
    commit(n);
    // Like Chrome: hiding the active tab activates the nearest visible tab after its group, else before it.
    if (activeId && keyOf(activeId) === cwd) {
      const open = tabs.filter((id) => !n.has(keyOf(id)));
      const at = tabs.indexOf(activeId);
      const next = open.find((id) => tabs.indexOf(id) > at) ?? [...open].reverse().find((id) => tabs.indexOf(id) < at);
      if (next) onSelect(next);
    }
  };
  const commit = (n: Set<string>) => {
    setCol({ mode: store, set: n });
    saveCollapsed(n, store);
  };
  // No other tab is visible: the active tab stays shown inside its collapsed group.
  const keepActive = chips && !!activeId && (compact || !tabs.some((id) => !collapsed.has(keyOf(id))));
  const hidden = (id: string) => chips && collapsed.has(keyOf(id)) && !(keepActive && id === activeId);
  const visible = tabs.filter((id) => !hidden(id));
  // A tab that becomes active (sidebar, next/previous tab, URL hash) inside a collapsed group expands it, like Chrome.
  const activeKey = activeId && tabs.includes(activeId) ? keyOf(activeId) : undefined;
  const activeHidden = !!activeId && tabs.includes(activeId) && !keepActive && hidden(activeId);
  useEffect(() => {
    if (!activeHidden || !activeKey) return;
    const n = new Set(stored);
    n.delete(activeKey);
    commit(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activeHidden]);
  const strip = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  // Tab to focus once the parent applied a keyboard close or move; none left → the New session button.
  const refocus = useRef<{ id?: string; group?: string }>(undefined);
  useEffect(() => {
    const r = refocus.current;
    refocus.current = undefined;
    if (!r) return;
    if (r.group) return strip.current?.querySelector<HTMLElement>(`[data-group-chip="${CSS.escape(r.group)}"]`)?.focus();
    ((r.id ? strip.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(r.id)}"] [role="tab"]`) : undefined) ?? newButton.current)?.focus();
  }, [tabs]);
  const closeKeepFocus = (id: string) => {
    refocus.current = { id: closeTab(tabs, id, activeId ?? id).active };
    onClose(id);
  };
  const closeGroup = (key: string) => {
    const ids = groups.find(([k]) => k === key)?.[1];
    if (ids?.length) onCloseGroup?.(key, ids);
  };
  const moveBy = (id: string, by: -1 | 1) => {
    const to = tabs[tabs.indexOf(id) + by];
    if (!to || keyOf(to) !== keyOf(id)) return;
    refocus.current = { id };
    onMove(id, to);
  };
  useEffect(() => {
    const el = strip.current;
    const reveal = () => el?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    reveal();
    // The strip narrows on a window resize or sidebar toggle: keep the active tab in view.
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(reveal);
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeId, tabs.length, collapsed]);
  // When the last swipe on a switcher row ended: the click that follows it must not select the row (base-ui commits a selection on click).
  const swiped = useRef(-Infinity);
  const active = activeId && activeId !== FOCUS_TAB ? info(activeId) : undefined;
  const sideOf = use(SideLabel);
  // Below sm the session header row is gone: the switcher says where the session is, "<project or project · branch> · <side>" (GH-165).
  const place = (t: TabInfo) => [t.worktree ?? (t.cwd ? projectName(t.cwd) : ""), t.cwd ? sideOf(t.cwd)?.label : ""].filter(Boolean).join(" · ");
  // Only one tab is in the Tab order; arrows, Home and End move between tabs (WAI-ARIA tabs, automatic activation). Delete closes.
  const focusable = activeId === FOCUS_TAB ? undefined : activeId && visible.includes(activeId) ? activeId : visible[0];
  // The arrow keys also reach the pinned Focus tab, which comes first.
  const ring = focus ? [FOCUS_TAB, ...visible] : visible;
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const chip = target.closest<HTMLElement>("[data-group-chip]")?.dataset.groupChip;
    if (chip !== undefined) {
      if (e.key === "Delete" && chip) {
        e.preventDefault();
        return closeGroup(chip);
      }
      const by = e.altKey && e.shiftKey ? ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, -1 | 1>)[e.key] : undefined;
      if (!by) return;
      e.preventDefault();
      refocus.current = { group: chip };
      return onMoveGroup(chip, by);
    }
    const id = target.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
    const at = id ? ring.indexOf(id) : -1;
    if (at < 0 || target.getAttribute("role") !== "tab") return;
    // Focus is pinned: it neither closes nor moves.
    if (id === FOCUS_TAB && (e.key === "Delete" || e.altKey || e.ctrlKey)) return;
    if (e.key === "Delete") return closeKeepFocus(id!);
    const by =
      e.altKey && e.shiftKey ? { ArrowLeft: -1, ArrowRight: 1 }[e.key] : e.ctrlKey && e.shiftKey ? { PageUp: -1, PageDown: 1 }[e.key] : undefined;
    if (by) {
      e.preventDefault();
      return moveBy(id!, by as -1 | 1);
    }
    const n = ring.length;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1 + n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = ring[to % n]!;
    onSelect(next);
    strip.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next)}"] [role="tab"]`)?.focus();
  };

  return (
    // Below md: 44px hit areas, 8px apart (touch-target-size, touch-spacing).
    <div className="flex min-w-0 flex-1 items-center gap-1.5 max-md:gap-2">
      {onHome && (
        <IconButton className="w-9! max-md:hidden aria-pressed:bg-transparent aria-pressed:text-faint aria-pressed:hover:bg-accent aria-pressed:hover:text-foreground" label="Toggle sidebar" onClick={onHome} pressed={home} testId="tab-home" command="sidebar.toggle">
          <PanelLeftIcon />
        </IconButton>
      )}
      <div
        ref={strip}
        role="tablist"
        aria-label="Open sessions"
        className="hidden min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] md:flex [&::-webkit-scrollbar]:hidden"
        data-testid="tab-strip"
        // A vertical wheel scrolls the strip sideways, like a browser tab strip.
        onWheel={(e) => !e.deltaX && (e.currentTarget.scrollLeft += e.deltaY)}
        onKeyDown={onKeyDown}
      >
        {/* One provider for the chips: same (default) delay as the message action tooltips; moving to a neighbouring chip opens at once. */}
        <TooltipProvider>
        {focus && <FocusTab active={activeId === FOCUS_TAB} count={focus.count} focusable={activeId === FOCUS_TAB || !focusable} onSelect={() => onSelect(FOCUS_TAB)} />}
        {groups.map(([cwd, ids]) => (
          // `contents`: groups are no boxes, tabs shrink in the strip as before. The chip is a button inside the tablist (a11y trade-off, no group role).
          <div key={cwd} role="none" className="contents" data-testid="tab-group">
            {chips && cwd && <GroupChip cwd={cwd} ids={ids} hiddenIds={ids.filter(hidden)} info={info} collapsed={collapsed.has(cwd)} onToggle={() => toggle(cwd)} onMoveTo={onMoveGroupTo} onCloseGroup={() => closeGroup(cwd)} move={{ left: groups.findIndex(([k]) => k === cwd) > 0, right: groups.findIndex(([k]) => k === cwd) < groups.length - 1, by: (by) => ((refocus.current = { group: cwd }), onMoveGroup(cwd, by)) }} menu={compact ? { activeId, onSelect, onClose: (id) => (ids.length === 1 ? closeKeepFocus(id) : onClose(id)) } : undefined} />}
            {ids
              .filter((id) => !hidden(id))
              .map((id) => {
                const i = tabs.indexOf(id);
                return (
                  <StableTab
                    key={id}
                    id={id}
                    t={info(id)}
                    active={id === activeId}
                    focusable={id === focusable}
                    first={keyOf(tabs[i - 1] ?? NEW_TAB) !== keyOf(id) || i === 0}
                    last={keyOf(tabs[i + 1] ?? NEW_TAB) !== keyOf(id) || i === tabs.length - 1}
                    onSelect={onSelect}
                    onClose={onClose}
                    onMove={onMove}
                    onMenuMove={(by) => moveBy(id, by)}
                    onMenuClose={() => closeKeepFocus(id)}
                    renaming={renaming === id}
                    onAction={(a) => onAction(id, a)}
                    onRenamed={(title) => onRenamed(id, title)}
                  />
                );
              })}
          </div>
        ))}
        </TooltipProvider>
      </div>
      {(given.length > 0 || focus) && (
        <div className="flex h-7 min-w-0 flex-1 max-md:h-11 md:hidden">
          <Select
            value={activeId ?? null}
            onValueChange={(v, d) => (justSwiped(swiped) ? d.cancel() : v && onSelect(v))}
            onOpenChange={(o, d) => !o && d.reason === "item-press" && justSwiped(swiped) && d.cancel()}
          >
            <SelectTrigger
              aria-label="Switch tab"
              data-testid="tab-switcher"
              className={`${GHOST} max-md:h-11! min-w-0 flex-1 bg-secondary! px-1.5 font-medium text-foreground max-md:my-2`}
            >
              {activeId === FOCUS_TAB ? <CrosshairIcon className="size-4 shrink-0 text-faint" aria-hidden /> : active && activeId ? <TabIcon s={status(activeId, active)} cwd={active.cwd} /> : null}
              <span className="flex min-w-0 flex-col text-left">
                <span className="truncate" data-slot="tab-switcher-title">{activeId === FOCUS_TAB ? "Focus" : active?.titleLoading ? <TitleSkeleton title={active.title} /> : (active?.title ?? "Open tabs")}</span>
                {active && place(active) && <span className="truncate font-normal text-muted-foreground text-xs leading-4" data-slot="tab-switcher-place">{place(active)}</span>}
              </span>
              {focus && focus.count > 0 && <span className="ml-auto flex items-center gap-1 rounded-full bg-warning px-1.5 text-background text-xs tabular-nums" data-testid="focus-badge"><CircleAlertIcon className="size-3" aria-hidden />{focus.count}</span>}
              <span className={cn("text-muted-foreground tabular-nums", !(focus && focus.count > 0) && "ml-auto")}>{given.length}</span>
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} side="bottom" align="start" className="w-auto min-w-56 max-w-[calc(100vw-2rem)] overscroll-contain rounded-md p-0.5 shadow-floating! ring-0">
              {focus && (
                <SelectItem value={FOCUS_TAB} className={ROW}>
                  <CrosshairIcon className="size-4 shrink-0 text-faint" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">Focus</span>
                  </span>
                  {focus.count > 0 && <span className="text-muted-foreground text-xs leading-none">{focus.count} waiting</span>}
                </SelectItem>
              )}
              {given.map((id) => {
                const t = info(id);
                const label = stateNote(t) || STATUS_LABEL[status(id, t)];
                return (
                  <SwipeRow key={id} id={id} swiped={swiped} onClose={onSwipeClose ?? onClose}>
                    <TabIcon s={status(id, t)} cwd={t.cwd} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      {t.titleLoading ? <TitleSkeleton title={t.title} /> : <span className="truncate">{t.title}</span>}
                      {place(t) && <span className="truncate text-muted-foreground text-xs leading-4">{place(t)}</span>}
                    </span>
                    {label && <span className="text-muted-foreground text-xs leading-none">{label}</span>}
                  </SwipeRow>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}
      {activeId && activeId !== FOCUS_TAB && (
        <IconButton className="md:hidden" label={`Close ${active?.title ?? "tab"}`} onClick={() => onClose(activeId)} testId="tab-close-active">
          <XIcon />
        </IconButton>
      )}
      <IconButton label="New session" onClick={onNew} testId="tab-new" command="session.new" ref={newButton}>
        <PlusIcon />
      </IconButton>
    </div>
  );
}

const SWIPE_CLICK_MS = 400;
const justSwiped = (at: RefObject<number>) => performance.now() - at.current < SWIPE_CLICK_MS;
const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

type RowView = { stage: "idle" | "drag" | "settle" | "out" | "collapse"; offset: number; width: number; height: number; sign: -1 | 1 };

/**
 * A row of the phone switcher (GH-209): a LEFT swipe closes its tab like iOS Safari's tab overview (a right swipe only rubber-bands), Delete does too.
 * Touch and pen only; `touch-action: pan-y` leaves the list's vertical scroll to the browser, the horizontal move is ours (swipe.ts).
 */
function SwipeRow({ id, swiped, onClose, children }: { id: string; swiped: RefObject<number>; onClose: (id: string) => void; children: ReactNode }) {
  const [view, setView] = useState<RowView>({ stage: "idle", offset: 0, width: 0, height: 0, sign: -1 });
  const state = useRef<SwipeState>({ phase: "idle" });
  const cfg = useRef(ROW_SWIPE);
  const box = useRef({ width: 0, height: 0 });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => void timers.current.push(setTimeout(fn, ms));
  const sign = (cfg.current.allow === "positive" ? 1 : -1) as -1 | 1;
  const settle = () => {
    setView((v) => ({ ...v, stage: "settle", offset: 0 }));
    later(() => setView((v) => (v.stage === "settle" ? { ...v, stage: "idle" } : v)), 200);
  };
  const commit = () => {
    const { width, height } = box.current;
    if (reducedMotion()) return onClose(id);
    setView({ stage: "out", offset: sign * width, width, height, sign });
    later(() => setView({ stage: "collapse", offset: sign * width, width, height, sign }), 180);
    later(() => (onClose(id), setView({ stage: "idle", offset: 0, width, height, sign })), 330);
  };
  const feed = (e: ReactPointerEvent<HTMLElement>, type: "down" | "move" | "up") => {
    const before = state.current;
    const next = swipe(before, { type, p: { x: e.clientX, y: e.clientY, t: performance.now() } }, cfg.current, box.current.width);
    state.current = next;
    if (next.phase === "dragging") {
      swiped.current = performance.now();
      if (before.phase !== "dragging") e.currentTarget.setPointerCapture?.(e.pointerId);
      setView({ stage: "drag", offset: next.offset, width: box.current.width, height: box.current.height, sign });
    } else if (next.phase === "committed") {
      swiped.current = performance.now();
      commit();
    } else if (next.phase === "settling") {
      swiped.current = performance.now();
      settle();
    }
  };
  const reveal = view.stage !== "idle" && Math.sign(view.offset) === view.sign;
  const motion = { drag: "none", settle: "transform 200ms cubic-bezier(0.2,0,0,1), opacity 200ms", out: "transform 180ms ease-out, opacity 180ms ease-out", collapse: "none", idle: undefined }[view.stage];
  return (
    <div
      role="presentation"
      className="relative overflow-hidden"
      style={view.stage === "out" || view.stage === "collapse" ? { height: view.stage === "out" ? view.height : 0, transition: view.stage === "collapse" ? "height 150ms ease-out" : undefined } : undefined}
    >
      {reveal && (
        <div aria-hidden className={cn("absolute inset-0 flex items-center gap-1.5 bg-destructive/10 px-4 font-medium text-destructive text-sm", view.sign < 0 ? "justify-end" : "justify-start")}>
          <XIcon className="size-4" />
          Close
        </div>
      )}
      <SelectItem
        value={id}
        className={cn(ROW, "touch-pan-y [-webkit-touch-callout:none]")}
        aria-keyshortcuts="Delete"
        style={view.stage === "idle" ? undefined : { transform: `translateX(${view.offset}px)`, opacity: opacityFor(view.offset, view.width), transition: motion }}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" || !e.isPrimary || view.stage === "out" || view.stage === "collapse") return;
          const r = e.currentTarget.getBoundingClientRect();
          box.current = { width: r.width, height: r.height };
          cfg.current = getComputedStyle(e.currentTarget).direction === "rtl" ? { ...ROW_SWIPE, allow: mirror(ROW_SWIPE.allow) } : ROW_SWIPE;
          feed(e, "down");
        }}
        onPointerMove={(e) => state.current.phase !== "idle" && feed(e, "move")}
        onPointerUp={(e) => {
          if (state.current.phase !== "idle") feed(e, "up");
          if (!["dragging", "committed", "settling"].includes(state.current.phase)) state.current = { phase: "idle" };
        }}
        onPointerCancel={() => {
          if (state.current.phase === "idle") return;
          state.current = { phase: "idle" };
          if (view.stage === "drag") settle();
        }}
        onClickCapture={(e) => {
          if (!justSwiped(swiped)) return;
          e.preventDefault();
          e.stopPropagation();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Delete" && e.key !== "Backspace") return;
          e.preventDefault();
          onClose(id);
        }}
      >
        {children}
      </SelectItem>
    </div>
  );
}

/** The pinned Focus tab: first in the strip, a count of the sessions waiting for the user (a shape and a number, not only a color). */
function FocusTab({ active, count, focusable, onSelect }: { active: boolean; count: number; focusable: boolean; onSelect: () => void }) {
  return (
    <div
      className={cn("relative flex h-7 shrink-0 items-center rounded-md transition-colors", active ? "bg-secondary" : "hover:bg-secondary/70")}
      data-active={active || undefined}
      data-testid="focus-tab"
      data-tab-id={FOCUS_TAB}
    >
      <button
        role="tab"
        aria-selected={active}
        tabIndex={focusable ? 0 : -1}
        aria-label={count ? `Focus, ${count} ${count === 1 ? "session needs" : "sessions need"} input` : "Focus"}
        className={cn("flex h-full cursor-pointer items-center gap-1.5 rounded-md px-2 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", active ? "text-foreground" : "text-muted-foreground")}
        onClick={onSelect}
      >
        <CrosshairIcon className="size-4 shrink-0" aria-hidden />
        <span className="leading-4">Focus</span>
        {count > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-warning px-1.5 text-background text-xs tabular-nums leading-4" data-testid="focus-badge" aria-hidden>
            <CircleAlertIcon className="size-3" aria-hidden />
            {count}
          </span>
        )}
      </button>
    </div>
  );
}

/** Group header: project color, name, tab count; a collapsed group shows its most urgent tab state. */
function GroupChip({ cwd, ids, hiddenIds, info, collapsed, onToggle, onMoveTo, onCloseGroup, move, menu }: { onCloseGroup: () => void; move: { left: boolean; right: boolean; by: (by: -1 | 1) => void }; menu?: { activeId?: string; onSelect: (id: string) => void; onClose: (id: string) => void }; onMoveTo: (from: string, to: string) => void; cwd: string; ids: string[]; hiddenIds: string[]; info: (id: string) => TabInfo; collapsed: boolean; onToggle: () => void }) {
  const first = info(ids[0]!);
  const c = avatarColor(first.groupColor ?? cwd, use(AvatarColors));
  const states = hiddenIds.map((id) => status(id, info(id)));
  const urgent = states.includes("needs_input") ? "needs_input" : states.includes("running") ? "running" : states.includes("unread") ? "unread" : undefined;
  const name = first.groupLabel ?? projectName(cwd);
  const sub = first.groupSub;
  const pathId = useId();
  const shown = collapsed || !!menu;
  const [open, setOpen] = useState(false);
  const props = {
    "aria-describedby": pathId,
    "aria-label": `${name}${sub ? ` (${sub})` : ""}, ${ids.length} ${ids.length === 1 ? "tab" : "tabs"}${urgent ? `, ${STATUS_LABEL[urgent]}` : ""}`,
    "data-group-chip": cwd,
    "data-testid": "tab-group-chip",
    className: "flex h-6 max-w-40 shrink-0 cursor-pointer items-center gap-1 rounded-md bg-[color-mix(in_oklab,var(--av)_18%,var(--background))] px-1.5 font-medium text-foreground text-xs shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--av)_60%,transparent)] outline-none focus-visible:ring-2 focus-visible:ring-ring",
    style: { "--av": `var(--avatar-${c})` } as CSSProperties,
    draggable: true,
    // Middle click closes the group; its mousedown would start autoscroll (and must not open the compact menu).
    onMouseDown: (e: ReactMouseEvent) => e.button === 1 && e.preventDefault(),
    onAuxClick: (e: ReactMouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      onCloseGroup();
    },
    onDragStart: (e: DragEvent) => {
      setOpen(false);
      e.dataTransfer.setData(GROUP_DRAG_TYPE, cwd);
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(GROUP_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDrop: (e: DragEvent) => {
      const from = e.dataTransfer.getData(GROUP_DRAG_TYPE);
      if (!from) return;
      e.preventDefault();
      onMoveTo(from, cwd);
    },
  };
  const body = (
    <>
      <ChevronDownIcon className={cn("size-3 shrink-0 transition-transform", shown && "-rotate-90")} aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
      <span className="tabular-nums" aria-hidden>{ids.length}</span>
      {shown && urgent === "running" && <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" data-icon="running" aria-hidden />}
      {shown && urgent === "needs_input" && <CircleAlertIcon className="size-3.5 shrink-0" data-icon="needs_input" aria-hidden />}
      {shown && urgent === "unread" && <span data-dot="unread" className="size-1.5 shrink-0 rounded-full bg-info" aria-hidden />}
    </>
  );
  if (menu)
    // Compact: a menu button (click, Enter, Space, ArrowDown; hover after CHIP_HOVER_DELAY_MS). A path tooltip would fight the hover menu, so the menu header carries name and path.
    return (
      // Not modal: a modal menu opened by the press puts a backdrop over the other chips, and a chip drag could not drop. A drag start closes the menu.
      <Menu.Root modal={false} open={open} onOpenChange={setOpen}>
        <Menu.Trigger {...props} openOnHover delay={CHIP_HOVER_DELAY_MS}>
          {body}
        </Menu.Trigger>
        <span id={pathId} hidden>{cwd}</span>
        <Menu.Portal>
          <Menu.Positioner align="start" sideOffset={4} className="z-50">
            <Menu.Popup className={cn(POPUP, "max-w-80")} data-testid="tab-group-menu">
              <div className="flex flex-col px-2 py-1 text-xs" aria-hidden>
                <span className="font-medium">{sub ?? name}</span>
                <span className="truncate text-muted-foreground">{cwd}</span>
              </div>
              {ids.map((id) => {
                const t = info(id);
                const s = status(id, t);
                const label = stateNote(t) || STATUS_LABEL[s];
                return (
                  <Menu.Item
                    key={id}
                    className={cn(ITEM, "gap-2")}
                    aria-current={id === menu.activeId ? "true" : undefined}
                    data-menu-tab={id}
                    onClick={() => menu.onSelect(id)}
                    // Middle click closes the tab, like on the tab itself; the menu stays open.
                    onMouseDown={(e) => e.button === 1 && e.preventDefault()}
                    onAuxClick={(e) => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      menu.onClose(id);
                    }}
                  >
                    <TabIcon s={s} cwd={t.cwd} />
                    {t.titleLoading ? <TitleSkeleton title={t.title} /> : <span className={cn("min-w-0 flex-1 truncate", id === menu.activeId && "font-medium")}>{t.title}</span>}
                    {label && <span className="text-muted-foreground text-xs leading-none">{label}</span>}
                  </Menu.Item>
                );
              })}
              <Menu.Separator className="-mx-1 my-1 h-px bg-border" />
              <Menu.Item className={ITEM} data-testid="tab-group-close" onClick={onCloseGroup}>
                Close group
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    );
  return (
    // Right click (long press on touch): the menu the compact chip has, for a chip whose click collapses.
    <ContextMenu.Root>
      <ContextMenu.Trigger className="contents">
        <Tooltip>
          <TooltipTrigger aria-expanded={!collapsed} {...props} onClick={onToggle}>
            {body}
          </TooltipTrigger>
          <span id={pathId} hidden>{cwd}</span>
          <TooltipContent className="flex-col items-start gap-0.5">
            <span className="font-medium">{sub ?? name}</span>
            <span className="break-all opacity-80">{cwd}</span>
          </TooltipContent>
        </Tooltip>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className={POPUP} data-testid="tab-group-menu">
            <ContextMenu.Item className={ITEM} onClick={onToggle}>
              {collapsed ? "Expand group" : "Collapse group"}
            </ContextMenu.Item>
            <ContextMenu.Item className={ITEM} disabled={!move.left} onClick={() => move.by(-1)}>
              Move group left
            </ContextMenu.Item>
            <ContextMenu.Item className={ITEM} disabled={!move.right} onClick={() => move.by(1)}>
              Move group right
            </ContextMenu.Item>
            <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />
            <ContextMenu.Item className={ITEM} data-testid="tab-group-close" onClick={onCloseGroup}>
              Close group
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// A tab re-renders only when what it shows changes (info by value), not for App's new closures and info objects on every render.
const MemoTab = memo(Tab, (a, b) =>
  (Object.keys(b) as (keyof typeof b)[]).every((k) => (k === "t" ? (Object.keys(b.t) as (keyof TabInfo)[]).every((f) => a.t[f] === b.t[f]) : a[k] === b[k])),
);
function StableTab(props: ComponentProps<typeof Tab>) {
  return <MemoTab {...useStableProps(props)} />;
}

function Tab({
  id,
  t,
  active,
  focusable,
  first,
  last,
  onSelect,
  onClose,
  onMove,
  onMenuMove,
  onMenuClose,
  renaming,
  onAction,
  onRenamed,
}: {
  id: string;
  t: TabInfo;
  active: boolean;
  focusable: boolean;
  first: boolean;
  last: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (from: string, to: string) => void;
  onMenuMove: (by: -1 | 1) => void;
  onMenuClose: () => void;
  renaming: boolean;
  onAction: (a: SessionAction) => void;
  onRenamed: (title: string | undefined) => void;
}) {
  const s = status(id, t);
  const session = id !== NEW_TAB;
  const dragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const button = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  // Dismissed (Escape, outside click): back to this tab; the trigger div is not focusable. Move and Close tab already focused a tab (refocus),
  // Rename and Delete… focused the title editor or the dialog: leave those. A closed tab has no button: nothing to do.
  const finalFocus = () => {
    const a = document.activeElement;
    return (!a || a === document.body || !!popup.current?.contains(a)) && (button.current ?? false);
  };
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger
        className={cn(
          "group relative flex h-7 w-56 min-w-24 max-w-56 shrink items-center rounded-md transition-colors",
          // OpenCode separator: 1.5×12px bar 3.75px left of each tab, hidden at the first tab and beside the active or hovered one.
          "before:-left-[3.75px] before:absolute before:top-2 before:h-3 before:w-[1.5px] before:rounded-full before:bg-tab-separator data-first:before:hidden hover:before:hidden data-active:before:hidden [:hover+&]:before:hidden [[data-active]+&]:before:hidden",
          active ? "bg-secondary" : "hover:bg-secondary/70",
        )}
        data-active={active || undefined}
        data-first={first || undefined}
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={dragOver}
        onDrop={(e) => {
          const from = e.dataTransfer.getData(DRAG_TYPE);
          if (!from) return;
          e.preventDefault();
          onMove(from, id);
        }}
        // Middle click closes; its mousedown would start autoscroll.
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onAuxClick={(e) => e.button === 1 && onClose(id)}
        data-testid="tab"
        data-tab-id={id}
        data-state={s}
        title={[STATUS_LABEL[s] ? `${t.title} (${STATUS_LABEL[s]})` : t.title, t.worktree, t.cwd].filter(Boolean).join("\n")}
      >
        {renaming ? (
          <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-1 pl-1.5">
            <TabIcon s={s} cwd={t.cwd} />
            <RenameInput title={t.title} onDone={onRenamed} />
          </div>
        ) : (
          <button
            ref={button}
            role="tab"
            aria-selected={active}
            tabIndex={focusable ? 0 : -1}
            aria-label={STATUS_LABEL[s] ? `${t.title}, ${STATUS_LABEL[s]}` : undefined}
            className={cn(
              "flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md pr-7 pl-1.5 text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              active ? "text-foreground" : "text-muted-foreground",
            )}
            onClick={() => onSelect(id)}
            // OpenCode: double click on the title renames.
            onDoubleClick={() => session && t.transcript !== false && onAction("rename")}
          >
            <TabIcon s={s} cwd={t.cwd} />
            {t.titleLoading ? <TitleSkeleton title={t.title} /> : <span className="truncate leading-4">{t.title}</span>}
          </button>
        )}
        {!renaming && (
          <button
            aria-label={`Close ${t.title}`}
            // Out of the Tab order (roving tabindex); Delete on the tab closes it.
            tabIndex={-1}
            className={cn(
              "absolute top-0.5 right-0.5 grid size-6 cursor-pointer place-items-center rounded-sm text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset group-hover:opacity-100",
              active ? "opacity-100" : "opacity-0",
            )}
            onClick={() => onClose(id)}
            data-testid="tab-close"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup ref={popup} finalFocus={finalFocus} className={POPUP}>
            <ContextMenu.Item className={ITEM} disabled={first} onClick={() => onMenuMove(-1)}>
              Move left
            </ContextMenu.Item>
            <ContextMenu.Item className={ITEM} disabled={last} onClick={() => onMenuMove(1)}>
              Move right
            </ContextMenu.Item>
            <ContextMenu.Item className={ITEM} onClick={onMenuClose}>
              Close tab
            </ContextMenu.Item>
            {session && (
              <>
                <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />
                <Items
                  kind="context"
                  target={{ title: t.title, archived: !!t.archived, busy: t.state === "running" || t.state === "needs_input", transcript: t.transcript !== false }}
                  onAction={onAction}
                />
              </>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The look of an icon button; `aria-disabled` keeps it focusable and its tooltip readable. */
export const ICON_BUTTON =
  "grid size-7 shrink-0 cursor-pointer place-items-center max-md:size-11 pointer-coarse:size-11 rounded-md text-faint outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-secondary aria-pressed:text-foreground aria-expanded:bg-secondary aria-expanded:text-foreground aria-expanded:shadow-[inset_0_-2px_0_var(--foreground)] [&_svg]:size-4 aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-faint";

export function IconButton({
  label,
  onClick,
  children,
  className,
  testId,
  command,
  pressed,
  expanded,
  controls,
  disabled,
  ref,
}: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  /** The app command (shortcuts registry id) the button runs: the guided tour spotlights it by this. */
  command?: string;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  /** Looks and acts disabled but stays focusable (`aria-disabled`); put the reason in `label`. */
  disabled?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      aria-disabled={disabled || undefined}
      className={cn(ICON_BUTTON, className)}
      onClick={disabled ? undefined : onClick}
      data-testid={testId}
      data-command={command}
    >
      {children}
    </button>
  );
}
