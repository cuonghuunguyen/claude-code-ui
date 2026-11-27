// A generic SDK query() player for the conformance suite: answers each input message with the next turn (up to a `result`) of a recorded Claude fixture.
// fake-query.ts is hard-wired to one fixture and to hand-built queries; this takes any recording of packages/protocol/test/fixtures.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fakeUsage } from "../fake-query.ts";
import type { CanUseTool, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/** A line of the recorder (scripts/record-fixture.ts) that is not an SDK message: the engine asked `canUseTool`, or the recorder pressed Stop. */
export type RecorderLine = { type: "__can_use_tool"; toolName: string; toolUseID: string; input: Record<string, unknown> } | { type: "__action"; action: "interrupt" };
type Line = SDKMessage | RecorderLine;

export function fixtureTurns(file: URL): Line[][] {
  const turns: Line[][] = [[]];
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const m = JSON.parse(line) as Line;
    turns.at(-1)!.push(m);
    if (m.type === "result") turns.push([]);
  }
  return turns.filter((t) => t.length > 0);
}

/** `query` option of a Session: turn n of the fixture answers the n-th prompt. */
export const fixtureQuery = (file: URL) => {
  const turns = fixtureTurns(file);
  return ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options?: { canUseTool?: CanUseTool } }) => {
    // The recorder's Stop: the turn goes on after the engine called interrupt().
    let interrupted!: () => void;
    const stopPressed = new Promise<void>((r) => (interrupted = r));
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
        for (const line of turn) {
          if (line.type === "__can_use_tool") {
            // The engine's own answer decides what follows; the recorded reply is not compared (the scenario drives the reply).
            if (!options?.canUseTool) throw new Error("the fixture asks canUseTool, the query has none");
            await options.canUseTool(line.toolName, line.input, { signal: new AbortController().signal, suggestions: [], toolUseID: line.toolUseID, requestId: randomUUID() } as never);
          } else if (line.type === "__action") {
            if (line.action !== "interrupt") throw new Error(`unknown recorder action ${line.action}`);
            await Promise.race([stopPressed, stopped]);
          } else yield line;
        }
      }
    })();
    return Object.assign(q, {
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {},
      supportedModels: async () => [],
      supportedCommands: async () => [],
      getContextUsage: async () => fakeUsage,
      interrupt: async () => interrupted(),
      close: stop,
    });
  };
};
