// Sidebar session list (docs/spec.md "Layout"): one collapsible group per known project (per repository), its worktrees as collapsible rows; search by title, project name or branch.
import { SideBadge, SideLabel } from "./sides.tsx";
import { Fragment, memo, use, useEffect, useRef, useState } from "react";
import { useNarrow } from "@/lib/use-narrow.ts";
import { Menu } from "@base-ui/react/menu";
import { ArchiveIcon, ChevronRightIcon, CircleAlertIcon, EllipsisIcon, FolderPlusIcon, GitBranchIcon, GitBranchPlusIcon, LoaderCircleIcon, LockIcon, SearchIcon, SquarePenIcon, Trash2Icon, UsersIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SessionListItem, SessionState, Worktree } from "@claude-ui/protocol";
import { cn, useStableProps } from "@/lib/utils";
import { TitleSkeleton } from "@/components/ui/skeleton";
import { byDay, groupByCwd, limitSessions, loadCollapsed, MORE, removableWorktree, SHOWN, saveCollapsed, nestWorkers, parseSessionQuery, timeAgo, worktreeName, type WorktreeRow } from "./sessions.ts";
import { useNow } from "./plan-meter.tsx";
import { projectName } from "./tabs.ts";
import { IconButton, ProjectAvatar } from "./tabs-bar.tsx";
import { ITEM, POPUP, RenameInput, SessionContextMenu, SessionMenu, type SessionAction } from "./session-actions.tsx";

/** What follows the last `/` or `\` (a branch tail, a folder name). */
const lastSegment = (p: string) => p.split(/[\\/]/).pop()!;

/** `...` menu of a project or worktree row below `md`: the secondary actions, so the label keeps the room. */
function RowMenu({ label, testId, items }: { label: string; testId: string; items: { label: string; onClick: (e: React.MouseEvent) => void; testId: string; destructive?: boolean }[] }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Actions for ${label}`}
        title="Actions"
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:size-11 [&_svg]:size-4"
        data-testid={testId}
      >
        <EllipsisIcon aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={POPUP}>
            {items.map((i) => (
              <Menu.Item key={i.testId} className={cn(ITEM, i.destructive && "text-destructive")} onClick={i.onClick} data-testid={i.testId}>
                {i.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

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
  onOpenProject,
  renaming,
  onAction,
  onRenamed,
  search,
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
  /** New worktree in the project's repository; `named`: Shift+click, ask for a name. */
  onNewWorktree?: (cwd: string, named: boolean) => void;
  /** Remove a worktree under the repository's .claude/worktrees (the app confirms first). */
  onRemoveWorktree?: (project: string, path: string) => void;
  onOpenProject: () => void;
  /** Session whose row shows the title editor. */
  renaming?: string;
  onAction: (id: string, a: SessionAction) => void;
  /** New title, or undefined when the edit was cancelled. */
  onRenamed: (id: string, title: string | undefined) => void;
  /** `/resume` (GH-100): each new `seq` puts `text` into the search box, focuses it and puts the caret at the end. */
  search?: { text: string; seq: number };
}) {
  const narrow = useNarrow();
  const sideOf = use(SideLabel);
  // Stable for the memo rows: a tab switch re-renders only the two rows whose active mark changes.
  const rowProps = useStableProps({ onOpen, onAction, onRenamed });
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
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = (cwd: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(cwd)) next.add(cwd);
      saveCollapsed(next);
      return next;
    });

  // Sessions shown per group or row key (not persisted); a row's id to focus once "Load more" has shown it.
  const [limits, setLimits] = useState<Record<string, number>>({});
  const focusId = useRef<string>(undefined);
  const listRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusId.current) listRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(focusId.current)}"]`)?.focus();
    focusId.current = undefined;
  });
  const { top, workers } = nestWorkers(list, archived);
  const groups = groupByCwd(top, query, projects, archived, worktrees, workers);
  // While searching every match shows, also in collapsed groups and rows.
  const isOpen = (key: string) => !!query.trim() || !collapsed.has(key);
  /** A worktree row's collapse key: not its path alone, which is also the project's key for the main checkout. */
  const rowKey = (r: WorktreeRow) => `worktree:${r.path}`;
  const days = (all: SessionListItem[], depth: 0 | 1, key: string, name: string) => {
    key = archived ? `archived:${key}` : key;
    // While searching every match shows; the active, running and needs-input sessions always do.
    const { shown: sessions, hidden } = query.trim()
      ? { shown: all, hidden: undefined }
      : limitSessions(all, limits[key] ?? SHOWN, (s) => s.id === activeId || state(s) === "running" || state(s) === "needs_input" || !!workers.get(s.id)?.some((w) => state(w) === "running" || state(w) === "needs_input"));
    return [
      ...byDay(sessions, now).map((day) => (
        <div key={day.title}>
          {/* OpenCode Home day label: 28px, muted, weight 440, aligned with the row titles. */}
          <h4 className={cn("flex h-7 items-center font-normal text-muted-foreground text-sm", PAD[depth])} data-testid="day-header">
            {day.title}
          </h4>
          <ul className="flex flex-col gap-0.5">
            {day.sessions.map((s) => {
              const ws = workers.get(s.id) ?? [];
              const k = `${archived ? "archived:" : ""}coordinator:${s.id}`;
              const needs = ws.some((w) => state(w) === "needs_input");
              const row = (x: SessionListItem, d: Depth, worker?: { workerName: string; place: string }) => (
                <SessionRow key={x.id} s={x} ago={timeAgo(x.lastActivity, now)} st={state(x)} loading={!!titleLoading?.(x)} unread={unread.has(x.id)} active={x.id === activeId} renaming={renaming === x.id} depth={d} {...worker} {...rowProps} />
              );
              return (
                <Fragment key={s.id}>
                  {row(s, depth)}
                  {!!ws.length && (
                    <li>
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
  const header = (
    <div className="flex h-7 items-center pl-1.5">
      <h2 className="flex-1 font-medium text-muted-foreground text-sm">Projects</h2>
      <IconButton label="Open project" onClick={onOpenProject} testId="open-project">
        <FolderPlusIcon />
      </IconButton>
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
                : "All sessions are archived."}
          </p>
        )}
        {groups.map((g) => {
          const open = isOpen(g.cwd);
          return (
            <section key={g.cwd} data-testid="session-group" data-cwd={g.cwd}>
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
                  <ChevronRightIcon className={cn("ml-auto size-4 shrink-0 text-faint transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
                </button>
                {/* OpenCode project row actions: shown on hover or focus; always on touch screens (no hover there), any width. */}
                <span className="absolute inset-y-0 right-0.5 flex items-center gap-0.5 opacity-100 transition-opacity group-focus-within/project:opacity-100 group-hover/project:opacity-100 motion-reduce:transition-none md:opacity-0 max-md:gap-2 pointer-coarse:gap-2 pointer-coarse:opacity-100">
                  {onNewWorktree && !narrow && worktrees?.[g.cwd]?.some((w) => w.main && !w.outsideRoots) && (
                    <IconButton label={`New worktree in ${projectName(g.cwd)} (Shift+click to name it)`} onClick={(e) => onNewWorktree(g.cwd, e.shiftKey)} testId="project-new-worktree" className="size-6">
                      <GitBranchPlusIcon />
                    </IconButton>
                  )}
                  <IconButton label={`New session in ${projectName(g.cwd)}`} onClick={() => onNew(g.cwd)} testId="project-new-session" className="size-6">
                    <SquarePenIcon />
                  </IconButton>
                  {narrow ? (
                    <RowMenu
                      label={projectName(g.cwd)}
                      testId="project-menu"
                      items={[
                        ...(onNewWorktree && worktrees?.[g.cwd]?.some((w) => w.main && !w.outsideRoots)
                          ? [
                              { label: "New worktree", onClick: () => onNewWorktree(g.cwd, false), testId: "project-menu-new-worktree" },
                              { label: "New worktree (named)…", onClick: () => onNewWorktree(g.cwd, true), testId: "project-menu-new-worktree-named" },
                            ]
                          : []),
                        { label: "Remove from list (files stay)", onClick: () => onRemove(g.cwd), testId: "project-menu-remove", destructive: true },
                      ]}
                    />
                  ) : (
                    <IconButton label={`Remove ${projectName(g.cwd)} from the list (files stay)`} onClick={() => onRemove(g.cwd)} testId="project-remove" className="size-6">
                      <XIcon />
                    </IconButton>
                  )}
                </span>
              </h3>
              {open && !g.sessions.length && !g.worktrees.length && <p className="py-1 pl-7 text-muted-foreground text-sm">No sessions yet</p>}
              {open && days(g.sessions, 0, g.cwd, projectName(g.cwd))}
              {open &&
                g.worktrees.map((r) => {
                  const rowOpen = isOpen(rowKey(r));
                  const kind = r.main ? "local" : "worktree";
                  const branch = r.branch ?? lastSegment(r.path);
                  // Below md: only what follows the last "/" (the ticket part of "user/GH-1-fix"); the full name is the aria label and tooltip.
                  // Two rows of the project with the same tail (alice/fix, bob/fix) keep the full branch; counted on all its rows, not just the searched ones.
                  const sameTail = (worktrees?.[g.cwd] ?? g.worktrees).filter((w) => lastSegment(w.branch ?? lastSegment(w.path)) === lastSegment(branch)).length > 1;
                  const shortBranch = sameTail ? branch : lastSegment(branch);
                  const label = `${kind} : ${branch}`;
                  return (
                    <div key={r.path} data-testid="worktree-row" data-path={r.path}>
                      {/* OpenCode WorkspaceHeader: branch icon, "local : <branch>" / "worktree : <branch>", chevron; New session on hover. */}
                      <div className="group/worktree relative">
                        <button
                          className="flex h-7 w-full items-center gap-2 rounded-md pr-14 pl-6 text-left text-muted-foreground text-sm outline-none transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none max-md:h-11 max-md:pr-26 pointer-coarse:pr-26"
                          aria-expanded={rowOpen}
                          onClick={() => toggle(rowKey(r))}
                          aria-label={narrow ? `${label}${r.outsideRoots ? " (outside the allowed roots)" : ""}` : undefined}
                          title={`${narrow ? `${label}\n` : ""}${r.outsideRoots ? `${r.path}: Outside the allowed roots (--roots)` : r.path}`}
                          data-testid="worktree-toggle"
                        >
                          <GitBranchIcon className="size-4 shrink-0 text-faint" aria-hidden />
                          <span className="min-w-0 truncate font-medium">{narrow ? shortBranch : label}</span>
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
                            <IconButton label={`New session in ${label}`} onClick={() => onNew(r.path)} testId="worktree-new-session" className="size-6">
                              <SquarePenIcon />
                            </IconButton>
                            {onRemoveWorktree &&
                              removableWorktree(worktrees?.[g.cwd] ?? [], r) &&
                              (narrow ? (
                                <RowMenu label={label} testId="worktree-menu" items={[{ label: "Delete worktree…", onClick: () => onRemoveWorktree(g.cwd, r.path), testId: "worktree-menu-remove", destructive: true }]} />
                              ) : (
                                <IconButton label={`Remove ${label}`} onClick={() => onRemoveWorktree(g.cwd, r.path)} testId="worktree-remove" className="size-6">
                                  <Trash2Icon />
                                </IconButton>
                              ))}
                          </span>
                        )}
                      </div>
                      {rowOpen && !r.sessions.length && <p className="py-1 pl-12 text-muted-foreground text-sm">No sessions yet</p>}
                      {rowOpen && days(r.sessions, 1, rowKey(r), label)}
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
  depth,
  workerName,
  place,
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
  /** Indent level (PAD). */
  depth: Depth;
  /** A worker under its coordinator: the row shows its name, place and state as text. */
  workerName?: string;
  place?: string;
  onOpen: (id: string) => void;
  onAction: (id: string, a: SessionAction) => void;
  onRenamed: (id: string, title: string | undefined) => void;
}) {
  const label = STATE_LABEL[st];
  const target = { title: s.title, archived: s.archived, busy: st === "running" || st === "needs_input", transcript: s.transcript };
  const act = (a: SessionAction) => onAction(s.id, a);
  if (renaming)
    return (
      <li className={cn("flex h-8 items-center pr-1.5 max-md:h-11", PAD[depth])}>
        <RenameInput title={s.title} onDone={(t) => onRenamed(s.id, t)} />
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
          aria-label={(workerName ? [workerName, "worker", WORKER_STATE[st], place, unread && "unread"] : [s.title, label, unread && "unread"]).filter(Boolean).join(", ")}
          onClick={() => onOpen(s.id)}
          title={workerName ? `${s.title}\n${s.cwd}` : label ? `${s.title} (${label})` : s.title}
        >
          {workerName ? (
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium text-foreground">{workerName}</span>
              <span className="truncate text-muted-foreground text-xs">{`${place} · ${WORKER_STATE[st]}`}</span>
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
