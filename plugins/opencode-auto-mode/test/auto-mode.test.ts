import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AutoModeModule, { AutoModePlugin, JOB_SLACK_MS } from "../auto-mode.ts";
import { EVAL_CONCURRENCY } from "../eval.ts";
import type { ChatParamsOutput, Hooks, OpencodeClient, PluginInput } from "../types.ts";

// Keep every test's default decision log out of the real OpenCode data dir.
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "auto-mode-xdg-"));

interface FakeClientOptions {
  promptText?: string;
  onPrompt?: (sessionID: string) => Promise<void> | void;
  replyStatus?: number;
  /** Pending asks as the GET /permission listing returns them. */
  pending?: Array<{ id: string; sessionID: string }>;
  listFails?: boolean;
  /** The V2 reply route errors for this reply kind. */
  v2Fails?: "once" | "reject";
}

/** Every ask the test fired, as the default GET /permission listing returns them. */
const asked = new Map<string, string>();

function fakeClient(opts: FakeClientOptions = {}) {
  asked.clear();
  const log: Array<Record<string, unknown>> = [];
  const toasts: Array<Record<string, unknown>> = [];
  const replies: Array<{ id: string; reply: string; message?: string }> = [];
  const deleted: string[] = [];
  const aborted: string[] = [];
  let sessionCounter = 0;

  const client: OpencodeClient = {
    _client: {
      get: vi.fn(async () => (opts.listFails ? { error: "boom" } : { data: opts.pending ?? [...asked].map(([id, sessionID]) => ({ id, sessionID })) })),
      post: vi.fn(async ({ url, path, body }: { url: string; path?: Record<string, unknown>; body?: unknown }) => {
        if (url !== "/permission/{requestID}/reply") throw new Error(`unexpected url ${url}`);
        const b = body as { reply: string; message?: string };
        replies.push({ id: path!.requestID as string, reply: b.reply, message: b.message });
        asked.delete(path!.requestID as string); // answered: no longer pending
        if (opts.replyStatus === 404) return { response: { status: 404 } };
        if (opts.v2Fails === b.reply) return { error: "boom", response: { status: 500 } };
        return { data: true, response: { status: 200 } };
      }),
    },
    session: {
      messages: vi.fn(async () => ({
        data: [{ info: { role: "user" as const, model: { providerID: "anthropic", modelID: "claude" } }, parts: [{ type: "text" as const, text: "do the task" }] }],
      })),
      create: vi.fn(async () => ({ data: { id: `classifier-${++sessionCounter}` } })),
      prompt: vi.fn(async ({ path }: { path: { id: string } }) => {
        if (opts.onPrompt) await opts.onPrompt(path.id);
        return { data: { info: {}, parts: [{ type: "text" as const, text: opts.promptText ?? "" }] } };
      }),
      delete: vi.fn(async ({ path }: { path: { id: string } }) => {
        deleted.push(path.id);
        return {};
      }),
      abort: vi.fn(async ({ path }: { path: { id: string } }) => {
        aborted.push(path.id);
        return {};
      }),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
    app: {
      log: vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
        log.push(body);
        return {};
      }),
    },
    tui: {
      showToast: vi.fn(async ({ body }: { body: Record<string, unknown> }) => {
        toasts.push(body);
        return {};
      }),
    },
  };
  return { client, log, toasts, replies, deleted, aborted };
}

function pluginInput(client: OpencodeClient): PluginInput {
  return { client, directory: "/proj", worktree: "/proj", serverUrl: new URL("http://127.0.0.1:4096") };
}

function askedEvent(overrides: Partial<{ id: string; sessionID: string; permission: string; metadata: Record<string, unknown>; callID: string }> = {}) {
  asked.set(overrides.id ?? "per1", overrides.sessionID ?? "ses1");
  return {
    event: {
      type: "permission.asked",
      properties: {
        id: overrides.id ?? "per1",
        sessionID: overrides.sessionID ?? "ses1",
        permission: overrides.permission ?? "bash",
        patterns: ["*"],
        metadata: overrides.metadata ?? { command: "ls" },
        always: [],
        ...(overrides.callID ? { tool: { messageID: "m1", callID: overrides.callID } } : {}),
      },
    },
  };
}

const extras = (log: Array<Record<string, unknown>>) => log.map((l) => l.extra as { verdict: string; outcome?: string });
const paramsOut = (): ChatParamsOutput => ({ temperature: 1, topP: 1, topK: 1, maxOutputTokens: undefined, options: {} });
const promptText = (client: OpencodeClient, call: number) => vi.mocked(client.session.prompt).mock.calls[call][0].body.parts[0].text;

describe("AutoModePlugin event handler", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allow: replies once and logs an allow verdict", async () => {
    const { client, log, replies } = fakeClient({ promptText: "<block>no</block><reason>reading a file</reason>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([{ id: "per1", reply: "once", message: undefined }]);
    expect(extras(log)).toEqual([expect.objectContaining({ verdict: "allow", outcome: "replied" })]);
  });

  it("block: rejects with the model's reason and logs a block verdict", async () => {
    const { client, log, replies, toasts } = fakeClient({ promptText: "<block>yes</block><reason>force-push to main</reason>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([{ id: "per1", reply: "reject", message: "force-push to main" }]);
    expect(extras(log)).toEqual([expect.objectContaining({ verdict: "block", outcome: "replied" })]);
    expect(toasts.some((t) => t.variant === "warning")).toBe(true);
  });

  it("block with an empty reason still sends a non-empty message (so the turn continues)", async () => {
    const { client, replies } = fakeClient({ promptText: "<block>yes</block>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([{ id: "per1", reply: "reject", message: "Blocked by auto mode." }]);
  });

  it("block while other asks of the session are pending: does not reject, leaves it to the human", async () => {
    const { client, log, replies } = fakeClient({
      promptText: "<block>yes</block><reason>bad</reason>",
      pending: [{ id: "per1", sessionID: "ses1" }, { id: "per2", sessionID: "ses1" }],
    });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([]);
    expect(extras(log)).toEqual([expect.objectContaining({ verdict: "deferred" })]);
  });

  it("pending asks of other sessions do not prevent a reject", async () => {
    const { client, replies } = fakeClient({
      promptText: "<block>yes</block><reason>bad</reason>",
      pending: [{ id: "per1", sessionID: "ses1" }, { id: "perX", sessionID: "other" }],
    });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toHaveLength(1);
  });

  it("block when the pending asks can't be listed: does not reject", async () => {
    const { client, replies } = fakeClient({ promptText: "<block>yes</block><reason>bad</reason>", listFails: true });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([]);
  });

  it("V2 reject failure: no V1 fallback (the V1 route carries no message and would halt the turn)", async () => {
    const { client, log } = fakeClient({ promptText: "<block>yes</block><reason>bad</reason>", v2Fails: "reject" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(client.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
    expect(extras(log)).toEqual([expect.objectContaining({ verdict: "block", outcome: "failed" })]);
  });

  it("V2 allow failure: falls back to the V1 route", async () => {
    const { client } = fakeClient({ promptText: "<block>no</block>", v2Fails: "once" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(client.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({ path: { id: "ses1", permissionID: "per1" }, body: { response: "once" } });
  });

  it("ask (default unsure): no reply, deferred, and it does not count toward the block limits", async () => {
    const logDir = newLogDir();
    const { client, log, replies, toasts } = fakeClient({ promptText: "<block>ask</block><reason>target unclear</reason>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { logDir, maxConsecutiveBlocks: 1, maxTotalBlocks: 1 });
    await hooks.event!(askedEvent({ id: "q1" }));
    await hooks.event!(askedEvent({ id: "q2" }));

    expect(replies).toEqual([]);
    expect(toasts).toEqual([]);
    expect(extras(log).map((e) => e.verdict)).toEqual(["ask", "ask"]); // still deciding: the limit was not hit
    expect(readRecords(logDir).map((r) => [r.requestID, r.verdict, r.outcome, r.reason])).toEqual([
      ["q1", "ask", "deferred", "target unclear"],
      ["q2", "ask", "deferred", "target unclear"],
    ]);
    expect(vi.mocked(client.session.prompt)).toHaveBeenCalledTimes(2);
  });

  it("the human's answer to a deferred ask is captured as a label", async () => {
    const logDir = newLogDir();
    const { client } = fakeClient({ promptText: "<block>ask</block><reason>unsure</reason>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { logDir });
    await hooks.event!(askedEvent({ id: "q1" }));
    await hooks.event!(repliedEvent("q1", "once"));
    expect(readRecords(logDir).filter((r) => r.kind === "label")).toEqual([expect.objectContaining({ requestID: "q1", reply: "once" })]);
  });

  it("unsure: \"block\" turns an ask reply into a reject carrying its reason, counted as a block", async () => {
    const logDir = newLogDir();
    const { client, replies } = fakeClient({ promptText: "<block>ask</block><reason>target unclear</reason>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { logDir, unsure: "block" });
    await hooks.event!(askedEvent());
    expect(replies).toEqual([{ id: "per1", reply: "reject", message: "target unclear" }]);
    expect(readRecords(logDir).map((r) => [r.verdict, r.outcome])).toEqual([["block", "replied"]]);
  });

  it("unsure: \"block\" puts the block-when-unsure rule in the classifier's prompt", async () => {
    const { client } = fakeClient();
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { unsure: "block" });
    const config: { agent?: Record<string, { prompt?: string }> } = {};
    await hooks.config!(config);
    const prompt = config.agent!["auto-mode-classifier"].prompt!;
    expect(prompt).toContain("block when unsure");
    expect(prompt).not.toContain("<block>ask</block>");
  });

  it("unparseable reply: does nothing (no reply, logged as 'none')", async () => {
    const { client, log, replies } = fakeClient({ promptText: "I cannot decide." });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([]);
    expect(extras(log)).toEqual([expect.objectContaining({ verdict: "none" })]);
  });

  it("classifier error (session.create fails): does nothing", async () => {
    const { client, replies, deleted } = fakeClient({ promptText: "<block>yes</block>" });
    vi.mocked(client.session.create).mockResolvedValueOnce({ error: new Error("boom") });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("classifier prompt error: does nothing and still deletes the session, without aborting it", async () => {
    const { client, replies, deleted, aborted } = fakeClient();
    vi.mocked(client.session.prompt).mockRejectedValueOnce(new Error("boom"));
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([]);
    expect(deleted).toEqual(["classifier-1"]);
    expect(aborted).toEqual([]);
  });

  it("classifier timeout: does nothing, aborts then deletes the classifier session", async () => {
    const { client, replies, deleted, aborted } = fakeClient();
    // Simulates a real fetch client: it rejects once the abort signal fires, it doesn't hang forever.
    vi.mocked(client.session.prompt).mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { timeoutMs: 10 });
    await hooks.event!(askedEvent());

    expect(replies).toEqual([]);
    expect(aborted).toEqual(["classifier-1"]);
    expect(deleted).toEqual(["classifier-1"]);
  });

  it("sends the transcript and the action under their headings", async () => {
    const { client } = fakeClient({ promptText: "<block>no</block>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(promptText(client, 0)).toMatch(/^## Transcript\n\{"user":"do the task"\}\n\n## Action\n\{"action":/);
  });

  it("ignores permission.asked events from its own classifier session", async () => {
    let innerReplies = -1;
    let hooks!: Hooks;
    const { client, replies } = fakeClient({
      promptText: "<block>no</block>",
      onPrompt: async (sessionID) => {
        const before = replies.length;
        await hooks.event!(askedEvent({ id: "per-inner", sessionID }));
        innerReplies = replies.length - before;
      },
    });
    hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent({ id: "per-outer" }));

    expect(innerReplies).toBe(0);
    expect(replies.map((r) => r.id)).toEqual(["per-outer"]);
  });

  it("a 404 on reply is swallowed and logged as already-answered", async () => {
    const { client, log } = fakeClient({ promptText: "<block>no</block>", replyStatus: 404 });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await expect(hooks.event!(askedEvent())).resolves.toBeUndefined();
    expect(extras(log)).toEqual([expect.objectContaining({ verdict: "allow", outcome: "already-answered" })]);
  });

  it("stops deciding once the consecutive-block limit is hit", async () => {
    const { client, replies, toasts } = fakeClient({ promptText: "<block>yes</block><reason>no</reason>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { maxConsecutiveBlocks: 1, maxTotalBlocks: 20 });

    await hooks.event!(askedEvent({ id: "per1" }));
    await hooks.event!(askedEvent({ id: "per2" }));

    expect(replies).toHaveLength(1);
    expect(toasts.filter((t) => (t.message as string).includes("too many blocks"))).toHaveLength(1);
  });

  it("blocks that were not actually replied (already answered) do not count toward the limit", async () => {
    const { client, replies } = fakeClient({ promptText: "<block>yes</block><reason>no</reason>", replyStatus: 404 });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { maxConsecutiveBlocks: 1 });

    await hooks.event!(askedEvent({ id: "per1" }));
    await hooks.event!(askedEvent({ id: "per2" }));

    expect(replies).toHaveLength(2); // still deciding
  });

  it("failed block replies do not count toward the limit or toast", async () => {
    const { client, replies, toasts } = fakeClient({ promptText: "<block>yes</block><reason>no</reason>", v2Fails: "reject" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { maxConsecutiveBlocks: 1 });

    await hooks.event!(askedEvent({ id: "per1" }));
    await hooks.event!(askedEvent({ id: "per2" }));

    expect(replies).toHaveLength(2);
    expect(toasts).toEqual([]);
  });

  it("parallel asks of one session are classified one at a time", async () => {
    let running = 0;
    let maxRunning = 0;
    const { client, replies } = fakeClient({
      promptText: "<block>no</block>",
      onPrompt: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
      },
    });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});

    await Promise.all([hooks.event!(askedEvent({ id: "per1" })), hooks.event!(askedEvent({ id: "per2" })), hooks.event!(askedEvent({ id: "per3" }))]);

    expect(maxRunning).toBe(1);
    expect(replies).toHaveLength(3);
  });

  it("skips a queued ask that was replied meanwhile (permission.replied)", async () => {
    let hooks!: Hooks;
    const { client, replies } = fakeClient({
      promptText: "<block>no</block>",
      onPrompt: async () => {
        await hooks.event!({ event: { type: "permission.replied", properties: { sessionID: "ses1", requestID: "per2", reply: "once" } } });
      },
    });
    hooks = await AutoModePlugin(pluginInput(client), {});
    await Promise.all([hooks.event!(askedEvent({ id: "per1" })), hooks.event!(askedEvent({ id: "per2" }))]);

    expect(replies.map((r) => r.id)).toEqual(["per1"]);
    expect(client.session.create).toHaveBeenCalledTimes(1);
  });

  it("skips an ask that is no longer pending at job start; proceeds when the list fails", async () => {
    const a = fakeClient({ promptText: "<block>no</block>", pending: [] });
    const hooksA = await AutoModePlugin(pluginInput(a.client), {});
    await hooksA.event!(askedEvent());
    expect(a.client.session.create).not.toHaveBeenCalled();

    const b = fakeClient({ promptText: "<block>no</block>", listFails: true });
    const hooksB = await AutoModePlugin(pluginInput(b.client), {});
    await hooksB.event!(askedEvent());
    expect(b.replies).toHaveLength(1);
  });

  it("passes the abort signal to session.messages and session.create", async () => {
    const { client } = fakeClient({ promptText: "<block>no</block>" });
    const hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());
    expect(vi.mocked(client.session.messages).mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(vi.mocked(client.session.create).mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it("a hung call can't wedge the session queue: the job is cut off at timeoutMs + slack and the next ask proceeds", async () => {
    vi.useFakeTimers();
    try {
      const { client, replies, log } = fakeClient({ promptText: "<block>no</block>" });
      vi.mocked(client._client!.get).mockImplementationOnce(() => new Promise(() => {})); // GET /permission hangs, ignoring any signal
      const hooks = await AutoModePlugin(pluginInput(client), { timeoutMs: 1000 });
      const first = hooks.event!(askedEvent({ id: "per1" }));
      const second = hooks.event!(askedEvent({ id: "per2" }));
      await vi.advanceTimersByTimeAsync(1000 + JOB_SLACK_MS + 1);
      await Promise.all([first, second]);

      expect(replies.map((r) => r.id)).toEqual(["per2"]);
      expect(log.some((l) => (l.extra as { reason: string }).reason === "timeout")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skipPermissions and onlyPermissions leave asks to the human", async () => {
    const a = fakeClient({ promptText: "<block>no</block>" });
    const hooksA = await AutoModePlugin(pluginInput(a.client), { skipPermissions: ["bash"] });
    await hooksA.event!(askedEvent());
    expect(a.replies).toEqual([]);

    const b = fakeClient({ promptText: "<block>no</block>" });
    const hooksB = await AutoModePlugin(pluginInput(b.client), { onlyPermissions: ["edit"] });
    await hooksB.event!(askedEvent());
    expect(b.replies).toEqual([]);
  });

  it("malformed options fall back to defaults instead of throwing", async () => {
    const { client, replies } = fakeClient({ promptText: "<block>no</block>" });
    const hooks = await AutoModePlugin(pluginInput(client), { skipPermissions: "bash", onlyPermissions: 3, timeoutMs: "fast", allow: [1], maxConsecutiveBlocks: -1 });
    await hooks.event!(askedEvent());
    expect(replies).toHaveLength(1);
  });

  it("an unexpected error in the handler is logged, not thrown", async () => {
    const { client, log } = fakeClient({ promptText: "<block>no</block>" });
    vi.mocked(client._client!.post).mockRejectedValue(new Error("x")); // swallowed by reply.ts
    vi.mocked(client.postSessionIdPermissionsPermissionId).mockRejectedValue(new Error("y"));
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await expect(hooks.event!(askedEvent())).resolves.toBeUndefined();
    expect(extras(log)).toEqual([expect.objectContaining({ verdict: "allow", outcome: "failed" })]);
  });

  it("is a no-op when disabled via options", async () => {
    const { client } = fakeClient({ promptText: "<block>yes</block>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { enabled: false });
    expect(hooks.event).toBeUndefined();
  });

  it("is a no-op when OPENCODE_AUTO_MODE=0", async () => {
    const prev = process.env.OPENCODE_AUTO_MODE;
    process.env.OPENCODE_AUTO_MODE = "0";
    try {
      const { client } = fakeClient({ promptText: "<block>yes</block>" });
      const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
      expect(hooks.event).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_AUTO_MODE;
      else process.env.OPENCODE_AUTO_MODE = prev;
    }
  });
});

describe("AutoModePlugin other hooks", () => {
  it("config registers the classifier agent with the wildcard deny", async () => {
    const { client } = fakeClient();
    const hooks = await AutoModePlugin(pluginInput(client), {});
    const config: { agent?: Record<string, unknown> } = {};
    await hooks.config!(config);
    expect(config.agent!["auto-mode-classifier"]).toMatchObject({ hidden: true, permission: { "*": "deny" } });
  });

  it("chat.params forces temperature 0 and maxOutputTokens only for classifier sessions", async () => {
    let seen: ChatParamsOutput | undefined;
    let hooks!: Hooks;
    const { client } = fakeClient({
      promptText: "<block>no</block>",
      onPrompt: async (sessionID) => {
        const out = paramsOut();
        await hooks["chat.params"]!({ sessionID, agent: "a", model: {}, provider: {}, message: {} }, out);
        seen = out;
      },
    });
    hooks = await AutoModePlugin(pluginInput(client), { maxOutputTokens: 256 });
    await hooks.event!(askedEvent());
    expect(seen).toMatchObject({ temperature: 0, maxOutputTokens: 256 });

    const other = paramsOut();
    await hooks["chat.params"]!({ sessionID: "ses-user", agent: "a", model: {}, provider: {}, message: {} }, other);
    expect(other).toMatchObject({ temperature: 1, maxOutputTokens: undefined });
  });

  it("maxOutputTokens defaults to 1024", async () => {
    let seen: ChatParamsOutput | undefined;
    let hooks!: Hooks;
    const { client } = fakeClient({
      promptText: "<block>no</block>",
      onPrompt: async (sessionID) => {
        seen = paramsOut();
        await hooks["chat.params"]!({ sessionID, agent: "a", model: {}, provider: {}, message: {} }, seen);
      },
    });
    hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());
    expect(seen?.maxOutputTokens).toBe(1024);
  });

  it("tool.execute.after drops the cached tool input", async () => {
    const { client } = fakeClient({ promptText: "<block>no</block>" });
    const hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses1", callID: "c1" }, { args: { command: "SECRET_CMD" } });
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses1", callID: "c1", args: {} }, {});
    await hooks.event!(askedEvent({ callID: "c1", metadata: { command: "FALLBACK_CMD" } }));

    expect(promptText(client, 0)).toContain("FALLBACK_CMD");
    expect(promptText(client, 0)).not.toContain("SECRET_CMD");
  });

  it("the tool-input cache entry is dropped after the decision, and the cache is capped", async () => {
    const { client } = fakeClient({ promptText: "<block>no</block>" });
    const hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses1", callID: "c1" }, { args: { command: "CACHED_CMD" } });
    await hooks.event!(askedEvent({ id: "p1", callID: "c1" }));
    await hooks.event!(askedEvent({ id: "p2", callID: "c1", metadata: { command: "FALLBACK_CMD" } }));
    expect(promptText(client, 0)).toContain("CACHED_CMD");
    expect(promptText(client, 1)).toContain("FALLBACK_CMD");

    for (let i = 0; i < 501; i++) await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses1", callID: `k${i}` }, { args: { command: `CMD${i}` } });
    await hooks.event!(askedEvent({ id: "p3", callID: "k0", metadata: { command: "EVICTED_FALLBACK" } }));
    expect(promptText(client, 2)).toContain("EVICTED_FALLBACK");
  });
});

const newLogDir = () => mkdtempSync(join(tmpdir(), "auto-mode-logdir-"));
const readRecords = (dir: string): Array<Record<string, any>> => {
  const file = join(dir, "auto-mode", "decisions.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const repliedEvent = (requestID: string, reply: string, sessionID = "ses1") => ({ event: { type: "permission.replied", properties: { sessionID, requestID, reply } } });

describe("decision log", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is on by default and writes a full decision record with the exact classifier input", async () => {
    const logDir = newLogDir();
    const { client } = fakeClient({ promptText: "<block>no</block><reason>reading</reason>" });
    const hooks = await AutoModePlugin(pluginInput(client), { logDir });
    await hooks.event!(askedEvent());

    const [rec] = readRecords(logDir);
    expect(rec).toMatchObject({ v: 1, kind: "decision", requestID: "per1", sessionID: "ses1", project: "/proj", permission: "bash", patterns: ["*"], model: "anthropic/claude", verdict: "allow", reason: "reading", outcome: "replied" });
    expect(rec.policyHash).toMatch(/^[0-9a-f]{12}$/);
    expect(typeof rec.ms).toBe("number");
    expect(Date.parse(rec.at)).not.toBeNaN();
    expect(`## Transcript\n${rec.input.transcript}\n\n## Action\n${rec.input.action}`).toBe(promptText(client, 0));
  });

  it("log:false writes nothing", async () => {
    const logDir = newLogDir();
    const { client } = fakeClient({ promptText: "<block>no</block>" });
    const hooks = await AutoModePlugin(pluginInput(client), { logDir, log: false });
    await hooks.event!(askedEvent());
    expect(readRecords(logDir)).toEqual([]);
  });

  it("records block, deferred and none outcomes", async () => {
    const logDir = newLogDir();
    const a = fakeClient({ promptText: "<block>yes</block><reason>bad</reason>" });
    const hooksA = await AutoModePlugin(pluginInput(a.client), { logDir });
    await hooksA.event!(askedEvent({ id: "blk" }));

    const b = fakeClient({ promptText: "<block>yes</block><reason>bad</reason>", pending: [{ id: "d1", sessionID: "s2" }, { id: "d2", sessionID: "s2" }] });
    const hooksB = await AutoModePlugin(pluginInput(b.client), { logDir });
    await hooksB.event!(askedEvent({ id: "d1", sessionID: "s2" }));

    const c = fakeClient({ promptText: "garbage" });
    const hooksC = await AutoModePlugin(pluginInput(c.client), { logDir });
    await hooksC.event!(askedEvent({ id: "nn" }));

    expect(readRecords(logDir).map((r) => [r.requestID, r.verdict, r.outcome])).toEqual([
      ["blk", "block", "replied"],
      ["d1", "block", "deferred"],
      ["nn", "none", "none"],
    ]);
    expect(readRecords(logDir)[2].input).toBeDefined(); // none keeps its input: it can be replayed
  });

  it("records a skipped ask when the session hit its block limit", async () => {
    const logDir = newLogDir();
    const { client } = fakeClient({ promptText: "<block>yes</block><reason>bad</reason>" });
    const hooks = await AutoModePlugin(pluginInput(client), { logDir, maxConsecutiveBlocks: 1 });
    await hooks.event!(askedEvent({ id: "one" }));
    await hooks.event!(askedEvent({ id: "two" }));
    expect(readRecords(logDir).map((r) => [r.requestID, r.outcome])).toEqual([["one", "replied"], ["two", "skipped"]]);
  });

  it("a log write failure never throws out of the hook and is reported once", async () => {
    const blocker = join(newLogDir(), "file");
    writeFileSync(blocker, "x"); // a file where the directory must go
    const { client, log, replies } = fakeClient({ promptText: "<block>no</block>" });
    const hooks = await AutoModePlugin(pluginInput(client), { logDir: blocker });
    await expect(hooks.event!(askedEvent({ id: "a" }))).resolves.toBeUndefined();
    await expect(hooks.event!(askedEvent({ id: "b" }))).resolves.toBeUndefined();
    expect(replies).toHaveLength(2);
    expect(log.filter((l) => String(l.message).includes("decision log write failed"))).toHaveLength(1);
  });
});

describe("human labels from permission.replied", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("labels an ask the plugin left to the human, with the human's reply", async () => {
    const logDir = newLogDir();
    const { client } = fakeClient({ promptText: "garbage" });
    const hooks = await AutoModePlugin(pluginInput(client), { logDir });
    await hooks.event!(askedEvent({ id: "h1" }));
    await hooks.event!(repliedEvent("h1", "reject"));
    const labels = readRecords(logDir).filter((r) => r.kind === "label");
    expect(labels).toEqual([expect.objectContaining({ v: 1, kind: "label", requestID: "h1", reply: "reject" })]);
  });

  it("does not label asks the plugin answered itself (its own reply echoes back as permission.replied)", async () => {
    const logDir = newLogDir();
    let hooks!: Hooks;
    const { client } = fakeClient({ promptText: "<block>no</block>" });
    // The real server publishes permission.replied while the reply call is still in flight.
    vi.mocked(client._client!.post).mockImplementationOnce(async ({ path }: { path?: Record<string, unknown> }) => {
      await hooks.event!(repliedEvent(path!.requestID as string, "once"));
      return { data: true, response: { status: 200 } };
    });
    hooks = await AutoModePlugin(pluginInput(client), { logDir });
    await hooks.event!(askedEvent({ id: "own" }));
    expect(readRecords(logDir).filter((r) => r.kind === "label")).toEqual([]);
  });

  it("labels a skipped (limit-stopped) ask, but not asks the plugin filtered out", async () => {
    const logDir = newLogDir();
    const { client } = fakeClient({ promptText: "<block>yes</block><reason>bad</reason>" });
    const hooks = await AutoModePlugin(pluginInput(client), { logDir, maxConsecutiveBlocks: 1, skipPermissions: ["edit"] });
    await hooks.event!(askedEvent({ id: "one" }));
    await hooks.event!(askedEvent({ id: "two" }));
    await hooks.event!(askedEvent({ id: "filtered", permission: "edit" }));
    await hooks.event!(repliedEvent("two", "once"));
    await hooks.event!(repliedEvent("filtered", "once"));
    expect(readRecords(logDir).filter((r) => r.kind === "label").map((r) => r.requestID)).toEqual(["two"]);
  });

  it("ignores a malformed reply value", async () => {
    const logDir = newLogDir();
    const { client } = fakeClient({ promptText: "garbage" });
    const hooks = await AutoModePlugin(pluginInput(client), { logDir });
    await hooks.event!(askedEvent({ id: "h1" }));
    await hooks.event!(repliedEvent("h1", "maybe"));
    expect(readRecords(logDir).filter((r) => r.kind === "label")).toEqual([]);
  });
});

describe("commands and tools", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("config hook registers both commands (template calls the tool with $ARGUMENTS) and the classifier agent still denies every tool", async () => {
    const { client } = fakeClient();
    const hooks = await AutoModePlugin(pluginInput(client), { logDir: newLogDir() });
    const config: { agent?: Record<string, any>; command?: Record<string, any> } = {};
    await hooks.config!(config);
    expect(Object.keys(config.command!).sort()).toEqual(["auto-mode-eval", "auto-mode-improve"]);
    expect(config.command!["auto-mode-eval"].template).toContain("auto_mode_eval");
    expect(config.command!["auto-mode-eval"].template).toContain("$ARGUMENTS");
    expect(config.command!["auto-mode-improve"].template).toContain("auto_mode_improve");
    expect(config.command!["auto-mode-improve"].template).toMatch(/project-specific[\s\S]*personal[\s\S]*shipped defaults/);
    expect(config.command!["auto-mode-improve"].template).toContain("Do not edit any files");
    expect(config.command!["auto-mode-eval"].description).toBeTruthy();
    expect(config.agent!["auto-mode-classifier"].permission).toEqual({ "*": "deny" });
  });

  it("registers both tools in the 1.19.5 plugin-tool shape (description, args as JSON-schema props, execute)", async () => {
    const { client } = fakeClient();
    const hooks = await AutoModePlugin(pluginInput(client), { logDir: newLogDir() });
    expect(Object.keys(hooks.tool!).sort()).toEqual(["auto_mode_eval", "auto_mode_improve"]);
    for (const t of Object.values(hooks.tool!)) {
      expect(typeof t.description).toBe("string");
      expect(typeof t.execute).toBe("function");
      for (const prop of Object.values(t.args)) expect(prop).toMatchObject({ type: expect.any(String) }); // not a Zod type: 1.19.5 uses it as JSON Schema
    }
    expect(hooks.tool!.auto_mode_eval.description).toMatch(/cost/i);
  });

  /** Six asks the plugin left to the human (held-0..5): even ones allowed, odd ones rejected. */
  async function seeded(extra: Record<string, unknown> = {}, promptText = "<block>no</block><reason>fine</reason>") {
    const logDir = newLogDir();
    const hold = fakeClient({ promptText: "garbage" });
    const holdHooks = await AutoModePlugin(pluginInput(hold.client), { logDir });
    for (let i = 0; i < 6; i++) {
      await holdHooks.event!(askedEvent({ id: `h${i}`, metadata: { command: `held-${i}` } }));
      await holdHooks.event!(repliedEvent(`h${i}`, i % 2 === 0 ? "once" : "reject"));
    }
    const run = fakeClient({ promptText });
    const hooks = await AutoModePlugin(pluginInput(run.client), { logDir, ...extra });
    return { logDir, run, hooks };
  }

  it("eval replays labeled cases with the current policy, never writes to the decision log, and caps concurrency", async () => {
    const { logDir, run, hooks } = await seeded();
    const before = readFileSync(join(logDir, "auto-mode", "decisions.jsonl"), "utf8");
    let inFlight = 0;
    let max = 0;
    vi.mocked(run.client.session.prompt).mockImplementation(async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { data: { info: {}, parts: [{ type: "text" as const, text: "<block>no</block><reason>fine</reason>" }] } };
    });

    const report = await hooks.tool!.auto_mode_eval.execute({ limit: 0, only: "labeled", scope: "project", model: "" }, { worktree: "/proj", directory: "/proj" });

    expect(report).toContain("6 cases");
    expect(report).toContain("agreement: 50% (3/6)");
    expect(report).toMatch(/expected allow\s*\|\s*3\s*\|\s*0\s*\|\s*0/);
    expect(report).toMatch(/expected block\s*\|\s*3\s*\|\s*0\s*\|\s*0/);
    expect(report).toContain("held-1");
    expect(readFileSync(join(logDir, "auto-mode", "decisions.jsonl"), "utf8")).toBe(before);
    expect(max).toBeLessThanOrEqual(EVAL_CONCURRENCY);
    expect(max).toBeGreaterThan(1);
    expect(run.deleted.length).toBe(6); // every replay session cleaned up
  });

  it("eval matrix: an ask reply is its own column and a disagreement; with unsure block it counts as block", async () => {
    const asked = await seeded({}, "<block>ask</block><reason>unsure</reason>");
    const ctx = { worktree: "/proj", directory: "/proj" };
    const report = await asked.hooks.tool!.auto_mode_eval.execute({ limit: 0, only: "labeled", scope: "project", model: "" }, ctx);
    expect(report).toContain("agreement: 0% (0/6)");
    expect(report).toMatch(/expected allow\s*\|\s*0\s*\|\s*0\s*\|\s*3\s*\|\s*0/);
    expect(report).toContain("asked the human: 6");

    const blocking = await seeded({ unsure: "block" }, "<block>ask</block><reason>unsure</reason>");
    const report2 = await blocking.hooks.tool!.auto_mode_eval.execute({ limit: 0, only: "labeled", scope: "project", model: "" }, ctx);
    expect(report2).toContain("agreement: 50% (3/6)");
    expect(report2).toMatch(/expected block\s*\|\s*0\s*\|\s*3\s*\|\s*0\s*\|\s*0/);
  });

  it("eval honours scope: another project's decisions are excluded unless scope is all", async () => {
    const { run, hooks } = await seeded();
    const other = await hooks.tool!.auto_mode_eval.execute({ limit: 0, only: "labeled", scope: "project", model: "" }, { worktree: "/elsewhere", directory: "/elsewhere" });
    expect(other).toContain("No matching");
    const all = await hooks.tool!.auto_mode_eval.execute({ limit: 3, only: "labeled", scope: "all", model: "" }, { worktree: "/elsewhere", directory: "/elsewhere" });
    expect(all).toContain("3 cases");
    expect(run.client.session.prompt).toHaveBeenCalledTimes(3);
  });

  it("improve returns the effective rules, the overrides and makes no model call", async () => {
    const { run, hooks } = await seeded({ allow: ["Deploys to staging.sh are fine"], environment: ["staging host is example.com"] });
    const report = await hooks.tool!.auto_mode_improve.execute({ limit: 0, scope: "project" }, { worktree: "/proj", directory: "/proj" });
    expect(report).toContain("Deploys to staging.sh are fine");
    expect(report).toContain("staging host is example.com");
    expect(report).toContain("human allowed");
    expect(report).toContain("held-0");
    expect(run.client.session.create).not.toHaveBeenCalled();
    expect(run.client.session.prompt).not.toHaveBeenCalled();
    const none = await hooks.tool!.auto_mode_improve.execute({ limit: 0, scope: "project" }, { worktree: "/elsewhere", directory: "/elsewhere" });
    expect(none).toContain("No overrides");
  });
});

describe("module shape", () => {
  it("default-exports a V1 plugin object ({ id, server }) so OpenCode 1.19.5 ignores the other exports", () => {
    expect(AutoModeModule).toEqual({ id: "auto-mode", server: AutoModePlugin });
  });
});
