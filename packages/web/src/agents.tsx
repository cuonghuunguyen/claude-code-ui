// Subagent runs (CONTEXT.md "Subagent run"): Agents button + agent map, the subagent view's top bar and its not-promptable notice.
import { createContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, LoaderCircleIcon, NetworkIcon, SquareIcon, XCircleIcon } from "lucide-react";
import type { Part, ToolStatus } from "@claude-ui/protocol";
import type { SessionView } from "./store.ts";
import { GHOST } from "./toolbar.tsx";

export type Run = Extract<Part, { type: "subagent" }>;

/** Opens the subagent view of a run; `undefined` goes back to the session view. Provided by the session pane. */
export const OpenRunContext = createContext<((id?: string) => void) | undefined>(undefined);

/** Runs started by `parentId` (undefined = by the session), oldest first. */
export const runsOf = (view: SessionView, parentId?: string): Run[] =>
  view.order.flatMap((id) => {
    const p = view.parts.get(id)!;
    return p.type === "subagent" && p.parentId === parentId ? [p] : [];
  });

export const isRunning = (r: Run) => r.status === "pending" || r.status === "running";

/** The subagent part `id` names, if it is one. */
export function runOf(view: SessionView, id?: string): Run | undefined {
  const p = id ? view.parts.get(id) : undefined;
  return p?.type === "subagent" ? p : undefined;
}

/** True when the call `toolUseId` (or the run itself) is inside run `runId`, at any depth. */
export function inRun(view: SessionView, toolUseId: string, runId: string) {
  for (let id: string | undefined = toolUseId, depth = 0; id && depth < 10; id = view.parts.get(id)?.parentId, depth++) if (id === runId) return true;
  return false;
}

const STATUS_LABEL: Record<ToolStatus, string> = { pending: "Running", running: "Running", done: "Done", error: "Failed", denied: "Denied" };

/** 12s, 3m 05s, 1h 02m. */
export function duration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor(s / 60) % 60)}m`;
}

const runDuration = (r: Run, now: number) => duration((r.endedAt ?? now) - r.startedAt);

/** Now, re-read every second while `live`: running durations count up. */
function useNow(live: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  return now;
}

export function StatusMark({ run }: { run: Run }) {
  const cls = "size-4 shrink-0";
  return isRunning(run) ? (
    <LoaderCircleIcon aria-hidden className={`${cls} animate-spin text-muted-foreground motion-reduce:animate-none`} />
  ) : run.status === "done" ? (
    <CheckIcon aria-hidden className={`${cls} text-success`} />
  ) : (
    <XCircleIcon aria-hidden className={`${cls} ${run.status === "error" ? "text-destructive" : "text-warning"}`} />
  );
}

type Node = { run?: Run; level: number; parent?: number };

/** Depth-first rows: the session (level 1), then every run under the run that started it. */
function flatten(view: SessionView): Node[] {
  const rows: Node[] = [{ level: 1 }];
  const walk = (parentId: string | undefined, level: number, parent: number) => {
    for (const run of runsOf(view, parentId)) {
      rows.push({ run, level, parent });
      walk(run.id, level + 1, rows.length - 1);
    }
  };
  walk(undefined, 2, 0);
  return rows;
}

/**
 * Agents button in the prompt toolbar (only with at least one run) and the agent map popover: a tree with the session as root.
 * `current`: the run whose view shows (undefined = the session view). Arrow keys move, Enter opens, Esc closes.
 */
export function AgentsButton({ view, current, onOpen, side = "top" }: { view: SessionView; current?: string; onOpen: (id?: string) => void; side?: "top" | "bottom" }) {
  const [open, setOpen] = useState(false);
  const all = [...view.parts.values()].filter((p): p is Run => p.type === "subagent");
  const running = all.filter(isRunning).length;
  if (!all.length) return null;
  const label = running ? `Agents, ${running} running` : "Agents";
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger aria-label={label} title={label} data-testid="agents-button" className={`${GHOST} flex shrink-0 items-center`}>
        <NetworkIcon aria-hidden className="size-4" />
        <span className="hidden @2xl:inline">Agents</span>
        {running > 0 && (
          <span data-testid="agents-running" className="min-w-4 rounded-full bg-accent px-1 text-center text-[11px] text-foreground tabular-nums">
            {running}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align={side === "top" ? "start" : "end"} sideOffset={6} collisionPadding={16} className="z-50">
          <Popover.Popup
            initialFocus={false}
            data-testid="agent-map"
            className="w-96 max-w-[calc(100vw-32px)] origin-(--transform-origin) rounded-xl bg-popover p-1 text-popover-foreground text-sm shadow-floating outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none"
          >
            <Popover.Title className="px-2 pt-1.5 pb-1 font-medium text-[13px] text-muted-foreground">Agent map</Popover.Title>
            <AgentTree
              view={view}
              current={current}
              onOpen={(id) => {
                setOpen(false);
                onOpen(id);
              }}
              onClose={() => setOpen(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AgentTree({ view, current, onOpen, onClose }: { view: SessionView; current?: string; onOpen: (id?: string) => void; onClose: () => void }) {
  const rows = flatten(view);
  const now = useNow(rows.some((r) => r.run && isRunning(r.run)));
  const start = Math.max(0, rows.findIndex((r) => r.run?.id === current));
  const [focus, setFocus] = useState(start);
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const at = Math.min(focus, rows.length - 1);
  // The popup opens with the current node focused, so the arrow keys work at once.
  useEffect(() => void items.current[at]?.focus(), [at]);
  const onKeyDown = (e: KeyboardEvent) => {
    const row = rows[at]!;
    const firstChild = rows.findIndex((r) => r.parent === at);
    const next: Record<string, number | undefined> = {
      ArrowDown: Math.min(at + 1, rows.length - 1),
      ArrowUp: Math.max(at - 1, 0),
      Home: 0,
      End: rows.length - 1,
      ArrowLeft: row.parent,
      ArrowRight: firstChild >= 0 ? firstChild : undefined,
    };
    if (e.key in next) {
      e.preventDefault();
      if (next[e.key] !== undefined) setFocus(next[e.key]!);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(row.run?.id);
    } else if (e.key === "Escape") {
      // Handled here: the session's Esc would stop the turn.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <ul role="tree" aria-label="Agent map" className="max-h-[min(60vh,420px)] overflow-y-auto" onKeyDown={onKeyDown}>
      {rows.map((r, i) => {
        const name = r.run ? r.run.description || "Subagent run" : "Session";
        const status = r.run ? `${STATUS_LABEL[r.run.status]}, ${runDuration(r.run, now)}` : "";
        const selected = (r.run?.id ?? undefined) === current;
        return (
          <li
            key={r.run?.id ?? "session"}
            ref={(el) => void (items.current[i] = el)}
            role="treeitem"
            aria-level={r.level}
            aria-selected={selected}
            aria-label={status ? `${name}, ${status}` : name}
            tabIndex={i === at ? 0 : -1}
            data-testid="agent-node"
            data-status={r.run?.status}
            onClick={() => onOpen(r.run?.id)}
            onFocus={() => setFocus(i)}
            style={{ paddingLeft: 8 + (r.level - 1) * 16 }}
            className={`flex min-h-8 cursor-pointer items-center gap-2 rounded-md pr-2 outline-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-info pointer-coarse:min-h-11 ${selected ? "bg-accent" : ""}`}
          >
            {r.run ? <StatusMark run={r.run} /> : <NetworkIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
            <span className={`min-w-0 flex-1 truncate ${r.run ? "" : "font-medium"}`}>{name}</span>
            {r.run && (
              <span aria-hidden className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
                {STATUS_LABEL[r.run.status]} · {runDuration(r.run, now)}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Top bar of the subagent view (OpenCode child session header): Back, parent / description, status and duration, Children, Agents. */
export function SubagentBar({ view, run, onOpen }: { view: SessionView; run: Run; onOpen: (id?: string) => void }) {
  const parent = runOf(view, run.parentId);
  const children = runsOf(view, run.id);
  const now = useNow(isRunning(run) || children.some(isRunning));
  const back = parent ? `Back to ${parent.description || "parent run"}` : "Back to session";
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b px-2 sm:px-4" data-testid="subagent-bar">
      <button type="button" aria-label={back} title={back} data-testid="subagent-back" className={`${GHOST} flex w-7 shrink-0 items-center justify-center px-0! pointer-coarse:w-11`} onClick={() => onOpen(parent?.id)}>
        <ArrowLeftIcon aria-hidden className="size-4" />
      </button>
      <button type="button" tabIndex={-1} aria-hidden className="hidden min-w-0 max-w-[30%] cursor-pointer truncate text-[13px] text-muted-foreground hover:text-foreground sm:block" onClick={() => onOpen(parent?.id)}>
        {parent ? parent.description || "Subagent run" : "Session"}
      </button>
      <span aria-hidden className="hidden px-1 text-[11px] text-muted-foreground sm:inline">
        /
      </span>
      <h1 className="min-w-0 flex-1 truncate font-medium text-[13px]" data-testid="subagent-title">
        {run.description || "Subagent run"}
      </h1>
      <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground tabular-nums" data-testid="subagent-status">
        <StatusMark run={run} />
        {STATUS_LABEL[run.status]}
        <span className="hidden sm:inline"> · {runDuration(run, now)}</span>
      </span>
      {children.length > 0 && (
        <Menu.Root>
          <Menu.Trigger aria-label={`Children, ${children.length} subagent runs`} data-testid="subagent-children" className={`${GHOST} flex shrink-0 items-center`}>
            <span className="hidden sm:inline">Children</span>
            <span className="tabular-nums">{children.length}</span>
            <ChevronDownIcon aria-hidden className="size-4" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={16} className="z-50">
              <Menu.Popup className="w-72 max-w-[calc(100vw-32px)] rounded-md bg-popover p-0.5 text-popover-foreground text-sm shadow-floating outline-none">
                {children.map((c) => (
                  <Menu.Item
                    key={c.id}
                    data-testid="subagent-child"
                    onClick={() => onOpen(c.id)}
                    className="flex h-7 cursor-pointer items-center gap-2 rounded-sm px-3 outline-none data-highlighted:bg-accent pointer-coarse:h-11"
                  >
                    <StatusMark run={c} />
                    <span className="min-w-0 flex-1 truncate">{c.description || "Subagent run"}</span>
                    <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{runDuration(c, now)}</span>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
      <AgentsButton view={view} current={run.id} onOpen={onOpen} side="bottom" />
    </header>
  );
}

/** Replaces the prompt box in the subagent view (OpenCode "Subagent sessions cannot be prompted."): Back and, while it runs, Stop agent. */
export function NotPromptable({ view, run, onOpen, onStop }: { view: SessionView; run: Run; onOpen: (id?: string) => void; onStop: (id: string) => void }) {
  const parent = runOf(view, run.parentId);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card p-3 text-sm text-muted-foreground" data-testid="not-promptable">
      <p className="min-w-0 flex-1">
        Subagent runs cannot be prompted.{" "}
        <button type="button" className="cursor-pointer text-foreground hover:underline pointer-coarse:min-h-11" data-testid="not-promptable-back" onClick={() => onOpen(parent?.id)}>
          {parent ? "Back to parent run." : "Back to main session."}
        </button>
      </p>
      {isRunning(run) && (
        <button type="button" data-testid="stop-agent" className={`${GHOST} flex shrink-0 items-center text-foreground!`} onClick={() => onStop(run.id)}>
          <SquareIcon aria-hidden className="size-3 fill-current" />
          Stop agent
        </button>
      )}
    </div>
  );
}
