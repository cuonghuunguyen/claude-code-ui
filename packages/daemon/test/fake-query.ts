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
    close: () => void (closed++, q.return(undefined)),
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

/** Fake query(): each prompt starts a Bash tool call, asks canUseTool, records the answer, then ends the turn. */
export function permissionQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  calls.push(options ?? {});
  const q = (async function* () {
    for await (const _ of prompt) {
      const toolUseID = randomUUID();
      yield {
        type: "assistant",
        uuid: randomUUID(),
        session_id: "x",
        parent_tool_use_id: null,
        message: { id: `msg_${toolUseID}`, content: [{ type: "tool_use", id: toolUseID, name: "Bash", input: { command: "npm test" } }] },
      } as never as SDKMessage;
      const abort = new AbortController();
      aborts.push(abort);
      const r = await options!.canUseTool!("Bash", { command: "npm test" }, {
        signal: abort.signal,
        suggestions: [bashSuggestion],
        toolUseID,
        requestId: randomUUID(),
        title: "Claude wants to run npm test",
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
