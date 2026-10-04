import { describe, expect, it } from "vitest";
import type { Event, Part } from "@claude-ui/protocol";
import { applyEvent, emptySession, withSubscribe, type SessionView } from "./store.ts";
import type { SessionInfo } from "@claude-ui/protocol";

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
