import { describe, expect, it, vi } from "vitest";
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

  it("strips API key env vars from the SDK env (ADR 0002)", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "tok");
    new Session("/tmp", { query: fakeQuery as never });
    vi.unstubAllEnvs();
    const env = calls.at(-1)!.env!;
    expect(env.PATH).toBe(process.env.PATH);
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("rejects a prompt once the query failed, and logs the failure reason", async () => {
    const failing = () => (async function* () { throw new Error("login expired"); })();
    const s = new Session("/tmp", { query: failing as never });
    const events: Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    await until(events, (e) => e.part.type === "session_state" && e.part.state === "error");
    expect(events.some((e) => e.part.type === "raw" && JSON.stringify(e.part.message).includes("login expired"))).toBe(true);
    expect(() => s.prompt("hello")).toThrow(/not live/);
    expect(s.info().state).toBe("error");
  });
});
