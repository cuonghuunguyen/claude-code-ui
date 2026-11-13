import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Part } from "@claude-ui/protocol";
import { describe, expect, it, vi } from "vitest";
import { ToolError } from "../src/daemon-mcp.ts";
import { inlineClaudeOptions, runInlineClaude, type InlineClaudeDeps } from "../src/inline-claude.ts";
import { INLINE_OUTPUT_TOKENS, type InlineSpec } from "../src/inline-types.ts";

const SPEC: InlineSpec = { text: "Find foo", title: "Find foo", tools: ["Read", "Grep", "Glob"], mcp: [], maxTurns: 10 };
const usage = (o: Partial<Record<"input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens", number>> = {}) => ({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o });
const assistant = (id: string, content: unknown[], u = usage(), model = "claude-haiku-4-5-20251001") =>
  ({ type: "assistant", uuid: `u-${id}-${Math.random()}`, session_id: "x", parent_tool_use_id: null, message: { id, model, role: "assistant", content, usage: u, stop_reason: "end_turn" } }) as unknown as SDKMessage;
const text = (t: string) => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, content = "ok", isError = false) =>
  ({ type: "user", uuid: `r-${id}`, session_id: "x", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } }) as unknown as SDKMessage;
const result = (o: Record<string, unknown> = {}) =>
  ({ type: "result", subtype: "success", is_error: false, result: "final", num_turns: 2, total_cost_usd: 0.002, duration_ms: 5, duration_api_ms: 4, session_id: "x", uuid: "res", usage: usage({ input_tokens: 30, output_tokens: 12, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }), ...o }) as unknown as SDKMessage;

type Setup = {
  messages?: (SDKMessage | (() => Promise<void>))[];
  throwAfter?: Error;
  status?: unknown[];
  settings?: unknown;
  settingsError?: boolean;
  noParent?: boolean;
  dirty?: (Map<string, string> | undefined)[];
  ask?: InlineClaudeDeps["canUseTool"];
  limits?: InlineClaudeDeps["limits"];
  mode?: "default" | "bypassPermissions" | "auto";
  supportsAuto?: (model: string) => boolean;
};
function setup(s: Setup = {}) {
  const emitted: Part[] = [];
  const optionsSeen: Options[] = [];
  const runs = new Map<string, () => void>();
  const dirty = [...(s.dirty ?? [])];
  const deps: InlineClaudeDeps = {
    query: (({ options }: { prompt: string; options: Options }) => {
      optionsSeen.push(options);
      const gen = (async function* () {
        for (const m of s.messages ?? []) {
          if (options.abortController?.signal.aborted) return;
          if (typeof m === "function") await m();
          else yield m;
        }
        if (s.throwAfter) throw s.throwAfter;
        // A run without messages left waits for the abort, like a CLI in a long tool.
        if (!(s.messages ?? []).some((m) => typeof m !== "function" && m.type === "result")) await new Promise<void>((r) => (options.abortController?.signal.aborted ? r() : options.abortController?.signal.addEventListener("abort", () => r())));
      })();
      return Object.assign(gen, { close: vi.fn() });
    }) as unknown as InlineClaudeDeps["query"],
    parent: () => ({ cwd: "/proj", permissionMode: s.mode ?? "default", allowBypass: true, additionalDirectories: ["/extra"], allowedTools: ["Bash(git status:*)"] }),
    parentQuery: () =>
      s.noParent
        ? undefined
        : ({
            mcpServerStatus: async () => s.status ?? [],
            getSettings: async () => {
              if (s.settingsError) throw new Error("no settings");
              return s.settings ?? { effective: { permissions: { allow: ["Read(*)"], deny: ["Bash(rm:*)"], ask: ["Edit"], defaultMode: "plan", additionalDirectories: ["/x"] }, hooks: { PreToolUse: [] } } };
            },
          } as never),
    defaultModel: () => "haiku",
    ...(s.supportsAuto && { supportsAuto: s.supportsAuto }),
    emit: (p) => emitted.push(p),
    canUseTool: s.ask ?? (async () => ({ behavior: "allow", updatedInput: {} })),
    gitDirty: async () => dirty.shift(),
    env: () => ({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-secret", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "oauth" }),
    runs,
    limits: s.limits,
  };
  return { deps, emitted, optionsSeen, runs };
}
const run = (s: Setup = {}, spec: Partial<InlineSpec> = {}, hooks: { signal?: AbortSignal; toolUseId?: string } = {}) => {
  const x = setup(s);
  return { ...x, done: runInlineClaude(x.deps, { ...SPEC, ...spec }, { signal: hooks.signal ?? new AbortController().signal, toolUseId: "toolu_main", ...hooks }) };
};
const connected = (name: string, source: string, tools: string[] = [], status = "connected") => ({ name, status, source, config: { type: "stdio", command: name }, tools: tools.map((n) => ({ name: n })) });

describe("runInlineClaude options", () => {
  it("minimizes the query: no settings files, no skills, only the granted tools, no persistence, fixed short system prompt", async () => {
    const { done, optionsSeen } = run({ messages: [result()] });
    await done;
    const o = optionsSeen[0]!;
    expect(o).toMatchObject({
      model: "haiku",
      settingSources: [],
      skills: [],
      tools: ["Read", "Grep", "Glob"],
      mcpServers: {},
      strictMcpConfig: true,
      maxTurns: 10,
      persistSession: false,
      cwd: "/proj",
      additionalDirectories: ["/extra"],
      permissionMode: "default",
      allowDangerouslySkipPermissions: true,
      allowedTools: ["Bash(git status:*)"],
      includePartialMessages: false,
    });
    expect(typeof o.systemPrompt).toBe("string");
    expect((o.systemPrompt as string).length).toBeLessThanOrEqual(600);
    expect(o.abortController).toBeInstanceOf(AbortController);
    expect(typeof o.canUseTool).toBe("function");
  });
  it("parent mode auto falls back to default when the inline model does not support auto", async () => {
    const no = run({ messages: [result()], mode: "auto", supportsAuto: (m) => m !== "haiku" });
    await no.done;
    expect(no.optionsSeen[0]!.permissionMode).toBe("default");
    const yes = run({ messages: [result()], mode: "auto", supportsAuto: (m) => m !== "haiku" }, { model: "sonnet" });
    await yes.done;
    expect(yes.optionsSeen[0]!.permissionMode).toBe("auto");
    const none = run({ messages: [result()], mode: "auto" });
    await none.done;
    expect(none.optionsSeen[0]!.permissionMode).toBe("default");
  });
  it("model: the input first, then the setting", async () => {
    const a = run({ messages: [result()] }, { model: "sonnet" });
    await a.done;
    expect(a.optionsSeen[0]!.model).toBe("sonnet");
  });
  it("copies only allow, deny and ask of the parent's effective permissions; hooks off", async () => {
    const { done, optionsSeen } = run({ messages: [result()] });
    await done;
    expect(optionsSeen[0]!.settings).toEqual({ permissions: { allow: ["Read(*)"], deny: ["Bash(rm:*)"], ask: ["Edit"] }, disableAllHooks: true });
  });
  it("without usable parent permissions only hooks are off (grants and mode still pass)", async () => {
    for (const s of [{ settingsError: true }, { settings: {} }, { settings: { effective: { permissions: "x" } } }, { noParent: true }]) {
      const { done, optionsSeen } = run({ messages: [result()], ...s });
      await done;
      expect(optionsSeen[0]!.settings).toEqual({ disableAllHooks: true });
    }
  });
  it("env: no API keys, the account token and the rest of the daemon env stay", async () => {
    const { done, optionsSeen } = run({ messages: [result()] });
    await done;
    expect(optionsSeen[0]!.env).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
  });
  it("the bypass flag is the parent's (off stays off)", () => {
    const o = inlineClaudeOptions({ cwd: "/p", permissionMode: "default", allowBypass: false }, SPEC, { model: "haiku", mcpServers: {}, disallowedTools: [], abort: new AbortController(), env: {}, canUseTool: async () => ({ behavior: "deny", message: "" }) });
    expect(o.allowDangerouslySkipPermissions).toBe(false);
    expect(o.allowedTools).toBeUndefined();
    expect(o.additionalDirectories).toBeUndefined();
  });
});

describe("runInlineClaude mcp grants", () => {
  const status = [connected("playwright", "project", ["navigate", "screenshot"]), connected("claude-ui", "sdk", ["inline_task"]), connected("down", "user", [], "failed"), connected("git", "user", ["log", "diff", "push"])];
  it("a server name passes its config and no disallowed tools", async () => {
    const { done, optionsSeen } = run({ messages: [result()], status }, { mcp: ["playwright"] });
    await done;
    expect(optionsSeen[0]!.mcpServers).toEqual({ playwright: { type: "stdio", command: "playwright" } });
    expect(optionsSeen[0]!.disallowedTools).toBeUndefined();
  });
  it("one tool grants the server and disallows its other tools", async () => {
    const { done, optionsSeen } = run({ messages: [result()], status }, { mcp: ["mcp__git__log", "mcp__git__diff"] });
    await done;
    expect(Object.keys(optionsSeen[0]!.mcpServers!)).toEqual(["git"]);
    expect(optionsSeen[0]!.disallowedTools).toEqual(["mcp__git__push"]);
  });
  it("a whole server wins over a tool of it", async () => {
    const { done, optionsSeen } = run({ messages: [result()], status }, { mcp: ["git", "mcp__git__log"] });
    await done;
    expect(optionsSeen[0]!.disallowedTools).toBeUndefined();
  });
  it("refuses an sdk server, an unknown server and a failed one, naming the connected servers", async () => {
    for (const mcp of ["claude-ui", "nope", "down"]) {
      const x = run({ messages: [result()], status }, { mcp: [mcp] });
      const err = await x.done.catch((e) => e);
      expect(err).toBeInstanceOf(ToolError);
      expect(err.message).toContain("playwright");
      expect(err.message).toContain("git");
      expect(err.message).not.toMatch(/claude-ui, /);
      expect(x.optionsSeen).toHaveLength(0);
    }
  });
  it("an unknown tool of a granted server is refused", async () => {
    await expect(run({ messages: [result()], status }, { mcp: ["mcp__git__nothing"] }).done).rejects.toThrow(/nothing/);
  });
  it("passes a claudeai-proxy config as it is", async () => {
    const proxy = { name: "Gmail", status: "connected", source: "claudeai", config: { type: "claudeai-proxy", url: "https://x/mcp", id: "mcpsrv_1" }, tools: [{ name: "search" }] };
    const { done, optionsSeen } = run({ messages: [result()], status: [proxy] }, { mcp: ["Gmail"] });
    await done;
    expect(optionsSeen[0]!.mcpServers).toEqual({ Gmail: proxy.config });
  });
  it("a grant without a live parent query is a ToolError", async () => {
    await expect(run({ messages: [result()], noParent: true }, { mcp: ["git"] }).done).rejects.toThrow(ToolError);
  });
});

describe("runInlineClaude steps", () => {
  it("emits text, thinking, tool calls, results with parentId = the call; drops the rest", async () => {
    const { done, emitted } = run({
      messages: [
        assistant("m1", [{ type: "thinking", thinking: "hmm", signature: "s" }, text("looking"), toolUse("t1", "Grep", { pattern: "foo" })]),
        toolResult("t1", "a.ts:1"),
        assistant("m2", [text("done")]),
        result(),
      ],
    });
    await done;
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted.every((p) => p.parentId === "toolu_main")).toBe(true);
    const types = emitted.map((p) => p.type);
    expect(types).toEqual(expect.arrayContaining(["thinking", "assistant_text", "tool_call", "tool_result"]));
    expect(types.every((t) => ["assistant_text", "thinking", "tool_call", "tool_result", "notice"].includes(t))).toBe(true);
    const call = emitted.filter((p) => p.type === "tool_call").at(-1)!;
    expect(call).toMatchObject({ tool: "Grep", status: "done", toolUseId: "t1" });
  });
  it("without the call's id no step reaches the parent log (permission prompts still work)", async () => {
    const x = setup({ messages: [assistant("m1", [text("hi")]), result()] });
    const r = await runInlineClaude(x.deps, SPEC, { signal: new AbortController().signal });
    expect(r.status).toBe("done");
    expect(x.emitted).toEqual([]);
  });
});

describe("runInlineClaude permissions", () => {
  it("canUseTool goes through the parent's flow with the step's id, a bridge adapter and a tagging emit", async () => {
    const ask = vi.fn<InlineClaudeDeps["canUseTool"]>(async (_t, _i, _o, bridge) => {
      bridge.emit({ type: "notice", id: "n", level: "notice", text: "x" } as Part);
      return { behavior: "deny", message: "no" } as PermissionResult;
    });
    const x = setup({ messages: [assistant("m1", [toolUse("t9", "Bash", { command: "ls" })]), result()], ask });
    const p = runInlineClaude(x.deps, { ...SPEC, tools: ["Bash"] }, { signal: new AbortController().signal, toolUseId: "toolu_main" });
    await p;
    const o = x.optionsSeen[0]!;
    const res = await o.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t9" } as never);
    expect(res).toEqual({ behavior: "deny", message: "no" });
    expect(ask.mock.calls[0]![0]).toBe("Bash");
    expect(ask.mock.calls[0]![2].toolUseID).toBe("t9");
    // The bridge emit tags parts with the run's call id.
    expect(x.emitted.find((e) => e.id === "n")?.parentId).toBe("toolu_main");
  });
});

describe("runInlineClaude result", () => {
  it("sums usage, takes the cost and turns from the result and the last assistant text", async () => {
    const { done } = run({
      messages: [
        assistant("m1", [text("first")], usage({ input_tokens: 20, output_tokens: 6, cache_creation_input_tokens: 3 })),
        toolResult("t1"),
        assistant("m2", [text("The answer")], usage({ input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 7 })),
        result(),
      ],
    });
    const r = await done;
    expect(r).toMatchObject({ status: "done", text: "The answer", model: "claude-haiku-4-5-20251001", turns: 2, costUsd: 0.002, filesChanged: [] });
    expect(r.tokens).toEqual({ input: 30, output: 12, cacheRead: 7, cacheWrite: 3 });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.limit).toBeUndefined();
    expect(r.truncated).toBeUndefined();
  });
  it("a message id streamed in several blocks counts once", async () => {
    const same = usage({ input_tokens: 4, output_tokens: 9 });
    const { done } = run({ messages: [assistant("m1", [text("a")], same), assistant("m1", [toolUse("t1", "Read", {})], same), result({ usage: undefined, num_turns: undefined })] });
    const r = await done;
    expect(r.tokens.input).toBe(4);
    expect(r.tokens.output).toBe(9);
    expect(r.turns).toBe(1);
  });
  it("keeps the tail of a text over 16000 chars and flags it", async () => {
    const long = "a".repeat(10_000) + "b".repeat(10_000);
    const { done } = run({ messages: [assistant("m1", [text(long)]), result()] });
    const r = await done;
    expect(r.text).toBe(long.slice(-16_000));
    expect(r.truncated).toBe(true);
  });
  it("uses the result's text when no assistant text came", async () => {
    const r = await run({ messages: [result({ result: "from result" })] }).done;
    expect(r.text).toBe("from result");
  });
  it("model falls back to the requested one before any reply", async () => {
    const r = await run({ messages: [result()] }, { model: "sonnet" }).done;
    expect(r.model).toBe("sonnet");
  });
});

describe("runInlineClaude limits and stops", () => {
  it("max turns: limit turns with the partial text", async () => {
    const r = await run({ messages: [assistant("m1", [text("partial")]), result({ subtype: "error_max_turns", is_error: true, num_turns: 3 })] }).done;
    expect(r).toMatchObject({ status: "limit", limit: "turns", text: "partial", turns: 3 });
  });
  it("output tokens over the cap abort the run: limit tokens", async () => {
    const x = setup({ messages: [assistant("m1", [text("big")], usage({ output_tokens: INLINE_OUTPUT_TOKENS - 100 })), assistant("m2", [text("bigger")], usage({ output_tokens: 200 }))] });
    const r = await runInlineClaude(x.deps, SPEC, { signal: new AbortController().signal, toolUseId: "toolu_main" });
    expect(r).toMatchObject({ status: "limit", limit: "tokens", text: "bigger" });
    expect(r.tokens.output).toBe(INLINE_OUTPUT_TOKENS + 100);
    expect(x.optionsSeen[0]!.abortController!.signal.aborted).toBe(true);
  });
  it("wall clock: limit time", async () => {
    const r = await run({ messages: [assistant("m1", [text("slow start")])], limits: { timeoutMs: 20 } }).done;
    expect(r).toMatchObject({ status: "limit", limit: "time", text: "slow start" });
  });
  it("abort signal: stopped, with the partial text", async () => {
    const ctrl = new AbortController();
    const x = run({ messages: [assistant("m1", [text("so far")]), async () => ctrl.abort()] }, {}, { signal: ctrl.signal });
    expect(await x.done).toMatchObject({ status: "stopped", text: "so far" });
  });
  it("an already aborted signal stops without starting the query", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const x = run({ messages: [result()] }, {}, { signal: ctrl.signal });
    expect((await x.done).status).toBe("stopped");
  });
  it("the runs map holds an abort per call id while running (stopSubagent) and drops it after", async () => {
    const x = setup({ messages: [assistant("m1", [text("a")])] });
    const p = runInlineClaude(x.deps, SPEC, { signal: new AbortController().signal, toolUseId: "toolu_main" });
    await vi.waitFor(() => expect(x.runs.has("toolu_main")).toBe(true));
    x.runs.get("toolu_main")!();
    expect((await p).status).toBe("stopped");
    expect(x.runs.size).toBe(0);
  });
  it("a CLI error result and a thrown error: status error with the message and the partial text", async () => {
    const a = await run({ messages: [assistant("m1", [text("p")]), result({ subtype: "error_during_execution", is_error: true, errors: ["boom"] })] }).done;
    expect(a).toMatchObject({ status: "error", text: "p" });
    expect(a.error).toContain("boom");
    const b = await run({ messages: [assistant("m1", [text("q")])], throwAfter: new Error("CLI died") }).done;
    expect(b).toMatchObject({ status: "error", error: "CLI died", text: "q" });
  });
});

describe("runInlineClaude filesChanged", () => {
  it("unions done Edit/Write/NotebookEdit inputs with the git status delta, relative to the folder", async () => {
    const before = new Map([["/proj/dirty.ts", "M"], ["/proj/same.ts", "M"]]);
    const after = new Map([["/proj/dirty.ts", "MM"], ["/proj/same.ts", "M"], ["/proj/new.txt", "??"], ["/elsewhere/x", "??"]]);
    const { done } = run({
      dirty: [before, after],
      messages: [
        assistant("m1", [toolUse("e1", "Edit", { file_path: "/proj/src/a.ts" }), toolUse("w1", "Write", { file_path: "/proj/b.txt" }), toolUse("n1", "NotebookEdit", { notebook_path: "/proj/n.ipynb" }), toolUse("e2", "Edit", { file_path: "/proj/failed.ts" })]),
        toolResult("e1"),
        toolResult("w1"),
        toolResult("n1"),
        toolResult("e2", "denied", true),
        result(),
      ],
    });
    const r = await done;
    expect(r.filesChanged.sort()).toEqual(["b.txt", "dirty.ts", "n.ipynb", "new.txt", "src/a.ts", "/elsewhere/x"].sort());
  });
  it("outside a repository (no git state) only the tool inputs count", async () => {
    const { done } = run({ dirty: [undefined, undefined], messages: [assistant("m1", [toolUse("w1", "Write", { file_path: "/proj/b.txt" })]), toolResult("w1"), result()] });
    expect((await done).filesChanged).toEqual(["b.txt"]);
  });
});

describe("ClaudeSession inline runs", () => {
  /** A session whose first query (the parent) idles and whose later queries (inline runs) are `inline`. */
  async function parentSession(inline: (o: Options) => unknown) {
    const { Session } = await import("../src/session.ts");
    let n = 0;
    const query = ({ options }: { options: Options }) => {
      if (n++ > 0) return inline(options) as never;
      let end!: () => void;
      return Object.assign(
        (async function* () {
          await new Promise<void>((r) => (end = r));
        })(),
        { supportedCommands: async () => [], mcpServerStatus: async () => [], getSettings: async () => ({ effective: { permissions: { allow: ["Read(*)"] } } }), close: () => end?.() },
      ) as never;
    };
    const s = new Session("/tmp", { query: query as never });
    s.prompt("hi");
    await vi.waitFor(() => expect((s.run as unknown as { liveQuery(): unknown }).liveQuery()).toBeDefined());
    return s;
  }
  const hanging = (o: Options) =>
    Object.assign(
      (async function* () {
        await new Promise<void>((r) => o.abortController?.signal.addEventListener("abort", () => r()));
      })(),
      { close: () => {} },
    );
  const hooks = (toolUseId: string) => ({ signal: new AbortController().signal, toolUseId });

  it("a read-only parent's disallowedTools stay blocked in the inline run: not granted, listed as disallowed", async () => {
    const { Session } = await import("../src/session.ts");
    let n = 0;
    let seen: Options | undefined;
    const query = ({ options }: { options: Options }) => {
      if (n++ > 0) {
        seen = options;
        return Object.assign((async function* () { yield result(); })(), { close: () => {} }) as never;
      }
      let end!: () => void;
      return Object.assign((async function* () { await new Promise<void>((r) => (end = r)); })(), { supportedCommands: async () => [], mcpServerStatus: async () => [], getSettings: async () => ({}), close: () => end?.() }) as never;
    };
    const s = new Session("/tmp", { query: query as never, disallowedTools: () => ["Edit", "Write", "NotebookEdit"] } as never);
    s.prompt("hi");
    await vi.waitFor(() => expect((s.run as unknown as { liveQuery(): unknown }).liveQuery()).toBeDefined());
    await s.run.inlineTask!({ ...SPEC, tools: ["Read", "Write", "Edit"] }, hooks("toolu_x"));
    expect(seen!.tools).toEqual(["Read"]);
    expect(seen!.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "NotebookEdit"]));
    await s.close();
  });
  it("stopSubagent(toolUseId) aborts the inline run: result stopped", async () => {
    const s = await parentSession(hanging);
    const p = s.run.inlineTask!(SPEC, hooks("toolu_a"));
    await vi.waitFor(async () => expect(await s.run.stopSubagent("toolu_a")).toBe(true));
    expect((await p).status).toBe("stopped");
    expect(await s.run.stopSubagent("toolu_a")).toBe(false);
    await s.close();
  });
  it("close() aborts every inline run", async () => {
    const s = await parentSession(hanging);
    const a = s.run.inlineTask!(SPEC, hooks("toolu_a"));
    const b = s.run.inlineTask!(SPEC, hooks("toolu_b"));
    await vi.waitFor(async () => expect(await s.run.stopSubagent("nothing")).toBe(false));
    await new Promise((r) => setTimeout(r, 20));
    await s.close();
    expect([(await a).status, (await b).status]).toEqual(["stopped", "stopped"]);
  });
  it("the inline query carries the parent's mode and settings; a step's permission request goes to the parent as a child of the call and the reply reaches the SDK", async () => {
    let seen!: Options;
    const s = await parentSession((o) => {
      seen = o;
      return Object.assign(
        (async function* () {
          yield assistant("m1", [toolUse("t1", "Bash", { command: "ls" })]);
          const r = (await o.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t1", suggestions: [] } as never))!;
          yield toolResult("t1", r.behavior === "allow" ? "files" : "denied", r.behavior !== "allow");
          yield assistant("m2", [text(r.behavior)]);
          yield result();
        })(),
        { close: () => {} },
      );
    });
    const events: import("@claude-ui/protocol").Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    const p = s.run.inlineTask!({ ...SPEC, tools: ["Bash"] }, hooks("toolu_main"));
    await vi.waitFor(() => expect(events.some((e) => e.part.type === "permission_request")).toBe(true));
    const req = events.find((e) => e.part.type === "permission_request")!.part as { requestId: string; toolUseId: string; tool: string };
    expect(req).toMatchObject({ tool: "Bash", toolUseId: "t1" });
    const call = events.filter((e) => e.part.id === "t1" && e.part.type === "tool_call").at(-1)!.part;
    expect(call.parentId).toBe("toolu_main");
    expect(s.info().state).toBe("needs_input");
    s.respond(req.requestId, { decision: "allow" } as never);
    const r = await p;
    expect(r.text).toBe("allow");
    expect(seen.permissionMode).toBe("default");
    expect(seen.settings).toEqual({ permissions: { allow: ["Read(*)"] }, disableAllHooks: true });
    await s.close();
  });
  it("allow_always on a bridged step request appends the session grant to the parent: the next inline query allows the rule", async () => {
    const suggestion = { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "ls:*" }], behavior: "allow", destination: "session" };
    const seen: Options[] = [];
    const s = await parentSession((o) => {
      seen.push(o);
      return Object.assign(
        (async function* () {
          if (seen.length === 1) await o.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t1", suggestions: [suggestion] } as never);
          yield result();
        })(),
        { close: () => {} },
      );
    });
    const events: import("@claude-ui/protocol").Event[] = [];
    s.subscribe(0, (e) => events.push(e));
    const p = s.run.inlineTask!({ ...SPEC, tools: ["Bash"] }, hooks("toolu_main"));
    await vi.waitFor(() => expect(events.some((e) => e.part.type === "permission_request")).toBe(true));
    const req = events.find((e) => e.part.type === "permission_request")!.part as { requestId: string };
    s.respond(req.requestId, { decision: "allow_always" } as never);
    await p;
    expect(seen[0]!.allowedTools ?? []).not.toContain("Bash(ls:*)");
    await s.run.inlineTask!(SPEC, hooks("toolu_next"));
    expect(seen[1]!.allowedTools).toContain("Bash(ls:*)");
    await s.close();
  });
});
