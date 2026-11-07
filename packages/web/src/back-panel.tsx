// "I'll be back" UI (docs/spec.md, plan section 6): the mark panel of a reply, the button, the collapsed brief row of the timeline and the reminder cards.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AlarmClockIcon, BookmarkCheckIcon, BookmarkIcon, CheckIcon, ChevronDownIcon, ClockIcon, LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { BACK_NOTE_MAX, type BackMark } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageAction, MessageResponse } from "@/components/ai-elements/message";
import { aboutOf, fallbackBrief, formatInterval, intervalWords, onFired, parseBrief, parseInterval, type Fired } from "./back-marks.ts";
import { useT, type Key } from "./i18n.ts";
import { TOAST_CARD } from "./toast.tsx";

const clock = (at: number) => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(at);
/** Panel and row targets: 28 px from md up, 44 px below. */
/** The 2px --ring outline (plan 6.0 Focus); the shared Button only draws a halo. */
export const RING = "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[2.5px] focus-visible:outline-ring";
const BTN = `max-md:h-11 max-md:px-3 ${RING}`;
const INPUT = "h-7 min-w-0 rounded-md border-[0.5px] border-border bg-background px-2 text-base text-foreground outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[2.5px] focus-visible:outline-ring max-md:h-11 md:text-[13px]";

/** The "I'll be back" button of a reply's action row. Marked: a plain button that goes to the panel (never a toggle: Done is only in the panel). */
export function BackButton({ partId, marked, onMark, onGo }: { partId: string; marked: boolean; onMark: () => void; onGo: () => void }) {
  const tr = useT();
  const text = tr(marked ? "app.back.marked" : "app.back.mark");
  return (
    <MessageAction data-back-button={partId} className={`max-md:size-11 max-md:ml-1 ${RING}`} title={text} label={text} onClick={marked ? onGo : onMark}>
      {marked ? <BookmarkCheckIcon className="text-foreground" /> : <BookmarkIcon />}
    </MessageAction>
  );
}

const Spin = () => <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />;

/** The brief: three labelled rows, or the plain text when the answer has another shape. */
export function BriefBody({ text }: { text: string }) {
  const tr = useT();
  const rows = parseBrief(text);
  if (!rows) return <MessageResponse className="text-sm leading-[1.6]">{text}</MessageResponse>;
  return (
    <dl className="grid gap-y-1.5 sm:grid-cols-[auto_1fr] sm:gap-x-3">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="font-[530] text-[11px] text-muted-foreground sm:pt-0.5">{tr(`app.back.${r.label}` as Key)}</dt>
          <dd className="min-w-0 text-sm leading-[1.6] [overflow-wrap:anywhere]">{r.text}</dd>
        </div>
      ))}
    </dl>
  );
}

type Held = { reason: "usage_limit" | "not_live"; until?: number } | undefined;

export function BackPanel({ sessionId, mark, stale, gone, held, request, onNotice, onRemoved }: {
  sessionId: string;
  mark: BackMark;
  /** Prompts sent after the brief turn (staleTurns). */
  stale: number;
  /** The marked reply is no longer in the session. */
  gone?: boolean;
  /** The session's queue pause, for a queued brief. */
  held?: Held;
  request: (m: { type: "back.set" | "back.done" | "back.brief"; sessionId: string; partId: string } & Record<string, unknown>) => Promise<unknown>;
  onNotice?: (message: string) => void;
  /** Focus goes back to the reply's button once the panel is gone. */
  onRemoved?: () => void;
}) {
  const tr = useT();
  const head = useId();
  const [error, setError] = useState<string>();
  const run = (m: Record<string, unknown>, type: "back.set" | "back.done" | "back.brief" = "back.set") => request({ type, sessionId, partId: mark.partId, ...m } as never).then(() => setError(undefined), (e: Error) => (setError(e.message), Promise.reject(e)));
  const pending = mark.briefState === "queued" || mark.briefState === "running";
  const failed = mark.briefState === "failed";
  const when = mark.brief ? clock(mark.brief.at) : "";
  // The one live region of the panel: a state change is announced as a full phrase, without moving focus.
  const status = pending
    ? mark.briefState === "running"
      ? tr(mark.brief ? "app.back.writingNew" : "app.back.writing")
      : held?.reason === "not_live"
        ? tr("app.back.pausedError")
        : held?.until
          ? tr("app.back.pausedLimit", { time: clock(held.until) })
          : tr("app.back.queued")
    : failed
      ? tr("app.back.failedStatus")
      : mark.brief
        ? tr("app.back.ready")
        : "";

  const fb = fallbackBrief(mark, tr("app.back.openReply"));
  const reason = mark.briefError === "Interrupted by a restart" ? tr("app.back.interrupted") : mark.briefError;
  return (
    <section
      role="group"
      aria-labelledby={head}
      tabIndex={-1}
      data-back-panel={mark.partId}
      className="my-2 flex scroll-mt-14 flex-col gap-3 rounded-[10px] border-[0.5px] border-border bg-muted p-3 outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[2.5px] focus-visible:outline-ring"
    >
      <div className="flex flex-wrap items-center gap-2 max-md:gap-2">
        <BookmarkIcon aria-hidden className="size-4 shrink-0" />
        <span id={head} className="font-[530] text-[13px]">
          {tr("app.back.title")}
        </span>
        <span className="text-[11px] text-muted-foreground">{tr("app.back.markedAt", { time: clock(mark.at) })}</span>
        <Button
          variant="secondary"
          size="sm"
          className={`ml-auto ${BTN}`}
          aria-label={tr("app.back.doneLabel")}
          onClick={() =>
            void run({}, "back.done").then(() => {
              onNotice?.(tr("app.back.removed"));
              onRemoved?.();
            }, () => {})
          }
        >
          <CheckIcon aria-hidden />
          {tr("app.back.done")}
        </Button>
      </div>
      {gone && <p className="text-[13px] text-muted-foreground">{tr("app.back.replyGone")}</p>}
      <div role="status" aria-atomic="true" className="sr-only">
        {status}
      </div>
      <div className="flex min-h-40 flex-col gap-2 max-sm:min-h-72">
        {pending && !mark.brief ? (
          mark.briefState === "running" ? (
            <>
              <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                <Spin />
                {tr("app.back.writing")}
              </p>
              <div className="flex flex-col gap-2" data-testid="back-skeleton">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </>
          ) : (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              {held?.reason === "not_live" ? <TriangleAlertIcon aria-hidden className="size-4 shrink-0" /> : <ClockIcon aria-hidden className="size-4 shrink-0" />}
              {status}
            </p>
          )
        ) : mark.brief ? (
          <>
            <BriefBody text={mark.brief.text} />
            <p className="text-[11px] text-muted-foreground">{tr("app.back.written", { time: when })}</p>
          </>
        ) : (
          <dl className="grid gap-y-1.5 sm:grid-cols-[auto_1fr] sm:gap-x-3" data-testid="back-fallback">
            {(["about", "lastReply", "next"] as const).map((k) => (
              <div key={k} className="contents">
                <dt className="font-[530] text-[11px] text-muted-foreground sm:pt-0.5">{tr(`app.back.${k}` as Key)}</dt>
                <dd className="min-w-0 text-sm leading-[1.6] [overflow-wrap:anywhere]">{fb[k === "about" ? "about" : k === "lastReply" ? "lastReply" : "next"]}</dd>
              </div>
            ))}
          </dl>
        )}
        {failed && (
          <p className="flex flex-wrap items-center gap-2 text-[13px] text-destructive">
            <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{tr("app.back.failed", { reason: reason ?? "" })}</span>
            <Button variant="secondary" size="sm" className={BTN} onClick={() => void run({}, "back.brief").catch(() => {})}>
              <RefreshCwIcon aria-hidden />
              {tr("app.back.retry")}
            </Button>
          </p>
        )}
        {!failed && mark.brief && (stale > 0 || pending) && (
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <RefreshCwIcon aria-hidden className="size-3.5 shrink-0" />
            <span>{pending ? tr("app.back.writingNew") : tr("app.back.stale", { count: stale })}</span>
            <Button variant="ghost" size="sm" className={BTN} disabled={pending} onClick={() => void run({}, "back.brief").catch(() => {})}>
              {pending && <Spin />}
              {tr("app.back.refresh")}
            </Button>
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-3 max-sm:flex-col">
        <NoteField mark={mark} save={(note) => run({ title: mark.title, note })} />
        <RemindField mark={mark} save={(remindMs) => run({ title: mark.title, remindMs })} />
      </div>
      {error && (
        <p role="alert" className="text-[13px] text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      )}
    </section>
  );
}

function NoteField({ mark, save }: { mark: BackMark; save: (note: string) => Promise<unknown> }) {
  const tr = useT();
  const id = useId();
  const [value, setValue] = useState(mark.note ?? "");
  const [saved, setSaved] = useState(false);
  const last = useRef(mark.note ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = () => {
    if (value === last.current) return;
    last.current = value;
    void save(value).then(() => {
      setSaved(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 2000);
    }, () => (last.current = mark.note ?? ""));
  };
  return (
    <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
      <label htmlFor={id} className="font-[530] text-[11px] text-muted-foreground">
        {tr("app.back.note")}
      </label>
      <input
        id={id}
        type="text"
        maxLength={BACK_NOTE_MAX}
        value={value}
        placeholder={tr("app.back.notePlaceholder")}
        aria-describedby={value.length >= 240 ? `${id}-n` : undefined}
        className={INPUT}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), commit())}
      />
      <div className="flex min-h-4 gap-2 text-[11px] text-muted-foreground">
        {value.length >= 240 && <span id={`${id}-n`}>{tr("app.back.noteCount", { count: value.length })}</span>}
        {saved && <span>{tr("app.back.saved")}</span>}
      </div>
    </div>
  );
}

function RemindField({ mark, save }: { mark: BackMark; save: (ms: number | null) => Promise<unknown> }) {
  const tr = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<"format" | "min" | "max">();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const fired = mark.remindedAt !== undefined;
  const armed = mark.remindAt !== undefined && !fired;
  const apply = async (ms: number | null) => {
    setBusy(true);
    try {
      await save(ms);
      setEditing(false);
      setText("");
      // The input row is replaced by the state line: focus goes to the row, never lost to the body.
      queueMicrotask(() => row.current?.focus());
    } catch {
      // The panel shows the request's error.
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    const r = parseInterval(text);
    if ("error" in r) return (setErr(r.error), input.current?.focus());
    void apply(r.ms);
  };
  const showInput = !armed && !fired ? true : editing;
  const interval = mark.remindMs ? formatInterval(mark.remindMs) : "";
  return (
    <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
      <label htmlFor={id} className="font-[530] text-[11px] text-muted-foreground">
        {tr("app.back.remindIn")}
      </label>
      {showInput ? (
        <>
          <div className="flex items-center gap-2">
            <input
              ref={input}
              id={id}
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={text}
              placeholder="30m"
              aria-invalid={err ? true : undefined}
              aria-describedby={`${id}-h${err ? ` ${id}-e` : ""}`}
              className={`${INPUT} w-[9ch] min-w-24`}
              onChange={(e) => (setText(e.target.value), setErr(undefined))}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), submit())}
            />
            <Button variant="secondary" size="sm" className={BTN} disabled={busy} onClick={submit}>
              {busy && <Spin />}
              {tr("app.back.set")}
            </Button>
          </div>
          <p id={`${id}-h`} className="text-[11px] text-muted-foreground">
            {tr("app.back.remindHelp")}
          </p>
          {err && (
            <p id={`${id}-e`} role="alert" className="flex items-center gap-1.5 text-[13px] text-destructive">
              <TriangleAlertIcon aria-hidden className="size-4 shrink-0" />
              {tr(err === "format" ? "app.back.errFormat" : err === "min" ? "app.back.errMin" : "app.back.errMax")}
            </p>
          )}
        </>
      ) : (
        <div ref={row} id={id} tabIndex={-1} className="flex flex-wrap items-center gap-2 outline-none max-md:gap-2">
          <span className="text-[13px]">{fired ? tr("app.back.reminded", { time: clock(mark.remindedAt!) }) : tr("app.back.reminds", { time: clock(mark.remindAt!), interval })}</span>
          {fired ? (
            <>
              <Snooze mark={mark} busy={busy} apply={apply} />
              <Button variant="ghost" size="sm" className={BTN} aria-label={tr("app.back.dismissLabel")} disabled={busy} onClick={() => void apply(null)}>
                {tr("app.back.dismiss")}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                className={BTN}
                onClick={() => (setText(interval), setEditing(true), setTimeout(() => input.current?.focus()))}
              >
                {tr("app.back.change")}
              </Button>
              <Button variant="ghost" size="sm" className={BTN} aria-label={tr("app.back.clear")} disabled={busy} onClick={() => void apply(null)}>
                {tr("app.back.clear")}
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "Snooze 2h" (name "Snooze 2 hours"): the stored interval again. */
export function Snooze({ mark, busy, apply, className = "" }: { mark: BackMark; busy?: boolean; apply: (ms: number) => void; className?: string }) {
  const tr = useT();
  if (!mark.remindMs) return null;
  return (
    <Button variant="secondary" size="sm" className={`${BTN} ${className}`} aria-label={tr("app.back.snoozeLabel", { intervalLong: intervalWords(mark.remindMs) })} disabled={busy} onClick={() => apply(mark.remindMs!)}>
      {tr("app.back.snooze", { interval: formatInterval(mark.remindMs) })}
    </Button>
  );
}

/** The timeline row of a brief turn: collapsed, with the answer as its body. The tagged prompt itself never shows. */
export function BriefRow({ answer, children }: { answer?: string; children?: ReactNode }) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const body = useId();
  const about = answer ? parseBrief(answer)?.[0]?.text : undefined;
  return (
    <div className="mt-3" data-testid="back-brief-row">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={body}
        onClick={() => setOpen(!open)}
        className="group flex min-h-8 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-[2.5px] focus-visible:outline-ring max-md:min-h-11"
      >
        <BookmarkIcon aria-hidden className="size-4 shrink-0 text-faint" />
        <span className="shrink-0 font-medium text-sm">{tr("app.back.briefRow")}</span>
        {about && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm" title={about}>
            {tr("app.back.about")}: {about}
          </span>
        )}
        <ChevronDownIcon aria-hidden className={`ml-auto size-4 shrink-0 text-faint transition-transform motion-reduce:transition-none max-md:opacity-100 ${open ? "rotate-180 opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"}`} />
      </button>
      <div id={body} hidden={!open} className="px-1 pb-1 pt-1">
        {open && (answer ? <BriefBody text={answer} /> : null)}
        {children}
      </div>
    </div>
  );
}

/** In-app reminder cards: one per fired reminder of a live settings change, until Open, Snooze, Dismiss or close. Not focused, announced politely by the region. */
export function BackReminderCards({ enabled, skip, title, marks, onOpen, request }: {
  enabled: boolean;
  /** A session that gets no card (archived: the daemon sends no push for it either). */
  skip?: (sessionId: string) => boolean;
  /** The session's title for the card. */
  title: (sessionId: string) => string;
  /** The marks now (a card follows its mark: Done or a new reminder removes it). */
  marks: Record<string, BackMark[]>;
  onOpen: (sessionId: string, partId: string) => void;
  request: (m: Record<string, unknown>) => Promise<unknown>;
}) {
  const tr = useT();
  const [cards, setCards] = useState<Fired[]>([]);
  const [snoozed, setSnoozed] = useState<{ key: string; text: string }>();
  const on = useRef(enabled);
  on.current = enabled;
  useEffect(
    () =>
      onFired((f) => {
        if (!on.current) return;
        setCards((c) => [...c.filter((x) => !f.some((y) => y.sessionId === x.sessionId && y.mark.partId === x.mark.partId)), ...f]);
      }),
    [],
  );
  const key = (c: Fired) => `${c.sessionId}\0${c.mark.partId}`;
  const drop = (c: Fired) => setCards((all) => all.filter((x) => key(x) !== key(c)));
  // A card follows its mark: gone (Done, session deleted) or re-armed (Snooze elsewhere) removes it.
  const live = cards.filter((c) => !skip?.(c.sessionId) && (key(c) === snoozed?.key || marks[c.sessionId]?.find((m) => m.partId === c.mark.partId)?.remindedAt === c.mark.remindedAt));
  useEffect(() => {
    if (live.length !== cards.length) setCards(live);
  });
  useEffect(() => {
    if (!snoozed) return;
    const t = setTimeout(() => setSnoozed(undefined), 3000);
    return () => clearTimeout(t);
  }, [snoozed]);
  const shown = live.slice(-3);
  const newest = shown.at(-1);
  return (
    <>
      {/* The region exists before its text, so a screen reader announces each new card (the cards take no focus). */}
      <div role="status" className="sr-only">
        {newest ? tr("app.back.announce", { title: title(newest.sessionId) }) : ""}
      </div>
      {shown.map((c) => {
        const mark = marks[c.sessionId]?.find((m) => m.partId === c.mark.partId) ?? c.mark;
        const sessionTitle = title(c.sessionId);
        const missed = mark.remindAt !== undefined && mark.remindedAt !== undefined && mark.remindedAt - mark.remindAt > 60_000;
        const snoozedNow = snoozed?.key === key(c);
        return (
          <div key={key(c)} className={`${TOAST_CARD} flex flex-col gap-1`} data-testid="back-reminder-card">
            <div className="flex items-start gap-2">
              <AlarmClockIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              <p className="min-w-0 flex-1 truncate font-[530] text-[13px]" title={sessionTitle}>
                {tr("app.back.cardTitle", { title: sessionTitle })}
              </p>
              <button type="button" aria-label={tr("app.toast.dismiss")} className="rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring max-md:size-11" onClick={() => drop(c)}>
                <XIcon aria-hidden className="size-4" />
              </button>
            </div>
            {snoozedNow ? (
              <p role="status" className="text-[13px] text-muted-foreground">
                {snoozed!.text}
              </p>
            ) : (
              <>
                <p className="line-clamp-2 text-[13px] [overflow-wrap:anywhere]">{mark.note || aboutOf(mark) || mark.title}</p>
                <p className="text-[11px] text-muted-foreground">{tr(missed ? "app.back.wasDue" : "app.back.due", { time: clock(mark.remindAt ?? mark.remindedAt!) })}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" className={BTN} onClick={() => (onOpen(c.sessionId, mark.partId), drop(c))}>
                    {tr("app.back.open")}
                  </Button>
                  <Snooze
                    mark={mark}
                    apply={(ms) => {
                      // Before the request: the daemon's settings_changed (mark re-armed) arrives before its reply and would drop the card.
                      setSnoozed({ key: key(c), text: tr("app.back.snoozed", { time: clock(Date.now() + ms) }) });
                      void request({ type: "back.set", sessionId: c.sessionId, partId: mark.partId, title: mark.title, remindMs: ms }).then(
                        () => void setTimeout(() => drop(c), 3000),
                        () => setSnoozed(undefined),
                      );
                    }}
                  />
                  <Button variant="ghost" size="sm" className={BTN} aria-label={tr("app.back.dismissLabel")} onClick={() => void request({ type: "back.set", sessionId: c.sessionId, partId: mark.partId, title: mark.title, remindMs: null }).then(() => drop(c), () => {})}>
                    {tr("app.back.dismiss")}
                  </Button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}

/** Test seam: an interval parse result as its i18n key. */
export const intervalErrorKey = (e: "format" | "min" | "max"): Key => (e === "format" ? "app.back.errFormat" : e === "min" ? "app.back.errMin" : "app.back.errMax");
