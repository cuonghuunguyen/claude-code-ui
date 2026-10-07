import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event, Part } from "@claude-ui/protocol";
import { createNotifier, createPush, fitPayload, MAX_PAYLOAD_BYTES, osNotify, osNotifyCommand, type Run } from "../src/push.ts";

// File modes are POSIX: on Windows chmod only sets the read-only flag.
const posix = process.platform !== "win32";

let seq = 0;
const ev = (part: Part, sessionId = "s1"): Event => ({ type: "event", sessionId, seq: ++seq, part });
const state = (s: "idle" | "running" | "needs_input" | "error", sessionId = "s1", working = false) =>
  ev({ type: "session_state", id: "session_state", state: s, ...(working ? { working: true as const } : {}) }, sessionId);
const text = (t: string) => ev({ type: "assistant_text", id: "a1", text: t, streaming: false });
const permission = (input: unknown) =>
  ev({ type: "permission_request", id: "r1", requestId: "r1", toolUseId: "t1", tool: "Bash", input, suggestions: [], settled: false });

describe("notifier (same rules as Orca)", () => {
  let pushed: { sessionId: string; body: string }[];
  let replaced: { sessionId: string; body: string }[];
  let watched: Set<string>;
  let n: ReturnType<typeof createNotifier>;
  beforeEach(() => {
    vi.useFakeTimers();
    pushed = [];
    replaced = [];
    watched = new Set();
    n = createNotifier({ push: (sessionId, body) => void pushed.push({ sessionId, body }), suppressed: (id) => watched.has(id), replace: (sessionId, body) => void replaced.push({ sessionId, body }) });
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

  const question = (extra: object = {}) =>
    ev({ type: "question", id: "q", requestId: "q", toolUseId: "t", settled: false, questions: [{ question: "Delete?", header: "D", options: [], multiSelect: false }] as never, ...extra });

  it("an escalated request pushes at once with the reason, past the 5 s gap", () => {
    n.observe(state("running"));
    n.observe(question());
    n.observe(state("needs_input"));
    n.observe(question({ escalated: true, reason: "scope" }));
    expect(pushed.map((p) => p.body)).toEqual(["Needs input · Delete?", "Needs input · Escalated by coordinator: scope · Delete?"]);
  });

  it("the escalation push cuts a long reason so the question stays visible", () => {
    n.observe(state("running"));
    n.observe(question({ escalated: true, reason: "r".repeat(1000) }));
    n.observe(state("needs_input"));
    expect(pushed[0]!.body).toMatch(/^Needs input · Escalated by coordinator: r{199}… · Delete\?$/);
  });

  it("an escalated push is suppressed only by a focused tab of that session", () => {
    n.observe(state("running"));
    n.observe(question());
    watched.add("other");
    n.observe(question({ escalated: true, reason: "scope" }));
    expect(pushed).toHaveLength(1);
    watched.clear();
    watched.add("s1");
    n.observe(question({ escalated: true, reason: "scope" }));
    expect(pushed).toHaveLength(1);
  });

  it("a settled escalated request replaces its notification at once, silently, also while its tab is focused", () => {
    n.observe(state("running"));
    n.observe(question({ escalated: true, reason: "scope" }));
    expect(pushed).toHaveLength(1);
    expect(replaced).toEqual([]);
    watched.add("s1");
    n.observe(question({ escalated: true, reason: "scope", settled: true }));
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.sessionId).toBe("s1");
    expect(replaced[0]!.body).toMatch(/^No longer needs input · /);
    // The same request settling again (a repeated event) replaces nothing more.
    n.observe(question({ escalated: true, reason: "scope", settled: true }));
    expect(replaced).toHaveLength(1);
  });

  it("a settled escalated permission request names its decision", () => {
    n.observe(state("running"));
    n.observe(ev({ type: "permission_request", id: "r1", requestId: "r1", toolUseId: "t1", tool: "Bash", input: { command: "npm view react" }, suggestions: [], settled: false, escalated: true, reason: "net" }));
    n.observe(ev({ type: "permission_request", id: "r1", requestId: "r1", toolUseId: "t1", tool: "Bash", input: { command: "npm view react" }, suggestions: [], settled: true, escalated: true, decision: "deny" }));
    expect(replaced.map((r) => r.body)).toEqual(["No longer needs input · deny · Bash: npm view react"]);
  });

  it("a settled request that was never escalated replaces nothing", () => {
    n.observe(state("running"));
    n.observe(question());
    n.observe(state("needs_input"));
    n.observe(question({ settled: true }));
    expect(replaced).toEqual([]);
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

  it("no finished while background work runs; finished after the last notification turn", () => {
    n.observe(state("running"));
    n.observe(text("Started the sweep."));
    n.observe(state("idle", "s1", true));
    vi.advanceTimersByTime(5000);
    expect(pushed).toEqual([]);
    n.observe(state("running"));
    n.observe(text("Sweep done.\nAll green."));
    n.observe(state("idle"));
    vi.advanceTimersByTime(1500);
    expect(pushed).toEqual([{ sessionId: "s1", body: "All green." }]);
  });

  it("an error while background work runs still counts as finished", () => {
    n.observe(state("running"));
    n.observe(state("error"));
    vi.advanceTimersByTime(1500);
    expect(pushed).toHaveLength(1);
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

describe("notifier: workers of one coordinator blocked on the same request (GH-163)", () => {
  type P = { sessionId: string; body: string; tag?: string; silent?: boolean; replace?: boolean; titleSession?: string };
  let pushed: P[];
  let n: ReturnType<typeof createNotifier>;
  const group = (id: string) => ({ w1: "c1", w2: "c1", w3: "c1", w4: "c2" })[id];
  beforeEach(() => {
    vi.useFakeTimers();
    pushed = [];
    n = createNotifier({
      push: (sessionId, body, extra) => void pushed.push({ sessionId, body, ...extra }),
      replace: (sessionId, body, tag) => void pushed.push({ sessionId, body, tag, silent: true, replace: true }),
      suppressed: () => false,
      group,
    });
  });
  afterEach(() => vi.useRealTimers());

  const read = (path: string, requestId: string, extra: object = {}) =>
    ({ type: "permission_request", id: requestId, requestId, toolUseId: `t-${requestId}`, tool: "Read", input: { file_path: path }, suggestions: [], settled: false, ...extra }) as Part;
  const block = (sid: string, path = "/main/.claude/skills/implement-issue/SKILL.md", requestId = `r-${sid}`) => {
    n.observe(state("running", sid));
    n.observe(ev(read(path, requestId), sid));
    n.observe(state("needs_input", sid));
  };
  const unblock = (sid: string, path = "/main/.claude/skills/implement-issue/SKILL.md", requestId = `r-${sid}`) => {
    n.observe(ev(read(path, requestId, { settled: true, decision: "allow" }), sid));
    n.observe(state("running", sid));
  };

  it("three workers of one coordinator blocked on the same Read push one tag; the bodies count 1, 2, 3", () => {
    block("w1");
    block("w2");
    block("w3");
    expect(pushed.map((p) => p.body)).toEqual([
      "Needs input · Read: /main/.claude/skills/implement-issue/SKILL.md",
      "2 workers need input · Read: …/implement-issue/SKILL.md",
      "3 workers need input · Read: …/implement-issue/SKILL.md",
    ]);
    expect(new Set(pushed.map((p) => p.tag)).size).toBe(1);
    expect(pushed[0]!.tag).toMatch(/^req-[0-9a-f]{16}$/);
    // The first shows (also as a desktop toast); the updates only replace it, silently.
    expect(pushed.map((p) => [p.silent ?? false, p.replace ?? false])).toEqual([[false, false], [true, true], [true, true]]);
    // The notification carries the coordinator's title and opens the newest worker.
    expect(pushed.map((p) => p.titleSession)).toEqual(["c1", "c1", "c1"]);
    expect(pushed.map((p) => p.sessionId)).toEqual(["w1", "w2", "w3"]);
  });

  it("workers of different coordinators, or different requests, are not grouped", () => {
    block("w1");
    block("w4");
    block("w2", "/main/docs/spec.md");
    expect(pushed.map((p) => p.body)).toEqual(["Needs input · Read: /main/.claude/skills/implement-issue/SKILL.md", "Needs input · Read: /main/.claude/skills/implement-issue/SKILL.md", "Needs input · Read: /main/docs/spec.md"]);
    expect(new Set(pushed.map((p) => p.tag)).size).toBe(3);
  });

  it("a worker leaving the group updates the count; the last one replaces it with No longer needs input", () => {
    block("w1");
    block("w2");
    block("w3");
    pushed.length = 0;
    unblock("w2");
    expect(pushed.map((p) => [p.body, p.replace])).toEqual([["2 workers need input · Read: …/implement-issue/SKILL.md", true]]);
    unblock("w1");
    expect(pushed.at(-1)!.body).toBe("Needs input · Read: /main/.claude/skills/implement-issue/SKILL.md");
    unblock("w3");
    expect(pushed.at(-1)).toMatchObject({ replace: true, silent: true });
    expect(pushed.at(-1)!.body).toMatch(/^No longer needs input · /);
    // Gone: nothing more for a repeated settle, and a new block starts over at 1.
    const count = pushed.length;
    unblock("w3");
    expect(pushed).toHaveLength(count);
    vi.advanceTimersByTime(6000);
    block("w1", undefined, "r-again");
    expect(pushed.at(-1)!.body).toMatch(/^Needs input · /);
    expect(pushed.at(-1)!.replace).toBeUndefined();
  });

  it("an escalated request of a grouped worker keeps the group tag and replaces on settle", () => {
    block("w1");
    block("w2");
    n.observe(ev(read("/main/.claude/skills/implement-issue/SKILL.md", "r-w2", { escalated: true, reason: "blocked" }), "w2"));
    expect(pushed.at(-1)!.body).toMatch(/^2 workers need input/);
    unblock("w2");
    unblock("w1");
    expect(pushed.at(-1)!.body).toMatch(/^No longer needs input/);
    expect(new Set(pushed.map((p) => p.tag)).size).toBe(1);
  });

  it("non-worker sessions keep sessionId tags and push as before", () => {
    n.observe(state("running", "plain"));
    n.observe(ev(read("/x/y.ts", "r1"), "plain"));
    n.observe(state("needs_input", "plain"));
    expect(pushed).toEqual([{ sessionId: "plain", body: "Needs input · Read: /x/y.ts" }]);
  });
});

describe("createPush", () => {
  const sub = (endpoint = "https://push.example/abc") => ({ endpoint, keys: { p256dh: "p", auth: "a" } });

  it("generates VAPID keys once, owner-only, and reuses them", () => {
    const dir = mkdtempSync(join(tmpdir(), "push-"));
    const a = createPush({ dir });
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    if (posix) expect(statSync(join(dir, "vapid.json")).mode & 0o777).toBe(0o600);
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
    if (posix) expect(statSync(join(dir, "push-subscriptions.json")).mode & 0o777).toBe(0o600);
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

describe("desktop notification", () => {
  const evil = `a "q" 'single' ’curly’ ‘ $(touch /tmp/pwn) \`id\` %PATH% ; | & '@ "@\n- line2 <b>&amp;\u0007`;
  const fakeRun = (calls: [string, string[], object][], err?: Error): Run => (f, a, o, cb) => (calls.push([f, a, o]), cb(err ?? null));
  const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };
  const mk = () => ({ dir: mkdtempSync(join(tmpdir(), "push-")), send: vi.fn(async () => ({})) as never });
  const pl = { sessionId: "s1", title: "My session", body: "Needs input · Bash: ls" };

  it("no subscription: send runs the command once with title and body as separate arguments", async () => {
    const calls: [string, string[], object][] = [];
    const m = mk();
    await createPush({ ...m, notify: (p) => osNotify(p, "linux", fakeRun(calls)) }).send(pl);
    expect(calls).toEqual([["notify-send", ["--app-name=claude-ui", "--", "My session", "Needs input · Bash: ls"], { timeout: 10_000, windowsHide: true }]]);
    expect(m.send).not.toHaveBeenCalled();
    expect(calls[0]![2]).not.toHaveProperty("shell");
  });

  it("a subscription: web push only, no desktop notification", async () => {
    const calls: [string, string[], object][] = [];
    const m = mk();
    const p = createPush({ ...m, notify: (x) => osNotify(x, "linux", fakeRun(calls)) });
    p.subscribe(sub);
    await p.send(pl);
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });

  it("createPush: a replace payload with no subscription shows no desktop notification", async () => {
    const calls: [string, string[], object][] = [];
    await createPush({ ...mk(), notify: (x) => osNotify(x, "linux", fakeRun(calls)) }).send({ ...pl, silent: true, replace: true });
    expect(calls).toEqual([]);
  });

  it("notify false (--no-os-notify): nothing runs", async () => {
    await expect(createPush({ ...mk(), notify: false }).send(pl)).resolves.toBeUndefined();
  });

  it("linux: text is literal argv after --", () => {
    expect(osNotifyCommand({ title: "-x", body: evil }, "linux")).toEqual(["notify-send", ["--app-name=claude-ui", "--", "-x", evil]]);
  });

  it("macOS: text is on run argv arguments after --, the script is constant", () => {
    expect(osNotifyCommand({ title: "-x", body: evil }, "darwin")).toEqual(["osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", "--", "-x", evil]]);
  });

  it("Windows: XML-escaped text, base64 inside a constant -EncodedCommand script", () => {
    const parts = (t: string, b: string) => {
      const [file, args] = osNotifyCommand({ title: t, body: b }, "win32");
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
      const b64 = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(script)![1]!;
      return { file, head: args.slice(0, -1), script, b64, xml: Buffer.from(b64, "base64").toString("utf8") };
    };
    const r = parts("-x", evil);
    expect(r.file).toBe("powershell.exe");
    expect(r.head).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(r.xml).toBe(
      "<toast><visual><binding template=\"ToastGeneric\"><text>-x</text><text>a &quot;q&quot; &apos;single&apos; ’curly’ ‘ $(touch /tmp/pwn) `id` %PATH% ; | &amp; &apos;@ &quot;@\n- line2 &lt;b&gt;&amp;amp;</text></binding></visual></toast>",
    );
    const e = parts("", "");
    expect(r.script.replace(r.b64, "")).toBe(e.script.replace(e.b64, ""));
  });

  it("long text is clipped; the Windows command line stays under 32767 chars", () => {
    const x = { title: "t".repeat(500), body: '"'.repeat(10_000) };
    const [, a] = osNotifyCommand(x, "linux");
    expect(a[2]).toHaveLength(100);
    expect(a[3]).toHaveLength(500);
    expect(a[3]!.endsWith("…")).toBe(true);
    expect(osNotifyCommand(x, "win32")[1].join(" ").length).toBeLessThan(32_000);
  });

  it("clipping cuts by code point: a surrogate pair is never split", () => {
    const [, a] = osNotifyCommand({ title: "😀".repeat(200), body: "x".repeat(499) + "😀😀" }, "linux");
    expect(a[2]).toBe("😀".repeat(99) + "…");
    expect(a[3]).toBe("x".repeat(499) + "…");
    expect(osNotifyCommand({ title: "t", body: "x".repeat(498) + "😀😀" }, "linux")[1][3]).toBe("x".repeat(498) + "😀😀");
  });

  it("a missing command (ENOENT) logs one line, is not called again, and send still resolves", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: [string, string[], object][] = [];
    const err = Object.assign(new Error(`spawn notify-send ENOENT ${evil}`), { code: "ENOENT" });
    const p = createPush({ ...mk(), notify: (x) => osNotify(x, "linux", fakeRun(calls, err)) });
    await p.send(pl);
    await p.send(pl);
    expect(calls).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain("ENOENT");
    expect(String(spy.mock.calls[0]![0])).not.toContain("touch");
    spy.mockRestore();
  });

  it("another failure logs once but later notifications are still tried", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: [string, string[], object][] = [];
    const p = createPush({ ...mk(), notify: (x) => osNotify(x, "linux", fakeRun(calls, Object.assign(new Error("x"), { code: 1 }))) });
    await p.send(pl);
    await p.send(pl);
    expect(calls).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
