// Subagent runs (CONTEXT.md "Subagent run"): Agents button + agent map, the subagent view's top bar and its not-promptable notice.
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, CircleIcon, CornerLeftUpIcon, LoaderCircleIcon, NetworkIcon, SquareIcon, XCircleIcon } from "lucide-react";
import type { Part, SessionState, ToolStatus } from "@claude-ui/protocol";
import { partOf, wholeParts, type SessionView } from "./store.ts";
import { GHOST } from "./toolbar.tsx";
import { NO_LINKS, type AgentLinks, type WorkerRow } from "./workers.ts";

export type Run = Extract<Part, { type: "subagent" }>;

/** Opens the subagent view of a run; `undefined` goes back to the session view. Provided by the session pane. */
export const OpenRunContext = createContext<((id?: string) => void) | undefined>(undefined);

/** Orchestration links of the session (its workers, its coordinator) and how to open another session; provided by the session pane. */
export const AgentLinksContext = createContext<{ links: AgentLinks; onOpenSession: (id: string) => void }>({ links: NO_LINKS, onOpenSession: () => {} });

/** Runs started by `parentId` (undefined = by the session), oldest first. */
export const runsOf = (view: SessionView, parentId?: string): Run[] =>
  wholeParts(view).flatMap((p) => (p.type === "subagent" && p.parentId === parentId ? [p] : []));

export const isRunning = (r: Run) => r.status === "pending" || r.status === "running";

/** The subagent part `id` names, if it is one. */
export function runOf(view: SessionView, id?: string): Run | undefined {
  const p = id ? partOf(view, id) : undefined;
  return p?.type === "subagent" ? p : undefined;
}

/** True when the call `toolUseId` (or the run itself) is inside run `runId`, at any depth. */
export function inRun(view: SessionView, toolUseId: string, runId: string) {
  for (let id: string | undefined = toolUseId, depth = 0; id && depth < 10; id = partOf(view, id)?.parentId, depth++) if (id === runId) return true;
  return false;
}

const STATUS_LABEL: Record<ToolStatus, string> = { pending: "Running", running: "Running", done: "Done", error: "Failed", denied: "Denied", stopped: "Stopped" };

const WORKER_LABEL: Record<SessionState, string> = { running: "Running", idle: "Idle", needs_input: "Needs input", error: "Error", closed: "Closed" };

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
export function useNow(live: boolean) {
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

export function WorkerMark({ state }: { state: SessionState }) {
  const cls = "size-4 shrink-0";
  return state === "running" ? (
    <LoaderCircleIcon aria-hidden className={`${cls} animate-spin text-muted-foreground motion-reduce:animate-none`} />
  ) : state === "needs_input" ? (
    <CircleAlertIcon aria-hidden className={`${cls} text-warning`} />
  ) : state === "error" ? (
    <XCircleIcon aria-hidden className={`${cls} text-destructive`} />
  ) : (
    <CircleIcon aria-hidden className={`${cls} text-muted-foreground`} />
  );
}

/** `pos` / `size`: place among its siblings (aria-posinset / aria-setsize); `children`: number of rows below it. */
type Base = { level: number; parent?: number; pos: number; size: number; children: number };
type Node = Base &
  (
    | { kind: "coordinator"; id: string; title: string }
    | { kind: "session" }
    | { kind: "run"; run: Run }
    | { kind: "workers" }
    | { kind: "worker"; worker: WorkerRow }
    | { kind: "closed"; n: number; open: boolean }
  );

/**
 * Depth-first rows: the coordinator (a worker's own map), the session (level 1) with every run under the run that started it,
 * then the Workers node with the open workers and the Closed node (its workers only while it is open).
 */
function flatten(view: SessionView, links: AgentLinks, closedOpen: boolean): Node[] {
  const rows: Node[] = [];
  if (links.coordinator) rows.push({ kind: "coordinator", id: links.coordinator.id, title: links.coordinator.title, level: 1, pos: 1, size: 1, children: 0 });
  const root = rows.length;
  rows.push({ kind: "session", level: 1, pos: 1, size: 1, children: 0 });
  const walk = (parentId: string | undefined, level: number, parent: number) => {
    const runs = runsOf(view, parentId);
    rows[parent]!.children = runs.length;
    runs.forEach((run, i) => {
      rows.push({ kind: "run", run, level, parent, pos: i + 1, size: runs.length, children: 0 });
      walk(run.id, level + 1, rows.length - 1);
    });
  };
  walk(undefined, 2, root);
  if (links.workers.length || links.closed.length) {
    const at = rows.length;
    rows.push({ kind: "workers", level: 1, pos: 1, size: 1, children: links.workers.length + (links.closed.length ? 1 : 0) });
    links.workers.forEach((worker, i) => rows.push({ kind: "worker", worker, level: 2, parent: at, pos: i + 1, size: rows[at]!.children, children: 0 }));
    if (links.closed.length) {
      const c = rows.length;
      rows.push({ kind: "closed", n: links.closed.length, open: closedOpen, level: 2, parent: at, pos: rows[at]!.children, size: rows[at]!.children, children: closedOpen ? links.closed.length : 0 });
      if (closedOpen) links.closed.forEach((worker, i) => rows.push({ kind: "worker", worker, level: 3, parent: c, pos: i + 1, size: links.closed.length, children: 0 }));
    }
  }
  const top = rows.filter((r) => r.level === 1);
  top.forEach((r, i) => ((r.pos = i + 1), (r.size = top.length)));
  return rows;
}

/**
 * Agents button in the prompt toolbar (only with a run, a worker or a coordinator) and the agent map popover: a tree with the session as root.
 * `current`: the run whose view shows (undefined = the session view). Arrow keys move, Enter opens, Esc closes.
 */
export function AgentsButton({ view, current, onOpen, side = "top" }: { view: SessionView; current?: string; onOpen: (id?: string) => void; side?: "top" | "bottom" }) {
  const [open, setOpen] = useState(false);
  const all = wholeParts(view).filter((p): p is Run => p.type === "subagent");
  const { links, onOpenSession } = useContext(AgentLinksContext);
  // Another session's tab hides this pane (Activity), which would freeze the closing popup: it opens that tab once the map is closed.
  const target = useRef<string>(undefined);
  const running = all.filter(isRunning).length + links.workers.filter((w) => w.state === "running").length;
  if (!all.length && !links.workers.length && !links.closed.length && !links.coordinator) return null;
  const label = running ? `Agents, ${running} running` : "Agents";
  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        // Reopened before the close of a worker row finished: that worker is no longer wanted.
        if (o) target.current = undefined;
        setOpen(o);
      }}
      onOpenChangeComplete={(o) => {
        if (o || !target.current) return;
        const id = target.current;
        target.current = undefined;
        onOpenSession(id);
      }}
    >
      <Popover.Trigger aria-label={label} title={label} data-testid="agents-button" className={`${GHOST} flex shrink-0 items-center`}>
        <NetworkIcon aria-hidden className="size-4" />
        <span className="hidden @2xl:inline">Agents</span>
        {running > 0 && (
          <span data-testid="agents-running" className="min-w-4 rounded-full bg-accent px-1 text-center text-xs text-foreground tabular-nums">
            {running}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align={side === "top" ? "start" : "end"} sideOffset={6} collisionPadding={16} className="z-50">
          <Popover.Popup
            initialFocus={false}
            data-testid="agent-map"
            className="w-96 max-w-[calc(100vw-32px)] origin-(--transform-origin) rounded-2xl border bg-popover p-1 text-popover-foreground text-sm shadow-floating outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none"
          >
            <Popover.Title className="px-2 pt-1.5 pb-1 font-medium text-[13px] text-muted-foreground">Agent map</Popover.Title>
            <AgentTree
              view={view}
              current={current}
              links={links}
              onOpen={(id) => {
                setOpen(false);
                onOpen(id);
              }}
              onOpenSession={(id) => {
                target.current = id;
                setOpen(false);
              }}
              onClose={() => setOpen(false)}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

const rowKey = (r: Node) => (r.kind === "run" ? r.run.id : r.kind === "worker" ? `w:${r.worker.id}` : r.kind);

function AgentTree({ view, current, links, onOpen, onOpenSession, onClose }: { view: SessionView; current?: string; links: AgentLinks; onOpen: (id?: string) => void; onOpenSession: (id: string) => void; onClose: () => void }) {
  const [closedOpen, setClosedOpen] = useState(false);
  const rows = flatten(view, links, closedOpen);
  const now = useNow(rows.some((r) => r.kind === "run" && isRunning(r.run)));
  const found = rows.findIndex((r) => r.kind === "run" && r.run.id === current);
  const start = found >= 0 ? found : rows.findIndex((r) => r.kind === "session");
  // The focused row by key: a worker that moves into the collapsed Closed group leaves the rows, focus goes to that group's header.
  const [focusKey, setFocusKey] = useState(rowKey(rows[start]!));
  const setFocus = (i: number) => setFocusKey(rowKey(rows[i]!));
  const items = useRef<(HTMLLIElement | null)[]>([]);
  const foundAt = rows.findIndex((r) => rowKey(r) === focusKey);
  const fallback = ["closed", "workers", "session"].map((k) => rows.findIndex((r) => r.kind === k)).find((i) => i >= 0)!;
  const at = foundAt >= 0 ? foundAt : fallback;
  // The popup opens with the current node focused, so the arrow keys work at once.
  useEffect(() => void items.current[at]?.focus(), [at, focusKey, rows.length]);
  const activate = (row: Node) => {
    if (row.kind === "run") onOpen(row.run.id);
    else if (row.kind === "session") onOpen(undefined);
    else if (row.kind === "coordinator") onOpenSession(row.id);
    else if (row.kind === "worker") onOpenSession(row.worker.id);
    else if (row.kind === "closed") setClosedOpen((o) => !o);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const row = rows[at]!;
    const firstChild = rows.findIndex((r) => r.parent === at);
    const closed = row.kind === "closed" ? row : undefined;
    const next: Record<string, number | undefined> = {
      ArrowDown: Math.min(at + 1, rows.length - 1),
      ArrowUp: Math.max(at - 1, 0),
      Home: 0,
      End: rows.length - 1,
      ArrowLeft: closed?.open ? undefined : row.parent,
      ArrowRight: closed && !closed.open ? undefined : firstChild >= 0 ? firstChild : undefined,
    };
    if (e.key in next) {
      e.preventDefault();
      if (e.key === "ArrowLeft" && closed?.open) setClosedOpen(false);
      else if (e.key === "ArrowRight" && closed && !closed.open) setClosedOpen(true);
      else if (next[e.key] !== undefined) setFocus(next[e.key]!);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(row);
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
        const run = r.kind === "run" ? r.run : undefined;
        const name = r.kind === "run" ? r.run.description || "Subagent run" : r.kind === "session" ? "Session" : r.kind === "coordinator" ? `Coordinator: ${r.title}` : r.kind === "workers" ? "Workers" : r.kind === "worker" ? r.worker.name : `Closed (${r.n})`;
        const status = run ? `${STATUS_LABEL[run.status]}, ${runDuration(run, now)}` : r.kind === "worker" ? `worker, ${WORKER_LABEL[r.worker.state]}` : "";
        const selected = (r.kind === "run" || r.kind === "session") && (run?.id ?? undefined) === current;
        const inert = r.kind === "workers";
        const testId = r.kind === "run" || r.kind === "session" ? "agent-node" : `agent-${r.kind}`;
        return (
          <li
            key={rowKey(r)}
            ref={(el) => void (items.current[i] = el)}
            role="treeitem"
            aria-level={r.level}
            aria-posinset={r.pos}
            aria-setsize={r.size}
            // Runs, Workers and the open Closed node show their children: the map shows the whole tree, except closed workers.
            aria-expanded={r.kind === "closed" ? r.open : r.children ? true : undefined}
            aria-selected={selected}
            aria-label={status ? `${name}, ${status}` : name}
            tabIndex={i === at ? 0 : -1}
            data-testid={testId}
            data-status={run?.status}
            data-state={r.kind === "worker" ? r.worker.state : undefined}
            data-session-id={r.kind === "worker" ? r.worker.id : undefined}
            onClick={() => activate(r)}
            onFocus={() => setFocus(i)}
            style={{ paddingLeft: 8 + (r.level - 1) * 16 }}
            className={`flex min-h-8 items-center gap-2 rounded-md pr-2 outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-info pointer-coarse:min-h-11 ${inert ? "cursor-default" : "cursor-pointer hover:bg-accent"} ${selected ? "bg-accent" : ""}`}
          >
            {run ? (
              <StatusMark run={run} />
            ) : r.kind === "worker" ? (
              <WorkerMark state={r.worker.state} />
            ) : r.kind === "coordinator" ? (
              <CornerLeftUpIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            ) : r.kind === "closed" ? (
              <ChevronRightIcon aria-hidden className={`size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${r.open ? "rotate-90" : ""}`} />
            ) : (
              <NetworkIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span title={r.kind === "worker" ? r.worker.title : name} className={`min-w-0 flex-1 truncate ${r.kind === "session" || r.kind === "workers" ? "font-medium" : ""} ${r.kind === "worker" && r.level === 3 ? "text-muted-foreground" : ""}`}>
              {name}
            </span>
            {run && (
              <span aria-hidden className="shrink-0 text-[12px] text-muted-foreground tabular-nums">
                {STATUS_LABEL[run.status]} · {runDuration(run, now)}
              </span>
            )}
            {r.kind === "worker" && (
              <span aria-hidden className="shrink-0 text-[12px] text-muted-foreground">
                {WORKER_LABEL[r.worker.state]}
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
              <Menu.Popup className="w-72 max-w-[calc(100vw-32px)] rounded-2xl border bg-popover p-0.5 text-popover-foreground text-sm shadow-floating outline-none">
                {children.map((c) => (
                  <Menu.Item
                    key={c.id}
                    data-testid="subagent-child"
                    onClick={() => onOpen(c.id)}
                    className="flex h-7 cursor-pointer items-center gap-2 rounded-sm px-3 outline-none data-highlighted:bg-accent pointer-coarse:h-11"
                  >
                    <StatusMark run={c} />
                    <span title={c.description || "Subagent run"} className="min-w-0 flex-1 truncate">
                      {c.description || "Subagent run"}
                    </span>
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

/**
 * Replaces the prompt box in the subagent view (OpenCode "Subagent sessions cannot be prompted."): Back and, while it runs, Stop agent.
 * `stopping`: a stop request of this run is in flight or done and the run did not end yet; `error`: the failed stop request's message.
 */
export function NotPromptable({
  view,
  run,
  onOpen,
  onStop,
  stopping = false,
  error,
}: {
  view: SessionView;
  run: Run;
  onOpen: (id?: string) => void;
  onStop: (id: string) => void;
  stopping?: boolean;
  error?: string;
}) {
  const parent = runOf(view, run.parentId);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-muted p-3 text-sm text-muted-foreground" data-testid="not-promptable">
      <p className="min-w-0 flex-1">
        Subagent runs cannot be prompted.{" "}
        <button type="button" className="cursor-pointer text-foreground hover:underline pointer-coarse:min-h-11" data-testid="not-promptable-back" onClick={() => onOpen(parent?.id)}>
          {parent ? "Back to parent run." : "Back to main session."}
        </button>
      </p>
      {isRunning(run) && (
        <button type="button" data-testid="stop-agent" disabled={stopping} className={`${GHOST} flex shrink-0 items-center text-foreground! disabled:opacity-50`} onClick={() => onStop(run.id)}>
          <SquareIcon aria-hidden className="size-3 fill-current" />
          {stopping ? "Stopping…" : "Stop agent"}
        </button>
      )}
      {error && isRunning(run) && (
        <p role="alert" className="basis-full text-right text-destructive text-xs">
          {error}
        </p>
      )}
    </div>
  );
}
