// Fake SDK query(): answers each input message with the next turn of a recorded fixture.
import { readFileSync } from "node:fs";
import type { ModelInfo, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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

export function fakeQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  calls.push(options ?? {});
  const q = (async function* () {
    let turn = 0;
    for await (const _ of prompt) yield* turns[turn++ % 2]!;
  })();
  return Object.assign(q, {
    setModel: async (m?: string) => void setModelCalls.push(m),
    supportedModels: async () => models,
    close: () => void q.return(undefined),
  });
}

/** Transcript as `getSessionMessages()` returns it: the fixture's complete messages plus the user prompts. */
export const history = [
  { type: "user", uuid: "u1", session_id: "x", message: { role: "user", content: "first" }, parent_tool_use_id: null, parent_agent_id: null },
  ...turns[0]!.filter((m) => m.type === "assistant"),
  { type: "user", uuid: "u2", session_id: "x", message: { role: "user", content: "second" }, parent_tool_use_id: null, parent_agent_id: null },
  ...turns[1]!.filter((m) => m.type === "assistant"),
] as never[];
