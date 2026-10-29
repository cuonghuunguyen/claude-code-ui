import type { Part, SessionListItem } from "@claude-ui/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { answeredLabel, attentionRows, blockingCount, capRows, doneSummary, focusSubtitle, KIND_ORDER, loadFocusCollapsed, nestRows, nextWaiting, saveFocusCollapsed, nowLine, quietLabel, requestSummary, rowTodos, taskProgress, waitLabel, waitingCount, waitingRequests, waitingStatus, workingRows, type FocusInput } from "./focus.ts";
import { asideItem } from "./aside.ts";
import { applyEvent, emptySession, type PermissionRequest, type QuestionRequest, type SessionView } from "./store.ts";

const item = (id: string, over: Partial<SessionListItem> = {}) => ({ id, cwd: "/p", state: "idle", title: id, lastActivity: 0, archived: false, transcript: true, ...over }) as SessionListItem;
const perm = (id: string, over: Partial<PermissionRequest> = {}): PermissionRequest => ({ type: "permission_request", id, requestId: id, toolUseId: `tu-${id}`, tool: "Bash", input: { command: "npm run test -- auth" }, suggestions: [], settled: false, ...over });
const ask = (id: string, over: Partial<QuestionRequest> = {}): QuestionRequest => ({ type: "question", id, requestId: id, toolUseId: `tu-${id}`, questions: [{ question: "Keep the old route?", header: "Route", options: [], multiSelect: false }], settled: false, ...over });
const view = (parts: Part[]): SessionView => parts.reduce((s, part, i) => applyEvent(s, { type: "event", sessionId: "s", seq: i + 1, part }), emptySession());
const none = new Map<string, number>();

it("lists every unsettled request of every session in the displayed order: escalated, permission, question, then oldest first by the daemon time", () => {
  const list = [item("a"), item("b"), item("c")];
  const w = waitingRequests(list, { a: view([perm("a1", { at: 300 })]), b: view([ask("b1", { at: 100 })]), c: view([perm("c1", { at: 200 })]) }, none, 1000);
  expect(w.map((x) => [x.sessionId, x.part.id, x.since])).toEqual([["c", "c1", 200], ["a", "a1", 300], ["b", "b1", 100]]);
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

// ---- GH-270: attention rows ----
const NOW = 10_000_000;
const min = 60_000;
const input = (list: SessionListItem[], views: Record<string, SessionView>, o: { unread?: string[]; activity?: Record<string, number>; now?: number } = {}): FocusInput => ({
  list,
  views,
  waiting: waitingRequests(list, views, none, o.now ?? NOW),
  unread: new Set(o.unread ?? []),
  activity: (id) => o.activity?.[id] ?? list.find((s) => s.id === id)?.lastActivity ?? 0,
  now: o.now ?? NOW,
  clock: () => "14:05",
});
const state = (st: "running" | "idle" | "error", working?: true): Part => ({ type: "session_state", id: "st", state: st, ...(working ? { working } : {}) });
const call = (id: string, tool: string, status: "done" | "running", inp: unknown = {}): Part => ({ type: "tool_call", id, toolUseId: id, tool, input: inp, status });
const user: Part = { type: "user_text", id: "u", text: "go", images: [] };
const reply = (text: string): Part => ({ type: "assistant_text", id: "r", text, streaming: false });
const todos = (...items: [string, "pending" | "in_progress" | "completed", string?][]): Part => ({ type: "todo_update", id: "t:todos", items: items.map(([content, status, activeForm]) => ({ content, status, activeForm })) });

it("attentionRows: kinds come in the fixed order escalated, permission, question, error, usage limit, stuck, finished", () => {
  const list = ["fin", "stk", "lim", "err", "q", "p", "esc"].map((id) => item(id, { lastActivity: NOW - 1000 }));
  const views = {
    esc: view([perm("e1", { escalated: true, at: 1 })]),
    p: view([perm("p1", { at: 2 })]),
    q: view([ask("q1", { at: 3 })]),
    err: view([user, state("running"), state("error")]),
    lim: view([{ type: "auto_continue", id: "auto_continue", at: NOW + 1000 }]),
    stk: view([user, state("running")]),
    fin: view([user, state("running"), reply("ok"), state("idle")]),
  };
  const rows = attentionRows(input(list, views, { unread: ["err", "fin"], activity: { stk: NOW - 6 * min } }));
  expect(rows.map((r) => r.kind)).toEqual([...KIND_ORDER]);
});

it("escalated: Decide line, coordinator reason as line 3, action answer", () => {
  const list = [item("a")];
  const [r] = attentionRows(input(list, { a: view([perm("e1", { escalated: true, reason: "risky", at: 1 })]) }));
  expect(r).toMatchObject({ id: "e1", kind: "escalated", reason: "Decide: Bash · npm run test -- auth", detail: "Coordinator: risky", action: "answer" });
  const [q] = attentionRows(input(list, { a: view([ask("e2", { escalated: true, at: 1 })]) }));
  expect(q).toMatchObject({ kind: "escalated", reason: "Answer: Keep the old route?" });
});

it("permission: Allow or deny line", () => {
  const [r] = attentionRows(input([item("a")], { a: view([perm("p1", { at: 1 })]) }));
  expect(r).toMatchObject({ kind: "permission", reason: "Allow or deny Bash · npm run test -- auth", action: "answer", sessionId: "a", since: 1 });
});

it("question: Answer line", () => {
  const [r] = attentionRows(input([item("a")], { a: view([ask("q1", { at: 1 })]) }));
  expect(r).toMatchObject({ kind: "question", reason: "Answer: Keep the old route?" });
});

it("error: an unread error session shows the raw error text, else a plain sentence; a read one gives no row", () => {
  const list = [item("a"), item("b")];
  const raw: Part = { type: "raw", id: "raw", message: { error: "authentication_failed" } };
  const views = { a: view([user, raw, state("running"), state("error")]), b: view([user, state("running"), state("error")]) };
  const rows = attentionRows(input(list, views, { unread: ["a", "b"] }));
  expect(rows.map((r) => [r.sessionId, r.reason, r.action])).toEqual([["a", "Check the error: authentication_failed", "open"], ["b", "Check the error: the turn ended with an error", "open"]]);
  expect(attentionRows(input(list, views, { unread: ["a"] })).map((r) => r.sessionId)).toEqual(["a"]);
});

it("usage limit: a scheduled continue gives a Cancel continue row", () => {
  const [r] = attentionRows(input([item("a")], { a: view([{ type: "auto_continue", id: "auto_continue", at: NOW + 5000 }]) }));
  expect(r).toMatchObject({ kind: "limit", reason: "Wait for the usage limit to reset: continues at 14:05", action: "cancel_continue" });
});

it("usage limit without a scheduled continue (auto-continue off): an Open session row, with or without the reset time; a scheduled continue wins", () => {
  const stop = (resetsAt?: number): Part => ({ type: "limit_stop", id: "limit_stop", stopped: true, ...(resetsAt && { resetsAt }) });
  expect(attentionRows(input([item("a")], { a: view([stop(NOW + 5000)]) }))[0]).toMatchObject({ kind: "limit", reason: "Wait for the usage limit to reset: resets at 14:05", action: "open" });
  expect(attentionRows(input([item("a")], { a: view([stop()]) }))[0]).toMatchObject({ kind: "limit", reason: "Wait for the usage limit to reset", action: "open" });
  expect(attentionRows(input([item("a")], { a: view([stop(NOW + 9000), { type: "auto_continue", id: "auto_continue", at: NOW + 5000 }]) }))[0]).toMatchObject({ reason: "Wait for the usage limit to reset: continues at 14:05", action: "cancel_continue" });
  expect(attentionRows(input([item("a")], { a: view([stop(NOW), { type: "limit_stop", id: "limit_stop", stopped: false }]) }))).toEqual([]);
});

it("finished row carries the Next for you suggestion of the view (GH-305)", () => {
  const list = [item("a", { lastActivity: NOW - min })];
  const withSuggestion = view([state("running"), reply("done"), state("idle"), { type: "prompt_suggestion", id: "prompt_suggestion", text: "run the tests" }]);
  expect(attentionRows(input(list, { a: withSuggestion }, { unread: ["a"] }))[0]).toMatchObject({ kind: "finished", suggestion: "run the tests" });
  expect(attentionRows(input(list, { a: view([state("running"), reply("done"), state("idle")]) }, { unread: ["a"] }))[0]).not.toHaveProperty("suggestion", expect.anything());
});

it("finished after a daemon restart (GH-305): a closed session with an unread record gets a finished row, with or without a view; not unread, none; older than 24 h, none", () => {
  const closed = (over: Partial<SessionListItem> = {}) => item("a", { state: "closed", lastActivity: NOW - min, ...over });
  const withText = view([user, state("running"), reply("All green."), state("idle")]);
  expect(attentionRows(input([closed()], { a: withText }, { unread: ["a"] }))[0]).toMatchObject({ kind: "finished", reason: "Review: All green.", action: "open" });
  expect(attentionRows(input([closed()], {}, { unread: ["a"] }))[0]).toMatchObject({ kind: "finished", reason: "Review the result", action: "open", id: "finished:a" });
  expect(attentionRows(input([closed()], {}))).toEqual([]);
  expect(attentionRows(input([closed()], { a: withText }))).toEqual([]);
  expect(attentionRows(input([closed({ lastActivity: NOW - 25 * 60 * min })], {}, { unread: ["a"] }))).toEqual([]);
  expect(attentionRows(input([closed({ archived: true })], {}, { unread: ["a"] }))).toEqual([]);
});

it("error, limit and quiet rows still need a view (a closed or unknown session without one gets none of them)", () => {
  expect(attentionRows(input([item("a", { state: "error", lastActivity: NOW })], {}, { unread: ["a"] }))).toEqual([]);
});

it("stuck: running, nothing pending, no running call, quiet 5 min; quiet 4 min or a running call gives none", () => {
  const list = [item("a")];
  const v = view([user, call("c1", "Read", "done", { file_path: "/p/a.ts" }), state("running")]);
  const [r] = attentionRows(input(list, { a: v }, { activity: { a: NOW - 6 * min } }));
  expect(r).toMatchObject({ kind: "stuck", reason: "Check it: quiet 6m since Read · a.ts", action: "open", since: NOW - 6 * min });
  expect(attentionRows(input(list, { a: v }, { activity: { a: NOW - 5 * min + 1000 } }))).toEqual([]);
  const busy = view([user, call("c1", "Bash", "running"), state("running")]);
  expect(attentionRows(input(list, { a: busy }, { activity: { a: NOW - 20 * min } }))).toEqual([]);
});

it("finished: an unread idle session shows the reply's last line and the task summary", () => {
  const views = { a: view([user, state("running"), todos(["a", "completed"], ["b", "completed"], ["c", "completed"], ["Ship it", "completed"]), reply("Done.\nAll 12 tests pass"), state("idle")]) };
  const [r] = attentionRows(input([item("a", { lastActivity: NOW - 1000 })], views, { unread: ["a"] }));
  expect(r).toMatchObject({ kind: "finished", reason: "Review: All 12 tests pass", detail: "4 of 4 · Done: Ship it", action: "open" });
  const bare = { a: view([user, state("running"), state("idle")]) };
  expect(attentionRows(input([item("a", { lastActivity: NOW - 1000 })], bare, { unread: ["a"] }))[0]).toMatchObject({ reason: "Review the result", detail: undefined });
});

it("finished: working (background task), read, or older than 24 h gives none", () => {
  const done = [user, state("running"), reply("x"), state("idle")];
  const list = (over: Partial<SessionListItem> = {}) => [item("a", { lastActivity: NOW - 1000, ...over })];
  expect(attentionRows(input(list(), { a: view([...done, state("idle", true)]) }, { unread: ["a"] }))).toEqual([]);
  expect(attentionRows(input(list(), { a: view(done) }))).toEqual([]);
  expect(attentionRows(input(list({ lastActivity: NOW - 25 * 60 * min }), { a: view(done) }, { unread: ["a"] }))).toEqual([]);
});

it("a session with a waiting request gets no session row; one session row per session (error before finished)", () => {
  const w = attentionRows(input([item("a")], { a: view([user, state("running"), perm("p1", { at: 1 }), state("error")]) }, { unread: ["a"] }));
  expect(w.map((r) => r.kind)).toEqual(["permission"]);
  const e = attentionRows(input([item("a", { lastActivity: NOW })], { a: view([user, state("running"), state("error")]) }, { unread: ["a"] }));
  expect(e.map((r) => r.kind)).toEqual(["error"]);
});

it("nowLine: in-progress todo activeForm first, then the running tool, then Compacting, Thinking, Writing", () => {
  expect(nowLine(view([todos(["Fix", "in_progress", "Fixing the bug"]), call("c", "Bash", "running", { command: "ls" })]))).toBe("Fixing the bug");
  expect(nowLine(view([todos(["Fix", "in_progress"])]))).toBe("Fix");
  expect(nowLine(view([call("c", "Read", "running", { file_path: "/p/a.ts" })]), "/p")).toBe("Read · a.ts");
  expect(nowLine(view([call("c", "Bash", "running", { command: "ls" })]))).toBe("Bash · ls");
  expect(nowLine(view([{ type: "compaction", id: "k" }]))).toBe("Compacting");
  expect(nowLine(view([{ type: "compaction", id: "k", summary: "s" }]))).toBe("Writing");
  expect(nowLine(view([{ type: "thinking", id: "th", text: "", streaming: true }]))).toBe("Thinking");
  expect(nowLine(view([reply("x")]))).toBe("Writing");
});

it("workingRows: running sessions without an attention row, newest first, with the now line and k of n", () => {
  const list = [item("a", { lastActivity: 1 }), item("b", { lastActivity: 5 }), item("c"), item("d")];
  const running = (extra: Part[]) => view([user, ...extra, state("running")]);
  const views = {
    a: running([call("t1", "Edit", "running")]),
    b: running([todos(["x", "completed"], ["y", "in_progress", "Doing y"], ["z", "pending"], ["w", "pending"], ["v", "pending"])]),
    c: running([perm("c1", { at: 1 })]),
    d: view([]),
  };
  const i = input(list, views, { activity: { a: NOW - 1000, b: NOW - 3 * min } });
  const rows = attentionRows(i);
  expect(workingRows(i, rows).map((r) => [r.session.id, r.now, r.progress, r.quietMs])).toEqual([["a", "Edit", undefined, 1000], ["b", "Doing y", "2 of 5", 3 * min]]);
});

it("taskProgress and doneSummary", () => {
  expect(taskProgress([])).toBeUndefined();
  expect(taskProgress([{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }])).toBe("2 of 3");
  expect(doneSummary([])).toBeUndefined();
  expect(doneSummary([{ content: "a", status: "pending" }])).toBeUndefined();
  expect(doneSummary([{ content: "a", status: "completed" }, { content: "b", status: "pending" }])).toBe("1 of 2 · Done: a");
});

it("capRows: at most 5, the rest counted; expanded shows all", () => {
  const rows = [1, 2, 3, 4, 5, 6, 7];
  expect(capRows(rows, false)).toEqual({ shown: [1, 2, 3, 4, 5], more: 2 });
  expect(capRows(rows, true)).toEqual({ shown: rows, more: 0 });
  expect(capRows([1, 2], false)).toEqual({ shown: [1, 2], more: 0 });
});

it("quietLabel: minutes floor, hours past 60", () => {
  expect([quietLabel(6 * min), quietLabel(6 * min + 59_000), quietLabel(63 * min)]).toEqual(["quiet 6m", "quiet 6m", "quiet 1h 3m"]);
});

it("focusSubtitle: blocking sessions, to review, working; zero parts left out; nothing", () => {
  const row = (kind: string, sessionId: string) => ({ id: `${kind}:${sessionId}`, kind, sessionId, since: 0, reason: "", action: "open" }) as never;
  const rows = [row("permission", "a"), row("question", "a"), row("escalated", "b"), row("permission", "c"), row("error", "d"), row("finished", "e")];
  expect(focusSubtitle(rows, 2)).toBe("3 need you · 2 to review · 2 working");
  expect(focusSubtitle([row("permission", "a")], 0)).toBe("1 needs you");
  expect(focusSubtitle([], 0)).toBe("Nothing needs you");
  expect(focusSubtitle([], 3)).toBe("3 working");
});

it("request rows keep oldest first; session rows of one kind newest first", () => {
  const list = [item("a", { lastActivity: 1 }), item("b", { lastActivity: 9 }), item("c"), item("d")];
  const fin = (extra: Part[] = []) => view([user, state("running"), ...extra, state("idle")]);
  const rows = attentionRows(input(list, { a: fin(), b: fin(), c: view([perm("c1", { at: 20 })]), d: view([perm("d1", { at: 10 })]) }, { unread: ["a", "b"], now: 100 }));
  expect(rows.map((r) => r.sessionId)).toEqual(["d", "c", "b", "a"]);
});

it("badge: blockingCount counts sessions with blocking rows only and equals waitingCount", () => {
  const list = [item("a"), item("b"), item("e"), item("l"), item("s"), item("f")];
  const views = {
    a: view([perm("a1", { at: 1 }), perm("a2", { at: 2 })]),
    b: view([perm("b1", { escalated: true, at: 3 })]),
    e: view([user, state("running"), state("error")]),
    l: view([{ type: "auto_continue", id: "auto_continue", at: NOW + 1 }]),
    s: view([user, state("running")]),
    f: view([user, state("running"), state("idle")]),
  };
  const i = input(list, views, { unread: ["e", "f"], activity: { s: NOW - 9 * min } });
  const rows = attentionRows(i);
  expect(rows.map((r) => r.kind).sort()).toEqual(["error", "escalated", "limit", "permission", "permission", "stuck", "finished"].sort());
  expect(blockingCount(rows)).toBe(2);
  expect(blockingCount(rows)).toBe(waitingCount(i.waiting));
});

const bg = (extra: Part[] = []) => view([user, state("running"), ...extra, state("idle", true)]);

it("idle with a background task: the working row keeps the task list's now line and k of n (rowTodos)", () => {
  const v = bg([todos(["a", "completed"], ["b", "in_progress", "doing b"], ["c", "pending"])]);
  expect(v.todos).toEqual([]);
  expect(rowTodos(v)).toHaveLength(3);
  const i = input([item("a", { state: "idle" })], { a: v }, { activity: { a: NOW - 1000 } });
  expect(workingRows(i, attentionRows(i)).map((w) => [w.now, w.progress])).toEqual([["doing b", "2 of 3"]]);
  expect(nowLine(v)).toBe("doing b");
});

it("stuck: an idle session with a background task is not quiet; a terminal CLI turn is", () => {
  const list = [item("a", { state: "idle" })];
  expect(attentionRows(input(list, { a: bg() }, { activity: { a: NOW - 10 * min } }))).toEqual([]);
  const ext = view([user, { type: "external_turn", id: "external_turn", running: true }]);
  expect(attentionRows(input(list, { a: ext }, { activity: { a: NOW - 10 * min } })).map((r) => r.kind)).toEqual(["stuck"]);
});

it("an error reason drops a leading Error: prefix", () => {
  const raw: Part = { type: "raw", id: "raw", message: { error: "Error: boom" } };
  const [r] = attentionRows(input([item("a")], { a: view([user, raw, state("running"), state("error")]) }, { unread: ["a"] }));
  expect(r!.reason).toBe("Check the error: boom");
});

it("waitingRequests and attentionRows give the requests in the same order", () => {
  const list = [item("a"), item("b"), item("c"), item("d")];
  const views = { a: view([perm("pa", { at: 1 })]), b: view([perm("pb", { at: 2, escalated: true })]), c: view([ask("qc", { at: 0 })]), d: view([perm("pd", { at: 3 })]) };
  const i = input(list, views);
  expect(i.waiting.map((w) => w.part.id)).toEqual(["pb", "pa", "pd", "qc"]);
  expect(attentionRows(i).map((r) => r.id)).toEqual(i.waiting.map((w) => w.part.id));
  expect(nextWaiting(i.waiting, "pb")?.part.id).toBe("pa");
});

it("an Aside's request is listed as 'Aside: title' through its synthetic list item", () => {
  const info = { id: "as1", state: "needs_input", model: "default", permissionMode: "default", effort: "default", permissionModes: [], cwd: "/p" } as never;
  const a = { id: "as1", ownerId: "o", title: "why?", from: "p", minimized: false, readOnly: true };
  const list = [item("o"), asideItem(a, info)];
  const w = waitingRequests(list, { as1: view([perm("p1", { at: 1 })]) }, none, 5);
  expect(w.map((x) => x.sessionId)).toEqual(["as1"]);
  expect(list[1]!.title).toBe("Aside: why?");
  expect(waitingCount(w)).toBe(1);
});

// ---- GH-305: worker rows nest under their coordinator ----
const r = (sessionId: string, tag = sessionId) => ({ sessionId, tag });
const tags = (g: { own: { tag: string }[]; workers: { tag: string }[] }) => [g.own.map((x) => x.tag), g.workers.map((x) => x.tag)];

it("nestRows: a worker's row goes under its coordinator; the group sits where its first row is, so the kind order holds", () => {
  const list = [item("c", { coordinatorId: undefined }), item("w1", { coordinatorId: "c", workerName: "one" }), item("x")];
  const groups = nestRows([r("w1"), r("x"), r("c")], list);
  expect(groups.map((g) => [g.root, ...tags(g)])).toEqual([["c", ["c"], ["w1"]], ["x", ["x"], []]]);
});

it("nestRows: a coordinator without its own row gets a group with no own rows; a depth-2 worker goes to the root coordinator", () => {
  const list = [item("c"), item("w1", { coordinatorId: "c" }), item("w2", { coordinatorId: "w1" })];
  const [g, ...more] = nestRows([r("w2"), r("w1")], list);
  expect(more).toEqual([]);
  expect([g!.root, ...tags(g!)]).toEqual(["c", [], ["w2", "w1"]]);
});

it("nestRows: rows of closed workers are dropped; closed coordinators and other sessions stay", () => {
  const list = [item("c", { state: "closed" }), item("w1", { coordinatorId: "c", state: "closed" }), item("w2", { coordinatorId: "c" })];
  expect(nestRows([r("w1"), r("w2"), r("c")], list).map((g) => [g.root, ...tags(g)])).toEqual([["c", ["c"], ["w2"]]]);
});

it("nestRows: several own rows of a coordinator stay together as its own rows", () => {
  const list = [item("c"), item("w1", { coordinatorId: "c" })];
  const [g] = nestRows([r("c", "q1"), r("w1"), r("c", "q2")], list);
  expect(tags(g!)).toEqual([["q1", "q2"], ["w1"]]);
});

it("nestRows: a worker whose coordinator is archived (not in the list) stays a plain row", () => {
  const list = [item("c", { archived: true }), item("w1", { coordinatorId: "c" })];
  expect(nestRows([r("w1")], list).map((g) => [g.root, ...tags(g)])).toEqual([["w1", ["w1"], []]]);
});

afterEach(() => vi.unstubAllGlobals());
const store = (data: Record<string, string>) => vi.stubGlobal("localStorage", { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) });

it("the collapsed groups load as a set; bad or blocked storage means none collapsed; save keeps only listed coordinators", () => {
  expect(loadFocusCollapsed().size).toBe(0);
  store({ "claude-ui.focusCollapsed": "{oops" });
  expect(loadFocusCollapsed().size).toBe(0);
  const data: Record<string, string> = { "claude-ui.focusCollapsed": '["a",3,"b"]' };
  store(data);
  expect([...loadFocusCollapsed()]).toEqual(["a", "b"]);
  saveFocusCollapsed(new Set(["a", "b"]), [item("a")]);
  expect(JSON.parse(data["claude-ui.focusCollapsed"]!)).toEqual(["a"]);
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(loadFocusCollapsed().size).toBe(0);
  expect(() => saveFocusCollapsed(new Set(["a"]), [item("a")])).not.toThrow();
});
