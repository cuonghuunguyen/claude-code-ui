// "I'll be back" (docs/spec.md): pure rules for Back marks: validation, upsert, the brief prompt. The server and the reminder runner own the effects.
import { BACK_BRIEF_MAX, BACK_MARKS_MAX, BACK_NOTE_MAX, BACK_REMIND_MAX_MS, BACK_REMIND_MIN_MS, BACK_TEXT_MAX, type BackMark } from "@claude-ui/protocol";

export type Marks = Record<string, BackMark[]>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max && !v.includes("\0");
const optStr = (v: unknown, max: number) => v === undefined || str(v, max);
const optTime = (v: unknown) => v === undefined || (Number.isInteger(v) && (v as number) >= 0);
const STATES = ["queued", "running", "failed"];

/** A stored mark of the settings file (a hand-edited or old one that fails is dropped with its section). */
export function markOk(m: unknown): m is BackMark {
  if (!isObj(m)) return false;
  const b = m.brief;
  return (
    str(m.partId, 200, 1) && optTime(m.at) && m.at !== undefined && str(m.title, BACK_TEXT_MAX) && optStr(m.lastLine, BACK_TEXT_MAX) && optStr(m.prompt, BACK_TEXT_MAX) && optStr(m.note, BACK_NOTE_MAX) &&
    (m.remindMs === undefined || (Number.isInteger(m.remindMs) && (m.remindMs as number) >= BACK_REMIND_MIN_MS && (m.remindMs as number) <= BACK_REMIND_MAX_MS)) &&
    optTime(m.remindAt) && optTime(m.remindedAt) &&
    (b === undefined || (isObj(b) && str(b.text, BACK_BRIEF_MAX) && Number.isInteger(b.at))) &&
    (m.briefState === undefined || STATES.includes(m.briefState as string)) && optStr(m.briefError, BACK_TEXT_MAX)
  );
}

/** The whole `back.marks` map: sessions with at most BACK_MARKS_MAX marks in total, one per part. */
export function marksOk(v: unknown): v is Marks {
  if (!isObj(v)) return false;
  let n = 0;
  return Object.entries(v).every(([id, list]) => {
    if (!str(id, 4096, 1) || !Array.isArray(list)) return false;
    n += list.length;
    return n <= BACK_MARKS_MAX && list.every(markOk) && new Set(list.map((m) => m.partId)).size === list.length;
  });
}

export type SetInput = { partId: unknown; title: unknown; lastLine?: unknown; prompt?: unknown; note?: unknown; remindMs?: unknown };

/** The first problem of a back.set (trust boundary), or undefined. */
export function checkSet(m: SetInput): string | undefined {
  if (!str(m.partId, 200, 1)) return "partId must be 1 to 200 characters";
  if (!str(m.title, BACK_TEXT_MAX)) return `title must be at most ${BACK_TEXT_MAX} characters`;
  if (!optStr(m.lastLine, BACK_TEXT_MAX)) return `lastLine must be at most ${BACK_TEXT_MAX} characters`;
  if (!optStr(m.prompt, BACK_TEXT_MAX)) return `prompt must be at most ${BACK_TEXT_MAX} characters`;
  if (!optStr(m.note, BACK_NOTE_MAX)) return `note must be at most ${BACK_NOTE_MAX} characters`;
  if (m.remindMs !== undefined && m.remindMs !== null && !(Number.isInteger(m.remindMs) && (m.remindMs as number) >= BACK_REMIND_MIN_MS && (m.remindMs as number) <= BACK_REMIND_MAX_MS)) return "remindMs must be a whole number of milliseconds from 1 minute to 7 days";
}

export const total = (marks: Marks) => Object.values(marks).reduce((n, l) => n + l.length, 0);

/** Upserts one mark in `list` (mutates the settings file's copy). `note`, `remindMs` follow the request: absent = unchanged. Returns the mark and whether it is new. */
export function upsert(list: BackMark[], m: SetInput & { partId: string; title: string }, now: number): { mark: BackMark; isNew: boolean } {
  let mark = list.find((x) => x.partId === m.partId);
  const isNew = !mark;
  if (!mark) list.push((mark = { partId: m.partId, at: now, title: m.title }));
  mark.title = m.title;
  for (const k of ["lastLine", "prompt"] as const) if (m[k] !== undefined) mark[k] = m[k] as string;
  if (m.note !== undefined) {
    if (m.note === "") delete mark.note;
    else mark.note = m.note as string;
  }
  if (m.remindMs === null) (delete mark.remindMs, delete mark.remindAt, delete mark.remindedAt);
  else if (typeof m.remindMs === "number") (mark.remindMs = m.remindMs), (mark.remindAt = now + m.remindMs), delete mark.remindedAt;
  return { mark, isNew };
}

/** Marks of a session and the one of `partId`; both undefined when absent. */
export const find = (marks: Marks, id: string, partId: string) => marks[id]?.find((m) => m.partId === partId);

/** The brief turn's prompt: the tag line (the web app folds it) and the instruction; the daemon builds it, a browser never sends this text. */
export function briefPrompt(partId: string, title: string, refresh: boolean): string {
  return [
    `<claude-ui-brief part="${partId.replace(/"/g, "")}"/>`,
    `The user marked your reply that starts with "${title.replace(/["\n\r]/g, " ")}" to come back to later and is switching to other work now.`,
    "Write a brief that will let them refocus when they return. Use your full context of this session. Do not use tools.",
    ...(refresh ? ["This is a refresh: take into account everything that happened after that reply."] : []),
    "Reply with exactly three lines:",
    "About: <what that reply and the work around it are about>",
    "Focus now: <what matters most when they come back>",
    "Next: <the concrete next step for the user>",
  ].join("\n");
}
