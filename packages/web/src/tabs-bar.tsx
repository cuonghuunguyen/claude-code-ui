// Titlebar tabs (OpenCode titlebar-tab-strip): avatar + title + close; middle click closes, drag reorders, overflow scrolls.
// Reorder without drag (WCAG 2.5.7): Alt+Shift+Arrow or Ctrl+Shift+PageUp/PageDown on a focused tab, or the tab context menu.
// Below md the strip collapses into a switcher (native select over the active tab).
import { createContext, use, useEffect, useRef, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { ChevronDownIcon, CircleAlertIcon, Grid2x2PlusIcon, LoaderCircleIcon, PlusIcon, SquarePenIcon, XIcon } from "lucide-react";
import type { SessionState } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import { NEW_TAB, avatarColor, closeTab, projectName, type AvatarColor } from "./tabs.ts";
import { ITEM, Items, POPUP, RenameInput, type SessionAction } from "./session-actions.tsx";

export type TabInfo = { title: string; cwd?: string; state?: SessionState; unread: boolean; archived?: boolean; transcript?: boolean };
type TabStatus = "new" | "running" | "needs_input" | "unread" | "idle";

const status = (id: string, t: TabInfo): TabStatus =>
  id === NEW_TAB ? "new" : t.state === "running" ? "running" : t.state === "needs_input" ? "needs_input" : t.unread ? "unread" : "idle";

const STATUS_LABEL: Record<TabStatus, string> = { new: "", running: "running", needs_input: "needs input", unread: "unread", idle: "" };

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

export function TabsBar({
  tabs,
  activeId,
  info,
  onSelect,
  onClose,
  onMove,
  onNew,
  home,
  onHome,
  renaming,
  onAction,
  onRenamed,
}: {
  tabs: string[];
  activeId?: string;
  info: (id: string) => TabInfo;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (from: string, to: string) => void;
  onNew: () => void;
  /** Home button (OpenCode grid-plus, md and up): aria-pressed while the sessions sidebar shows; no pressed fill, as OpenCode fills it only on its Home page. */
  home?: boolean;
  onHome?: () => void;
  /** Session tab that shows the title editor. */
  renaming?: string;
  onAction: (id: string, a: SessionAction) => void;
  onRenamed: (id: string, title: string | undefined) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  // Tab to focus once the parent applied a keyboard close or move; none left → the New session button.
  const refocus = useRef<{ id?: string }>(undefined);
  useEffect(() => {
    const r = refocus.current;
    refocus.current = undefined;
    if (!r) return;
    (r.id ? strip.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(r.id)}"] [role="tab"]`) : newButton.current)?.focus();
  }, [tabs]);
  const closeKeepFocus = (id: string) => {
    refocus.current = { id: closeTab(tabs, id, activeId ?? id).active };
    onClose(id);
  };
  const moveBy = (id: string, by: -1 | 1) => {
    const to = tabs[tabs.indexOf(id) + by];
    if (!to) return;
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
  }, [activeId, tabs.length]);
  const active = activeId ? info(activeId) : undefined;
  // Only one tab is in the Tab order; arrows, Home and End move between tabs (WAI-ARIA tabs, automatic activation). Delete closes.
  const focusable = activeId && tabs.includes(activeId) ? activeId : tabs[0];
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const id = target.closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
    const at = id ? tabs.indexOf(id) : -1;
    if (at < 0 || target.getAttribute("role") !== "tab") return;
    if (e.key === "Delete") return closeKeepFocus(id!);
    const by =
      e.altKey && e.shiftKey ? { ArrowLeft: -1, ArrowRight: 1 }[e.key] : e.ctrlKey && e.shiftKey ? { PageUp: -1, PageDown: 1 }[e.key] : undefined;
    if (by) {
      e.preventDefault();
      return moveBy(id!, by as -1 | 1);
    }
    const n = tabs.length;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1 + n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = tabs[to % n]!;
    onSelect(next);
    strip.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(next)}"] [role="tab"]`)?.focus();
  };

  return (
    // Below md: 44px hit areas, 8px apart (touch-target-size, touch-spacing).
    <div className="flex min-w-0 flex-1 items-center gap-1.5 max-md:gap-2">
      {onHome && (
        <IconButton className="w-9! max-md:hidden aria-pressed:bg-transparent aria-pressed:text-faint aria-pressed:hover:bg-accent aria-pressed:hover:text-foreground" label="Home" onClick={onHome} pressed={home} testId="tab-home">
          <Grid2x2PlusIcon />
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
        {tabs.map((id, i) => (
          <Tab
            key={id}
            id={id}
            t={info(id)}
            active={id === activeId}
            focusable={id === focusable}
            first={i === 0}
            last={i === tabs.length - 1}
            onSelect={onSelect}
            onClose={onClose}
            onMove={onMove}
            onMenuMove={(by) => moveBy(id, by)}
            onMenuClose={() => closeKeepFocus(id)}
            renaming={renaming === id}
            onAction={(a) => onAction(id, a)}
            onRenamed={(title) => onRenamed(id, title)}
          />
        ))}
      </div>
      {tabs.length > 0 && (
        <div className="relative flex h-7 min-w-0 flex-1 rounded-md max-md:h-11 has-focus-visible:ring-2 has-focus-visible:ring-ring md:hidden">
          <div
            className="pointer-events-none flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-secondary px-1.5 font-medium max-md:my-2"
            aria-hidden
          >
            {active && activeId ? <TabIcon s={status(activeId, active)} cwd={active.cwd} /> : null}
            <span className="truncate">{active?.title ?? "Open tabs"}</span>
            <span className="ml-auto text-muted-foreground tabular-nums">{tabs.length}</span>
            <ChevronDownIcon className="size-4 shrink-0 text-faint" />
          </div>
          <select
            aria-label="Switch tab"
            data-testid="tab-switcher"
            className="absolute inset-0 cursor-pointer text-base opacity-0"
            value={activeId ?? ""}
            onChange={(e) => onSelect(e.target.value)}
          >
            {!activeId && <option value="">Open tabs</option>}
            {tabs.map((id) => {
              const t = info(id);
              const label = STATUS_LABEL[status(id, t)];
              return (
                <option key={id} value={id}>
                  {t.title}
                  {label && ` (${label})`}
                </option>
              );
            })}
          </select>
        </div>
      )}
      {activeId && (
        <IconButton className="md:hidden" label={`Close ${active?.title ?? "tab"}`} onClick={() => onClose(activeId)} testId="tab-close-active">
          <XIcon />
        </IconButton>
      )}
      <IconButton label="New session" onClick={onNew} testId="tab-new" ref={newButton}>
        <PlusIcon />
      </IconButton>
    </div>
  );
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
          "before:-left-[3.75px] before:absolute before:top-2 before:h-3 before:w-[1.5px] before:rounded-full before:bg-tab-separator first:before:hidden hover:before:hidden data-active:before:hidden [:hover+&]:before:hidden [[data-active]+&]:before:hidden",
          active ? "bg-secondary" : "hover:bg-secondary/70",
        )}
        data-active={active || undefined}
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
        title={[STATUS_LABEL[s] ? `${t.title} (${STATUS_LABEL[s]})` : t.title, t.cwd].filter(Boolean).join("\n")}
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
            <span className="truncate leading-4">{t.title}</span>
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

export function IconButton({
  label,
  onClick,
  children,
  className,
  testId,
  pressed,
  ref,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  pressed?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        "grid size-7 shrink-0 cursor-pointer place-items-center max-md:size-11 pointer-coarse:size-11 rounded-md text-faint outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-secondary aria-pressed:text-foreground [&_svg]:size-4",
        className,
      )}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
