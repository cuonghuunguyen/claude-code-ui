// Titlebar tabs (OpenCode titlebar-tab-strip): avatar + title + close; middle click closes, drag reorders, overflow scrolls.
// Below md the strip collapses into a switcher (native select over the active tab).
import { useEffect, useRef, type CSSProperties, type DragEvent } from "react";
import { ChevronDownIcon, CircleAlertIcon, LoaderCircleIcon, PlusIcon, SquarePenIcon, XIcon } from "lucide-react";
import type { SessionState } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import { NEW_TAB, avatarColor, projectName } from "./tabs.ts";

export type TabInfo = { title: string; cwd?: string; state?: SessionState; unread: boolean };
type TabStatus = "new" | "running" | "needs_input" | "unread" | "idle";

const status = (id: string, t: TabInfo): TabStatus =>
  id === NEW_TAB ? "new" : t.state === "running" ? "running" : t.state === "needs_input" ? "needs_input" : t.unread ? "unread" : "idle";

const STATUS_LABEL: Record<TabStatus, string> = { new: "", running: "running", needs_input: "needs input", unread: "unread", idle: "" };

/** 16px project initial on the project's color (OpenCode project-avatar-v2). */
export function ProjectAvatar({ cwd, unread }: { cwd: string; unread?: boolean }) {
  const c = avatarColor(cwd);
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
}: {
  tabs: string[];
  activeId?: string;
  info: (id: string) => TabInfo;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (from: string, to: string) => void;
  onNew: () => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current?.querySelector('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);
  const active = activeId ? info(activeId) : undefined;

  return (
    // Below md: 44px hit areas, 8px apart (touch-target-size, touch-spacing).
    <div className="flex min-w-0 flex-1 items-center gap-1.5 max-md:gap-2">
      <div
        ref={strip}
        role="tablist"
        aria-label="Open sessions"
        className="hidden min-w-0 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] md:flex [&::-webkit-scrollbar]:hidden"
        data-testid="tab-strip"
        // A vertical wheel scrolls the strip sideways, like a browser tab strip.
        onWheel={(e) => !e.deltaX && (e.currentTarget.scrollLeft += e.deltaY)}
      >
        {tabs.map((id) => (
          <Tab key={id} id={id} t={info(id)} active={id === activeId} onSelect={onSelect} onClose={onClose} onMove={onMove} />
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
      <IconButton label="New session" onClick={onNew} testId="tab-new">
        <PlusIcon />
      </IconButton>
    </div>
  );
}

function Tab({
  id,
  t,
  active,
  onSelect,
  onClose,
  onMove,
}: {
  id: string;
  t: TabInfo;
  active: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (from: string, to: string) => void;
}) {
  const s = status(id, t);
  const dragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  return (
    <div
      className={cn(
        "group relative flex h-7 w-56 min-w-24 max-w-56 shrink items-center rounded-md transition-colors",
        active ? "bg-secondary" : "hover:bg-secondary/70",
      )}
      draggable
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
      <button
        role="tab"
        aria-selected={active}
        aria-label={STATUS_LABEL[s] ? `${t.title}, ${STATUS_LABEL[s]}` : undefined}
        className={cn(
          "flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-7 pl-1.5 text-left font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          active ? "text-foreground" : "text-muted-foreground",
        )}
        onClick={() => onSelect(id)}
      >
        <TabIcon s={s} cwd={t.cwd} />
        <span className="truncate leading-4">{t.title}</span>
      </button>
      <button
        aria-label={`Close ${t.title}`}
        className={cn(
          "absolute top-0.5 right-0.5 grid size-6 place-items-center rounded-sm text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset group-hover:opacity-100",
          active ? "opacity-100" : "opacity-0",
        )}
        onClick={() => onClose(id)}
        data-testid="tab-close"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  className,
  testId,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  pressed?: boolean;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={cn(
        "grid size-7 shrink-0 place-items-center max-md:size-11 rounded-md text-faint outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-secondary aria-pressed:text-foreground [&_svg]:size-4",
        className,
      )}
      onClick={onClick}
      data-testid={testId}
    >
      {children}
    </button>
  );
}
