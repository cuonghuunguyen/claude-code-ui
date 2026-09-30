import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Part } from "@claude-ui/protocol";
import { createNotifier, createPush, fitPayload, MAX_PAYLOAD_BYTES } from "../src/push.ts";

let seq = 0;
const ev = (part: Part, sessionId = "s1"): Event => ({ type: "event", sessionId, seq: ++seq, part });
const state = (s: "idle" | "running" | "needs_input" | "error", sessionId = "s1") =>
  ev({ type: "session_state", id: "session_state", state: s }, sessionId);
const text = (t: string) => ev({ type: "assistant_text", id: "a1", text: t, streaming: false });
const permission = (input: unknown) =>
  ev({ type: "permission_request", id: "r1", requestId: "r1", toolUseId: "t1", tool: "Bash", input, suggestions: [], settled: false });

describe("notifier (rules copied from Orca)", () => {
  let pushed: { sessionId: string; body: string }[];
  let watched: Set<string>;
  let n: ReturnType<typeof createNotifier>;
  beforeEach(() => {
    vi.useFakeTimers();
    pushed = [];
    watched = new Set();
    n = createNotifier({ push: (sessionId, body) => void pushed.push({ sessionId, body }), suppressed: (id) => watched.has(id) });
  });
  afterEach(() => vi.useRealTimers());

  it("needs input: pushes at once with the tool and command", () => {
    n.observe(state("running"));
    n.observe(permission({ command: "npm test" }));
    n.observe(state("needs_input"));
    expect(pushed).toEqual([{ sessionId: "s1", body: "Needs input · Bash: npm test" }]);
  });

  it("a question: pushes the question text", () => {
    n.observe(state("running"));
    n.observe(ev({ type: "question", id: "q", requestId: "q", toolUseId: "t", settled: false, questions: [{ question: "Which DB?", header: "DB", options: [], multiSelect: false }] as never }));
    n.observe(state("needs_input"));
    expect(pushed).toEqual([{ sessionId: "s1", body: "Needs input · Which DB?" }]);
  });

  it("finished: waits 1.5 s, then pushes the last line of the answer", () => {
    n.observe(state("running"));
    n.observe(text("Done.\n\nAll tests pass.\n"));
    n.observe(state("idle"));
    vi.advanceTimersByTime(1499);
    expect(pushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(pushed).toEqual([{ sessionId: "s1", body: "All tests pass." }]);
  });

  it("finished is cancelled when work resumes within 1.5 s", () => {
    n.observe(state("running"));
    n.observe(state("idle"));
    vi.advanceTimersByTime(1000);
    n.observe(state("running"));
    vi.advanceTimersByTime(5000);
    expect(pushed).toEqual([]);
  });

  it("an error counts as finished", () => {
    n.observe(state("running"));
    n.observe(ev({ type: "raw", id: "x", message: { error: "Error: boom" } }));
    n.observe(state("error"));
    vi.advanceTimersByTime(1500);
    expect(pushed).toEqual([{ sessionId: "s1", body: "Error · Error: boom" }]);
  });

  it("idle without a running turn before it is not a finish", () => {
    n.observe(state("idle"));
    vi.advanceTimersByTime(2000);
    expect(pushed).toEqual([]);
  });

  it("at most one push per session per 5 s; other sessions are independent", () => {
    n.observe(state("running"));
    n.observe(permission({ command: "a" }));
    n.observe(state("needs_input"));
    n.observe(state("running"));
    n.observe(state("needs_input"));
    n.observe(state("needs_input", "s2"));
    expect(pushed.map((p) => p.sessionId)).toEqual(["s1", "s2"]);
    vi.advanceTimersByTime(5000);
    n.observe(state("needs_input"));
    expect(pushed.map((p) => p.sessionId)).toEqual(["s1", "s2", "s1"]);
  });

  it("suppressed while a focused, visible tab shows the session", () => {
    watched.add("s1");
    n.observe(state("running"));
    n.observe(state("needs_input"));
    expect(pushed).toEqual([]);
    // Suppression does not use up the 5 s budget.
    watched.clear();
    n.observe(state("running"));
    n.observe(state("needs_input"));
    expect(pushed).toHaveLength(1);
  });

  it("the finished body is the answer of the current turn, not the previous one", () => {
    n.observe(text("old answer"));
    n.observe(ev({ type: "user_text", id: "u", text: "next", images: [] }));
    n.observe(state("running"));
    n.observe(state("idle"));
    vi.advanceTimersByTime(1500);
    expect(pushed).toEqual([{ sessionId: "s1", body: "Finished" }]);
  });
});

describe("fitPayload", () => {
  it("keeps the full text when it fits and truncates to ~4 KB otherwise", () => {
    expect(fitPayload({ sessionId: "s", title: "t", body: "short" }).body).toBe("short");
    const big = fitPayload({ sessionId: "s", title: "t".repeat(500), body: "é".repeat(10_000) });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(big.body.endsWith("…")).toBe(true);
  });
});

describe("createPush", () => {
  const sub = (endpoint = "https://push.example/abc") => ({ endpoint, keys: { p256dh: "p", auth: "a" } });

  it("generates VAPID keys once, owner-only, and reuses them", () => {
    const dir = mkdtempSync(join(tmpdir(), "push-"));
    const a = createPush({ dir });
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(statSync(join(dir, "vapid.json")).mode & 0o777).toBe(0o600);
    expect(createPush({ dir }).publicKey).toBe(a.publicKey);
  });

  it("stores subscriptions by endpoint across restarts and rejects malformed ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "push-"));
    const p = createPush({ dir });
    expect(p.subscribe(sub())).toBe(true);
    expect(p.subscribe(sub())).toBe(true);
    expect(p.subscribe({ endpoint: "http://insecure/x", keys: { p256dh: "p", auth: "a" } })).toBe(false);
    expect(p.subscribe({ endpoint: "https://x" })).toBe(false);
    expect(p.subscribe(null)).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "push-subscriptions.json"), "utf8"))).toEqual([sub()]);
    expect(statSync(join(dir, "push-subscriptions.json")).mode & 0o777).toBe(0o600);
  });

  it("sends the encrypted payload to every subscription with VAPID and drops gone ones (404/410)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "push-"));
    const sent: { endpoint: string; payload: string; vapid: unknown }[] = [];
    const send = vi.fn(async (s: { endpoint: string }, payload: string, o: { vapidDetails: unknown }) => {
      sent.push({ endpoint: s.endpoint, payload, vapid: o.vapidDetails });
      if (s.endpoint.endsWith("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      return {};
    });
    const p = createPush({ dir, send: send as never });
    p.subscribe(sub("https://push.example/ok"));
    p.subscribe(sub("https://push.example/gone"));
    await p.send({ sessionId: "s1", title: "My session", body: "Needs input · Bash: ls" });
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.example/ok", "https://push.example/gone"]);
    expect(JSON.parse(sent[0]!.payload)).toEqual({ sessionId: "s1", title: "My session", body: "Needs input · Bash: ls" });
    expect(sent[0]!.vapid).toMatchObject({ publicKey: p.publicKey });
    expect(JSON.parse(readFileSync(join(dir, "push-subscriptions.json"), "utf8"))).toEqual([sub("https://push.example/ok")]);
  });
});
