import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoModePlugin } from "../auto-mode.ts";
import type { Hooks, OpencodeClient, PluginInput } from "../types.ts";

interface FakeClientOptions {
  promptText?: string;
  onPrompt?: (sessionID: string) => Promise<void> | void;
  replyStatus?: number;
}

function fakeClient(opts: FakeClientOptions = {}) {
  const log: Array<Record<string, unknown>> = [];
  const toasts: Array<Record<string, unknown>> = [];
  const replies: Array<{ id: string; reply: string; message?: string }> = [];
  const deleted: string[] = [];
  let sessionCounter = 0;

  const client: OpencodeClient = {
    _client: {
      post: vi.fn(async ({ url, path, body }: { url: string; path?: Record<string, unknown>; body?: unknown }) => {
        if (url === "/permission/{requestID}/reply") {
          const b = body as { reply: string; message?: string };
          replies.push({ id: path!.requestID as string, reply: b.reply, message: b.message });
          if (opts.replyStatus === 404) return { response: { status: 404 } };
          return { data: true, response: { status: 200 } };
        }
        throw new Error(`unexpected url ${url}`);
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
  return { client, log, toasts, replies, deleted };
}

function pluginInput(client: OpencodeClient): PluginInput {
  return { client, directory: "/proj", worktree: "/proj", serverUrl: new URL("http://127.0.0.1:4096") };
}

function askedEvent(overrides: Partial<{ id: string; sessionID: string; permission: string; metadata: Record<string, unknown> }> = {}) {
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
      },
    },
  };
}

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
    expect(log.some((l) => (l.extra as { verdict: string }).verdict === "allow")).toBe(true);
  });

  it("block: rejects with the model's reason and logs a block verdict", async () => {
    const { client, log, replies, toasts } = fakeClient({ promptText: "<block>yes</block><reason>force-push to main</reason>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([{ id: "per1", reply: "reject", message: "force-push to main" }]);
    expect(log.some((l) => (l.extra as { verdict: string }).verdict === "block")).toBe(true);
    expect(toasts.some((t) => t.variant === "warning")).toBe(true);
  });

  it("unparseable reply: does nothing (no reply, logged as 'none')", async () => {
    const { client, log, replies } = fakeClient({ promptText: "I cannot decide." });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([]);
    expect(log.some((l) => (l.extra as { verdict: string }).verdict === "none")).toBe(true);
  });

  it("classifier error (session.create fails): does nothing", async () => {
    const { client, replies } = fakeClient({ promptText: "<block>yes</block>" });
    vi.mocked(client.session.create).mockResolvedValueOnce({ error: new Error("boom") });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent());

    expect(replies).toEqual([]);
  });

  it("classifier timeout: does nothing", async () => {
    const { client, replies } = fakeClient();
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
  });

  it("ignores permission.asked events from its own classifier session", async () => {
    let innerReplies = -1;
    const { client, replies } = fakeClient({
      promptText: "<block>no</block>",
      onPrompt: async (sessionID) => {
        const before = replies.length;
        await hooks.event!(askedEvent({ id: "per-inner", sessionID }));
        innerReplies = replies.length - before;
      },
    });
    let hooks!: Hooks;
    hooks = await AutoModePlugin(pluginInput(client), {});
    await hooks.event!(askedEvent({ id: "per-outer" }));

    expect(innerReplies).toBe(0); // the recursive, same-session event produced no reply
    expect(replies.some((r) => r.id === "per-inner")).toBe(false);
    expect(replies.some((r) => r.id === "per-outer")).toBe(true);
  });

  it("swallows a 404 on reply (someone else already answered)", async () => {
    const { client } = fakeClient({ promptText: "<block>no</block>", replyStatus: 404 });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), {});
    await expect(hooks.event!(askedEvent())).resolves.toBeUndefined();
  });

  it("stops deciding once the consecutive-block limit is hit", async () => {
    const { client, replies, toasts } = fakeClient({ promptText: "<block>yes</block><reason>no</reason>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { maxConsecutiveBlocks: 1, maxTotalBlocks: 20 });

    await hooks.event!(askedEvent({ id: "per1" }));
    await hooks.event!(askedEvent({ id: "per2" }));

    expect(replies).toHaveLength(1); // the second ask was left for the human
    expect(toasts.some((t) => (t.message as string).includes("too many blocks"))).toBe(true);
  });

  it("is a no-op when disabled via options", async () => {
    const { client, replies } = fakeClient({ promptText: "<block>yes</block>" });
    const hooks: Hooks = await AutoModePlugin(pluginInput(client), { enabled: false });
    expect(hooks.event).toBeUndefined();
    void replies;
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
