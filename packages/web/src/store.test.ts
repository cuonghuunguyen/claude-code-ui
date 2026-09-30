import { describe, expect, it } from "vitest";
import type { Event, Part } from "@claude-ui/protocol";
import { applyEvent, emptySession, withEpoch, type SessionView } from "./store.ts";

const ev = (seq: number, part: Part): Event => ({ type: "event", sessionId: "s", seq, part });
const text = (id: string, t: string, streaming = true): Part => ({ type: "assistant_text", id, text: t, streaming });

describe("applyEvent", () => {
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
});

describe("withEpoch", () => {
  const filled = (): SessionView => ({ ...[ev(1, text("a", "x")), ev(2, text("b", "y"))].reduce(applyEvent, emptySession()), logEpoch: "e1" });

  it("keeps the view for the same epoch", () => {
    const s = filled();
    expect(withEpoch(s, "e1")).toBe(s);
  });

  it("clears the view on a new epoch so the full replay from seq 1 applies", () => {
    let s = withEpoch(filled(), "e2");
    expect(s).toMatchObject({ logEpoch: "e2", lastSeq: 0, order: [] });
    s = applyEvent(s, ev(1, text("h", "history")));
    expect(s.order).toEqual(["h"]);
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
