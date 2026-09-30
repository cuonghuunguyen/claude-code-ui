import { describe, expect, it } from "vitest";
import type { Event, Part } from "@claude-ui/protocol";
import { applyEvent, emptySession } from "./store.ts";

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
});
