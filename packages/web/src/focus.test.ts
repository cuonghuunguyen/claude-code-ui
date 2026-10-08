import type { Part, SessionListItem } from "@claude-ui/protocol";
import { expect, it } from "vitest";
import { answeredLabel, nextWaiting, requestSummary, runningSessions, waitLabel, waitingCount, waitingRequests, waitingStatus } from "./focus.ts";
import { applyEvent, emptySession, type PermissionRequest, type QuestionRequest, type SessionView } from "./store.ts";

const item = (id: string, over: Partial<SessionListItem> = {}) => ({ id, cwd: "/p", state: "idle", title: id, lastActivity: 0, archived: false, transcript: true, ...over }) as SessionListItem;
const perm = (id: string, over: Partial<PermissionRequest> = {}): PermissionRequest => ({ type: "permission_request", id, requestId: id, toolUseId: `tu-${id}`, tool: "Bash", input: { command: "npm run test -- auth" }, suggestions: [], settled: false, ...over });
const ask = (id: string, over: Partial<QuestionRequest> = {}): QuestionRequest => ({ type: "question", id, requestId: id, toolUseId: `tu-${id}`, questions: [{ question: "Keep the old route?", header: "Route", options: [], multiSelect: false }], settled: false, ...over });
const view = (parts: Part[]): SessionView => parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s", seq: i + 1, part }), emptySession());
const none = new Map<string, number>();

it("lists every unsettled request of every session, oldest first by the daemon time", () => {
  const list = [item("a"), item("b"), item("c")];
  const w = waitingRequests(list, { a: view([perm("a1", { at: 300 })]), b: view([ask("b1", { at: 100 })]), c: view([perm("c1", { at: 200 })]) }, none, 1000);
  expect(w.map((x) => [x.sessionId, x.part.id, x.since])).toEqual([["b", "b1", 100], ["c", "c1", 200], ["a", "a1", 300]]);
});

it("a request without `at` uses when this browser first saw it, else now", () => {
  const w = waitingRequests([item("a")], { a: view([perm("a1"), perm("a2")]) }, new Map([["a1", 50]]), 900);
  expect(w.map((x) => [x.part.id, x.since])).toEqual([["a1", 50], ["a2", 900]]);
});

it("leaves out settled requests, archived sessions and sessions this browser holds no view of", () => {
  const list = [item("a"), item("b", { archived: true }), item("c")];
  const w = waitingRequests(list, { a: view([perm("a1", { at: 1 }), perm("a1", { at: 1, settled: true })]), b: view([perm("b1", { at: 1 })]) }, none, 5);
  expect(w).toEqual([]);
});

it("two requests of one session are two entries and count as one session", () => {
  const w = waitingRequests([item("a"), item("b")], { a: view([perm("a1", { at: 1 }), perm("a2", { at: 2 })]), b: view([ask("b1", { at: 3 })]) }, none, 5);
  expect(w).toHaveLength(3);
  expect(waitingCount(w)).toBe(2);
});

it("nextWaiting takes the entry after the current one, wraps, and starts at the oldest", () => {
  const w = waitingRequests([item("a"), item("b"), item("c")], { a: view([perm("a1", { at: 1 })]), b: view([perm("b1", { at: 2 })]), c: view([perm("c1", { at: 3 })]) }, none, 9);
  expect(nextWaiting(w)?.part.id).toBe("a1");
  expect(nextWaiting(w, "a1")?.part.id).toBe("b1");
  expect(nextWaiting(w, "c1")?.part.id).toBe("a1");
  expect(nextWaiting(w, "gone")?.part.id).toBe("a1");
  expect(nextWaiting([])).toBeUndefined();
});

it("running sessions leave out those that wait, newest activity first, with their last tool", () => {
  const running = (id: string, tool: string): SessionView => view([{ type: "tool_call", id, toolUseId: id, tool, input: {}, status: "running" }, { type: "session_state", id: "st", state: "running" }]);
  const list = [item("a", { lastActivity: 1 }), item("b", { lastActivity: 5 }), item("c", { lastActivity: 9 }), item("d")];
  const views = { a: running("t1", "Edit"), b: running("t2", "Read"), c: running("t3", "Bash"), d: view([]) };
  const w = waitingRequests(list, { ...views, c: view([perm("c1", { at: 1 }), { type: "session_state", id: "st", state: "needs_input" }]) }, none, 9);
  expect(runningSessions(list, views, w).map((r) => [r.session.id, r.tool])).toEqual([["b", "Read"], ["a", "Edit"]]);
});

it("summarises a request on one line", () => {
  expect(requestSummary(perm("x"))).toBe("Bash · npm run test -- auth");
  expect(requestSummary(perm("x", { tool: "Edit", input: { file_path: "/p/docs/setup.md", old_string: "a\n", new_string: "a\nb\nc\n" } }), "/p")).toBe("Edit · docs/setup.md +2 −0");
  expect(requestSummary(ask("q"))).toBe("Question · Keep the old route?");
});

it("labels an answered request", () => {
  expect(answeredLabel(perm("x", { settled: true, decision: "allow" }))).toBe("Allowed npm run test -- auth");
  expect(answeredLabel(perm("x", { settled: true, decision: "allow_always" }))).toBe("Always allowed npm run test -- auth");
  expect(answeredLabel(perm("x", { settled: true, decision: "deny" }))).toBe("Denied npm run test -- auth");
  expect(answeredLabel(perm("x", { settled: true, decision: "cancelled" }))).toBe("Cancelled");
  expect(answeredLabel(ask("q", { settled: true, answers: { "Keep the old route?": "Yes", Other: "Maybe" } }))).toBe("Answered: Yes, Maybe");
  expect(answeredLabel(ask("q", { settled: true }))).toBe("Cancelled");
});

it("formats the wait time and the status phrase", () => {
  expect([waitLabel(12_000), waitLabel(252_000), waitLabel(3_780_000)]).toEqual(["12s", "4m 12s", "1h 3m"]);
  expect([0, 1, 3].map(waitingStatus)).toEqual(["No session needs input", "1 session needs input", "3 sessions need input"]);
});
