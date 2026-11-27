// Cuts a raw OpenCode recording (scripts/record-opencode.ts) into a turn file of the fake binaries in test/fixtures.
// Usage: npm run cut-turn -w @claude-ui/daemon -- --v1|--v2 <scenario>.events.jsonl <out turn-*.json>
// OpenCode 1: {events, on?, abort?} (fake-opencode-bin.mjs). OpenCode 2: a list of steps (fake-opencode2-bin.mjs).
// The cut keeps only what the adapters read, replaces ids by the placeholders the fakes fill in, and names the machine's folders /work/proj and /home/user. An event the
// recorder saw for the session that is not in the keep list is dropped and counted; a placeholder that cannot be assigned (a second tool call, ten assistant messages) fails the cut.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import type { Entry } from "./record-opencode.ts";

type Ev = Extract<Entry, { kind: "event" }>;
type Json = Record<string, any>;

const V1_KEEP = new Set(["message.updated", "message.part.updated", "message.part.delta", "session.status", "session.idle", "session.error", "permission.asked", "permission.replied", "question.asked", "question.replied"]);
// Events of the session the adapters do not read: dropped and counted. Any other event type of the session fails the cut, so a type the adapters start to read later is not lost silently.
const V1_DROP = new Set(["session.created", "session.updated", "session.diff"]);
const V2_DROP = new Set(["session.created", "session.inbox.enqueued", "session.inbox.delivered", "session.instructions.updated", "session.renamed", "session.tool.progress", "shell.created", "shell.exited", "form.replied", "permission.replied"]);
const V2_KEEP = /^(session\.(execution|step|text|reasoning|tool)\.|session\.usage\.updated$|permission\.asked$|form\.created$)/;

/** The session an event belongs to. */
const sessionOf = (p: Json): string | undefined => p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID ?? p.form?.sessionID;

const read = (file: string): Entry[] =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Entry);

/** Applies `rename` (exact id -> placeholder) to every string of `value`, longest id first. */
function rename<T>(value: T, ids: Map<string, string>): T {
  let text = JSON.stringify(value);
  for (const [from, to] of [...ids].sort((a, b) => b[0].length - a[0].length)) text = text.replaceAll(from, to);
  return JSON.parse(text) as T;
}

function scrub<T>(value: T, cwd: string): T {
  // A tool title is the path relative to the filesystem root (no leading slash).
  const text = JSON.stringify(value).replaceAll(cwd, "/work/proj").replaceAll(cwd.slice(1), "work/proj").replaceAll(homedir(), "/home/user");
  for (const bad of ["/Users/", "/private/var", "private/var", userInfo().username]) if (text.includes(bad)) throw new Error(`the cut still contains "${bad}" (a machine path or a name); fix the recording or the scrub`);
  return JSON.parse(text) as T;
}

type Cut = { before: Ev[]; after: Ev[]; dropped: Map<string, number> };

/** Splits the recording's events of the sessions `sids` (the prompted one and its subagents') at `at` (an action of the recorder, or the ask event); the recorder's own lines are not events. */
function split(entries: Entry[], sids: ReadonlySet<string>, keep: (e: Ev) => boolean, known: ReadonlySet<string>, atAction?: string): Cut {
  const dropped = new Map<string, number>();
  const cutAt = atAction ? entries.findIndex((e) => e.kind === "action" && e.action === atAction) : -1;
  const before: Ev[] = [];
  const after: Ev[] = [];
  entries.forEach((e, i) => {
    if (e.kind !== "event") return;
    const s = sessionOf(e.properties);
    if (!s || !sids.has(s)) return;
    if (!keep(e)) {
      if (!known.has(e.type)) throw new Error(`unknown event type ${e.type}: add it to the keep or the drop list of cut-turn.ts`);
      return void dropped.set(e.type, (dropped.get(e.type) ?? 0) + 1);
    }
    (cutAt >= 0 && i > cutAt ? after : before).push(e);
  });
  return { before, after, dropped };
}

/** The subagent sessions of the prompted session `sid`, in order of their first appearance: the one a `task` call (OpenCode 1) or a `subagent` call (OpenCode 2) names in its metadata. */
function childSessions(entries: Entry[], sid: string, major: 1 | 2): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.kind !== "event" || sessionOf(e.properties) !== sid) continue;
    const child = major === 1 ? (e.type === "message.part.updated" && e.properties.part?.tool === "task" ? e.properties.part.state?.metadata?.sessionId : undefined) : e.type === "session.tool.progress" ? e.properties.metadata?.sessionID : undefined;
    if (typeof child === "string" && child !== sid && !out.includes(child) && !e.properties.metadata?.shellID) out.push(child);
  }
  return out;
}

const header = (entries: Entry[]) => {
  const start = entries.find((e) => e.kind === "action" && e.action === "start") as Json | undefined;
  const prompt = entries.find((e) => e.kind === "action" && e.action === "prompt") as Json | undefined;
  if (!start?.cwd || !prompt?.sessionID) throw new Error("the recording has no start/prompt line");
  return { cwd: start.cwd as string, sid: prompt.sessionID as string, scenarioActions: entries.filter((e) => e.kind === "action").map((e) => (e as Json).action as string) };
};

export function cutV1(entries: Entry[]) {
  const { cwd, sid, scenarioActions } = header(entries);
  const has = (a: string) => scenarioActions.includes(a);
  const keep = (e: Ev) => V1_KEEP.has(e.type);
  const kids = childSessions(entries, sid, 1);
  const at = has("permission.reply") ? "permission.reply" : has("question.reply") ? "question.reply" : has("interrupt") ? "interrupt" : undefined;
  const { before, after, dropped } = split(entries, new Set([sid, ...kids]), keep, V1_DROP, at);
  const asks = ["permission.asked", "question.asked"];
  // An ask ends the node's events: what OpenCode sent between the ask and the recorder's reply belongs to the reply's node.
  const askAt = before.findIndex((e) => asks.includes(e.type));
  const first = askAt >= 0 ? before.slice(0, askAt + 1) : before;
  const rest = askAt >= 0 ? [...before.slice(askAt + 1), ...after] : after;
  // A subagent's session is `ses_CHILD` (the fake names it after the prompted session; one subagent per recording).
  if (kids.length > 1) throw new Error(`${kids.length} subagent sessions: the fake knows one ses_CHILD`);
  const ids = new Map<string, string>([[sid, "ses_ROOT"], ...kids.map((k) => [k, "ses_CHILD"] as [string, string])]);
  let n = 0;
  for (const e of [...first, ...rest]) {
    const info = e.properties.info as Json | undefined;
    if (e.type === "message.updated" && info?.role === "assistant" && !ids.has(info.id)) ids.set(info.id, n++ === 0 ? "msg_ASSISTANT" : `msg_ASSISTANT_${n}`);
  }
  const plain = (list: Ev[]) => list.map((e) => ({ type: e.type, properties: e.properties }));
  const node: Json = { events: plain(first) };
  if (at === "permission.reply") node.on = { once: { events: plain(rest) } };
  else if (at === "question.reply") node.on = { answer: { events: plain(rest) } };
  else if (at === "interrupt") node.abort = plain(rest);
  return { node: scrub(rename(node, ids), cwd), dropped };
}

export function cutV2(entries: Entry[]) {
  const { cwd, sid, scenarioActions } = header(entries);
  const has = (a: string) => scenarioActions.includes(a);
  // A tool that ran a shell reports it by `shell*` events and a progress line naming the shell; neither is kept (the call's own success ends the card).
  // The synthetic inbox items are the notices OpenCode queues (a subagent ended): the adapter reads them; the user's own items it does not.
  const keep = (e: Ev) => (V2_KEEP.test(e.type) && !(e.type === "session.tool.progress" && e.properties.metadata?.shellID)) || (e.type === "session.inbox.enqueued" && e.properties.item?.type === "synthetic");
  const at = has("interrupt") ? "interrupt" : undefined;
  const kids = childSessions(entries, sid, 2);
  const sids = new Set([sid, ...kids]);
  const { before, dropped } = split(entries, sids, keep, V2_DROP, at);
  // The prompted session is `$SESSION`; a subagent's is `ses_child` (`ses_child2`, ...): literal, the test's session list names it.
  const ids = new Map<string, string>([[sid, "$SESSION"], ...kids.map((k, i) => [k, i === 0 ? "ses_child" : `ses_child${i + 1}`] as [string, string])]);
  const assistants: string[] = [];
  const childAssistants: string[] = [];
  const calls: string[] = [];
  for (const e of before) {
    const p = e.properties;
    const main = sessionOf(p) === sid;
    const list = main ? assistants : childAssistants;
    if (p.assistantMessageID && !list.includes(p.assistantMessageID)) list.push(p.assistantMessageID);
    if (e.type.startsWith("session.tool.") && p.id && !calls.includes(p.id)) calls.push(p.id);
    if (e.type === "permission.asked") ids.set(p.id, "$PERM");
    if (e.type === "form.created") ids.set(p.form.id, "$FORM");
  }
  if (assistants.length > 9) throw new Error(`${assistants.length} assistant messages: the fake knows $A1..$A9`);
  assistants.forEach((id, i) => ids.set(id, `$A${i + 1}`));
  childAssistants.forEach((id, i) => ids.set(id, `msg_c${i + 1}`));
  // The fake fills one `$CALL` (the first call, where a form or a failure names it); the other calls keep a literal id.
  calls.forEach((c, i) => ids.set(c, i === 0 ? "$CALL" : `call_${i + 1}`));
  const steps: Json[] = [];
  for (const e of before) {
    if (e.type === "form.created") {
      const f = e.properties.form as Json;
      steps.push({ form: { fields: f.fields, ...(f.title !== "Questions" && { title: f.title }) } }, { wait: "form" });
    } else if (e.type === "permission.asked") steps.push({ event: e.type, data: e.properties }, { wait: "permission" });
    else steps.push({ event: e.type, data: e.properties });
  }
  // The recorder's Stop: the fake holds the turn until the interrupt and ends it as OpenCode does.
  if (at === "interrupt") steps.push({ hold: true });
  return { node: scrub(rename(steps, ids), cwd), dropped };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mode, file, out] = process.argv.slice(2);
  if ((mode !== "--v1" && mode !== "--v2") || !file || !out) (console.error("usage: cut-turn --v1|--v2 <scenario>.events.jsonl <out turn.json>"), process.exit(2));
  const { node, dropped } = (mode === "--v1" ? cutV1 : cutV2)(read(file));
  writeFileSync(out, JSON.stringify(node, null, 1) + "\n");
  console.error(`wrote ${out}; dropped ${[...dropped].map(([k, v]) => `${k} x${v}`).join(", ") || "nothing"}`);
}
