// In-app notifications (docs/spec.md "In-app notifications", GH-158): the model behind the notice cards. Pure; notifications.tsx is the UI.
// One card per session. Events become signals (only live events do), the hook turns signals into cards, and what a card shows is read
// from the live session view each render, so a settled request, a late tier or a second request changes the card in place.
import { isAttention, type Event, type SessionListItem, type SessionState } from "@claude-ui/protocol";
import { requestSummary } from "./focus.ts";
import { pendingPermission, pendingQuestion, type PermissionRequest, type QuestionRequest, type SessionView } from "./store.ts";

export type CardKind = "permission" | "question" | "finished" | "error";
/** `requestId`: the request a permission or question card shows. `text`: what a finished or error card says. */
export type Card = { sessionId: string; kind: CardKind; requestId?: string; text?: string; since: number };

export type Signal =
  | { type: "request"; sessionId: string; requestId: string; kind: "permission" | "question"; escalated: boolean }
  | { type: "finish"; sessionId: string; kind: "finished" | "error"; text: string }
  | { type: "resume"; sessionId: string };

/** The last non-empty line of `text`, as the daemon's push uses for "finished". */
export const lastLine = (text?: string) => text?.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);

type Seen = { state?: SessionState; text?: string; error?: string };

/**
 * Follows every event of every session (replays too, so it knows what a session was doing) and says what a live event means for the
 * notices: a new request, an escalated one, a turn that ended, work that resumed. A replay or snapshot never makes a request or finish signal.
 * `known`: the session's state in the view, when the tracker has not seen the session yet (a snapshot carries no events).
 */
export function createTracker() {
  const sessions = new Map<string, Seen>();
  const requests = new Map<string, boolean>();
  return {
    observe({ sessionId, part }: Event, live: boolean, known?: SessionState): Signal[] {
      let t = sessions.get(sessionId);
      if (!t) sessions.set(sessionId, (t = { state: known }));
      if (part.type === "user_text") t.text = t.error = undefined;
      else if (part.type === "assistant_text") t.text = part.text;
      else if (part.type === "raw" && (part.message as { error?: unknown } | null)?.error) t.error = String((part.message as { error: unknown }).error);
      else if ((part.type === "permission_request" || part.type === "question") && !part.settled) {
        const escalated = !!part.escalated;
        const had = requests.get(part.requestId);
        requests.set(part.requestId, escalated || !!had);
        // The first sight is the signal; a later event of the same request (its tier) is none, an escalation after the first sight is one.
        if (live && (had === undefined || (escalated && !had))) return [{ type: "request", sessionId, requestId: part.requestId, kind: part.type === "question" ? "question" : "permission", escalated }];
      } else if (part.type === "session_state") {
        const prev = t.state;
        t.state = part.state;
        if (!live) return [];
        if (part.state === "running") return [{ type: "resume", sessionId }];
        if (prev && isAttention(prev, part) && part.state !== "needs_input")
          return [part.state === "error" ? { type: "finish", sessionId, kind: "error", text: t.error ?? "The turn ended with an error" } : { type: "finish", sessionId, kind: "finished", text: lastLine(t.text) ?? "Finished" }];
      }
      return [];
    },
  };
}

/** The card is the newest of its session: it replaces that session's card and goes first. */
export const addCard = (cards: Card[], card: Card): Card[] => [card, ...cards.filter((c) => c.sessionId !== card.sessionId)];
export const dismissSession = (cards: Card[], sessionId: string): Card[] => cards.filter((c) => c.sessionId !== sessionId);

type Request = PermissionRequest | QuestionRequest;
const unsettled = (view: SessionView | undefined): Request[] =>
  [...(view?.parts.values() ?? [])].filter((p): p is Request => (p.type === "permission_request" || p.type === "question") && !p.settled);

/**
 * The cards that still apply: a request card follows its session's next waiting request when its own settled (anywhere: here, Focus, the
 * session, another browser, a coordinator) and goes when none waits; every card goes when its session is shown, archived or not listed,
 * on the Focus page (it lists every waiting request) and with in-app notifications off. Returns `cards` itself when nothing changed.
 */
export function reconcile(
  cards: Card[],
  c: { views: Record<string, SessionView | undefined>; list: SessionListItem[]; shown: (sessionId: string) => boolean; focusPage: boolean; enabled: boolean },
): Card[] {
  if (!c.enabled || c.focusPage) return cards.length ? [] : cards;
  let changed = false;
  const out: Card[] = [];
  for (const card of cards) {
    const s = c.list.find((x) => x.id === card.sessionId);
    if (!s || s.archived || c.shown(card.sessionId)) {
      changed = true;
      continue;
    }
    if (card.kind !== "permission" && card.kind !== "question") {
      out.push(card);
      continue;
    }
    const view = c.views[card.sessionId];
    const own = view?.parts.get(card.requestId ?? "");
    if (own && (own.type === "permission_request" || own.type === "question") && !own.settled) {
      out.push(card);
      continue;
    }
    changed = true;
    const next = pendingPermission(view ?? ({ order: [], parts: new Map() } as unknown as SessionView)) ?? pendingQuestion(view ?? ({ order: [], parts: new Map() } as unknown as SessionView));
    if (next) out.push({ ...card, kind: next.type === "question" ? "question" : "permission", requestId: next.requestId });
  }
  return changed ? out : cards;
}

export type Described = {
  kind: CardKind;
  /** The tool of a permission card. */
  tool?: string;
  /** "Read · src/a.ts" (permission), the question text, or the finished/error line. */
  summary: string;
  /** The part of `summary` after the tool name. */
  body: string;
  tier?: "low";
  escalated?: boolean;
  reason?: string;
  /** Other requests of the session that wait too. */
  extra: number;
  requestId?: string;
};

/** What a card shows now, read from the session's view. */
export function describeCard(card: Card, view: SessionView | undefined, cwd: string): Described {
  const part = card.requestId ? view?.parts.get(card.requestId) : undefined;
  const extra = Math.max(0, unsettled(view).length - 1);
  if (part?.type === "permission_request") {
    const summary = requestSummary(part, cwd);
    return { kind: "permission", tool: part.tool, summary, body: summary.replace(/^[^·]*· ?/, ""), tier: part.tier, escalated: part.escalated, reason: part.reason, extra, requestId: part.requestId };
  }
  if (part?.type === "question") {
    const q = part.questions[0]?.question ?? "";
    return { kind: "question", summary: q, body: q, escalated: part.escalated, reason: part.reason, extra, requestId: part.requestId };
  }
  return { kind: card.kind, summary: card.text ?? "", body: card.text ?? "", extra: 0 };
}

/** Tools of the low tier that change nothing: the card may answer them. Edits are low tier too, but a diff nobody saw is a blind approval. */
const READ_ONLY = new Set(["Read", "NotebookRead", "LS", "Glob", "Grep", "TodoWrite", "WebSearch", "Bash"]);

/** "answer": the card offers Allow once and Deny. "open": it only opens Focus or the session. */
export const inlineActions = (d: { kind: CardKind; tier?: "low"; tool?: string; escalated?: boolean }): "answer" | "open" =>
  d.kind === "permission" && d.tier === "low" && !d.escalated && !!d.tool && READ_ONLY.has(d.tool) ? "answer" : "open";

const waits = (c: Card) => c.kind === "permission" || c.kind === "question";
const RANK: Record<CardKind, number> = { permission: 0, question: 0, error: 1, finished: 2 };

/** The `max` cards to show (waiting first, then error, then finished; the newest first inside each, the cards come newest first), and how many waiting ones do not fit. */
export function visibleCards(cards: Card[], max: number): { shown: Card[]; hiddenWaiting: number } {
  const ranked = cards.map((c, i) => ({ c, i })).sort((a, b) => RANK[a.c.kind] - RANK[b.c.kind] || a.i - b.i);
  const shown = ranked.slice(0, max).sort((a, b) => a.i - b.i).map((x) => x.c);
  return { shown, hiddenWaiting: ranked.slice(max).filter((x) => waits(x.c)).length };
}

/** "now", "12m", "1h 3m": whole minutes, so it needs to tick once a minute only. */
export function ageLabel(ms: number) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The sentence the status region says for a new card. */
export function cardText({ kind, title, body }: { kind: CardKind; title: string; body: string }) {
  switch (kind) {
    case "permission":
      return `${title} needs permission: ${body}.`;
    case "question":
      return `${title} asks a question: ${body}.`;
    case "finished":
      return `${title} finished.`;
    default:
      return `${title} stopped with an error.`;
  }
}

const KEY = "claude-ui.inAppNotifications";
/** Fired on `window` after saveInApp (`detail`: the new value), so App and the Settings dialog stay in step. */
export const IN_APP_EVENT = "claude-ui:in-app";
type Store = Pick<Storage, "getItem"> & Partial<Pick<Storage, "setItem">>;
const store = (): Store | undefined => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

/** Per browser; on unless the user turned it off. */
export function loadInApp(ls: Store | undefined = store()) {
  try {
    return ls?.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveInApp(on: boolean, ls: Store | undefined = store()) {
  try {
    ls?.setItem?.(KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the choice lasts for this page, through the event.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<boolean>(IN_APP_EVENT, { detail: on }));
}
