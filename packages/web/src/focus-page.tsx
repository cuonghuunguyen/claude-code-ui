// Focus page (docs/spec.md "Focus", GH-159, GH-270): per session, what needs you, what works and what finished; requests are answered in place.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionListItem, Worktree } from "@claude-ui/protocol";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, CircleAlertIcon, ClockIcon, CrosshairIcon, HourglassIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { answeredLabel, attentionRows, BLOCKING, capRows, focusSubtitle, KIND_LABEL, nextWaiting, QUIET_SHOWN_MS, quietLabel, rowTodos, taskProgress, waitLabel, workingRows, type AttentionKind, type AttentionRow, type Waiting } from "./focus.ts";
import { PermissionPanel, type PermissionAnswer } from "./permission.tsx";
import { QuestionPanel } from "./question.tsx";
import { foldLabel, signalItems } from "./signal.ts";
import { keyLabels } from "./shortcuts.ts";
import { useKeymap } from "./keymap.ts";
import { timeAgo, worktreeName } from "./sessions.ts";
import { summarizePasted } from "./pasted-text.ts";
import { awaitingPermission, timeline, type SessionView } from "./store.ts";
import { Mark, statusText } from "./todo-dock.tsx";
import { ProjectAvatar } from "./tabs-bar.tsx";
import { projectName } from "./tabs.ts";
import { toolSummary } from "./tools.ts";
import type { TodoItem } from "@claude-ui/protocol";

/** Re-renders every `ms`: the wait times tick. */
export function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** A request answered while the page was shown: its row shrinks to one line until the page is left. */
type Answered = { id: string; sessionId: string; since: number; label: string };

const LAST_ITEMS = 6;

/** The last steps of the session in signal-only form, read-only: the last prompt onward, never the request itself. */
function RecentContext({ view }: { view: SessionView }) {
  const items = useMemo(() => {
    const all = signalItems(timeline(view), (c) => awaitingPermission(view).has(c.toolUseId));
    const lastPrompt = all.map((i) => i.kind === "part" && i.part.type === "user_text").lastIndexOf(true);
    return all
      .slice(Math.max(lastPrompt, 0))
      .filter((i) => i.kind === "fold" || (i.kind === "part" && ["user_text", "assistant_text", "tool_call", "notice"].includes(i.part.type) && !(i.part.type === "tool_call" && awaitingPermission(view).has(i.part.toolUseId))))
      .slice(-LAST_ITEMS);
  }, [view]);
  if (!items.length) return <p className="text-muted-foreground text-sm">No steps yet.</p>;
  return (
    <ul className="flex flex-col gap-1.5" data-testid="focus-context">
      {items.map((item) => {
        if (item.kind === "fold") return <li key={item.id} className="font-mono text-muted-foreground text-xs">{foldLabel(item.calls)}</li>;
        if (item.kind !== "part") return null;
        const { part } = item;
        if (part.type === "user_text") return <li key={part.id} className="line-clamp-2 w-fit max-w-full rounded-lg bg-secondary px-2.5 py-1 text-sm [overflow-wrap:anywhere]">{summarizePasted(part.text)}</li>;
        if (part.type === "assistant_text") return <li key={part.id} className="line-clamp-4 whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{part.text}</li>;
        if (part.type === "tool_call") return <li key={part.id} className="truncate font-mono text-destructive text-xs">{part.tool} {toolSummary(part.input)} · {part.status}</li>;
        return part.type === "notice" ? <li key={part.id} className="text-muted-foreground text-xs">{part.text}</li> : null;
      })}
    </ul>
  );
}

type Props = {
  list: SessionListItem[];
  views: Record<string, SessionView | undefined>;
  worktrees: Record<string, Worktree[]>;
  /** Requests waiting, oldest first (focus.ts waitingRequests). */
  waiting: Waiting[];
  /** The selected row's id (a request's part id, else `${kind}:${sessionId}`); the first waiting request when it is absent or gone. */
  selected?: string;
  onSelect: (requestId: string | undefined) => void;
  onRespond: (requestId: string, answer: PermissionAnswer) => void;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  onOpenSession: (sessionId: string) => void;
  /** Sessions with an unseen finish or error (unread.ts). */
  unread: ReadonlySet<string>;
  /** Last activity of a session (ms): the last live event this browser saw, else the list's. */
  activity: (sessionId: string) => number;
  onCancelContinue: (sessionId: string) => void;
};

const TASK_GROUPS: { status: TodoItem["status"]; label: string }[] = [
  { status: "completed", label: "Done" },
  { status: "in_progress", label: "In progress" },
  { status: "pending", label: "Next" },
];

/** The session's todo list in three groups, with k of n; completed items muted. */
function TaskList({ items }: { items: TodoItem[] }) {
  return (
    <section aria-label="Tasks" data-testid="focus-tasks">
      <h3 className="mb-1.5 font-medium text-muted-foreground text-xs">Tasks · {taskProgress(items)}</h3>
      <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
        {TASK_GROUPS.map(({ status, label }) => {
          const group = items.filter((t) => t.status === status);
          return group.length ? (
            <div key={status}>
              <p className="mb-0.5 text-faint text-xs">{label}</p>
              <ul className="flex flex-col gap-1">
                {group.map((t, n) => (
                  <li key={n} className={`flex items-start gap-2 text-sm ${status === "completed" ? "text-muted-foreground line-through" : ""}`}>
                    <Mark status={t.status} />
                    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{status === "in_progress" ? (t.activeForm ?? t.content) : t.content}</span>
                    <span className="sr-only">{statusText[t.status]}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null;
        })}
      </div>
    </section>
  );
}

const KIND_ICON: Record<AttentionKind, { icon: typeof CircleAlertIcon; tone: string }> = {
  escalated: { icon: CircleAlertIcon, tone: "text-warning" },
  permission: { icon: CircleAlertIcon, tone: "text-warning" },
  question: { icon: CircleAlertIcon, tone: "text-warning" },
  error: { icon: TriangleAlertIcon, tone: "text-destructive" },
  limit: { icon: ClockIcon, tone: "text-muted-foreground" },
  stuck: { icon: HourglassIcon, tone: "text-muted-foreground" },
  finished: { icon: CheckIcon, tone: "text-success" },
};

type SectionKey = "needs" | "working" | "finished";

export function FocusPage({ list, views, worktrees, waiting, selected, onSelect, onRespond, onAnswer, onOpenSession, unread, activity, onCancelContinue }: Props) {
  const now = useNow(1000);
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({ needs: false, working: false, finished: false });
  const titleOf = (id: string) => list.find((s) => s.id === id)?.title || "Untitled";
  // Rows answered while this page is shown, anywhere (here or in the session): one line each until the page is left.
  const [answered, setAnswered] = useState<Answered[]>([]);
  const previous = useRef(waiting);
  useEffect(() => {
    const gone = previous.current.filter((p) => !waiting.some((w) => w.part.id === p.part.id));
    previous.current = waiting;
    if (!gone.length) return;
    setAnswered((a) => [
      ...a,
      ...gone.flatMap((g) => {
        const part = views[g.sessionId]?.parts.get(g.part.id);
        return part && (part.type === "permission_request" || part.type === "question") && part.settled && !a.some((x) => x.id === g.part.id)
          ? [{ id: g.part.id, sessionId: g.sessionId, since: g.since, label: answeredLabel(part, list.find((s) => s.id === g.sessionId)?.cwd) }]
          : [];
      }),
    ]);
  }, [waiting]);
  const input = { list, views, waiting, unread, activity, now };
  const attention = attentionRows(input);
  const working = workingRows(input, attention);
  const requestRows = attention.filter((r) => r.request);
  const current = attention.find((r) => r.id === selected) ?? requestRows[0];
  const req = current?.request ? waiting.find((w) => w.part.id === current.id) : undefined;
  // Below md one column: the queue, or the detail of a picked row with a way back.
  const [detail, setDetail] = useState(!!selected);
  const [prevSelected, setPrevSelected] = useState(selected);
  if (selected !== prevSelected) {
    setPrevSelected(selected);
    if (selected) setDetail(true);
  }
  const card = useRef<HTMLDivElement>(null);
  // After an answer the next request's first action takes the focus, so the keyboard flow goes on.
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    card.current?.querySelector<HTMLElement>("form input[type=radio], form input[type=checkbox], form button:not([aria-label='Stop'])")?.focus();
  }, [current?.id]);
  const moveOn = (w: Waiting) => {
    refocus.current = true;
    const at = waiting.findIndex((x) => x.part.id === w.part.id);
    onSelect((waiting[at + 1] ?? waiting.find((x) => x.part.id !== w.part.id))?.part.id);
  };
  const needs = capRows(attention.filter((r) => r.kind !== "finished"), expanded.needs);
  const finished = capRows(attention.filter((r) => r.kind === "finished"), expanded.finished);
  const workingShown = capRows(working, expanded.working);
  // Answered one-liners sit among the request rows by their time, before the other kinds.
  const lead = needs.shown.filter((r) => r.request);
  // The requests are in the displayed order already (kind, then time); the answered lines lead.
  const lines = [
    ...lead.map((r) => ({ id: r.id, rank: 0, row: r, answered: undefined as Answered | undefined })),
    ...answered.map((a) => ({ id: a.id, rank: -1, row: undefined, answered: a })),
  ].sort((a, b) => a.rank - b.rank);
  const rest = needs.shown.filter((r) => !r.request);
  const needsEmpty = !lines.length && !rest.length;
  const more = (key: SectionKey, n: number) =>
    n > 0 || expanded[key] ? (
      <button type="button" className="mt-1 w-full cursor-pointer rounded-lg px-2.5 py-1.5 text-left text-muted-foreground text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 pointer-coarse:min-h-11" onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))} data-testid="focus-more">
        {expanded[key] ? "Show less" : `+${n} more`}
      </button>
    ) : null;
  const select = (id: string) => (setDetail(true), onSelect(id));
  // A row's Cancel continue removes the row (when the daemon confirms): the focus goes to the next row's button, else the previous one, else the heading.
  const shownIds = [...lines.flatMap((l) => (l.row ? [l.row.id] : [])), ...rest.map((r) => r.id), ...finished.shown.map((r) => r.id)];
  const heading = useRef<HTMLHeadingElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ id: string; before: string[] } | undefined>(undefined);
  useEffect(() => {
    const p = pendingFocus.current;
    if (!p || shownIds.includes(p.id)) return;
    pendingFocus.current = undefined;
    const at = p.before.indexOf(p.id);
    const target = [...p.before.slice(at + 1), ...p.before.slice(0, at).reverse()].find((id) => shownIds.includes(id));
    const button = target && [...page.current!.querySelectorAll<HTMLElement>("[data-row-id]")].find((b) => b.dataset.rowId === target);
    (button || heading.current)?.focus();
  });
  const renderRow = (r: AttentionRow) => (
    <li key={r.id}>
      <AttentionRowView row={r} title={titleOf(r.sessionId)} now={now} selected={r.id === current?.id} onSelect={() => select(r.id)} onAct={() => (r.action === "cancel_continue" ? ((pendingFocus.current = { id: r.id, before: shownIds }), onCancelContinue(r.sessionId)) : onOpenSession(r.sessionId))} />
    </li>
  );
  const next = nextWaiting(waiting, req?.part.id);
  const nextKey = useKeymap()("focus.next");
  const keys = nextKey ? keyLabels(nextKey) : [];
  const session = current && list.find((s) => s.id === current.sessionId);
  const view = current && views[current.sessionId];
  const tasks = view ? (rowTodos(view).length ? rowTodos(view) : view.lastTodos) : [];
  const n = waiting.length ? new Set(waiting.map((w) => w.sessionId)).size : 0;
  return (
    <div ref={page} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-card shadow-raised" data-testid="focus-page">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 ref={heading} tabIndex={-1} className="font-medium text-base outline-none">Focus</h1>
          <p className="truncate text-muted-foreground text-sm" data-testid="focus-subtitle">
            {focusSubtitle(attention, working.length)}
          </p>
        </div>
        {n > 0 && (
          <Button type="button" variant="outline" className="max-md:h-11 pointer-coarse:h-11" onClick={() => next && onSelect(next.part.id)} data-testid="focus-next">
            Next waiting
            <span className="flex gap-0.5 max-md:hidden" aria-hidden>
              {keys.map((k) => <kbd key={k} className="rounded border px-1 font-mono text-[10px]">{k}</kbd>)}
            </span>
          </Button>
        )}
      </header>
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(260px,360px)_1fr]">
        <div className={`flex min-h-0 flex-col gap-4 overflow-y-auto border-r p-3 max-md:border-r-0 ${detail && current ? "max-md:hidden" : ""}`} data-testid="focus-queue">
          {!needsEmpty ? (
            <section aria-labelledby="focus-needs">
              <h2 id="focus-needs" className="mb-1.5 px-1 font-medium text-muted-foreground text-xs">Needs you · {attention.filter((r) => r.kind !== "finished").length}</h2>
              <ul className="flex flex-col gap-1.5">
                {lines.map((r) =>
                  r.answered ? (
                    <li key={r.id} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground text-sm pointer-coarse:min-h-11" data-testid="focus-answered">
                      <CheckIcon className="size-4 shrink-0 text-success" aria-hidden />
                      <span className="min-w-0 flex-1 truncate" title={`${titleOf(r.answered.sessionId)}: ${r.answered.label}`}>{r.answered.label}</span>
                    </li>
                  ) : (
                    renderRow(r.row!)
                  ),
                )}
                {rest.map(renderRow)}
              </ul>
              {more("needs", needs.more)}
            </section>
          ) : (
            <section className="px-1 py-6 text-center" data-testid="focus-empty">
              <CheckIcon className="mx-auto mb-2 size-6 text-success" aria-hidden />
              <p className="font-medium">Nothing needs you</p>
              <p className="text-muted-foreground text-sm">{working.length ? "These sessions are still working." : "No session is running."}</p>
            </section>
          )}
          {working.length > 0 && (
            <section aria-labelledby="focus-running">
              <h2 id="focus-running" className="mb-1.5 px-1 font-medium text-muted-foreground text-xs">Working · {working.length}</h2>
              <ul className="flex flex-col gap-1">
                {workingShown.shown.map(({ session: s, now: nowText, progress, quietMs }) => (
                  <li key={s.id}>
                    <button type="button" className="flex w-full cursor-pointer flex-col rounded-lg px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" onClick={() => onOpenSession(s.id)} data-testid="focus-running-row">
                      <span className="flex items-center gap-2">
                        <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-faint motion-reduce:animate-none" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{s.title || "Untitled"}</span>
                        <span className="shrink-0 text-muted-foreground text-xs">{quietMs > QUIET_SHOWN_MS ? quietLabel(quietMs) : timeAgo(s.lastActivity, now)}</span>
                      </span>
                      <span className="truncate pl-6 text-muted-foreground text-xs" data-testid="focus-now">{nowText}</span>
                      {progress && <span className="truncate pl-6 text-muted-foreground text-xs" data-testid="focus-progress">{progress}</span>}
                    </button>
                  </li>
                ))}
              </ul>
              {more("working", workingShown.more)}
            </section>
          )}
          {finished.shown.length > 0 && (
            <section aria-labelledby="focus-finished">
              <h2 id="focus-finished" className="mb-1.5 px-1 font-medium text-muted-foreground text-xs">Finished while you were away · {attention.filter((r) => r.kind === "finished").length}</h2>
              <ul className="flex flex-col gap-1.5">{finished.shown.map(renderRow)}</ul>
              {more("finished", finished.more)}
            </section>
          )}
        </div>
        <div className={`flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-4 max-md:p-3 ${detail && current ? "" : "max-md:hidden"}`} data-testid="focus-detail">
          {current && session && view ? (
            <>
              <Button type="button" variant="ghost" className="w-fit md:hidden max-md:h-11 pointer-coarse:h-11" onClick={() => setDetail(false)} data-testid="focus-back">
                <ArrowLeftIcon />
                Back to queue
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                <ProjectAvatar cwd={session.cwd} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-medium" data-testid="focus-title">{session.title || "Untitled"}</h2>
                  <p className="truncate text-muted-foreground text-xs" title={session.cwd}>{worktreeName(session.cwd, worktrees) ?? projectName(session.cwd)}</p>
                </div>
                <Button type="button" variant="outline" className="max-md:h-11 pointer-coarse:h-11" onClick={() => onOpenSession(session.id)} data-testid="focus-open-session">
                  Open session
                  <ArrowRightIcon />
                </Button>
              </div>
              {!req && (
                <p className={`flex items-center gap-1.5 text-xs ${BLOCKING.has(current.kind) ? "text-warning" : "text-muted-foreground"}`} data-testid="focus-kind-line">
                  <span className="font-medium">{KIND_LABEL[current.kind]}</span>
                  <span className="min-w-0 truncate">{current.reason}</span>
                </p>
              )}
              {current.action === "cancel_continue" && (
                <Button type="button" variant="outline" className="w-fit max-md:h-11 pointer-coarse:h-11" onClick={() => onCancelContinue(session.id)} data-testid="focus-cancel-continue">
                  Cancel continue
                </Button>
              )}
              {tasks.length > 0 && <TaskList items={tasks} />}
              <section aria-label="Recent context, signal only">
                <h3 className="mb-1.5 font-medium text-muted-foreground text-xs">Recent context · signal only</h3>
                <RecentContext view={view} />
              </section>
              {req && (
                <section className="flex flex-col gap-1.5" aria-label="Request">
                  <p className="flex items-center gap-1.5 text-warning text-xs" data-testid="focus-waiting">
                    <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden />
                    waiting {waitLabel(now - req.since)}
                  </p>
                  <div ref={card}>
                    {req.part.type === "permission_request" ? (
                      <PermissionPanel key={req.part.id} part={req.part} tier={req.part.tier ?? "high"} onRespond={(a) => (onRespond(req.part.requestId, a), moveOn(req))} />
                    ) : (
                      <QuestionPanel key={req.part.id} part={req.part} onAnswer={(a) => (onAnswer(req.part.requestId, a), moveOn(req))} />
                    )}
                  </div>
                </section>
              )}
            </>
          ) : (
            <p className="m-auto text-muted-foreground text-sm">Nothing is waiting for you.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function AttentionRowView({ row, title, now, selected, onSelect, onAct }: { row: AttentionRow; title: string; now: number; selected: boolean; onSelect: () => void; onAct: () => void }) {
  const { icon: Icon, tone } = KIND_ICON[row.kind];
  const kindTone = BLOCKING.has(row.kind) ? "text-warning" : row.kind === "error" ? "text-destructive" : "text-muted-foreground";
  const age = row.request ? waitLabel(now - row.since) : row.kind === "stuck" ? "" : timeAgo(row.since, now);
  const select = (
    <button
      type="button"
      aria-current={selected || undefined}
      className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
      onClick={onSelect}
      data-testid="focus-row"
      data-row-id={row.id}
      data-kind={row.kind}
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone}`} aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-1.5">
          <span className={`shrink-0 font-medium text-xs ${kindTone}`}>{KIND_LABEL[row.kind]}</span>
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        </span>
        <span className="truncate text-muted-foreground text-xs">{row.reason}</span>
        {row.detail && <span className="truncate text-muted-foreground text-xs">{row.detail}</span>}
      </span>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums" data-testid="focus-wait">{age}</span>
    </button>
  );
  if (row.request) return <div className={`flex rounded-lg ${selected ? "bg-secondary ring-2 ring-foreground" : ""}`}>{select}</div>;
  return (
    <div className={`flex items-start gap-1 rounded-lg ${selected ? "bg-secondary ring-2 ring-foreground" : ""}`}>
      {select}
      <Button type="button" variant="outline" size="sm" className="mt-1.5 mr-1.5 shrink-0 max-md:h-11 pointer-coarse:h-11" onClick={onAct} data-testid="focus-row-action">
        {row.action === "cancel_continue" ? "Cancel continue" : "Open session"}
      </Button>
    </div>
  );
}

/** The sidebar's Focus entry above Projects, with how many sessions wait. */
export function FocusRow({ count, active, onOpen }: { count: number; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-current={active || undefined}
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11 ${active ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      onClick={onOpen}
      data-testid="focus-row-sidebar"
      data-command="focus.open"
    >
      <CrosshairIcon className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-medium">Focus</span>
      {count > 0 && (
        <span className="flex items-center gap-1 rounded-full bg-warning px-1.5 text-background text-xs tabular-nums leading-5" data-testid="focus-count">
          <CircleAlertIcon className="size-3" aria-hidden />
          {count} waiting
        </span>
      )}
    </button>
  );
}
