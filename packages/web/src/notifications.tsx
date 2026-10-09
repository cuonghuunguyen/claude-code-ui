// In-app notification cards (docs/spec.md "In-app notifications", GH-158): one card per session that needs input or finished, in the toast corner.
// The model is notify.ts; useNotifications turns live events into cards (with the delays), NotificationStack draws them.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CircleCheckIcon, CircleXIcon, LockIcon, MessageCircleQuestionIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import type { Event, SessionListItem } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import { usePhone } from "@/lib/use-narrow";
import { addCard, ageLabel, createTracker, dismissSession, inlineActions, reconcile, visibleCards, type Card, type Described, type Signal } from "./notify.ts";
import type { SessionView } from "./store.ts";
import { ProjectAvatar } from "./tabs-bar.tsx";
import { TOAST_CARD } from "./toast.tsx";

const FINISHED_MS = 8000;
/** The daemon's FINISH_DELAY_MS: running, idle, running again inside a tool loop never shows "finished". */
export const FINISH_DELAY_MS = 1500;
/** A worker's request that a coordinator may answer shows only if it is still waiting after this. */
export const WORKER_DELAY_MS = 3000;
const MAX_CARDS = 3;

export type CardItem = { card: Card; d: Described; title: string; place: string; cwd?: string };

type Gate = {
  enabled: boolean;
  focused: boolean;
  /** The active tab is the Focus page. */
  focusPage: boolean;
  /** The session a tab shows right now (the session view or a subagent view of it). */
  shown: (sessionId: string) => boolean;
  list: SessionListItem[];
  views: Record<string, SessionView | undefined>;
};

/**
 * The cards. `observe(e, live)` takes every event; only live ones can make a card, and only while the gate allows it when the event
 * arrives and (for a finish and a worker's request) when its delay ends. Cards leave through `reconcile` on every change of the views,
 * the list, the shown tab and the switch.
 */
export function useNotifications(gate: Gate, onCard?: (card: Card) => void) {
  const [cards, setCards] = useState<Card[]>([]);
  const current = useRef(cards);
  current.current = cards;
  const max = usePhone() ? 1 : MAX_CARDS;
  const latest = useRef(gate);
  latest.current = gate;
  const announce = useRef(onCard);
  announce.current = onCard;
  const tracker = useRef(createTracker());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // The most recent card shown per session, to announce a card once and an in-place update of the same kind never.
  const kinds = useRef(new Map<string, string>());

  // The Focus page lists the waiting requests (no card for them there), but not a finished turn: that still gets its card.
  const allowed = (sessionId: string, request = true) => {
    const g = latest.current;
    return g.enabled && g.focused && !(request && g.focusPage) && !g.shown(sessionId) && g.list.some((s) => s.id === sessionId && !s.archived);
  };
  const add = (card: Card) => {
    // A finished or error card that does not fit is dropped by the stack at once: it is never said either.
    const fits = (card.kind !== "finished" && card.kind !== "error") || visibleCards(addCard(current.current, card), max).shown.some((c) => c.sessionId === card.sessionId);
    setCards((c) => addCard(c, card));
    if (!fits) return;
    const key = `${card.kind}:${card.requestId ?? ""}`;
    if (kinds.current.get(card.sessionId) !== key) announce.current?.(card);
    kinds.current.set(card.sessionId, key);
  };
  const later = (key: string, ms: number, run: () => void) => {
    clearTimeout(timers.current.get(key));
    timers.current.set(key, setTimeout(() => (timers.current.delete(key), run()), ms));
  };
  const cancel = (key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
  };

  const handle = (s: Signal) => {
    if (s.type === "resume") return cancel(`finish:${s.sessionId}`);
    if (s.type === "request") {
      if (!allowed(s.sessionId)) return;
      const show = (tries = 0) => {
        const g = latest.current;
        const part = g.views[s.sessionId]?.parts.get(s.requestId);
        // The event is applied to the views by the render that follows it: wait for that render (at most 1 s).
        if (!part && tries < 20 && allowed(s.sessionId)) return later(`req:${s.requestId}`, 50, () => show(tries + 1));
        if (!allowed(s.sessionId) || !part || (part.type !== "permission_request" && part.type !== "question") || part.settled) return;
        add({ sessionId: s.sessionId, kind: s.kind, requestId: s.requestId, since: part.at ?? Date.now() });
      };
      const worker = !!latest.current.list.find((x) => x.id === s.sessionId)?.coordinatorId;
      // A coordinator often answers a worker's low-tier request within seconds: show it only if it still waits. An escalated one waits for the user for certain.
      if (worker && !s.escalated) later(`req:${s.requestId}`, WORKER_DELAY_MS, () => show());
      else {
        cancel(`req:${s.requestId}`);
        // The part arrives with this render; the view may not hold it yet when the event is handled.
        later(`req:${s.requestId}`, 0, () => show());
      }
      return;
    }
    // finish: the turn ended; it counts if the session is still idle (or in error) with nothing waiting after the delay.
    later(`finish:${s.sessionId}`, FINISH_DELAY_MS, () => {
      const v = latest.current.views[s.sessionId];
      const done = v && (v.state === "error" ? s.kind === "error" : v.state === "idle" && !v.working && s.kind === "finished");
      const waits = v && [...v.parts.values()].some((p) => (p.type === "permission_request" || p.type === "question") && !p.settled);
      if (done && !waits && allowed(s.sessionId, false)) add({ sessionId: s.sessionId, kind: s.kind, text: s.text, since: Date.now() });
    });
  };

  const observe = useRef<(e: Event, live: boolean) => void>(() => {});
  observe.current = (e, live) => {
    const known = latest.current.views[e.sessionId]?.state;
    for (const s of tracker.current.observe(e, live, known)) handle(s);
  };

  // Cards that no longer apply leave.
  useEffect(() => {
    setCards((c) => reconcile(c, { views: gate.views, list: gate.list, shown: gate.shown, focusPage: gate.focusPage, enabled: gate.enabled }));
    const ids = new Set(cards.map((c) => c.sessionId));
    for (const id of [...kinds.current.keys()]) if (!ids.has(id)) kinds.current.delete(id);
  });
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  return {
    cards,
    observe: (e: Event, live: boolean) => observe.current(e, live),
    dismiss: (sessionId: string) => setCards((c) => dismissSession(c, sessionId)),
  };
}

const KIND = {
  permission: { label: "Needs permission", Icon: TriangleAlertIcon, color: "text-warning" },
  question: { label: "Question", Icon: MessageCircleQuestionIcon, color: "text-warning" },
  finished: { label: "Finished", Icon: CircleCheckIcon, color: "text-success" },
  error: { label: "Stopped with an error", Icon: CircleXIcon, color: "text-destructive" },
} as const;

const FOCUS_RING = "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-info";
const ACT = "max-sm:h-11 pointer-coarse:h-11";

type Props = {
  items: CardItem[];
  /** Date.now() as of the last minute tick: the age label. */
  now: number;
  /** Bumped by the "Go to notifications" command: focus moves to the newest card. */
  focusTick: number;
  /** A drawer, a dialog or the palette is open: the cards wait out of sight. */
  hidden: boolean;
  /** Allow once or Deny; rejects when it was not sent. */
  onRespond: (card: Card, decision: "allow" | "deny") => Promise<unknown>;
  onOpenFocus: (card: Card) => void;
  onOpenSession: (card: Card) => void;
  onDismiss: (sessionId: string) => void;
  /** The "+N more need you" pill: Focus lists them all. */
  onOpenAll: () => void;
  /** Where focus goes when a card that had it leaves and nothing else can take it: the prompt box. */
  restoreFocus: () => void;
};

export function NotificationStack({ items, now, focusTick, hidden, onRespond, onOpenFocus, onOpenSession, onDismiss, onOpenAll, restoreFocus }: Props) {
  const phone = usePhone();
  const { shown, hiddenWaiting } = visibleCards(items.map((i) => i.card), phone ? 1 : MAX_CARDS);
  const byCard = new Map(items.map((i) => [i.card, i]));
  const visible = hidden ? [] : shown.map((c) => byCard.get(c)!);
  const region = useRef<HTMLElement>(null);
  const remembered = useRef<HTMLElement | null>(null);
  const focusedSession = useRef<string>(undefined);
  const [sending, setSending] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});

  // A finished card goes after 8 s, unless the pointer is over the region or focus is inside it (WCAG 2.2.1); the timer waits while the page is hidden.
  const left = useRef(new Map<string, number>());
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  // Finished and error cards that do not fit are dropped, not kept for later (they would come back with an old age).
  const dropped = items.filter((i) => !shown.includes(i.card) && (i.card.kind === "finished" || i.card.kind === "error")).map((i) => i.card.sessionId).join();
  useEffect(() => void (dropped && dropped.split(",").forEach((id) => dismissRef.current(id))), [dropped]);
  const finishedKeys = visible.filter((i) => i.card.kind === "finished").map((i) => `${i.card.sessionId}:${i.card.since}`).join();
  useEffect(() => {
    const live = new Set(finishedKeys.split(",").filter(Boolean));
    for (const k of [...left.current.keys()]) if (!live.has(k)) left.current.delete(k);
    if (!live.size) return;
    const t = setInterval(() => {
      // Read at the tick, not tracked by events: a card that leaves with the focused button inside fires no blur.
      // Read at the tick: a card removed under the pointer or the focus fires no leave or blur.
      if (region.current?.matches(":hover") || region.current?.contains(document.activeElement) || document.visibilityState === "hidden") return;
      for (const k of live) {
        const rest = (left.current.get(k) ?? FINISHED_MS) - 250;
        left.current.set(k, rest);
        if (rest <= 0) {
          // Stays in the map (never due again) until the card is gone.
          left.current.set(k, Infinity);
          dismissRef.current(k.slice(0, k.lastIndexOf(":")));
        }
      }
    }, 250);
    return () => clearInterval(t);
  }, [finishedKeys]);

  const actions = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("[data-action]")].filter((b) => b.closest("article"));
  /** Focus after a card leaves: the neighbour card, else what had focus before, else the prompt box. */
  const handOver = (article: Element) => {
    const sibling = article.nextElementSibling?.matches("article") ? article.nextElementSibling : article.previousElementSibling?.matches("article") ? article.previousElementSibling : null;
    const next = sibling?.querySelector<HTMLElement>("[data-action]") ?? (remembered.current?.isConnected ? remembered.current : null);
    if (next) next.focus();
    else restoreFocus();
    remembered.current = null;
  };

  useEffect(() => {
    if (!focusTick) return;
    const first = region.current && actions(region.current)[0];
    if (!first) return;
    if (!region.current!.contains(document.activeElement)) remembered.current = document.activeElement as HTMLElement | null;
    first.focus();
  }, [focusTick]);

  // A card that had focus left without a key press (answered in Focus or by another tab): focus must not fall to the page.
  const keys = visible.map((i) => i.card.sessionId).join();
  // A card that moved on to the session's next request has new buttons: focus on the old one must not carry over to answer another request.
  const requests = visible.map((i) => `${i.card.sessionId}:${i.d.requestId ?? i.card.kind}`).join();
  useLayoutEffect(() => {
    const id = focusedSession.current;
    if (id && keys.split(",").includes(id) && (!document.activeElement || document.activeElement === document.body)) {
      // Never an answer button: the card now shows a request that was not read yet, and Enter must not answer it.
      const open = region.current?.querySelector<HTMLElement>(`article[data-session="${id}"] [data-open-focus]`);
      if (open) open.focus();
      else restoreFocus();
      return;
    }
    if (!id || keys.split(",").includes(id)) return;
    focusedSession.current = undefined;
    if (document.activeElement && document.activeElement !== document.body) return;
    const next = region.current && actions(region.current)[0];
    if (next) next.focus();
    else if (remembered.current?.isConnected) remembered.current.focus();
    else restoreFocus();
  }, [keys, requests]);

  if (!visible.length) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const article = (e.target as Element).closest("article");
    if (!article) {
      // The "+N more" pill: Esc must not stop the page's running turn either.
      if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), e.nativeEvent.stopPropagation(), restoreFocus());
      return;
    }
    if (e.key === "Escape") {
      // Esc in the page stops the running turn: a notice must take it, never pass it on.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopPropagation();
      handOver(article);
      onDismiss(article.getAttribute("data-session")!);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const all = [...region.current!.querySelectorAll("article")];
      const to = all[all.indexOf(article) + (e.key === "ArrowDown" ? 1 : -1)]?.querySelector<HTMLElement>("[data-action]");
      if (to) (e.preventDefault(), to.focus());
    }
  };

  const respond = async (card: Card, requestId: string | undefined, decision: "allow" | "deny", article: Element) => {
    // Only the request the card shows right now, the one the button was made for.
    if (!requestId || card.requestId !== requestId || article.getAttribute("data-request") !== requestId) return;
    if (sending[card.sessionId]) return;
    setSending((s) => ({ ...s, [card.sessionId]: true }));
    setFailed(({ [card.sessionId]: _, ...rest }) => rest);
    try {
      await onRespond(card, decision);
      // The settled event removes the card; the focus goes to the next one first.
      if (article.contains(document.activeElement)) handOver(article);
    } catch (e) {
      setFailed((f) => ({ ...f, [card.sessionId]: (e as Error).message }));
    } finally {
      setSending(({ [card.sessionId]: _, ...rest }) => rest);
    }
  };

  return (
    <section
      ref={region}
      aria-label="Notifications"
      data-testid="notifications"
      className="pointer-events-none flex flex-col gap-2 max-sm:fixed max-sm:inset-x-4 max-sm:top-20 max-sm:z-1000 sm:flex-col-reverse"
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        focusedSession.current = (e.target as Element).closest("article")?.getAttribute("data-session") ?? undefined;
      }}
    >
      {visible.map(({ card, d, title, place, cwd }) => {
        const id = `n-${card.sessionId}`;
        const kind = KIND[d.kind];
        const answer = inlineActions(d) === "answer";
        const busy = !!sending[card.sessionId];
        const lowEdit = d.kind === "permission" && d.tier === "low" && !answer && !d.escalated;
        const named = d.tool ? `${d.tool}${d.body ? ` ${d.body}` : ""}` : d.summary;
        return (
          <article
            key={card.sessionId}
            aria-labelledby={`${id}-t`}
            aria-describedby={`${id}-k ${id}-b`}
            data-session={card.sessionId}
            data-kind={d.kind}
            data-request={d.requestId}
            data-testid="notification"
            className={`${TOAST_CARD} flex flex-col gap-1.5 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2`}
          >
            <div className="flex items-start gap-2">
              {cwd && <ProjectAvatar cwd={cwd} />}
              <div className="min-w-0 flex-1">
                <p id={`${id}-t`} className="truncate font-[530] text-[13px] leading-4">{title}</p>
                <p className="truncate text-[11px] text-muted-foreground leading-4">{place}</p>
              </div>
              <time className="shrink-0 text-[11px] text-muted-foreground leading-4 tabular-nums">{ageLabel(now - card.since)}</time>
              <button
                type="button"
                aria-label={`Dismiss notification for ${title}`}
                onClick={(e) => (handOver(e.currentTarget.closest("article")!), onDismiss(card.sessionId))}
                className={`flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:-m-3 pointer-coarse:size-11 max-sm:-m-3 max-sm:size-11 ${FOCUS_RING}`}
              >
                <XIcon aria-hidden className="size-4" />
              </button>
            </div>
            <p id={`${id}-k`} className={`flex items-center gap-1.5 text-xs leading-4 font-medium ${kind.color}`}>
              <kind.Icon aria-hidden className="size-3.5 shrink-0" />
              <span>{d.escalated ? `${kind.label} · escalated` : kind.label}</span>
              {d.kind === "permission" && !d.tier && !d.escalated && (
                <span className="ml-1 inline-flex items-center gap-1 rounded-sm bg-secondary px-1.5 text-[11px] text-muted-foreground">
                  <LockIcon aria-hidden className="size-3" />
                  High tier
                </span>
              )}
            </p>
            <p id={`${id}-b`} className="line-clamp-2 text-[13px] leading-[18px] [overflow-wrap:anywhere]">
              {d.tool ? (
                <>
                  <strong data-tool className="font-[530]">{d.tool}</strong>
                  {d.body && ` · ${d.body}`}
                </>
              ) : (
                d.body
              )}
            </p>
            {d.escalated && d.reason && <p className="line-clamp-2 text-[11px] text-muted-foreground leading-4">Escalated by coordinator: {d.reason}</p>}
            {d.extra > 0 && <p className="text-[11px] text-muted-foreground leading-4">+{d.extra} more request{d.extra === 1 ? "" : "s"} in this session</p>}
            {lowEdit && <p className="text-[11px] text-muted-foreground leading-4">Review the change in Focus.</p>}
            {failed[card.sessionId] && (
              <p role="alert" className="text-[11px] text-destructive leading-4">
                Not sent: {failed[card.sessionId]}
              </p>
            )}
            <div key={d.requestId ?? card.kind} className="mt-0.5 flex flex-wrap items-center gap-2">
              {answer && (
                <>
                  <Button key="allow" type="button" size="sm" data-action aria-label={`Allow once: ${named} in ${title}`} aria-disabled={busy} className={ACT} onClick={(e) => void respond(card, d.requestId, "allow", e.currentTarget.closest("article")!)}>
                    Allow once
                  </Button>
                  <Button key="deny" type="button" size="sm" variant="secondary" data-action aria-label={`Deny: ${named} in ${title}`} aria-disabled={busy} className={ACT} onClick={(e) => void respond(card, d.requestId, "deny", e.currentTarget.closest("article")!)}>
                    Deny
                  </Button>
                  <span className="flex-1" />
                </>
              )}
              {(d.kind === "permission" || d.kind === "question") && (
                <Button key="focus" type="button" size="sm" variant={answer ? "ghost" : "default"} data-action data-open-focus aria-label={`Open in Focus: ${title}`} className={ACT} onClick={() => (onOpenFocus(card))}>
                  Open in Focus
                </Button>
              )}
              {!answer && (
                <Button key="session" type="button" size="sm" variant={d.kind === "permission" || d.kind === "question" ? "ghost" : "secondary"} data-action aria-label={`Open session: ${title}`} className={ACT} onClick={() => onOpenSession(card)}>
                  Open session
                </Button>
              )}
            </div>
          </article>
        );
      })}
      {hiddenWaiting > 0 && !hidden && (
        <button
          type="button"
          data-testid="notifications-more"
          onClick={onOpenAll}
          className={`${TOAST_CARD} min-h-11 cursor-pointer py-2 text-left text-[13px] font-medium hover:bg-accent max-sm:w-full sm:min-h-8 sm:py-1.5 ${FOCUS_RING}`}
        >
          +{hiddenWaiting} more need you · Open Focus
        </button>
      )}
    </section>
  );
}
