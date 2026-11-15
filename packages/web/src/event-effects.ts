// Side rules of the event stream: which events are live or a replay, and what the page does about each. No React, no DOM: the host
// answers what the page looks like, the caller performs the returned effects (docs/spec.md "Push notifications", "Recommendations").
import { isAttention, type Event, type SessionState } from "@claude-ui/protocol";

/** What App does for an event; data, so a rule is testable without a render. */
export type Effect =
  /** In-app notifications (`notify.observe`). */
  | { type: "notify"; event: Event; live: boolean }
  /** A replayed attention after a reconnect that followed a hidden page: the push recommendation, `afterMs` later. */
  | { type: "offerPush"; afterMs: number }
  | { type: "offerContextBreakdown"; sessionId: string; visible: boolean; percent: number }
  /** A live /clear: the tab of `from` shows `to`. */
  | { type: "clearMoved"; from: string; to: string }
  /** At most one per batch. */
  | { type: "refreshList" };

export type EffectsHost = {
  pageVisible(): boolean;
  /** The session is in the shown split, else the active tab. */
  onScreen(id: string): boolean;
  /** Listed and its transcript does not exist yet (its title is "New session"). */
  untitled(id: string): boolean;
  /** Seq of the session's last subscribe reply: events up to it are a replay. */
  replayedTo(id: string): number;
};

/** Replayed attention events count for this long after a connection opened on a page that was hidden. */
export const REPLAY_WINDOW_MS = 3000;
export const PUSH_DELAY_MS = 800;
/** The title of a session without transcript is refreshed at most this often. */
export const TITLE_REFRESH_MS = 2000;

export function createEventEffects(host: EffectsHost, now: () => number = Date.now) {
  /** Last live event per session (ms): the Focus page's quiet time. */
  const liveAt = new Map<string, number>();
  const sentHere = new Set<string>();
  /** Sessions whose turn ended and whose context_usage is still to come. */
  const turnEnded = new Set<string>();
  let hiddenNeed = false;
  let wasHidden = false;
  let replayUntil = 0;
  let titleRefreshed = 0;

  return {
    /**
     * Effects of one batch, in event order. `stateBefore`: the state each session had before the batch (the batch is tracked through).
     * A session_state attention while the page is hidden sets the push need; the replay of a reconnect after a hidden page offers the push.
     */
    classify(events: readonly Event[], stateBefore: (id: string) => SessionState | undefined): Effect[] {
      const out: Effect[] = [];
      const states = new Map<string, SessionState | undefined>();
      let refresh = false;
      for (const e of events) {
        const id = e.sessionId;
        const before = states.has(id) ? states.get(id) : stateBefore(id);
        states.set(id, e.part.type === "session_state" ? e.part.state : before ?? "idle");
        // A replayed change is in the list already (one session.list per subscribe would rescan every transcript, FIX-LEAK).
        const live = e.seq > host.replayedTo(id);
        if (live) liveAt.set(id, now());
        out.push({ type: "notify", event: e, live });
        const replayWindow = now() < replayUntil;
        if (e.part.type === "session_state") {
          if (before && isAttention(before, e.part) && (!host.pageVisible() || (replayWindow && !live))) {
            hiddenNeed = true;
            if (!live && replayWindow) out.push({ type: "offerPush", afterMs: PUSH_DELAY_MS });
          }
          // The turn's context_usage comes after this idle event: the rule waits for it. A new turn drops a context_usage that never came.
          if (live && e.part.state === "running") turnEnded.delete(id);
          if (live && sentHere.has(id) && e.part.state !== "running" && e.part.state !== "needs_input") (sentHere.delete(id), turnEnded.add(id));
        }
        if (live && e.part.type === "context_usage" && turnEnded.delete(id)) out.push({ type: "offerContextBreakdown", sessionId: id, visible: host.pageVisible() && host.onScreen(id), percent: e.part.usage.percentage });
        // /clear: a tab of the session follows the session the CLI goes on in; a replay (reopening the old session) does not.
        if (e.part.type === "session_cleared" && live) out.push({ type: "clearMoved", from: id, to: e.part.sessionId });
        if (e.part.type === "session_state" && live) refresh = true;
        // The title of a session without transcript is "New session" until its transcript exists, some time into the first turn.
        else if (live && host.untitled(id) && now() - titleRefreshed > TITLE_REFRESH_MS) (titleRefreshed = now(), (refresh = true));
      }
      if (refresh) out.push({ type: "refreshList" });
      return out;
    },
    /** A connection opened (`gen` counts them): a replay after a hidden page is awaited for a while. Not on the page's first connection. */
    opened(gen: number) {
      if (gen > 1 && wasHidden) (wasHidden = false), (replayUntil = now() + REPLAY_WINDOW_MS);
    },
    pageHidden() {
      wasHidden = true;
    },
    /** A prompt was sent from this page: the turn that follows is its own. */
    sent(id: string) {
      sentHere.add(id);
      turnEnded.delete(id);
    },
    lastLive: (id: string) => liveAt.get(id) ?? 0,
    /** Reads and clears the push need. */
    takeHiddenNeed() {
      const needed = hiddenNeed;
      hiddenNeed = false;
      return needed;
    },
  };
}

export type EventEffects = ReturnType<typeof createEventEffects>;
