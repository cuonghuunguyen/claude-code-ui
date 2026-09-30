// Fake SDK query(): answers each input message with the next turn of a recorded fixture.
import { readFileSync } from "node:fs";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

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

export function fakeQuery({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  calls.push(options ?? {});
  return (async function* () {
    let turn = 0;
    for await (const _ of prompt) yield* turns[turn++ % 2]!;
  })();
}
