// Sidebar session list (docs/spec.md "Layout"): one collapsible group per known project, search by title or project name.
import { useState } from "react";
import { ArchiveIcon, ChevronRightIcon, CircleAlertIcon, FolderPlusIcon, LoaderCircleIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import type { SessionListItem, SessionState } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import { byDay, groupByCwd, loadCollapsed, saveCollapsed, timeAgo } from "./sessions.ts";
import { projectName } from "./tabs.ts";
import { IconButton, ProjectAvatar } from "./tabs-bar.tsx";
import { RenameInput, SessionContextMenu, SessionMenu, type SessionAction } from "./session-actions.tsx";

/** Only states that need attention get an indicator; idle, error and closed rows stay plain. */
function StateIcon({ state }: { state: SessionState }) {
  if (state === "running") return <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-faint motion-reduce:animate-none" aria-hidden />;
  if (state === "needs_input") return <CircleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />;
  return null;
}

const STATE_LABEL: Partial<Record<SessionState, string>> = { running: "running", needs_input: "needs input" };

export function SessionList({
  list,
  projects,
  state,
  unread,
  activeId,
  onOpen,
  onNew,
  onRemove,
  onOpenProject,
  renaming,
  onAction,
  onRenamed,
}: {
  list: SessionListItem[];
  /** Known project cwds from the daemon, newest first; a project with no session still gets a group. */
  projects: string[];
  /** Live state of a session, falling back to its list state. */
  state: (s: SessionListItem) => SessionState;
  unread: Set<string>;
  activeId?: string;
  onOpen: (id: string) => void;
  /** New session in this project, without a directory picker. */
  onNew: (cwd: string) => void;
  /** Removes the project from the list; files stay. */
  onRemove: (cwd: string) => void;
  onOpenProject: () => void;
  /** Session whose row shows the title editor. */
  renaming?: string;
  onAction: (id: string, a: SessionAction) => void;
  /** New title, or undefined when the edit was cancelled. */
  onRenamed: (id: string, title: string | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = (cwd: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(cwd)) next.add(cwd);
      saveCollapsed(next);
      return next;
    });

  const groups = groupByCwd(list, query, projects, archived);
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
        <p className="px-1.5 text-muted-foreground text-sm">No projects yet. Open a project folder to start a session in it.</p>
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
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions"
            aria-label="Search sessions by title or project"
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
      <nav className="-mx-1 flex min-h-0 flex-col gap-2 overflow-y-auto px-1" aria-label="Sessions" data-testid="session-list">
        {archived && !!groups.length && (
          <p className="px-1.5 text-muted-foreground text-xs" data-testid="archived-caption">
            Archived sessions
          </p>
        )}
        {!groups.length && (
          <p className="px-1.5 text-muted-foreground text-sm">
            {query.trim()
              ? `No ${archived ? "archived " : ""}session title or project matches "${query.trim()}".`
              : archived
                ? "No archived sessions."
                : "All sessions are archived."}
          </p>
        )}
        {groups.map((g) => {
          // While searching every match shows, also in collapsed groups.
          const open = !!query.trim() || !collapsed.has(g.cwd);
          return (
            <section key={g.cwd} data-testid="session-group" data-cwd={g.cwd}>
              <h3 className="group/project relative">
                <button
                  className="flex h-7 w-full items-center gap-2 rounded-md pr-16 pl-1.5 text-left max-md:pr-26 pointer-coarse:pr-26 text-muted-foreground text-sm outline-none transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none max-md:h-11"
                  aria-expanded={open}
                  onClick={() => toggle(g.cwd)}
                  title={g.cwd}
                  data-testid="group-toggle"
                >
                  <ProjectAvatar cwd={g.cwd} />
                  <span className="min-w-0 flex-1 truncate font-medium">{projectName(g.cwd)}</span>
                  <ChevronRightIcon className={cn("size-4 shrink-0 text-faint transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
                </button>
                {/* OpenCode project row actions: shown on hover or focus; always on touch screens (no hover there), any width. */}
                <span className="absolute inset-y-0 right-0.5 flex items-center gap-0.5 opacity-100 transition-opacity group-focus-within/project:opacity-100 group-hover/project:opacity-100 motion-reduce:transition-none md:opacity-0 max-md:gap-2 pointer-coarse:gap-2 pointer-coarse:opacity-100">
                  <IconButton label={`New session in ${projectName(g.cwd)}`} onClick={() => onNew(g.cwd)} testId="project-new-session" className="size-6">
                    <SquarePenIcon />
                  </IconButton>
                  <IconButton label={`Remove ${projectName(g.cwd)} from the list (files stay)`} onClick={() => onRemove(g.cwd)} testId="project-remove" className="size-6">
                    <XIcon />
                  </IconButton>
                </span>
              </h3>
              {open && !g.sessions.length && <p className="py-1 pl-7 text-muted-foreground text-sm">No sessions yet</p>}
              {open &&
                byDay(g.sessions).map((day) => (
                  <div key={day.title}>
                    {/* OpenCode Home day label: 28px, muted, weight 440, aligned with the row titles. */}
                    <h4 className="flex h-7 items-center pl-7 font-normal text-muted-foreground text-sm" data-testid="day-header">
                      {day.title}
                    </h4>
                    <ul className="flex flex-col gap-0.5">
                      {day.sessions.map((s) => {
                        const st = state(s);
                        const label = STATE_LABEL[st];
                        const isUnread = unread.has(s.id);
                        const target = { title: s.title, archived: s.archived, busy: st === "running" || st === "needs_input", transcript: s.transcript };
                        const act = (a: SessionAction) => onAction(s.id, a);
                        if (renaming === s.id)
                          return (
                            <li key={s.id} className="flex h-8 items-center pr-1.5 pl-7 max-md:h-11">
                              <RenameInput title={s.title} onDone={(t) => onRenamed(s.id, t)} />
                            </li>
                          );
                        return (
                          <SessionContextMenu key={s.id} target={target} onAction={act}>
                            <li className="group relative">
                              <button
                                data-testid="session-item"
                                data-state={st}
                                className={cn(
                                  "flex h-10 w-full cursor-pointer items-center gap-2 rounded-md pr-8 max-md:pr-12 pl-7 text-left text-sm outline-none transition-colors hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none max-md:h-11",
                                  s.id === activeId && "bg-secondary",
                                )}
                                aria-current={s.id === activeId ? "page" : undefined}
                                aria-label={[s.title, label, isUnread && "unread"].filter(Boolean).join(", ")}
                                onClick={() => onOpen(s.id)}
                                title={label ? `${s.title} (${label})` : s.title}
                              >
                                <span className="min-w-0 flex-1 truncate font-medium text-foreground">{s.title}</span>
                                {isUnread && <span className="size-1.5 shrink-0 rounded-full bg-info" data-testid="unread-marker" aria-hidden />}
                                <StateIcon state={st} />
                                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{timeAgo(s.lastActivity)}</span>
                              </button>
                              <SessionMenu
                                target={target}
                                onAction={act}
                                className="-translate-y-1/2 absolute top-1/2 right-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100 pointer-coarse:opacity-100"
                              />
                            </li>
                          </SessionContextMenu>
                        );
                      })}
                    </ul>
                  </div>
                ))}
            </section>
          );
        })}
      </nav>
    </div>
  );
}
