// Sidebar session list (docs/spec.md "Layout"): one collapsible group per project, search by title or project name.
import { useState } from "react";
import { ChevronRightIcon, CircleAlertIcon, LoaderCircleIcon, SearchIcon } from "lucide-react";
import type { SessionListItem, SessionState } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import { groupByCwd, loadCollapsed, saveCollapsed, timeAgo } from "./sessions.ts";
import { projectName } from "./tabs.ts";
import { ProjectAvatar } from "./tabs-bar.tsx";

/** Only states that need attention get an indicator; idle, error and closed rows stay plain. */
function StateIcon({ state }: { state: SessionState }) {
  if (state === "running") return <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-faint motion-reduce:animate-none" aria-hidden />;
  if (state === "needs_input") return <CircleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden />;
  return null;
}

const STATE_LABEL: Partial<Record<SessionState, string>> = { running: "running", needs_input: "needs input" };

export function SessionList({
  list,
  state,
  unread,
  activeId,
  onOpen,
}: {
  list: SessionListItem[];
  /** Live state of a session, falling back to its list state. */
  state: (s: SessionListItem) => SessionState;
  unread: Set<string>;
  activeId?: string;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed);
  const toggle = (cwd: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(cwd)) next.add(cwd);
      saveCollapsed(next);
      return next;
    });

  if (!list.length) return <p className="text-muted-foreground text-sm">No sessions in the allowlisted roots.</p>;
  const groups = groupByCwd(list, query);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <label className="relative flex items-center">
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
      <nav className="-mx-1 flex min-h-0 flex-col gap-2 overflow-y-auto px-1" aria-label="Sessions" data-testid="session-list">
        {!groups.length && <p className="px-1.5 text-muted-foreground text-sm">No session title or project matches "{query.trim()}".</p>}
        {groups.map((g) => {
          // While searching every match shows, also in collapsed groups.
          const open = !!query.trim() || !collapsed.has(g.cwd);
          return (
            <section key={g.cwd} data-testid="session-group" data-cwd={g.cwd}>
              <h2>
                <button
                  className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-muted-foreground text-sm outline-none transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none max-md:h-11"
                  aria-expanded={open}
                  onClick={() => toggle(g.cwd)}
                  title={g.cwd}
                  data-testid="group-toggle"
                >
                  <ProjectAvatar cwd={g.cwd} />
                  <span className="min-w-0 flex-1 truncate font-medium">{projectName(g.cwd)}</span>
                  <ChevronRightIcon className={cn("size-4 shrink-0 text-faint transition-transform motion-reduce:transition-none", open && "rotate-90")} aria-hidden />
                </button>
              </h2>
              {open && (
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {g.sessions.map((s) => {
                    const st = state(s);
                    const label = STATE_LABEL[st];
                    const isUnread = unread.has(s.id);
                    return (
                      <li key={s.id}>
                        <button
                          data-testid="session-item"
                          data-state={st}
                          className={cn(
                            "flex h-10 w-full items-center gap-2 rounded-md pr-1.5 pl-7 text-left text-sm outline-none transition-colors hover:bg-secondary/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none max-md:h-11",
                            s.id === activeId ? "bg-secondary text-foreground" : "text-muted-foreground",
                          )}
                          aria-current={s.id === activeId ? "page" : undefined}
                          aria-label={[s.title, label, isUnread && "unread"].filter(Boolean).join(", ")}
                          onClick={() => onOpen(s.id)}
                          title={label ? `${s.title} (${label})` : s.title}
                        >
                          <span className={cn("min-w-0 flex-1 truncate font-medium", isUnread && "text-foreground")}>{s.title}</span>
                          {isUnread && <span className="size-1.5 shrink-0 rounded-full bg-info" data-testid="unread-marker" aria-hidden />}
                          <StateIcon state={st} />
                          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{timeAgo(s.lastActivity)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </nav>
    </div>
  );
}
