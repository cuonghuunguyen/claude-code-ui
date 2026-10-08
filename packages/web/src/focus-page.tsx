// Focus page (docs/spec.md "Focus", GH-159): every unanswered permission request and question across the sessions, answered in place.
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionListItem, Worktree } from "@claude-ui/protocol";
import { ArrowLeftIcon, ArrowRightIcon, CheckIcon, CircleAlertIcon, CrosshairIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { answeredLabel, nextWaiting, requestSummary, runningSessions, waitLabel, waitingCount, type Waiting } from "./focus.ts";
import { PermissionPanel, type PermissionAnswer } from "./permission.tsx";
import { QuestionPanel } from "./question.tsx";
import { foldLabel, signalItems } from "./signal.ts";
import { KEYS, keyLabels } from "./shortcuts.ts";
import { projectOf, timeAgo, worktreeName } from "./sessions.ts";
import { awaitingPermission, timeline, type SessionView } from "./store.ts";
import { ProjectAvatar } from "./tabs-bar.tsx";
import { projectName } from "./tabs.ts";
import { toolSummary } from "./tools.ts";

/** Re-renders every `ms`: the wait times tick. */
function useNow(ms: number) {
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
        if (part.type === "user_text") return <li key={part.id} className="line-clamp-2 w-fit max-w-full rounded-lg bg-secondary px-2.5 py-1 text-sm [overflow-wrap:anywhere]">{part.text}</li>;
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
  /** The selected request's id; the first waiting one when it is absent or answered. */
  selected?: string;
  onSelect: (requestId: string | undefined) => void;
  onRespond: (requestId: string, answer: PermissionAnswer) => void;
  onAnswer: (requestId: string, answers: Record<string, string>) => void;
  onOpenSession: (sessionId: string) => void;
};

export function FocusPage({ list, views, worktrees, waiting, selected, onSelect, onRespond, onAnswer, onOpenSession }: Props) {
  const now = useNow(1000);
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
  const current = waiting.find((w) => w.part.id === selected) ?? waiting[0];
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
  }, [current?.part.id]);
  const moveOn = (w: Waiting) => {
    refocus.current = true;
    const at = waiting.findIndex((x) => x.part.id === w.part.id);
    onSelect((waiting[at + 1] ?? waiting.find((x) => x.part.id !== w.part.id))?.part.id);
  };
  const running = runningSessions(list, views, waiting);
  const projects = new Set(waiting.map((w) => projectOf(list.find((s) => s.id === w.sessionId)?.cwd ?? "", worktrees))).size;
  const n = waitingCount(waiting);
  const rows = [
    ...waiting.map((w) => ({ id: w.part.id, since: w.since, w, answered: undefined as Answered | undefined })),
    ...answered.map((a) => ({ id: a.id, since: a.since, w: undefined, answered: a })),
  ].sort((a, b) => a.since - b.since);
  const next = nextWaiting(waiting, current?.part.id);
  const keys = keyLabels(KEYS.nextWaiting);
  const session = current && list.find((s) => s.id === current.sessionId);
  const view = current && views[current.sessionId];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-card shadow-raised" data-testid="focus-page">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-medium text-base">Focus</h1>
          <p className="truncate text-muted-foreground text-sm" data-testid="focus-subtitle">
            {n ? `${n} ${n === 1 ? "session needs" : "sessions need"} input across ${projects} ${projects === 1 ? "project" : "projects"}` : "Nothing needs you"}
          </p>
        </div>
        {n > 0 && (
          <Button type="button" variant="outline" className="pointer-coarse:h-11" onClick={() => next && onSelect(next.part.id)} data-testid="focus-next">
            Next waiting
            <span className="flex gap-0.5 max-md:hidden" aria-hidden>
              {keys.map((k) => <kbd key={k} className="rounded border px-1 font-mono text-[10px]">{k}</kbd>)}
            </span>
          </Button>
        )}
      </header>
      <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(260px,360px)_1fr]">
        <div className={`flex min-h-0 flex-col gap-4 overflow-y-auto border-r p-3 max-md:border-r-0 ${detail && current ? "max-md:hidden" : ""}`} data-testid="focus-queue">
          {rows.length > 0 ? (
            <section aria-labelledby="focus-needs">
              <h2 id="focus-needs" className="mb-1.5 px-1 font-medium text-muted-foreground text-xs">Needs you, oldest first</h2>
              <ul className="flex flex-col gap-1.5">
                {rows.map((r) =>
                  r.answered ? (
                    <li key={r.id} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted-foreground text-sm pointer-coarse:min-h-11" data-testid="focus-answered">
                      <CheckIcon className="size-4 shrink-0 text-success" aria-hidden />
                      <span className="min-w-0 flex-1 truncate" title={`${titleOf(r.answered.sessionId)}: ${r.answered.label}`}>{r.answered.label}</span>
                    </li>
                  ) : (
                    <li key={r.id}>
                      <RequestRow w={r.w!} title={titleOf(r.w!.sessionId)} cwd={list.find((s) => s.id === r.w!.sessionId)?.cwd} now={now} selected={r.w!.part.id === current?.part.id} onSelect={() => (setDetail(true), onSelect(r.w!.part.id))} />
                    </li>
                  ),
                )}
              </ul>
            </section>
          ) : (
            <section className="px-1 py-6 text-center" data-testid="focus-empty">
              <CheckIcon className="mx-auto mb-2 size-6 text-success" aria-hidden />
              <p className="font-medium">Nothing needs you</p>
              <p className="text-muted-foreground text-sm">{running.length ? "These sessions are still running." : "No session is running."}</p>
            </section>
          )}
          {running.length > 0 && (
            <section aria-labelledby="focus-running">
              <h2 id="focus-running" className="mb-1.5 px-1 font-medium text-muted-foreground text-xs">Running · {running.length}</h2>
              <ul className="flex flex-col gap-1">
                {running.map(({ session: s, tool }) => (
                  <li key={s.id}>
                    <button type="button" className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11" onClick={() => onOpenSession(s.id)} data-testid="focus-running-row">
                      <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-faint motion-reduce:animate-none" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{s.title || "Untitled"}</span>
                      <span className="shrink-0 text-muted-foreground text-xs">{[timeAgo(s.lastActivity) === "now" ? "now" : timeAgo(s.lastActivity), tool].filter(Boolean).join(" · ")}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div className={`flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto p-4 max-md:p-3 ${detail && current ? "" : "max-md:hidden"}`} data-testid="focus-detail">
          {current && session && view ? (
            <>
              <Button type="button" variant="ghost" className="w-fit md:hidden pointer-coarse:h-11" onClick={() => setDetail(false)} data-testid="focus-back">
                <ArrowLeftIcon />
                Back to queue
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                <ProjectAvatar cwd={session.cwd} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-medium" data-testid="focus-title">{session.title || "Untitled"}</h2>
                  <p className="truncate text-muted-foreground text-xs" title={session.cwd}>{worktreeName(session.cwd, worktrees) ?? projectName(session.cwd)}</p>
                </div>
                <Button type="button" variant="outline" className="pointer-coarse:h-11" onClick={() => onOpenSession(session.id)} data-testid="focus-open-session">
                  Open session
                  <ArrowRightIcon />
                </Button>
              </div>
              <section aria-label="Recent context, signal only">
                <h3 className="mb-1.5 font-medium text-muted-foreground text-xs">Recent context · signal only</h3>
                <RecentContext view={view} />
              </section>
              <section className="flex flex-col gap-1.5" aria-label="Request">
                <p className="flex items-center gap-1.5 text-warning text-xs" data-testid="focus-waiting">
                  <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden />
                  waiting {waitLabel(now - current.since)} · {requestSummary(current.part, session.cwd)}
                </p>
                <div ref={card}>
                  {current.part.type === "permission_request" ? (
                    <PermissionPanel key={current.part.id} part={current.part} tier={current.part.tier ?? "high"} onRespond={(a) => (onRespond(current.part.requestId, a), moveOn(current))} />
                  ) : (
                    <QuestionPanel key={current.part.id} part={current.part} onAnswer={(a) => (onAnswer(current.part.requestId, a), moveOn(current))} />
                  )}
                </div>
              </section>
            </>
          ) : (
            <p className="m-auto text-muted-foreground text-sm">Nothing is waiting for you.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function RequestRow({ w, title, cwd, now, selected, onSelect }: { w: Waiting; title: string; cwd?: string; now: number; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-current={selected || undefined}
      className={`flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 ${selected ? "bg-secondary ring-2 ring-foreground" : ""}`}
      onClick={onSelect}
      data-testid="focus-row"
    >
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        <span className="truncate text-muted-foreground text-xs">{requestSummary(w.part, cwd)}</span>
      </span>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums" data-testid="focus-wait">{waitLabel(now - w.since)}</span>
    </button>
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
