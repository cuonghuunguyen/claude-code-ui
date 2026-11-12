import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoModePlugin, JOB_SLACK_MS } from "../auto-mode.ts";
import type { ChatParamsOutput, Hooks, OpencodeClient, PluginInput } from "../types.ts";

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
