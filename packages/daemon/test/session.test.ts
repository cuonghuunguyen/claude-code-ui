import { describe, expect, it } from "vitest";
import type { Event } from "@claude-ui/protocol";
import { Session } from "../src/session.ts";
import { calls, fakeQuery } from "./fake-query.ts";

const until = (events: Event[], pred: (e: Event) => boolean) =>
  new Promise<void>((resolve) => {
    const t = setInterval(() => events.some(pred) && (clearInterval(t), resolve()), 5);
  });

describe("Session", () => {
  it("has a UUID before the first prompt and passes it to the SDK as sessionId", () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    expect(s.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.at(-1)).toMatchObject({ sessionId: s.id, cwd: "/tmp", includePartialMessages: true });
  });

  it("logs user_text, running, streamed parts, turn_result, idle with increasing seq", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    s.prompt("hello");
    await until(events, (e) => e.part.type === "session_state" && e.part.state === "idle");

    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.every((e) => e.sessionId === s.id)).toBe(true);
    const types = events.map((e) => e.part.type);
    expect(types.slice(0, 2)).toEqual(["user_text", "session_state"]);
    expect(types.at(-2)).toBe("turn_result");
    expect(types.filter((t) => t === "assistant_text").length).toBeGreaterThan(10);
    expect(s.info().state).toBe("idle");
  });

  it("replays only events after sinceSeq to a late subscriber", async () => {
    const s = new Session("/tmp", { query: fakeQuery as never });
    const all: Event[] = [];
    s.subscribe(0, (e) => all.push(e));
    s.prompt("hello");
    await until(all, (e) => e.part.type === "turn_result");
    const late: Event[] = [];
    s.subscribe(3, (e) => late.push(e));
    expect(late[0]!.seq).toBe(4);
    expect(late.length).toBe(all.length - 3);
  });
});
