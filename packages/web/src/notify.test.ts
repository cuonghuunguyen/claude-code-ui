import type { Event, Part, SessionListItem } from "@claude-ui/protocol";
import { expect, it } from "vitest";
import { applyEvent, emptySession, type PermissionRequest, type QuestionRequest, type SessionView } from "./store.ts";
import { addCard, ageLabel, cardText, createTracker, describeCard, dismissSession, inlineActions, lastLine, loadInApp, reconcile, saveInApp, visibleCards, type Card, type Signal } from "./notify.ts";

const item = (id: string, over: Partial<SessionListItem> = {}) => ({ id, cwd: "/p", state: "idle", title: id, lastActivity: 0, archived: false, transcript: true, ...over }) as SessionListItem;
const perm = (id: string, over: Partial<PermissionRequest> = {}): PermissionRequest => ({ type: "permission_request", id, requestId: id, toolUseId: `tu-${id}`, tool: "Read", input: { file_path: "/p/src/a.ts" }, suggestions: [], settled: false, ...over });
const ask = (id: string, over: Partial<QuestionRequest> = {}): QuestionRequest => ({ type: "question", id, requestId: id, toolUseId: `tu-${id}`, questions: [{ question: "Keep the old route?", header: "Route", options: [], multiSelect: false }], settled: false, ...over });
const state = (s: "idle" | "running" | "needs_input" | "error", working?: true): Part => ({ type: "session_state", id: "st", state: s, ...(working && { working }) });
const text = (t: string): Part => ({ type: "assistant_text", id: "m1", text: t, streaming: false });
let n = 0;
const ev = (sessionId: string, part: Part): Event => ({ type: "event", sessionId, seq: ++n, part });
const view = (parts: Part[]): SessionView => parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s", seq: i + 1, part }), emptySession());
const card = (over: Partial<Card> = {}): Card => ({ sessionId: "b", kind: "permission", requestId: "r1", since: 1, ...over });

// The tracker turns events into signals: only a live event makes one, a replay only teaches it what the session was doing.
it("seed: a request in a replay or snapshot makes no signal, and the same request live later does not either", () => {
  const t = createTracker();
  expect(t.observe(ev("b", perm("r1")), false)).toEqual([]);
  expect(t.observe(ev("b", perm("r1", { tier: "low" })), true)).toEqual([]);
});

it("a live request is one signal; its second event with the tier is not another", () => {
  const t = createTracker();
  expect(t.observe(ev("b", perm("r1")), true)).toEqual([{ type: "request", sessionId: "b", requestId: "r1", kind: "permission", escalated: false }]);
  expect(t.observe(ev("b", perm("r1", { tier: "low" })), true)).toEqual([]);
});

it("a question is a question signal; a settled request is none", () => {
  const t = createTracker();
  expect(t.observe(ev("b", ask("q1")), true)).toEqual([{ type: "request", sessionId: "b", requestId: "q1", kind: "question", escalated: false }]);
  expect(t.observe(ev("b", perm("r2", { settled: true })), true)).toEqual([]);
});

it("a request a coordinator escalates later is a second signal, flagged escalated", () => {
  const t = createTracker();
  t.observe(ev("w", perm("r1")), true);
  expect(t.observe(ev("w", perm("r1", { escalated: true, reason: "outside folder" })), true)).toEqual([{ type: "request", sessionId: "w", requestId: "r1", kind: "permission", escalated: true }]);
  expect(t.observe(ev("w", perm("r1", { escalated: true, reason: "outside folder", tier: "low" })), true)).toEqual([]);
});

it("finished: idle after running is a finish signal with the last non-empty line of the last answer", () => {
  const t = createTracker();
  t.observe(ev("e", state("running")), true);
  t.observe(ev("e", text("Done.\n\nAll 12 tests pass.\n")), true);
  expect(t.observe(ev("e", state("idle")), true)).toEqual([{ type: "finish", sessionId: "e", kind: "finished", text: "All 12 tests pass." }]);
});

it("finished without text says Finished; idle with background work (`working`) is nothing; idle after idle is nothing", () => {
  const t = createTracker();
  t.observe(ev("e", state("running")), true);
  expect(t.observe(ev("e", state("idle", true)), true)).toEqual([]);
  expect(t.observe(ev("e", state("idle")), true)).toEqual([]);
  t.observe(ev("e", state("running")), true);
  expect(t.observe(ev("e", state("idle")), true)).toEqual([{ type: "finish", sessionId: "e", kind: "finished", text: "Finished" }]);
});

it("an error after running is an error signal with the error text, else a plain line", () => {
  const t = createTracker();
  t.observe(ev("e", state("running")), true);
  t.observe(ev("e", { type: "raw", id: "x", message: { error: "rate_limit" } }), true);
  expect(t.observe(ev("e", state("error")), true)).toEqual([{ type: "finish", sessionId: "e", kind: "error", text: "rate_limit" }]);
  t.observe(ev("e", { type: "user_text", id: "u", text: "again", images: [] }), true);
  t.observe(ev("e", state("running")), true);
  expect(t.observe(ev("e", state("error")), true)).toEqual([{ type: "finish", sessionId: "e", kind: "error", text: "The turn ended with an error" }]);
});

it("running again is a resume signal, so a finish waiting for its delay is cancelled", () => {
  const t = createTracker();
  t.observe(ev("e", state("running")), true);
  expect(t.observe(ev("e", state("running")), true)).toEqual<Signal[]>([{ type: "resume", sessionId: "e" }]);
});

it("a replayed turn makes no finish signal, but teaches the state: the live idle after a replayed running counts", () => {
  const t = createTracker();
  expect(t.observe(ev("e", state("running")), false)).toEqual([]);
  expect(t.observe(ev("e", state("idle")), false)).toEqual([]);
  t.observe(ev("e", state("running")), false);
  expect(t.observe(ev("e", state("idle")), true)).toHaveLength(1);
});

it("a session first seen live uses the view's state as the state before (a snapshot carried no events)", () => {
  const t = createTracker();
  expect(t.observe(ev("e", state("idle")), true, "running")).toEqual([{ type: "finish", sessionId: "e", kind: "finished", text: "Finished" }]);
});

it("lastLine: the last non-empty trimmed line", () => {
  expect(lastLine("a\n  b  \n\n")).toBe("b");
  expect(lastLine("")).toBeUndefined();
  expect(lastLine(undefined)).toBeUndefined();
});

// Cards: one per session, newest first.
it("addCard replaces the session's card in place of the list's first position and keeps others", () => {
  const a = addCard([], card({ sessionId: "a", requestId: "ra" }));
  const b = addCard(a, card({ sessionId: "b" }));
  expect(b.map((c) => c.sessionId)).toEqual(["b", "a"]);
  const again = addCard(b, card({ sessionId: "a", kind: "finished", requestId: undefined, text: "ok" }));
  expect(again.map((c) => c.sessionId + c.kind)).toEqual(["afinished", "b" + "permission"]);
});

it("dismissSession removes that session's card", () => {
  expect(dismissSession([card({ sessionId: "a" }), card({ sessionId: "b" })], "a").map((c) => c.sessionId)).toEqual(["b"]);
});

const ctx = (views: Record<string, SessionView>, over: Partial<Parameters<typeof reconcile>[1]> = {}) => ({ views, list: [item("a"), item("b")], shown: (_: string) => false, focusPage: false, enabled: true, ...over });

it("reconcile keeps a card while its request waits and returns the same array when nothing changed", () => {
  const cards = [card()];
  expect(reconcile(cards, ctx({ b: view([perm("r1")]) }))).toBe(cards);
});

it("reconcile drops a card whose request settled, from anywhere", () => {
  expect(reconcile([card()], ctx({ b: view([perm("r1"), perm("r1", { settled: true })]) }))).toEqual([]);
});

it("reconcile moves a card to the session's other waiting request when one settled", () => {
  const out = reconcile([card()], ctx({ b: view([perm("r1"), ask("q2"), perm("r1", { settled: true })]) }));
  expect(out).toEqual([card({ kind: "question", requestId: "q2" })]);
});

it("reconcile drops cards of the shown session, of an archived or unlisted one, all of them on the Focus page and when in-app is off", () => {
  const views = { a: view([perm("r1")]), b: view([perm("r2")]) };
  const cards = [card({ sessionId: "a", requestId: "r1" }), card({ sessionId: "b", requestId: "r2" })];
  expect(reconcile(cards, ctx(views, { shown: (id) => id === "a" })).map((c) => c.sessionId)).toEqual(["b"]);
  expect(reconcile(cards, ctx(views, { list: [item("a", { archived: true }), item("b")] })).map((c) => c.sessionId)).toEqual(["b"]);
  expect(reconcile(cards, ctx(views, { list: [item("b")] })).map((c) => c.sessionId)).toEqual(["b"]);
  expect(reconcile(cards, ctx(views, { focusPage: true }))).toEqual([]);
  expect(reconcile(cards, ctx(views, { enabled: false }))).toEqual([]);
});

it("reconcile keeps finished and error cards while the session is listed and not shown", () => {
  const cards = [card({ kind: "finished", requestId: undefined, text: "ok" })];
  expect(reconcile(cards, ctx({ b: view([]) }))).toBe(cards);
});

// What a card shows, derived from the live view, so a tier arriving later changes it in place.
it("describeCard (permission): summary with the tool, tier, escalation and the other waiting requests", () => {
  const v = view([perm("r1", { escalated: true, reason: "outside the folder" }), ask("q2")]);
  const d = describeCard(card(), v, "/p");
  expect(d).toMatchObject({ tool: "Read", body: "src/a.ts", tier: undefined, escalated: true, reason: "outside the folder", extra: 1 });
  expect(describeCard(card(), view([perm("r1", { tier: "low" })]), "/p")).toMatchObject({ tier: "low", extra: 0 });
});

it("describeCard (question): the first question's text; (finished/error): the card text", () => {
  expect(describeCard(card({ kind: "question", requestId: "q1" }), view([ask("q1")]), "/p").body).toBe("Keep the old route?");
  expect(describeCard(card({ kind: "finished", requestId: undefined, text: "All 12 tests pass." }), view([]), "/p").body).toBe("All 12 tests pass.");
});

it("inlineActions: Allow and Deny only for a low-tier tool that changes nothing; an edit, a high tier, a question and an escalation open Focus", () => {
  expect(inlineActions({ kind: "permission", tier: "low", tool: "Read" })).toBe("answer");
  expect(inlineActions({ kind: "permission", tier: "low", tool: "Bash" })).toBe("answer");
  expect(inlineActions({ kind: "permission", tier: "low", tool: "Edit" })).toBe("open");
  expect(inlineActions({ kind: "permission", tier: "low", tool: "Write" })).toBe("open");
  expect(inlineActions({ kind: "permission", tier: undefined, tool: "Read" })).toBe("open");
  expect(inlineActions({ kind: "permission", tier: "low", tool: "Read", escalated: true })).toBe("open");
  expect(inlineActions({ kind: "question", tier: undefined, tool: undefined })).toBe("open");
  expect(inlineActions({ kind: "finished", tier: undefined, tool: undefined })).toBe("open");
});

it("tier arriving later turns the same card from open into answer", () => {
  const before = describeCard(card(), view([perm("r1")]), "/p");
  const after = describeCard(card(), view([perm("r1"), perm("r1", { tier: "low" })]), "/p");
  expect(inlineActions(before)).toBe("open");
  expect(inlineActions(after)).toBe("answer");
});

it("visibleCards: waiting before error before finished, newest first inside each; finished and error beyond the limit are dropped, waiting ones counted", () => {
  const mk = (id: string, kind: Card["kind"]) => card({ sessionId: id, kind, requestId: kind === "permission" || kind === "question" ? `r${id}` : undefined });
  const cards = [mk("1", "finished"), mk("2", "permission"), mk("3", "error"), mk("4", "question"), mk("5", "permission")];
  expect(visibleCards(cards, 3)).toEqual({ shown: [cards[1], cards[3], cards[4]], hiddenWaiting: 0 });
  const many = [mk("1", "permission"), mk("2", "permission"), mk("3", "finished"), mk("4", "permission"), mk("5", "permission")];
  expect(visibleCards(many, 3)).toEqual({ shown: [many[0], many[1], many[3]], hiddenWaiting: 1 });
  expect(visibleCards(many, 1)).toEqual({ shown: [many[0]], hiddenWaiting: 3 });
});

it("ageLabel: now, minutes, hours and minutes", () => {
  expect(ageLabel(20_000)).toBe("now");
  expect(ageLabel(60_000)).toBe("1m");
  expect(ageLabel(12 * 60_000 + 5_000)).toBe("12m");
  expect(ageLabel(63 * 60_000)).toBe("1h 3m");
  expect(ageLabel(-5)).toBe("now");
});

it("cardText: the sentence a screen reader hears for each kind", () => {
  expect(cardText({ kind: "permission", title: "Fix login", body: "Read · src/a.ts" })).toBe("Fix login needs permission: Read · src/a.ts.");
  expect(cardText({ kind: "question", title: "Fix login", body: "Keep the old route?" })).toBe("Fix login asks a question: Keep the old route?.");
  expect(cardText({ kind: "finished", title: "Fix login", body: "ok" })).toBe("Fix login finished.");
  expect(cardText({ kind: "error", title: "Fix login", body: "x" })).toBe("Fix login stopped with an error.");
});

it("loadInApp: on by default and when storage throws, off after saveInApp(false)", () => {
  const store = new Map<string, string>();
  const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  expect(loadInApp(ls)).toBe(true);
  saveInApp(false, ls);
  expect(loadInApp(ls)).toBe(false);
  saveInApp(true, ls);
  expect(loadInApp(ls)).toBe(true);
  expect(loadInApp({ getItem: () => { throw new Error("blocked"); } })).toBe(true);
});

it("lastLine shows markdown as plain text: links keep their title, list and emphasis markers go", () => {
  expect(lastLine("done\n- [Fix login](https://example.com/a?b=1)")).toBe("Fix login");
  expect(lastLine("**All** `12` tests pass")).toBe("All 12 tests pass");
  expect(lastLine("## Summary\n")).toBe("Summary");
  expect(lastLine("![alt](x.png)")).toBe("alt");
});

it("on the Focus page the request cards go but a finished or error card stays", () => {
  const views = { b: view([perm("r1")]) };
  const cards = [card(), card({ sessionId: "a", kind: "finished", requestId: undefined, text: "ok" })];
  expect(reconcile(cards, ctx(views, { focusPage: true })).map((c) => c.sessionId + c.kind)).toEqual(["afinished"]);
});
