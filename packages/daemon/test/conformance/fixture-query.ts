// A generic SDK query() player for the conformance suite: answers each input message with the next turn (up to a `result`) of a recorded Claude fixture.
// fake-query.ts is hard-wired to one fixture and to hand-built queries; this takes any recording of packages/protocol/test/fixtures.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fakeUsage } from "../fake-query.ts";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export function fixtureTurns(file: URL): SDKMessage[][] {
  const turns: SDKMessage[][] = [[]];
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const m = JSON.parse(line) as SDKMessage;
    turns.at(-1)!.push(m);
    if (m.type === "result") turns.push([]);
  }
  return turns.filter((t) => t.length > 0);
}

/** `query` option of a Session: turn n of the fixture answers the n-th prompt. */
export const fixtureQuery = (file: URL) => {
  const turns = fixtureTurns(file);
  return ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
    // close() ends the wait for the next prompt, as the real query ends when its input closes: the Session's close() waits for the loop.
    let stop!: () => void;
    const stopped = new Promise<{ done: true; value: undefined }>((r) => (stop = () => r({ done: true, value: undefined })));
    const input = prompt[Symbol.asyncIterator]();
    const q = (async function* () {
      let n = 0;
      for (;;) {
        const next = await Promise.race([input.next(), stopped]);
        if (next.done) return;
        const m = next.value;
        if (m.shouldQuery === false) {
          // A transcript append (bash mode: the CLI is told of the command, no turn): init, the replay echo, an empty result.
          yield { type: "system", subtype: "init", uuid: randomUUID(), session_id: "x" } as never;
          yield { ...m, session_id: "x", isReplay: true } as never;
          yield { type: "result", subtype: "success", uuid: randomUUID(), session_id: "x", is_error: false, duration_ms: 1, total_cost_usd: 0, result: "", usage: { input_tokens: 0, output_tokens: 0 }, permission_denials: [] } as never;
          continue;
        }
        const turn = turns[n++];
        if (!turn) throw new Error(`fixture has no turn ${n}`);
        yield* turn;
      }
    })();
    return Object.assign(q, {
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {},
      supportedModels: async () => [],
      supportedCommands: async () => [],
      getContextUsage: async () => fakeUsage,
      close: stop,
    });
  };
};
