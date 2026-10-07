// Fake SDK query(): answers each input message with the next turn of a recorded fixture.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ModelInfo, Options, PermissionResult, PermissionUpdate, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const lines: SDKMessage[] = readFileSync(
  new URL("../../protocol/test/fixtures/two-turn-text.jsonl", import.meta.url),
  "utf8",
).trim().split("\n").map((l) => JSON.parse(l));

const turns: SDKMessage[][] = [[]];
for (const m of lines) {
  turns.at(-1)!.push(m);
  if (m.type === "result") turns.push([]);
}

export const calls: Options[] = [];
export const setModelCalls: (string | undefined)[] = [];
/** setPermissionMode() and applyFlagSettings() calls. */
export const controlCalls: unknown[] = [];
export const models: ModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "", supportsAutoMode: true },
];
export const inputs: SDKUserMessage[] = [];
/** rewindFiles() calls, and the files each dry run reports (set per test). */
export const rewinds: { id: string; dryRun?: boolean }[] = [];
export const checkpointFiles: { files: string[] } = { files: ["/repo/a.ts"] };
export let closed = 0;
/** Options of each fakeQuery that was closed. */
export const closedQueries: Options[] = [];
/** getContextUsage() answer, shaped like the real one (trimmed; probe in development-docs/GH-27/probe.log). */
export const fakeUsage = {
  totalTokens: 25815,
  maxTokens: 1000000,
  rawMaxTokens: 1000000,
  percentage: 3,
  model: "claude-opus-5-5",
  categories: [
    { name: "System tools", tokens: 5161, color: "inactive", kind: "used" },
    // Deferred by kind only: classify on kind, never on the English name or the optional isDeferred.
    { name: "MCP tools", tokens: 22172, color: "inactive", kind: "deferred" },
    { name: "Messages", tokens: 20654, color: "purple", kind: "used" },
    { name: "Autocompact buffer", tokens: 33000, color: "inactive", kind: "buffer" },
    { name: "Free space", tokens: 941185, color: "promptBorder", kind: "free" },
  ],
};
/** Options of the query each getContextUsage() call went to, and the call's own options. */
export const usageCalls: { options: Options; opts?: object }[] = [];

/** usage_EXPERIMENTAL...() answer, shaped like the real one (trimmed; probe in development-docs/GH-26/probe.log). */
export const fakePlanUsage = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 1, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 55, resets_at: "2026-10-01T11:40:00.938490+00:00" },
    seven_day: { utilization: 44, resets_at: "2026-10-03T17:00:00.938512+00:00" },
    seven_day_opus: null,
    seven_day_sonnet: null,
    // Untyped in SDK 0.3.285's get_usage reply, present in the real one (typed on SDKUsageReport).
    limits: [
      { kind: "session", group: "session", percent: 55, severity: "normal", resets_at: "2026-10-01T11:40:00.938490+00:00", scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 44, severity: "normal", resets_at: "2026-10-03T17:00:00.938512+00:00", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 2, severity: "normal", resets_at: "2026-10-03T16:59:59.938700+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
    ],
  },
};
/** Options of the query each usage_EXPERIMENTAL...() call went to. */
export const planCalls: Options[] = [];

export const fakeCommands = [{ name: "review", description: "Review a PR", argumentHint: "<pr>" }];

export function fakeQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  calls.push(options ?? {});
  const q = (async function* () {
    let turn = 0;
    for await (const m of prompt) {
      inputs.push(m);
      if (m.shouldQuery === false) {
        // A transcript append (F5 of GH-97): init, a replay echo, then an empty result; no turn.
        yield { type: "system", subtype: "init", uuid: randomUUID(), session_id: "x" } as never;
        yield { ...m, session_id: "x", isReplay: true } as never;
        yield { type: "result", subtype: "success", uuid: randomUUID(), session_id: "x", is_error: false, duration_ms: 1, total_cost_usd: 0, result: "", usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [] } as never;
        continue;
      }
      yield* turns[turn++ % 2]!;
    }
  })();
  return Object.assign(q, {
    setModel: async (m?: string) => void setModelCalls.push(m),
    setPermissionMode: async (mode: string) => void controlCalls.push({ setPermissionMode: mode }),
    applyFlagSettings: async (settings: object) => void controlCalls.push({ applyFlagSettings: settings }),
    supportedModels: async () => models,
    supportedCommands: async () => fakeCommands,
    getContextUsage: async (opts?: object) => (usageCalls.push({ options: options ?? {}, opts }), fakeUsage),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => (planCalls.push(options ?? {}), fakePlanUsage),
    async rewindFiles(id: string, o?: { dryRun?: boolean }) {
      rewinds.push({ id, ...o });
      return { canRewind: true, filesChanged: checkpointFiles.files, insertions: 1, deletions: 1 };
    },
    close: () => void (closed++, closedQueries.push(options ?? {}), q.return(undefined)),
  });
}

/** Transcript as `getSessionMessages()` returns it: the fixture's complete messages plus the user prompts. */
export const history = [
  { type: "user", uuid: "u1", session_id: "x", message: { role: "user", content: "first" }, parent_tool_use_id: null, parent_agent_id: null },
  ...turns[0]!.filter((m) => m.type === "assistant"),
  { type: "user", uuid: "u2", session_id: "x", message: { role: "user", content: "second" }, parent_tool_use_id: null, parent_agent_id: null },
  ...turns[1]!.filter((m) => m.type === "assistant"),
] as never[];

/** SDK uuid of the last assistant message of the fixture's first turn: the fork point before the second prompt. */
export const firstTurnLastAssistant = turns[0]!.filter((m) => m.type === "assistant").at(-1)!.uuid;

/** SDK suggestion for a Bash prompt, as the CLI sends it (destination localSettings = `.claude/settings.local.json`). */
export const bashSuggestion: PermissionUpdate = {
  type: "addRules",
  rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
  behavior: "allow",
  destination: "localSettings",
};
export const permissionResults: PermissionResult[] = [];
export const aborts: AbortController[] = [];
/** Assistant messages permissionQuery yielded: what its CLI wrote to the transcript. */
export const yielded: SDKMessage[] = [];

/**
 * Fake query(): each prompt starts a Bash tool call, asks canUseTool, records the answer, then ends the turn. A prompt of JSON
 * `{tool, input, ...options}` asks for that tool call instead, with those canUseTool options.
 */
export function permissionQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  calls.push(options ?? {});
  const q = (async function* () {
    for await (const m of prompt) {
      const text = m.message.content;
      const { tool = "Bash", input = { command: "npm test" }, ...extra } = typeof text === "string" && text.startsWith("{") ? JSON.parse(text) : {};
      const toolUseID = randomUUID();
      const call = {
        type: "assistant",
        uuid: randomUUID(),
        session_id: "x",
        parent_tool_use_id: null,
        message: { id: `msg_${toolUseID}`, content: [{ type: "tool_use", id: toolUseID, name: tool, input }] },
      } as never as SDKMessage;
      yielded.push(call);
      yield call;
      const abort = new AbortController();
      aborts.push(abort);
      const r = await options!.canUseTool!(tool, input, {
        signal: abort.signal,
        suggestions: [bashSuggestion],
        toolUseID,
        requestId: randomUUID(),
        title: "Claude wants to run npm test",
        ...extra,
      });
      permissionResults.push(r!);
      yield turns[0]!.at(-1)!;
    }
  })();
  return Object.assign(q, { supportedCommands: async () => [], close: () => void q.return(undefined) });
}

export const askInput = {
  questions: [
    {
      question: "Which package manager?",
      header: "Manager",
      options: [
        { label: "npm", description: "Default" },
        { label: "pnpm", description: "Faster" },
      ],
      multiSelect: false,
    },
  ],
};

/** Fake query(): each prompt starts an AskUserQuestion tool call, asks canUseTool, records the answer, then ends the turn. */
export function questionQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  calls.push(options ?? {});
  const q = (async function* () {
    for await (const _ of prompt) {
      const toolUseID = randomUUID();
      yield {
        type: "assistant",
        uuid: randomUUID(),
        session_id: "x",
        parent_tool_use_id: null,
        message: { id: `msg_${toolUseID}`, content: [{ type: "tool_use", id: toolUseID, name: "AskUserQuestion", input: askInput }] },
      } as never as SDKMessage;
      const abort = new AbortController();
      aborts.push(abort);
      permissionResults.push((await options!.canUseTool!("AskUserQuestion", askInput, { signal: abort.signal, suggestions: [], toolUseID, requestId: randomUUID() }))!);
      yield turns[0]!.at(-1)!;
    }
  })();
  return Object.assign(q, { supportedCommands: async () => [], close: () => void q.return(undefined) });
}

export const interrupts: number[] = [];

/**
 * Fake query() for steering and interrupt: echoes every input message at once (replay), also mid-turn (steering).
 * Each turn starts a Bash call that runs until interrupt(); a prompt starting with "ask" (permission) or "question" (AskUserQuestion) waits in canUseTool instead,
 * "hi" runs a complete fixture turn; "late" sent mid-turn is taken only after the turn ended. interrupt() ends the turn like the CLI (recorded in development-docs/GH-5/probe2.log).
 */
export function interruptQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  calls.push(options ?? {});
  const out: SDKMessage[] = [];
  let wake = () => {};
  const emit = (m: unknown) => (out.push(m as SDKMessage), wake());
  let stop: (() => void) | undefined;
  let bg: Promise<void> | undefined;
  const turn = async (text: string) => {
    if (text === "hi") return turns[0]!.forEach(emit);
    const toolUseID = randomUUID();
    emit({ type: "assistant", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { id: `msg_${toolUseID}`, content: [{ type: "tool_use", id: toolUseID, name: "Bash", input: { command: "sleep 30" } }] } });
    const abort = new AbortController();
    aborts.push(abort);
    const stopped = new Promise<void>((r) => (stop = () => (abort.abort(), r())));
    if (text.startsWith("ask") || text.startsWith("question")) {
      const [tool, input] = text.startsWith("ask") ? ["Bash", { command: "sleep 30" }] : ["AskUserQuestion", askInput];
      void options!.canUseTool!(tool, input, { signal: abort.signal, suggestions: [], toolUseID, requestId: randomUUID() }).then((r) => permissionResults.push(r!));
    }
    await stopped;
    emit({ type: "user", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } });
    emit({ type: "result", subtype: "error_during_execution", terminal_reason: "aborted_tools", uuid: randomUUID(), session_id: "x", is_error: true, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [] });
  };
  void (async () => {
    let busy = false;
    const take = (m: SDKUserMessage) => {
      emit({ ...m, session_id: "x", isReplay: true });
      if (busy) return;
      busy = true;
      void turn(m.message.content as string).then(() => {
        busy = false;
        if (late) take(late), (late = undefined);
      });
    };
    let late: SDKUserMessage | undefined;
    for await (const m of prompt) {
      inputs.push(m);
      if (busy && m.message.content === "late") late = m;
      else take(m);
    }
  })();
  const q = (async function* () {
    for (;;) {
      while (out.length) yield out.shift()!;
      await new Promise<void>((r) => (wake = r));
    }
  })();
  return Object.assign(q, {
    supportedCommands: async () => [],
    interrupt: async () => (interrupts.push(1), stop?.(), { still_queued: [] }),
    // After a turn the CLI replays its /model echo (recorded in development-docs/FIX-A/model-probe.log).
    setModel: async (m: string) =>
      emit({ type: "user", isReplay: true, uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { role: "user", content: `<local-command-stdout>Set model to \`${m} (claude-${m})\`</local-command-stdout>` } }),
    close: () => void q.return(undefined as never),
  });
}

/** stopTask() calls of subagentQuery. */
export const stopped: string[] = [];

/**
 * Fake query() with a subagent run (shapes of the edit-todo-subagent fixture): each prompt starts Agent call `agent-<n>` (task `task-<n>`),
 * whose child Bash call asks canUseTool; once answered the run waits until stopTask() of its task, which ends it like the CLI
 * (task_notification stopped, then an error tool_result), and the parent turn goes on to its result.
 */
export function subagentQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  calls.push(options ?? {});
  const out: SDKMessage[] = [];
  let wake = () => {};
  const emit = (m: unknown) => (out.push(m as SDKMessage), wake());
  const stops = new Map<string, () => void>();
  let n = 0;
  void (async () => {
    for await (const _ of prompt) {
      const agent = `agent-${++n}`;
      const task = `task-${n}`;
      emit({ type: "assistant", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { id: `msg_${agent}`, content: [{ type: "tool_use", id: agent, name: "Agent", input: { description: "Run tests", prompt: "npm test" } }] } });
      emit({ type: "system", subtype: "task_started", uuid: randomUUID(), session_id: "x", task_id: task, tool_use_id: agent, description: "Run tests", spawn_depth: 1 });
      const bash = randomUUID();
      emit({ type: "assistant", uuid: randomUUID(), session_id: "x", parent_tool_use_id: agent, message: { id: `msg_${bash}`, content: [{ type: "tool_use", id: bash, name: "Bash", input: { command: "npm test" } }] } });
      const abort = new AbortController();
      permissionResults.push((await options!.canUseTool!("Bash", { command: "npm test" }, { signal: abort.signal, suggestions: [], toolUseID: bash, requestId: randomUUID(), agentID: task }))!);
      await new Promise<void>((r) => stops.set(task, r));
      emit({ type: "system", subtype: "task_notification", uuid: randomUUID(), session_id: "x", task_id: task, tool_use_id: agent, status: "stopped", output_file: "", summary: "" });
      emit({ type: "user", uuid: randomUUID(), session_id: "x", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: agent, content: "Agent stopped", is_error: true }] } });
      emit(turns[0]!.at(-1)!);
    }
  })();
  const q = (async function* () {
    for (;;) {
      while (out.length) yield out.shift()!;
      await new Promise<void>((r) => (wake = r));
    }
  })();
  return Object.assign(q, {
    supportedCommands: async () => [],
    stopTask: async (taskId: string) => {
      stopped.push(taskId);
      const stop = stops.get(taskId);
      if (!stop) throw new Error(`no task ${taskId}`);
      stops.delete(taskId);
      stop();
    },
    close: () => void q.return(undefined as never),
  });
}

/**
 * Fake query() for /clear (recorded in development-docs/GH-52/probe-clear.log): replays each input; "/clear" sends
 * conversation_reset, after which the CLI goes on under a new session_id (not new_conversation_id): a hook, init, the
 * /clear echo and a result of cost 0. Any other prompt runs the next fixture turn under the current session_id; "ask" first
 * asks canUseTool. "bg" starts background Bash call `bg` (task `bg-task`) and ends its turn; a /clear while it runs then
 * waits for stopTask() of it, whose task_notification and the CLI's own turn after it come under the new session_id.
 * "notify" ends the background call with its task_notification.
 */
export function clearQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  calls.push(options ?? {});
  let sid = options?.sessionId ?? options?.resume ?? "x";
  let stop: (() => void) | undefined;
  let bg: Promise<void> | undefined;
  const empty = { type: "result", subtype: "success", is_error: false, duration_ms: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [] };
  const q = (async function* () {
    let turn = 0;
    for await (const m of prompt) {
      inputs.push(m);
      if (m.message.content === "bg") {
        bg = new Promise<void>((r) => (stop = r));
        yield { ...m, isReplay: true, session_id: sid } as SDKMessage;
        yield { type: "assistant", uuid: randomUUID(), session_id: sid, parent_tool_use_id: null, message: { id: "msg_bg", content: [{ type: "tool_use", id: "bg", name: "Bash", input: { command: "sleep 60", run_in_background: true } }] } } as never as SDKMessage;
        yield { type: "system", subtype: "task_started", uuid: randomUUID(), session_id: sid, task_id: "bg-task", tool_use_id: "bg", description: "sleep 60", is_backgrounded: true } as never as SDKMessage;
        yield { type: "user", uuid: randomUUID(), session_id: sid, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bg", content: "Command running in background with ID: bg-task" }] } } as SDKMessage;
        yield { ...empty, uuid: randomUUID(), session_id: sid } as never as SDKMessage;
        continue;
      }
      // "notify": the background call's task_notification and a turn of the CLI's own (as for a subagent's hand-back message).
      if (m.message.content === "notify") {
        bg = undefined;
        yield { ...m, isReplay: true, session_id: sid } as SDKMessage;
        yield { type: "system", subtype: "task_notification", uuid: randomUUID(), session_id: sid, task_id: "bg-task", tool_use_id: "bg", status: "completed", output_file: "", summary: "" } as never as SDKMessage;
        yield { ...empty, uuid: randomUUID(), session_id: sid } as never as SDKMessage;
        continue;
      }
      if (m.message.content === "/clear") {
        yield { type: "conversation_reset", new_conversation_id: randomUUID(), trigger: "clear", user_message_uuid: m.uuid, uuid: randomUUID(), session_id: sid } as SDKMessage;
        sid = randomUUID();
        yield { type: "system", subtype: "hook_started", hook_id: "h", hook_name: "SessionStart:clear", hook_event: "SessionStart", uuid: randomUUID(), session_id: sid } as never as SDKMessage;
        yield { type: "system", subtype: "init", terminal_slash_commands: [], permissionMode: "default", uuid: randomUUID(), session_id: sid } as never as SDKMessage;
        yield { ...m, isReplay: true, session_id: sid, message: { role: "user", content: CLEAR_RECORD } } as SDKMessage;
        yield { ...empty, uuid: randomUUID(), session_id: sid } as never as SDKMessage;
        if (bg) {
          await bg;
          bg = undefined;
          yield { type: "system", subtype: "task_notification", uuid: randomUUID(), session_id: sid, task_id: "bg-task", tool_use_id: "bg", status: "stopped", output_file: "", summary: "" } as never as SDKMessage;
          yield { ...empty, uuid: randomUUID(), session_id: sid } as never as SDKMessage;
        }
        continue;
      }
      yield { ...m, isReplay: true, session_id: sid } as SDKMessage;
      // "ask": a permission request of the running CLI.
      if (m.message.content === "ask") permissionResults.push((await options!.canUseTool!("Bash", { command: "ls" }, { signal: new AbortController().signal, suggestions: [], toolUseID: randomUUID(), requestId: randomUUID() }))!);
      for (const t of turns[turn++ % 2]!) yield { ...t, session_id: sid } as SDKMessage;
    }
  })();
  return Object.assign(q, {
    supportedCommands: async () => fakeCommands,
    getContextUsage: async (opts?: object) => (usageCalls.push({ options: options ?? {}, opts }), fakeUsage),
    rewindFiles: async () => ({ canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => fakePlanUsage,
    stopTask: async (taskId: string) => void (stopped.push(taskId), stop?.()),
    close: () => void (closed++, closedQueries.push(options ?? {}), q.return(undefined)),
  });
}

/** How the CLI records a typed /clear, live (its echo) and as the first message of the new transcript. */
export const CLEAR_RECORD = "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>";
