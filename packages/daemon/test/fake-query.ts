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
export const models: ModelInfo[] = [
  { value: "default", displayName: "Default (recommended)", description: "" },
  { value: "haiku", displayName: "Haiku 4.5", description: "" },
];
export const inputs: SDKUserMessage[] = [];
/** rewindFiles() calls, and the files each dry run reports (set per test). */
export const rewinds: { id: string; dryRun?: boolean }[] = [];
export const checkpointFiles: { files: string[] } = { files: ["/repo/a.ts"] };
export let closed = 0;

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
    supportedModels: async () => models,
    supportedCommands: async () => fakeCommands,
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
