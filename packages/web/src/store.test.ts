import { describe, expect, it } from "vitest";
import type { Event, Part } from "@claude-ui/protocol";
import { applyEvent, emptySession, hitKey, partOf, shownState, wholeParts, withEdits, withPage, withSubscribe, type SessionView } from "./store.ts";
import type { SessionInfo, Snapshot } from "@claude-ui/protocol";

const ev = (seq: number, part: Part): Event => ({ type: "event", sessionId: "s", seq, part });
const text = (id: string, t: string, streaming = true): Part => ({ type: "assistant_text", id, text: t, streaming });

describe("applyEvent", () => {
  it("a rewind part drops the rewound user message and every part after it, and is not rendered", () => {
    let s = emptySession();
    s = applyEvent(s, ev(1, { type: "user_text", id: "u1", text: "one", images: [] }));
    s = applyEvent(s, ev(2, text("a", "x", false)));
    s = applyEvent(s, ev(3, { type: "user_text", id: "u2", text: "two", images: [] }));
    s = applyEvent(s, ev(4, text("b", "y", false)));
    s = applyEvent(s, ev(5, { type: "rewind", id: "r", userMessageId: "u2" }));
    expect(s.order).toEqual(["u1", "a"]);
    expect([...s.parts.keys()]).toEqual(["u1", "a"]);
    expect(s.lastSeq).toBe(5);
  });

  it("a retract part removes the named parts (refusal fallback) and is not rendered", () => {
    let s = emptySession();
    s = applyEvent(s, ev(1, { type: "user_text", id: "u1", text: "one", images: [] }));
    s = applyEvent(s, ev(2, text("a", "refused", false)));
    s = applyEvent(s, ev(3, { type: "retract", id: "f:retract", partIds: ["a", "unknown"] }));
    s = applyEvent(s, ev(4, text("b", "answer", false)));
    expect(s.order).toEqual(["u1", "b"]);
    expect([...s.parts.keys()]).toEqual(["u1", "b"]);
  });

  it("an external_turn part sets whether a terminal CLI turn runs", () => {
    const s = applyEvent(emptySession(), ev(1, { type: "external_turn", id: "external_turn", running: true }));
    expect(s.externalTurn).toBe(true);
    expect(s.order).toEqual([]);
    expect(applyEvent(s, ev(2, { type: "external_turn", id: "external_turn", running: false })).externalTurn).toBe(false);
  });

  it("auto_continue sets and clears continueAt and adds no timeline item", () => {
    const s = applyEvent(emptySession(), ev(1, { type: "auto_continue", id: "auto_continue", at: 5000 }));
    expect(s.continueAt).toBe(5000);
    expect(s.order).toEqual([]);
    expect(applyEvent(s, ev(2, { type: "auto_continue", id: "auto_continue", at: null })).continueAt).toBeUndefined();
  });

  it("tabs, sidebar and header show an idle session running while a terminal CLI turn runs", () => {
    const s = applyEvent(emptySession(), ev(1, { type: "external_turn", id: "external_turn", running: true }));
    expect(shownState(s)).toBe("running");
    expect(shownState({ ...s, state: "error" })).toBe("error");
    expect(shownState(applyEvent(s, ev(2, { type: "external_turn", id: "external_turn", running: false })))).toBe("idle");
    expect(shownState(undefined)).toBeUndefined();
  });

  it("a session_cleared part adds no timeline item", () => {
    const s = applyEvent(emptySession(), ev(1, { type: "session_cleared", id: "c1", sessionId: "next" }));
    expect([s.order, s.lastSeq]).toEqual([[], 1]);
  });

  it("replaces a part with the same id instead of appending", () => {
    let s = emptySession();
    s = applyEvent(s, ev(1, text("a", "Hel")));
    s = applyEvent(s, ev(2, text("a", "Hello")));
    s = applyEvent(s, ev(3, text("a", "Hello world", false)));
    expect(s.order).toEqual(["a"]);
    expect(s.parts.get("a")).toEqual(text("a", "Hello world", false));
  });

  it("keeps first-appearance order across parts", () => {
    let s = emptySession();
    s = applyEvent(s, ev(1, text("a", "x")));
    s = applyEvent(s, ev(2, text("b", "y")));
    s = applyEvent(s, ev(3, text("a", "xx")));
    expect(s.order).toEqual(["a", "b"]);
  });

  it("drops events with seq <= last applied", () => {
    let s = emptySession();
    s = applyEvent(s, ev(1, text("a", "new")));
    const same = applyEvent(s, ev(1, text("a", "stale")));
    expect(same).toBe(s);
    expect(s.lastSeq).toBe(1);
  });

  it("applies an overlapping replay after reconnect without duplicates", () => {
    const log = [ev(1, text("a", "He")), ev(2, text("a", "Hello", false)), ev(3, text("b", "x")), ev(4, text("b", "xy", false))];
    let s = log.slice(0, 3).reduce(applyEvent, emptySession());
    s = log.slice(1).reduce(applyEvent, s); // replay from an older sinceSeq
    expect(s.order).toEqual(["a", "b"]);
    expect(s.parts.get("b")).toEqual(text("b", "xy", false));
    expect(s.lastSeq).toBe(4);
  });

  it("restores the state badge from replayed session_state events alone", () => {
    const state = (seq: number, st: "running" | "idle"): Event => ev(seq, { type: "session_state", id: "session_state", state: st });
    const s = [state(1, "running"), ev(2, text("a", "x")), state(3, "idle"), state(4, "running")].reduce(applyEvent, emptySession());
    expect(s.state).toBe("running");
    expect(s.order).toEqual(["a"]);
  });

  it("tracks the current model from session_model parts without adding them to the timeline", () => {
    const s = applyEvent(emptySession(), ev(1, { type: "session_model", id: "session_model", model: "haiku" }));
    expect(s.model).toBe("haiku");
    expect(s.order).toEqual([]);
  });

  it("tracks permission mode and effort without adding them to the timeline", () => {
    const s = [
      ev(1, { type: "session_permission_mode", id: "session_permission_mode", mode: "plan" }),
      ev(2, { type: "session_effort", id: "session_effort", effort: "high" }),
    ].reduce(applyEvent, emptySession());
    expect(s).toMatchObject({ permissionMode: "plan", effort: "high", order: [] });
  });
});

describe("withSubscribe", () => {
  const filled = (): SessionView => ({ ...[ev(1, text("a", "x")), ev(2, text("b", "y"))].reduce(applyEvent, emptySession()), logEpoch: "e1" });
  const info: SessionInfo = { id: "s", cwd: "/", state: "idle", model: "sonnet", permissionMode: "acceptEdits", effort: "high", permissionModes: [] };

  it("keeps the timeline for the same epoch", () => {
    const s = filled();
    expect(withSubscribe(s, { logEpoch: "e1", seq: 2, session: info })).toMatchObject({ order: s.order, lastSeq: 2 });
  });

  it("clears the view on a new epoch so the full replay from seq 1 applies", () => {
    let s = withSubscribe(filled(), { logEpoch: "e2", seq: 0, session: info });
    expect(s).toMatchObject({ logEpoch: "e2", lastSeq: 0, order: [] });
    s = applyEvent(s, ev(1, text("h", "history")));
    expect(s.order).toEqual(["h"]);
  });

  it("the reply's model, mode and effort win over older changes the replay brings; later changes apply", () => {
    let s = withSubscribe(emptySession(), { logEpoch: "e1", seq: 3, session: info });
    s = applyEvent(s, ev(1, { type: "session_permission_mode", id: "session_permission_mode", mode: "plan" }));
    s = applyEvent(s, ev(2, { type: "session_model", id: "session_model", model: "haiku" }));
    s = applyEvent(s, ev(3, { type: "session_effort", id: "session_effort", effort: "low" }));
    expect(s).toMatchObject({ model: "sonnet", permissionMode: "acceptEdits", effort: "high", lastSeq: 3 });
    s = applyEvent(s, ev(4, { type: "session_permission_mode", id: "session_permission_mode", mode: "default" }));
    expect(s.permissionMode).toBe("default");
  });
});

describe("applyEvent commands", () => {
  it("keeps the latest commands list outside the timeline", () => {
    const cmd = { name: "review", description: "d", argumentHint: "" };
    let s = applyEvent(emptySession(), ev(1, { type: "commands", id: "commands", commands: [cmd] }));
    s = applyEvent(s, ev(2, { type: "commands", id: "commands", commands: [] }));
    expect(s.commands).toEqual([]);
    expect(s.order).toEqual([]);
  });
});

describe("applyEvent todo_update", () => {
  it("keeps the latest todo list outside the timeline", () => {
    const todo = (id: string, status: "pending" | "completed"): Event =>
      ev(Number(id), { type: "todo_update", id: `${id}:todos`, items: [{ content: "Fix", status }] });
    const s = [todo("1", "pending"), todo("2", "completed")].reduce(applyEvent, emptySession());
    expect(s.todos).toEqual([{ content: "Fix", status: "completed" }]);
    expect(s.order).toEqual([]);
  });

  it("clears the list when the session stops being live or rewinds, so a later turn without TodoWrite shows no stale list", () => {
    const items = [{ content: "Fix", status: "in_progress" as const }];
    const open = [ev(1, { type: "session_state", id: "st", state: "running" }), ev(2, { type: "todo_update", id: "t:todos", items })];
    for (const state of ["idle", "error"] as const) {
      const s = [...open, ev(3, { type: "session_state", id: "st", state }), ev(4, { type: "session_state", id: "st", state: "running" })].reduce(applyEvent, emptySession());
      expect(s.todos).toEqual([]);
    }
    // needs_input keeps the list (still live).
    expect([...open, ev(3, { type: "session_state", id: "st", state: "needs_input" })].reduce(applyEvent, emptySession()).todos).toEqual(items);
    const user = ev(3, { type: "user_message", id: "u1", text: "hi" } as never);
    expect([...open, user, ev(4, { type: "rewind", id: "rw", userMessageId: "u1" } as never)].reduce(applyEvent, emptySession()).todos).toEqual([]);
  });
});

describe("hitKey", () => {
  const part = (p: Part): { kind: "part"; part: Part } => ({ kind: "part", part: p });
  const items = [
    part({ type: "user_text", id: "U1", text: "hello", images: [] }),
    part({ type: "assistant_text", id: "M1:0", text: "first", streaming: false }),
    part({ type: "assistant_text", id: "M1:2", text: "has the Needle", streaming: false }),
  ];
  it("a prompt by its uuid, an answer by its message id (the block with the query), undefined until loaded", () => {
    expect(hitKey(items, { messageId: "U1", role: "user", snippet: "" }, "hello")).toBe("U1");
    expect(hitKey(items, { messageId: "M1", role: "assistant", snippet: "" }, "needle")).toBe("M1:2");
    expect(hitKey(items, { messageId: "M1", role: "assistant", snippet: "" }, "zzz")).toBe("M1:0");
    expect(hitKey(items, { messageId: "M9", role: "assistant", snippet: "" }, "x")).toBeUndefined();
    expect(hitKey([], { messageId: "U1", role: "user", snippet: "" }, "x")).toBeUndefined();
  });
});

describe("applyEvent background work (session_state working)", () => {
  const st = (seq: number, state: "idle" | "running", working = false): Event =>
    ev(seq, { type: "session_state", id: "session_state", state, ...(working ? { working: true as const } : {}) });

  it("tabs, sidebar and header show an idle session running while its background work runs; the prompt box state stays idle", () => {
    let s = applyEvent(emptySession(), st(1, "idle", true));
    expect(shownState(s)).toBe("running");
    expect(s.state).toBe("idle");
    s = applyEvent(s, st(2, "idle"));
    expect(shownState(s)).toBe("idle");
  });

  it("a turn that ends while background work runs marks no finish until the work ended", () => {
    let s = applyEvent(emptySession(), st(1, "running"));
    s = applyEvent(s, st(2, "idle", true));
    expect(s.attentionSeq).toBe(0);
    s = applyEvent(s, st(3, "running"));
    s = applyEvent(s, st(4, "idle"));
    expect(s.attentionSeq).toBe(4);
  });
});

describe("paging", () => {
  const info: SessionInfo = { id: "s", cwd: "/", state: "idle", model: "sonnet", permissionMode: "acceptEdits", effort: "high", permissionModes: [] };
  const user = (id: string): Part => ({ type: "user_text", id, text: id, images: [] });
  const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
    heads: [],
    attentionSeq: 0,
    page: { parts: [user("u9"), text("a9", "x", false)], older: { before: "u9", pos: 90 } },
    aux: [],
    ...over,
  });
  const loaded = (over: Partial<Snapshot> = {}) => withSubscribe(emptySession(), { logEpoch: "e1", seq: 100, session: info, snapshot: snap(over) });

  it("a snapshot replaces the view: heads fold into state, todos, commands, context usage; parts and order from the page; attentionSeq from the daemon", () => {
    const heads: Event[] = [
      ev(20, { type: "commands", id: "commands", commands: [{ name: "x", description: "", argumentHint: "" }] }),
      ev(30, { type: "todo_update", id: "t:todos", items: [{ content: "do", status: "pending" }] }),
      ev(40, { type: "context_usage", id: "context_usage", usage: { totalTokens: 1, maxTokens: 2, percentage: 50, categories: [] } }),
      ev(95, { type: "session_state", id: "session_state", state: "running" }),
    ];
    const s = loaded({ heads, attentionSeq: 77 });
    expect(s).toMatchObject({ logEpoch: "e1", lastSeq: 100, settingsSeq: 100, state: "running", attentionSeq: 77, model: "sonnet", order: ["u9", "a9"], older: { before: "u9", pos: 90 } });
    expect(s.todos).toHaveLength(1);
    expect(s.commands).toHaveLength(1);
    expect(s.contextUsage?.percentage).toBe(50);
    // Always a full replace, also for the same epoch.
    expect(withSubscribe({ ...s, order: ["zzz"] }, { logEpoch: "e1", seq: 100, session: info, snapshot: snap() }).order).toEqual(["u9", "a9"]);
  });

  it("withPage prepends an older page, sets the next cursor and drops aux parts it now holds; a reply for another cursor is ignored", () => {
    const run: Part = { type: "subagent", id: "r1", toolUseId: "r1", description: "d", status: "done", startedAt: 1 };
    const run0: Part = { ...run, id: "r0", toolUseId: "r0" };
    const s = loaded({ aux: [{ part: run0, pos: 5 }, { part: run, pos: 60 }] });
    const page = { parts: [user("u5"), run, user("u8")], older: { before: "u5", pos: 40 } };
    expect(withPage(s, "other", page)).toBe(s);
    const next = withPage(s, "u9", page);
    expect(next.order).toEqual(["u5", "r1", "u8", "u9", "a9"]);
    expect(next.older).toEqual({ before: "u5", pos: 40 });
    expect(next.aux.map((a) => a.part.id)).toEqual(["r0"]);
    expect(withPage(next, "u5", { parts: [user("u1")] }).older).toBeUndefined();
    expect(withPage(next, "u5", { parts: [user("u1")] }).aux).toEqual([]);
    // A second reply for the same cursor changes nothing.
    expect(withPage(next, "u9", page)).toBe(next);
  });

  it("an update of a part in the unloaded region adds nothing to the timeline and updates its aux entry", () => {
    const run: Part = { type: "subagent", id: "r1", toolUseId: "r1", description: "d", status: "running", startedAt: 1 };
    let s = loaded({ aux: [{ part: run, pos: 20 }] });
    s = applyEvent(s, { ...ev(101, { ...run, status: "done" } as Part), pos: 20 });
    expect(s.order).toEqual(["u9", "a9"]);
    expect(s.aux[0]!.part).toMatchObject({ status: "done" });
    s = applyEvent(s, { ...ev(102, text("old", "y")), pos: 30 });
    expect(s.order).toEqual(["u9", "a9"]);
    expect(s.lastSeq).toBe(102);
    // An update of a loaded part, and a new part, still apply.
    expect(applyEvent(s, { ...ev(103, text("a9", "more")), pos: 91 }).parts.get("a9")).toMatchObject({ text: "more" });
    expect(applyEvent(s, ev(104, text("new", "z"))).order).toEqual(["u9", "a9", "new"]);
  });

  it("live events applied between the page request and its reply stay (newest part kept, page prepended before it)", () => {
    let s = loaded();
    s = applyEvent(s, ev(101, text("live", "now")));
    s = withPage(s, "u9", { parts: [user("u5")] });
    expect(s.order).toEqual(["u5", "u9", "a9", "live"]);
  });

  it("a rewind of a message the view does not hold empties the view and marks it stale", () => {
    const s = applyEvent(loaded(), ev(101, { type: "rewind", id: "rw", userMessageId: "u3" }));
    expect(s).toMatchObject({ order: [], stale: true, lastSeq: 101 });
    expect(withSubscribe(s, { logEpoch: "e1", seq: 110, session: info, snapshot: snap() }).stale).toBe(false);
    // Not paged: an unknown rewind stays a no-op.
    expect(applyEvent(emptySession(), ev(1, { type: "rewind", id: "rw", userMessageId: "u3" })).stale).toBeUndefined();
  });

  it("withEdits merges edits by pos into aux, once per boundary", () => {
    const edit: Part = { type: "tool_call", id: "e1", toolUseId: "e1", tool: "Edit", input: {}, status: "done" };
    const s = loaded();
    const next = withEdits(s, "u9", [{ part: edit, pos: 12 }]);
    expect(next.auxEdits).toBe(true);
    expect(next.aux.map((a) => a.part.id)).toEqual(["e1"]);
    expect(withEdits(next, "u9", [{ part: edit, pos: 12 }]).aux).toHaveLength(1);
    expect(withEdits(s, "old", [{ part: edit, pos: 12 }])).toBe(s);
    expect(partOf(next, "e1")).toBe(edit);
    expect(wholeParts(next).map((p) => p.id)).toEqual(["e1", "u9", "a9"]);
  });
});

describe("paging, review fixes", () => {
  const run: Part = { type: "subagent", id: "r1", toolUseId: "r1", description: "d", status: "done", startedAt: 1 };
  const paged = (): SessionView => ({ ...emptySession(), lastSeq: 10, older: { before: "u9", pos: 90 }, aux: [{ part: run, pos: 5 }], todos: [{ content: "x", status: "pending" }] });

  it("a retract removes the ids from aux too, as PartIndex does", () => {
    const s = applyEvent(paged(), ev(11, { type: "retract", id: "n:retract", partIds: ["r1"] }));
    expect(s.aux).toEqual([]);
  });

  it("a rewind of an unknown message clears the todo list in an unpaged view too", () => {
    const s = applyEvent({ ...emptySession(), todos: [{ content: "x", status: "pending" }] }, ev(1, { type: "rewind", id: "rw", userMessageId: "nope" }));
    expect(s.todos).toEqual([]);
  });
});
