// Sidebar session list (docs/spec.md "Layout"): one collapsible group per known project (per repository), its worktrees as collapsible rows; search by title, project name or branch.
import { SideBadge, SideLabel } from "./sides.tsx";
import { Fragment, memo, use, useEffect, useRef, useState } from "react";
import { useNarrow } from "@/lib/use-narrow.ts";
import { Menu } from "@base-ui/react/menu";
import { ArchiveIcon, ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, CircleAlertIcon, EllipsisVerticalIcon, LocateFixedIcon, FolderPlusIcon, GitBranchIcon, GitBranchPlusIcon, LoaderCircleIcon, LockIcon, SearchIcon, SquarePenIcon, Trash2Icon, UsersIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SessionListItem, SessionState, Worktree } from "@claude-ui/protocol";
import { cn, useStableProps } from "@/lib/utils";
import { TitleSkeleton } from "@/components/ui/skeleton";
import type { CleanupScope } from "./cleanup.ts";
import { activeOnly, activeWorkers, byDay, collapseKeys, groupByCwd, limitSessions, isWorkerKey, loadCollapsed, loadExpandedWorkers, loadSidebarView, VIEW_EVENT, MORE, removableWorktree, revealKeys, rowKey, SHOWN, saveCollapsed, saveExpandedWorkers, saveSidebarView, nestWorkers, classicGroup, parseSessionQuery, sortGroups, timeAgo, workerKey, worktreeName, type SessionGroup, type SidebarView, type WorktreeRow } from "./sessions.ts";
import { useNow } from "./plan-meter.tsx";
import { projectName } from "./tabs.ts";
import { ICON_BUTTON, IconButton, ProjectAvatar } from "./tabs-bar.tsx";
import { ITEM, POPUP, RenameInput, SessionContextMenu, SessionMenu, type ActionTarget, type SessionAction } from "./session-actions.tsx";
import { CHECK_ITEM, RowContextMenu, RowMenu, Tick } from "./sidebar-menus.tsx";
import { groupEntries, groupSessions, idleTargets, workerCounts, workerEntries } from "./sidebar-menus.ts";
import { useKeyContextMenu } from "./context-menu-key.ts";

/** What follows the last `/` or `\` (a branch tail, a folder name). */
const lastSegment = (p: string) => p.split(/[\\/]/).pop()!;

/** Only states that need attention get an indicator; idle, error and closed rows stay plain. */
function StateIcon({ state }: { state: SessionState }) {
  if (state === "running") return <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-faint motion-reduce:animate-none" aria-hidden />;
  if (state === "needs_input") return <CircleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />;
  return null;
}

const STATE_LABEL: Partial<Record<SessionState, string>> = { running: "running", needs_input: "needs input" };
const WORKER_STATE: Record<SessionState, string> = { running: "running", idle: "idle", needs_input: "needs input", error: "error", closed: "closed" };
/** Left padding by depth: project group, worktree row or workers of a group, workers of a worktree row. */
const PAD = ["pl-7", "pl-12", "pl-17"] as const;
type Depth = 0 | 1 | 2;

/** The empty-list text for a search: names the project of an `@project=` token. */
function emptySearch(query: string, archived: boolean, projects: string[]) {
  const { project, text } = parseSessionQuery(query);
  const kind = archived ? "archived session" : "session";
  if (!project) return `No ${kind} title, project or branch matches "${text}".`;
  if (!projects.some((p) => projectName(p).toLowerCase() === project.toLowerCase())) return `No project named "${project}".`;
  return text ? `No ${kind} in ${project} matches "${text}".` : `No ${kind} in ${project}.`;
}

/** IntelliJ-style options of the sidebar (kebab in the Projects header): behavior, what shows, grouping, project order; below md also Expand all / Collapse all. */
function SidebarOptions({ view, onView, archived, onArchived, onExpand, onCollapse, treeHint, narrow }: { view: SidebarView; onView: (v: Partial<SidebarView>) => void; archived: boolean; onArchived: (on: boolean) => void; onExpand: () => void; onCollapse: () => void; treeHint: string; narrow: boolean }) {
  const check = (label: string, on: boolean, set: (on: boolean) => void, testId: string) => (
    <Menu.CheckboxItem className={CHECK_ITEM} checked={on} onCheckedChange={set} data-testid={testId}>
      <Tick on={on} />
      {label}
    </Menu.CheckboxItem>
  );
  return (
    <Menu.Root>
      <Menu.Trigger aria-label="Sidebar options" title="Sidebar options" className={ICON_BUTTON} data-testid="sidebar-options">
        <EllipsisVerticalIcon aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={POPUP} data-testid="sidebar-options-menu">
            {narrow && (
              <>
                <Menu.Item className={ITEM} disabled={!!treeHint} onClick={onExpand} data-testid="sidebar-menu-expand-all">
                  Expand all{treeHint}
                </Menu.Item>
                <Menu.Item className={ITEM} disabled={!!treeHint} onClick={onCollapse} data-testid="sidebar-menu-collapse-all">
                  Collapse all{treeHint}
                </Menu.Item>
                <Menu.Separator className="my-1 h-px bg-border" />
              </>
            )}
            <Menu.Group>
              <Menu.GroupLabel className="px-2 py-1 text-muted-foreground text-xs">Behavior</Menu.GroupLabel>
              {check("Always select active session", view.alwaysSelect, (alwaysSelect) => onView({ alwaysSelect }), "sidebar-opt-always-select")}
            </Menu.Group>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Group>
              <Menu.GroupLabel className="px-2 py-1 text-muted-foreground text-xs">Show</Menu.GroupLabel>
              {check("Archived sessions", archived, onArchived, "sidebar-opt-archived")}
              {check("Day headers", view.dayHeaders, (dayHeaders) => onView({ dayHeaders }), "sidebar-opt-day-headers")}
              {check("Only active sessions", view.onlyActive, (onlyActive) => onView({ onlyActive }), "sidebar-opt-only-active")}
            </Menu.Group>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Group>
              <Menu.GroupLabel className="px-2 py-1 text-muted-foreground text-xs">Group by</Menu.GroupLabel>
              <Menu.RadioGroup value={view.layout} onValueChange={(layout) => onView({ layout: layout as SidebarView["layout"] })}>
                {(["default", "classic"] as const).map((v) => (
                  <Menu.RadioItem key={v} value={v} className={CHECK_ITEM} closeOnClick data-testid={`sidebar-opt-group-${v === "default" ? "worktree" : "project"}`}>
                    <Tick on={view.layout === v} />
                    {v === "default" ? "Worktree" : "Project"}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Group>
              <Menu.GroupLabel className="px-2 py-1 text-muted-foreground text-xs">Sort projects</Menu.GroupLabel>
              <Menu.RadioGroup value={view.sort} onValueChange={(sort) => onView({ sort: sort as SidebarView["sort"] })}>
                {(["recent", "name"] as const).map((v) => (
                  <Menu.RadioItem key={v} value={v} className={CHECK_ITEM} closeOnClick data-testid={`sidebar-opt-sort-${v}`}>
                    <Tick on={view.sort === v} />
                    {v === "recent" ? "Recent activity" : "Name"}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function SessionList({
  list,
  projects,
  worktrees,
  state,
  titleLoading,
  unread,
  activeId,
  onOpen,
  onNew,
  onRemove,
  onNewWorktree,
  onRemoveWorktree,
  onWarmWorktree,
  removing,
  onCleanUp,
  onOpenProject,
  renaming,
  renamingFromMenu,
  onAction,
  onRenamed,
  search,
  reveal: revealSeq,
  openTabs,
  onWorkers,
  onCopy,
  onArchiveIdle,
}: {
  list: SessionListItem[];
  /** Known project cwds from the daemon, newest first; a project with no session still gets a group. */
  projects: string[];
  /** Git worktrees of each project (session.list); a repository with linked ones shows a row per worktree. */
  worktrees?: Record<string, Worktree[]>;
  /** Live state of a session, falling back to its list state. */
  state: (s: SessionListItem) => SessionState;
  /** Title still a placeholder after a prompt (GH-133): the row shows a skeleton. */
  titleLoading?: (s: SessionListItem) => boolean;
  unread: Set<string>;
  activeId?: string;
  onOpen: (id: string) => void;
  /** New session in this project or worktree, without a directory picker. */
  onNew: (cwd: string) => void;
  /** Removes the project from the list; files stay. */
  onRemove: (cwd: string) => void;
  /** New worktree in the project's repository: the Create worktree modal; `quick`: Shift+click or menu "New worktree", at once with a generated name. */
  onNewWorktree?: (cwd: string, quick: boolean) => void;
  /** Remove a linked worktree inside the roots that is not locked (the app confirms first). */
  onRemoveWorktree?: (project: string, path: string) => void;
  /** Pointer enter or focus on a worktree's trash button: the app reads its status ahead (GH-463). */
  onWarmWorktree?: (project: string, path: string) => void;
  /** This page removes the worktree now (the list's `removing` flag covers other clients and reloads). */
  removing?: (path: string) => boolean;
  /** Opens the Clean up dialog (GH-377) for a project's repository or a coordinator's workers. */
  onCleanUp?: (scope: CleanupScope) => void;
  onOpenProject: () => void;
  /** Session whose row shows the title editor. */
  renaming?: string;
  /** The editor was opened from a menu (RenameInput `fromMenu`). */
  renamingFromMenu?: boolean;
  onAction: (id: string, a: SessionAction) => void;
  /** New title, or undefined when the edit was cancelled. */
  onRenamed: (id: string, title: string | undefined) => void;
  /** `/resume` (GH-100): each new `seq` puts `text` into the search box, focuses it and puts the caret at the end. */
  search?: { text: string; seq: number };
  /** Reveal in sidebar (tab menu, GH-359): each new value runs Select active session with focus. */
  reveal?: number;
  /** Sessions with an open tab (Close tab in the row menu). */
  openTabs?: ReadonlySet<string>;
  /** Close finished / Remove closed workers of a coordinator: the worker ids (the app confirms removals). */
  onWorkers?: (ids: string[], action: "close" | "remove", coordinator: { id: string; title: string }) => void;
  /** Copy path of a project or worktree row; the app copies and toasts. */
  onCopy?: (text: string, what: string) => void;
  /** Archive idle sessions older than `days` in `where` (a project or worktree name); the app confirms first. */
  onArchiveIdle?: (ids: string[], where: string, days: number) => void;
}) {
  const narrow = useNarrow();
  const sideOf = use(SideLabel);
  // Stable for the memo rows: a tab switch re-renders only the two rows whose active mark changes.
  // Relative times and day groups move on without a list refresh; a row re-renders only when its label changes.
  const now = useNow(60_000, true);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!search) return;
    setQuery(search.text);
    const input = searchRef.current;
    input?.focus();
    input?.setSelectionRange(search.text.length, search.text.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search?.seq]);
  const [archived, setArchived] = useState(false);
  const [view, setViewState] = useState(loadSidebarView);
  const setView = (patch: Partial<SidebarView>) => {
    const next = { ...loadSidebarView(), ...view, ...patch };
    setViewState(next);
    saveSidebarView(next);
  };
  // Settings > Sidebar changes the same setting.
  useEffect(() => {
    const sync = () => setViewState(loadSidebarView());
    window.addEventListener(VIEW_EVENT, sync);
    return () => window.removeEventListener(VIEW_EVENT, sync);
  }, []);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  // Worker groups start collapsed: their keys live in an expanded set; projects and worktree rows in `collapsed`.
  const [expandedW, setExpandedW] = useState(loadExpandedWorkers);
  const toggle = (cwd: string) => {
    const [set, setSet, save] = isWorkerKey(cwd) ? ([expandedW, setExpandedW, saveExpandedWorkers] as const) : ([collapsed, setCollapsed, saveCollapsed] as const);
    const next = new Set(set);
    if (!next.delete(cwd)) next.add(cwd);
    save(next);
    setSet(next);
  };

  // Sessions shown per group or row key (not persisted); a row's id to focus once "Load more" has shown it.
  const [limits, setLimits] = useState<Record<string, number>>({});
  const focusId = useRef<string>(undefined);
  const listRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusId.current) listRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(focusId.current)}"]`)?.focus();
    focusId.current = undefined;
  });
  const nested = nestWorkers(list, archived);
  const workersAction = (id: string, a: SessionAction) => {
    if (a === "cleanup-workers") return onCleanUp?.({ kind: "coordinator", id, title: list.find((x) => x.id === id)?.title ?? "" });
    if (a !== "close-finished" && a !== "remove-closed") return onAction(id, a);
    const c = workerCounts(nested.workers.get(id) ?? [], state);
    onWorkers?.(a === "close-finished" ? c.finished : c.closed, a === "close-finished" ? "close" : "remove", { id, title: list.find((x) => x.id === id)?.title ?? "" });
  };
  const rowProps = useStableProps({ onOpen, onAction: workersAction, onRenamed });
  const cleanable = !!onCleanUp;
  const top = nested.top;
  const keepActive = (s: SessionListItem) => s.id === activeId || state(s) === "running" || state(s) === "needs_input";
  const shown = sortGroups(groupByCwd(top, query, projects, archived, worktrees, nested.workers), view.sort);
  // Only active sessions: a coordinator lists just its workers that qualify too.
  const searching = !!query.trim();
  // Search still finds every session, and the archived view lists archived ones only.
  const filtering = view.onlyActive && !searching && !archived;
  const workers = filtering ? activeWorkers(nested.workers, keepActive) : nested.workers;
  const filtered = filtering ? activeOnly(shown, nested.workers, keepActive) : undefined;
  const kept = filtered ? filtered.groups : shown;
  // Classic: the worktrees' sessions merge into the project's list (no worktree rows); `branches` labels those of a linked worktree.
  const classic = view.layout === "classic";
  const branches = new Map<string, string>();
  const groups = classic
    ? kept.map((g) => {
        const c = classicGroup(g);
        c.branch.forEach((b, id) => branches.set(id, b));
        return c.group;
      })
    : kept;
  // Menu targets come from the unfiltered, unsearched groups: search and Only active never shrink what an action covers.
  let unfiltered: SessionGroup[] | undefined;
  const baseGroup = (cwd: string) => (unfiltered ??= groupByCwd(nested.top, "", projects, archived, worktrees, nested.workers)).find((g) => g.cwd === cwd);
  const idle = (sessions: SessionListItem[], days: number) => idleTargets(sessions, nested.workers, { days, now: Date.now(), activeId, state });
  const menuBase = (sessions: () => SessionListItem[], where: string, prefix: string) => ({
    prefix,
    archivedView: archived,
    onlyActive: view.onlyActive,
    setOnlyActive: (onlyActive: boolean) => setView({ onlyActive }),
    archiveCount: (days: number) => idle(sessions(), days).length,
    onArchive: (days: number) => onArchiveIdle?.(idle(sessions(), days), where, days),
  });
  /** Menu of a project row: context menu (prefix group-menu-) and kebab below md (project-menu-). */
  const groupMenu = (g: SessionGroup, prefix: string) => () =>
    groupEntries({
      ...menuBase(() => groupSessions(baseGroup(g.cwd) ?? g), projectName(g.cwd), prefix),
      newSession: () => onNew(g.cwd),
      copyPath: onCopy && (() => onCopy(g.cwd, "path")),
      newWorktree: onNewWorktree && worktrees?.[g.cwd]?.some((w) => w.main && !w.outsideRoots) ? (quick) => onNewWorktree(g.cwd, quick) : undefined,
      cleanUp: onCleanUp && (() => onCleanUp({ kind: "project", cwd: g.cwd })),
      tail: { id: `${prefix}remove`, label: "Remove from list (files stay)", onSelect: () => onRemove(g.cwd) },
    });
  const isBusy = (r: WorktreeRow) => !!(r.removing || removing?.(r.path));
  /** Menu of a worktree row. */
  const rowMenu = (g: SessionGroup, r: WorktreeRow, label: string, prefix: string) => () =>
    groupEntries({
      ...menuBase(() => (baseGroup(g.cwd)?.worktrees.find((x) => x.path === r.path) ?? r).sessions, label, prefix),
      newSession: r.outsideRoots || isBusy(r) ? undefined : () => onNew(r.path),
      copyPath: onCopy && (() => onCopy(r.path, "path")),
      tail: onRemoveWorktree && !isBusy(r) && removableWorktree(worktrees?.[g.cwd] ?? [], r) ? { id: `${prefix}remove`, label: "Delete worktree…", onSelect: () => onRemoveWorktree(g.cwd, r.path) } : undefined,
    });
  const activeSession = list.find((s) => s.id === activeId);
  // Select active session: open what hides the row (clearing a search or switching to the row's archived view first), then scroll to it; `focus`: move the focus to it.
  const [reveal, setReveal] = useState<{ id: string; focus: boolean }>();
  const activeKeys = (() => {
    if (!activeSession) return undefined;
    const a = activeSession.archived;
    const nv = nestWorkers(list, a);
    return revealKeys(activeSession.id, groupByCwd(nv.top, "", projects, a, worktrees, nv.workers), nv.workers, a);
  })();
  const revealActive = (focus: boolean) => {
    const keys = activeKeys;
    if (!activeSession || !keys) return;
    const a = activeSession.archived;
    if (focus) {
      setQuery("");
      setArchived(a);
    }
    setCollapsed((c) => {
      const next = new Set(c);
      for (const k of keys) next.delete(k);
      saveCollapsed(next);
      return next;
    });
    setExpandedW((c) => {
      const next = new Set([...c, ...keys.filter(isWorkerKey)]);
      saveExpandedWorkers(next);
      return next;
    });
    setReveal({ id: activeSession.id, focus });
  };
  const servedReveal = useRef(revealSeq);
  useEffect(() => {
    // One-shot: a value present at mount (the list remounts after a re-pair) was served already.
    if (revealSeq && revealSeq !== servedReveal.current) revealActive(true);
    servedReveal.current = revealSeq;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealSeq]);
  const known = !!activeKeys;
  useEffect(() => {
    if (view.alwaysSelect && known) revealActive(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.alwaysSelect, activeId, known]);
  useEffect(() => {
    if (!reveal) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(reveal.id)}"]`);
    row?.scrollIntoView({ block: "nearest" });
    if (reveal.focus) row?.focus();
    setReveal(undefined);
  }, [reveal]);
  const setAll = (update: (c: Set<string>) => Iterable<string>) =>
    setCollapsed((c) => {
      const next = new Set(update(c));
      saveCollapsed(next);
      return next;
    });
  // The other view's worker group keys stay as they are.
  const otherView = (k: string) => (archived ? k.startsWith("coordinator:") : k.startsWith("archived:"));
  const setWorkers = (update: (c: Set<string>) => Iterable<string>) =>
    setExpandedW((c) => {
      const next = new Set(update(c));
      saveExpandedWorkers(next);
      return next;
    });
  const allKeys = collapseKeys(groups, nested.workers, archived);
  const expandAll = () => {
    setAll(() => []);
    setWorkers((c) => [...c, ...allKeys.filter(isWorkerKey)]);
  };
  const collapseAll = () => {
    setAll((c) => [...c, ...allKeys.filter((k) => !isWorkerKey(k))]);
    setWorkers((c) => [...c].filter(otherView));
  };
  // While searching every match shows, also in collapsed groups and rows.
  const isOpen = (key: string) => searching || (isWorkerKey(key) ? expandedW.has(key) : !collapsed.has(key));
  const days = (all: SessionListItem[], depth: 0 | 1, key: string, name: string) => {
    key = archived ? `archived:${key}` : key;
    // While searching every match shows; the active, running and needs-input sessions always do.
    const { shown: sessions, hidden } = query.trim()
      ? { shown: all, hidden: undefined }
      : limitSessions(all, limits[key] ?? SHOWN, (s) => s.id === activeId || !!workers.get(s.id)?.some((w) => w.id === activeId) || state(s) === "running" || state(s) === "needs_input" || !!workers.get(s.id)?.some((w) => state(w) === "running" || state(w) === "needs_input"));
    return [
      ...(view.dayHeaders ? byDay(sessions, now) : sessions.length ? [{ title: "", sessions }] : []).map((day) => (
        <div key={day.title}>
          {/* OpenCode Home day label: 28px, muted, weight 440, aligned with the row titles. */}
          {day.title && (
            <h4 className={cn("flex h-7 items-center font-normal text-muted-foreground text-sm", PAD[depth])} data-testid="day-header">
              {day.title}
            </h4>
          )}
          <ul className="flex flex-col gap-0.5">
            {day.sessions.map((s) => {
              const ws = workers.get(s.id) ?? [];
              const k = workerKey(s.id, archived);
              const needs = ws.some((w) => state(w) === "needs_input");
              const counts = nested.workers.get(s.id) && workerCounts(nested.workers.get(s.id)!, state);
              const row = (x: SessionListItem, d: Depth, worker?: { workerName: string; place: string }) => (
                <SessionRow
                  key={x.id}
                  s={x}
                  ago={timeAgo(x.lastActivity, now)}
                  st={state(x)}
                  loading={!!titleLoading?.(x)}
                  unread={unread.has(x.id)}
                  active={x.id === activeId}
                  renaming={renaming === x.id}
                  menuRename={!!renamingFromMenu}
                  depth={d}
                  classic={classic}
                  branch={branches.get(x.id)}
                  tab={!!openTabs?.has(x.id)}
                  coordinator={!worker && !!counts}
                  finished={!worker && counts ? counts.finished.length : 0}
                  closedN={!worker && counts ? counts.closed.length : 0}
                  cleanable={cleanable}
                  {...worker}
                  {...rowProps}
                />
              );
              return (
                <Fragment key={s.id}>
                  {row(s, depth)}
                  {!!ws.length && (
                    <li>
                      <RowContextMenu
                        testId="workers-menu"
                        entries={() => {
                          const c = workerCounts(nested.workers.get(s.id) ?? [], state);
                          return workerEntries("workers-menu-", c, { close: () => onWorkers?.(c.finished, "close", { id: s.id, title: s.title }), remove: () => onWorkers?.(c.closed, "remove", { id: s.id, title: s.title }), cleanUp: onCleanUp && (() => onCleanUp({ kind: "coordinator", id: s.id, title: s.title })) });
                        }}
                      >
                      <button
                        className={cn("flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-muted-foreground text-xs outline-none transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none max-md:h-11 pointer-coarse:h-11", PAD[depth + 1])}
                        aria-expanded={isOpen(k)}
                        aria-label={`${ws.length === 1 ? "1 worker" : `${ws.length} workers`} of ${s.title}${needs ? ", needs input" : ""}`}
                        onClick={() => toggle(k)}
                        data-testid="worker-group-toggle"
                        data-needs-input={needs || undefined}
                      >
                        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-faint transition-transform motion-reduce:transition-none", isOpen(k) && "rotate-90")} aria-hidden />
                        <UsersIcon className="size-3.5 shrink-0 text-faint" aria-hidden />
                        <span>{ws.length === 1 ? "1 worker" : `${ws.length} workers`}</span>
                        {needs && (
                          <>
                            <CircleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden />
                            <span className="text-warning">needs input</span>
                          </>
                        )}
                      </button>
                      </RowContextMenu>
                      {isOpen(k) && <ul className="flex flex-col gap-0.5">{ws.map((w) => row(w, (depth + 1) as Depth, { workerName: w.workerName ?? w.title, place: worktreeName(w.cwd, worktrees) ?? projectName(w.cwd) }))}</ul>}
                    </li>
                  )}
                </Fragment>
              );
            })}
          </ul>
        </div>
      )),
      hidden && (
        <button
          key="more"
          className={cn("flex h-8 w-full items-center rounded-md text-left text-muted-foreground text-sm outline-none transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none max-md:h-11 pointer-coarse:h-11", PAD[depth])}
          onClick={() => {
            focusId.current = hidden.id;
            setLimits((l) => ({ ...l, [key]: (l[key] ?? SHOWN) + MORE }));
          }}
          aria-label={`Load more sessions in ${name}`}
          data-testid="load-more"
        >
          Load more
        </button>
      ),
    ];
  };
  const emptyText = filtering ? "No active sessions" : "No sessions yet";
  const treeHint = searching ? " (clear the search first)" : "";
  const header = (
    <div className="flex h-7 items-center pl-1.5 max-md:h-11">
      <h2 className="min-w-0 flex-1 truncate font-medium text-muted-foreground text-sm">Projects</h2>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="Open project" onClick={onOpenProject} testId="open-project">
          <FolderPlusIcon />
        </IconButton>
        {!!projects.length && (
          <>
            {!view.alwaysSelect && (
              <IconButton label={`Select active session${known ? "" : " (no active session in the list)"}`} disabled={!known} onClick={() => revealActive(true)} testId="sidebar-select-active">
                <LocateFixedIcon />
              </IconButton>
            )}
            {!narrow && (
              <>
                <IconButton label={`Expand all${treeHint}`} disabled={searching} onClick={expandAll} testId="sidebar-expand-all">
                  <ChevronsUpDownIcon />
                </IconButton>
                <IconButton label={`Collapse all${treeHint}`} disabled={searching} onClick={collapseAll} testId="sidebar-collapse-all">
                  <ChevronsDownUpIcon />
                </IconButton>
              </>
            )}
            <SidebarOptions view={view} onView={setView} archived={archived} onArchived={setArchived} onExpand={expandAll} onCollapse={collapseAll} treeHint={treeHint} narrow={narrow} />
          </>
        )}
      </div>
    </div>
  );
  if (!projects.length)
    return (
      <div className="flex flex-col gap-2">
        {header}
        <p className="px-1.5 text-muted-foreground text-sm">No projects yet. Add a project folder to start a session in it.</p>
        <Button variant="secondary" size="sm" className="mx-1.5 self-start max-md:h-11" onClick={onOpenProject} data-testid="empty-open-project">
          <FolderPlusIcon /> Add project
        </Button>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {header}
      <div className="flex items-center gap-1 max-md:gap-2">
        <label className="relative flex min-w-0 flex-1 items-center">
          <SearchIcon className="pointer-events-none absolute left-2 size-4 text-faint" aria-hidden />
          <input
            type="search"
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions"
            aria-label="Search sessions by title, project or branch (@project=name for one project)"
            className="h-8 w-full rounded-md bg-secondary/60 pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring max-md:h-11"
            data-testid="session-search"
          />
        </label>
        <IconButton
          label={archived ? "Show sessions" : "Show archived sessions"}
          pressed={archived}
          onClick={() => setArchived(!archived)}
          testId="archived-filter"
        >
          <ArchiveIcon />
        </IconButton>
      </div>
      {filtering && (
        <p className="flex items-center gap-2 px-1.5 text-muted-foreground text-xs max-md:min-h-11" data-testid="active-only-chip">
          <span>Active only · {filtered!.idleTotal} idle hidden</span>
          <button type="button" className="cursor-pointer rounded text-foreground underline outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 max-md:px-2" onClick={() => setView({ onlyActive: false })} data-testid="active-only-show-all">
            Show all
          </button>
        </p>
      )}
      <nav className="-mx-1 flex min-h-0 flex-col gap-2 overflow-y-auto px-1" aria-label="Sessions" data-testid="session-list" ref={listRef}>
        {archived && !!groups.length && (
          <p className="px-1.5 text-muted-foreground text-xs" data-testid="archived-caption">
            Archived sessions
          </p>
        )}
        {!groups.length && (
          <p className="px-1.5 text-muted-foreground text-sm">
            {query.trim()
              ? emptySearch(query, archived, projects)
              : archived
                ? "No archived sessions."
                : filtering
                  ? "No active sessions. Show all lists the idle ones."
                : "All sessions are archived."}
          </p>
        )}
        {groups.map((g) => {
          const open = isOpen(g.cwd);
          return (
            <section key={g.cwd} data-testid="session-group" data-cwd={g.cwd}>
              <RowContextMenu testId="group-menu" entries={groupMenu(g, "group-menu-")}>
              <h3 className="group/project relative">
                <button
                  className="flex h-7 w-full items-center gap-2 rounded-md pr-20 pl-1.5 text-left max-md:pr-26 pointer-coarse:pr-38 max-md:pointer-coarse:pr-26 text-muted-foreground text-sm outline-none transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none max-md:h-11"
                  aria-expanded={open}
                  aria-label={sideOf(g.cwd) ? `${projectName(g.cwd)} (${sideOf(g.cwd)!.label})` : undefined}
                  onClick={() => toggle(g.cwd)}
                  title={g.cwd}
                  data-testid="group-toggle"
                >
                  <ProjectAvatar cwd={g.cwd} />
                  <span className="min-w-0 truncate font-medium">{projectName(g.cwd)}</span>
                  <SideBadge cwd={g.cwd} short />
                  {filtering && !!g.idle && <span className="shrink-0 font-normal text-faint text-xs" data-testid="idle-count">+{g.idle} idle</span>}
                  <ChevronRightIcon className={cn("ml-auto size-4 shrink-0 text-faint transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
                </button>
                {/* OpenCode project row actions: shown on hover or focus; always on touch screens (no hover there), any width. */}
                <span className="absolute inset-y-0 right-0.5 flex items-center gap-0.5 opacity-100 transition-opacity group-focus-within/project:opacity-100 group-hover/project:opacity-100 motion-reduce:transition-none md:opacity-0 max-md:gap-2 pointer-coarse:gap-2 pointer-coarse:opacity-100">
                  {onNewWorktree && !narrow && worktrees?.[g.cwd]?.some((w) => w.main && !w.outsideRoots) && (
                    <IconButton label={`Create worktree in ${projectName(g.cwd)} (Shift+click: new worktree with a generated name)`} onClick={(e) => onNewWorktree(g.cwd, e.shiftKey)} testId="project-new-worktree" className="size-6">
                      <GitBranchPlusIcon />
                    </IconButton>
                  )}
                  <IconButton label={`New session in ${projectName(g.cwd)}`} onClick={() => onNew(g.cwd)} testId="project-new-session" className="size-6">
                    <SquarePenIcon />
                  </IconButton>
                  {narrow ? (
                    <RowMenu label={projectName(g.cwd)} testId="project-menu" entries={groupMenu(g, "project-menu-")} />
                  ) : (
                    <IconButton label={`Remove ${projectName(g.cwd)} from the list (files stay)`} onClick={() => onRemove(g.cwd)} testId="project-remove" className="size-6">
                      <XIcon />
                    </IconButton>
                  )}
                </span>
              </h3>
              </RowContextMenu>
              {open && !g.sessions.length && !g.worktrees.length && <p className="py-1 pl-7 text-muted-foreground text-sm">{emptyText}</p>}
              {open && days(g.sessions, 0, g.cwd, projectName(g.cwd))}
              {open &&
                g.worktrees.map((r) => {
                  const rowOpen = isOpen(rowKey(r.path));
                  const kind = r.main ? "local" : "worktree";
                  const branch = r.branch ?? lastSegment(r.path);
                  // Below md: only what follows the last "/" (the ticket part of "user/GH-1-fix"); the full name is the aria label and tooltip.
                  // Two rows of the project with the same tail (alice/fix, bob/fix) keep the full branch; counted on all its rows, not just the searched ones.
                  const sameTail = (worktrees?.[g.cwd] ?? g.worktrees).filter((w) => lastSegment(w.branch ?? lastSegment(w.path)) === lastSegment(branch)).length > 1;
                  const shortBranch = sameTail ? branch : lastSegment(branch);
                  const label = `${kind} : ${branch}`;
                  const busy = isBusy(r);
                  return (
                    <div key={r.path} data-testid="worktree-row" data-path={r.path}>
                      {/* OpenCode WorkspaceHeader: branch icon, "local : <branch>" / "worktree : <branch>", chevron; New session on hover. */}
                      <RowContextMenu testId="worktree-context-menu" entries={rowMenu(g, r, label, "worktree-context-")}>
                      <div className={cn("group/worktree relative", busy && "pointer-events-none opacity-50")} data-removing={busy || undefined} aria-busy={busy || undefined}>
                        <button
                          className="flex h-7 w-full items-center gap-2 rounded-md pr-14 pl-6 text-left text-muted-foreground text-sm outline-none transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none max-md:h-11 max-md:pr-26 pointer-coarse:pr-26"
                          aria-expanded={rowOpen}
                          onClick={() => toggle(rowKey(r.path))}
                          aria-label={narrow ? `${label}${r.outsideRoots ? " (outside the allowed roots)" : ""}` : undefined}
                          title={`${narrow ? `${label}\n` : ""}${r.outsideRoots ? `${r.path}: Outside the allowed roots (--roots)` : r.path}`}
                          data-testid="worktree-toggle"
                        >
                          {busy ? <LoaderCircleIcon className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden /> : <GitBranchIcon className="size-4 shrink-0 text-faint" aria-hidden />}
                          <span className="min-w-0 truncate font-medium">{narrow ? shortBranch : label}</span>
                          {busy && (
                            <span className="shrink-0 text-xs" data-testid="worktree-removing">
                              Removing…
                            </span>
                          )}
                          {!narrow && r.outsideRoots && <span className="sr-only">(outside the allowed roots)</span>}
                          <ChevronRightIcon className={cn("ml-auto size-4 shrink-0 text-faint transition-transform motion-reduce:transition-none", rowOpen && "rotate-90")} aria-hidden />
                        </button>
                        {/* Touch has no tooltip: outside the roots a lock takes New session's place (same slot, so the chevrons stay in one column). */}
                        {r.outsideRoots ? (
                          <span className="pointer-events-none absolute inset-y-0 right-0.5 flex items-center" aria-hidden>
                            <span className="grid size-6 place-items-center max-md:size-11 pointer-coarse:size-11">
                              <LockIcon className="size-4 text-faint" data-testid="worktree-outside" />
                            </span>
                          </span>
                        ) : (
                          <span className="absolute inset-y-0 right-0.5 flex items-center opacity-100 transition-opacity group-focus-within/worktree:opacity-100 group-hover/worktree:opacity-100 motion-reduce:transition-none md:opacity-0 max-md:gap-2 pointer-coarse:gap-2 pointer-coarse:opacity-100">
                            <IconButton label={`New session in ${label}`} onClick={() => onNew(r.path)} disabled={busy} testId="worktree-new-session" className="size-6">
                              <SquarePenIcon />
                            </IconButton>
                            {narrow ? (
                              <RowMenu label={label} testId="worktree-menu" disabled={busy} entries={rowMenu(g, r, label, "worktree-menu-")} />
                            ) : (
                              onRemoveWorktree &&
                              removableWorktree(worktrees?.[g.cwd] ?? [], r) && (
                                <IconButton label={`Remove ${label}`} onClick={() => onRemoveWorktree(g.cwd, r.path)} disabled={busy} onWarm={onWarmWorktree && (() => onWarmWorktree(g.cwd, r.path))} testId="worktree-remove" className="size-6">
                                  <Trash2Icon />
                                </IconButton>
                              )
                            )}
                          </span>
                        )}
                      </div>
                      </RowContextMenu>
                      {rowOpen && !r.sessions.length && <p className="py-1 pl-12 text-muted-foreground text-sm">{emptyText}</p>}
                      {rowOpen && days(r.sessions, 1, rowKey(r.path), label)}
                    </div>
                  );
                })}
            </section>
          );
        })}
      </nav>
    </div>
  );
}

const SessionRow = memo(function SessionRow({
  s,
  ago,
  st,
  loading,
  unread,
  active,
  renaming,
  menuRename,
  depth,
  classic,
  branch,
  workerName,
  place,
  tab,
  coordinator,
  finished,
  closedN,
  cleanable,
  onOpen,
  onAction,
  onRenamed,
}: {
  s: SessionListItem;
  /** Title still a placeholder after a prompt (GH-133). */
  loading: boolean;
  /** Relative time of the last activity ("5m"). */
  ago: string;
  st: SessionState;
  unread: boolean;
  active: boolean;
  renaming: boolean;
  menuRename: boolean;
  /** Indent level (PAD). */
  depth: Depth;
  /** Classic layout: the row says its state as text and, in a linked worktree, its branch. */
  classic?: boolean;
  branch?: string;
  /** A worker under its coordinator: the row shows its name, place and state as text. */
  workerName?: string;
  place?: string;
  /** The session has an open tab. */
  tab: boolean;
  /** A coordinator with listed workers: how many Close finished / Remove closed would act on. */
  coordinator: boolean;
  finished: number;
  closedN: number;
  /** The Clean up dialog is available: the coordinator menu offers Clean up workers…. */
  cleanable?: boolean;
  onOpen: (id: string) => void;
  onAction: (id: string, a: SessionAction) => void;
  onRenamed: (id: string, title: string | undefined) => void;
}) {
  const label = STATE_LABEL[st];
  // Classic: every state reads as text (workers already do).
  const stateText = classic && !workerName ? WORKER_STATE[st] : undefined;
  const target: ActionTarget = {
    title: s.title,
    archived: s.archived,
    busy: st === "running" || st === "needs_input",
    transcript: s.transcript,
    copyId: true,
    tab,
    worker: workerName ? { closed: st === "closed" } : undefined,
    coordinator: coordinator ? { finished, closed: closedN, cleanUp: cleanable } : undefined,
  };
  const act = (a: SessionAction) => onAction(s.id, a);
  if (renaming)
    return (
      <li className={cn("flex h-8 items-center pr-1.5 max-md:h-11", PAD[depth])}>
        <RenameInput title={s.title} onDone={(t) => onRenamed(s.id, t)} fromMenu={menuRename} />
      </li>
    );
  return (
    <SessionContextMenu target={target} onAction={act}>
      <li className="group relative">
        <button
          data-testid="session-item"
          data-session-id={s.id}
          data-state={st}
          className={cn(
            "flex h-10 w-full cursor-pointer items-center gap-2 rounded-md pr-8 max-md:pr-12 text-left text-sm outline-none transition-colors hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none max-md:h-11",
            PAD[depth],
            active && "bg-secondary",
          )}
          aria-current={active ? "page" : undefined}
          data-worker={workerName}
          aria-label={(workerName ? [workerName, "worker", WORKER_STATE[st], place, unread && "unread"] : [s.title, stateText ?? label, branch && `branch ${branch}`, unread && "unread"]).filter(Boolean).join(", ")}
          onClick={() => onOpen(s.id)}
          title={workerName ? `${s.title}\n${s.cwd}` : stateText ? `${s.title} (${stateText}${branch ? `, ${branch}` : ""})` : label ? `${s.title} (${label})` : s.title}
        >
          {workerName ? (
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-foreground">{workerName}</span>
              <span className="truncate text-muted-foreground text-xs">{`${place} · ${WORKER_STATE[st]}`}</span>
            </span>
          ) : stateText ? (
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-baseline gap-1.5">
                {loading ? <TitleSkeleton title={s.title} className="h-3.5 w-28" /> : <span className="min-w-0 truncate font-medium text-foreground">{s.title}</span>}
                {branch && <span className="min-w-0 shrink-[2] truncate text-muted-foreground text-xs" data-testid="session-branch">{branch}</span>}
              </span>
              <span className="truncate text-muted-foreground text-xs" data-testid="session-state">{stateText}</span>
            </span>
          ) : loading ? (
            <TitleSkeleton title={s.title} className="h-3.5 w-28" />
          ) : (
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{s.title}</span>
          )}
          {unread && <span className="size-1.5 shrink-0 rounded-full bg-info" data-testid="unread-marker" aria-hidden />}
          <StateIcon state={st} />
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{ago}</span>
        </button>
        <SessionMenu
          target={target}
          onAction={act}
          className="-translate-y-1/2 absolute top-1/2 right-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
        />
      </li>
    </SessionContextMenu>
  );
});
