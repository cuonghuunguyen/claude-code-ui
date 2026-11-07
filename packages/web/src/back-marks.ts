// "I'll be back" (docs/spec.md): the Back marks of the daemon's `back` setting in one module store, plus the pure rules the panel,
// the timeline and Focus share: interval parsing, brief parsing, the brief written without the model, the tag, the stale count.
import { useSyncExternalStore } from "react";
import { BACK_REMIND_MAX_MS, BACK_REMIND_MIN_MS, BACK_TAG, type BackMark, type Part, type Settings } from "@claude-ui/protocol";

type Marks = Settings["back"]["marks"];
const EMPTY: Marks = {};
let cur = EMPTY;
let live = false;
const subs = new Set<() => void>();

/** Reminders that fired since the last change, newest last: the in-app cards. Only a live change fills it (not the first load or a reconnect). */
export type Fired = { sessionId: string; mark: BackMark };
const firedSubs = new Set<(f: Fired[]) => void>();
export const onFired = (f: (f: Fired[]) => void) => (firedSubs.add(f), () => void firedSubs.delete(f));

/** From settings.get (`first`: no card) and settings_changed; an older daemon has no `back`. */
export function setBack(b: Settings["back"] | undefined, first = false) {
  const next = b?.marks ?? EMPTY;
  if (JSON.stringify(next) === JSON.stringify(cur)) return;
  const fired: Fired[] = [];
  if (live && !first) for (const [sessionId, list] of Object.entries(next)) for (const mark of list) if (mark.remindedAt !== undefined && !cur[sessionId]?.find((m) => m.partId === mark.partId && m.remindedAt === mark.remindedAt)) fired.push({ sessionId, mark });
  cur = next;
  live = true;
  subs.forEach((f) => f());
  if (fired.length) firedSubs.forEach((f) => f(fired));
}
export const getBack = () => cur;
export const useBack = () => useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), getBack);
export const markOf = (marks: Marks, sessionId: string, partId: string) => marks[sessionId]?.find((m) => m.partId === partId);
/** Test seam. */
export const resetBack = () => ((cur = EMPTY), (live = false));

// ---- interval ----
export type Interval = { ms: number } | { error: "format" | "min" | "max" };
const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** "30m", "2H", " 1d ": one number and one unit (m, h, d), 1 minute to 7 days. */
export function parseInterval(text: string): Interval {
  const m = /^\s*(\d+)\s*([mhd])\s*$/i.exec(text);
  if (!m) return { error: "format" };
  const ms = Number(m[1]) * UNIT[m[2]!.toLowerCase() as keyof typeof UNIT];
  if (ms < BACK_REMIND_MIN_MS) return { error: "min" };
  if (ms > BACK_REMIND_MAX_MS) return { error: "max" };
  return { ms };
}

/** The interval as the user types it: the largest unit that divides it ("120m" -> "2h", "90m" stays). */
export const formatInterval = (ms: number) => (ms % UNIT.d === 0 ? `${ms / UNIT.d}d` : ms % UNIT.h === 0 ? `${ms / UNIT.h}h` : `${Math.round(ms / UNIT.m)}m`);
/** Long form for the accessible name: "2 hours". */
export const intervalWords = (ms: number) => {
  const [n, u] = ms % UNIT.d === 0 ? [ms / UNIT.d, "day"] : ms % UNIT.h === 0 ? [ms / UNIT.h, "hour"] : [Math.round(ms / UNIT.m), "minute"];
  return `${n} ${u}${n === 1 ? "" : "s"}`;
};

// ---- brief ----
export type BriefRows = { label: "about" | "focusNow" | "next"; text: string }[];
const BRIEF_LINES: { re: RegExp; label: BriefRows[number]["label"] }[] = [
  { re: /^About:\s*(.*)$/i, label: "about" },
  { re: /^Focus now:\s*(.*)$/i, label: "focusNow" },
  { re: /^Next:\s*(.*)$/i, label: "next" },
];

/** The three labelled lines of a brief; undefined for any other shape (shown as plain markdown). */
export function parseBrief(text: string): BriefRows | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const rows: BriefRows = [];
  for (const line of lines) {
    const hit = BRIEF_LINES.map((b) => [b.label, b.re.exec(line)] as const).find(([, m]) => m);
    if (hit) rows.push({ label: hit[0], text: hit[1]![1]!.trim() });
    else if (rows.length) rows[rows.length - 1]!.text += ` ${line}`;
    else return undefined;
  }
  return rows.length === 3 && rows.map((r) => r.label).join() === "about,focusNow,next" && rows.every((r) => r.text) ? rows : undefined;
}

/** The brief written without the model (a failed brief turn): from the mark's own fields. `reply`/`next` are the labels' texts; the labels come from i18n. */
export function fallbackBrief(m: Pick<BackMark, "title" | "lastLine" | "prompt" | "note">, openReply: string): { about: string; lastReply: string; next: string } {
  return { about: m.prompt || m.title, lastReply: m.lastLine || m.title, next: m.note || openReply };
}

/** The `About` line of a stored brief, for Focus rows and cards. */
export const aboutOf = (m: BackMark) => (m.brief ? parseBrief(m.brief.text)?.find((r) => r.label === "about")?.text : undefined);

// ---- tag ----
/** The part id of a brief turn's prompt (its first line is the tag), else undefined. */
export const briefTag = (text: string) => BACK_TAG.exec(text.split("\n")[0] ?? "")?.[1];

/** Number of prompts the user sent after the last brief turn of `partId` (brief turns of any mark are not counted). `parts`: the session's parts in order. */
export function staleTurns(parts: readonly Part[], partId: string): number {
  let after = -1;
  parts.forEach((p, i) => p.type === "user_text" && briefTag(p.text) === partId && (after = i));
  if (after < 0) return 0;
  return parts.slice(after + 1).filter((p) => p.type === "user_text" && briefTag(p.text) === undefined).length;
}

/** Brief turns hidden from the timeline: each tagged prompt maps to the text Claude answered with (the assistant texts of that turn); the same turn's assistant text and tool parts are dropped, its result footer stays. */
export function foldBriefTurns<T extends { kind: string; part?: Part }>(items: readonly T[]): { items: T[]; answers: Map<string, string> } {
  const out: T[] = [];
  const answers = new Map<string, string>();
  let into: string | undefined;
  for (const item of items) {
    const p = item.kind === "part" ? item.part : undefined;
    if (p?.type === "user_text") into = briefTag(p.text) ? p.id : undefined;
    else if (p?.type === "bash") into = undefined;
    else if (into && (item.kind !== "part" || (p && p.type !== "turn_result"))) {
      if (p?.type === "assistant_text") answers.set(into, [answers.get(into), p.text].filter(Boolean).join("\n\n"));
      continue;
    }
    out.push(item);
  }
  return { items: out, answers };
}

type Item = { kind: string; part?: Part };
const lineOf = (text: string, last = false) => {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return (last ? lines.at(-1) : lines[0])?.slice(0, 200);
};

/** The reply a turn-end action row marks: the turn's last assistant text up to `index`, with its title (first line), last line and the turn's prompt line. Undefined when the turn has no text. */
export function markFields(items: readonly Item[], index: number): { partId: string; title: string; lastLine?: string; prompt?: string } | undefined {
  let reply: Extract<Part, { type: "assistant_text" }> | undefined;
  let prompt: string | undefined;
  for (let i = index; i >= 0; i--) {
    const p = items[i]!.kind === "part" ? items[i]!.part : undefined;
    if (!p) continue;
    if (p.type === "user_text" || p.type === "bash") {
      if (p.type === "user_text") prompt = lineOf(p.text);
      break;
    }
    if (!reply && p.type === "assistant_text" && p.text.trim()) reply = p;
  }
  if (!reply) return undefined;
  const title = lineOf(reply.text) ?? "";
  return { partId: reply.id, title, ...(lineOf(reply.text, true) && { lastLine: lineOf(reply.text, true) }), ...(prompt && { prompt }) };
}
