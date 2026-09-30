// Records raw SDK messages of a real two-turn streaming session into a JSONL fixture for adapter tests.
// Usage: npm run record-fixture -w @claude-ui/daemon -- <out.jsonl>
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const out = process.argv[2] ?? "fixture.jsonl";
const prompts = [
  "Reply with a markdown heading, a 3-item bullet list and a short ts code block about seq numbers. Do not use tools.",
  "Now reply with exactly one short sentence. Do not use tools.",
];

let next: (() => void) | undefined;
async function* input(): AsyncGenerator<SDKUserMessage> {
  for (const text of prompts) {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    await new Promise<void>((r) => (next = r));
  }
}

const lines: string[] = [];
const q = query({
  prompt: input(),
  options: { sessionId: randomUUID(), cwd: process.cwd(), includePartialMessages: true, settingSources: [] },
});
let turns = 0;
for await (const m of q) {
  lines.push(JSON.stringify(m));
  if (m.type === "system" && m.subtype === "init") console.error("apiKeySource:", m.apiKeySource);
  if (m.type === "result") {
    console.error("result:", m.subtype, m.duration_ms, m.total_cost_usd);
    if (++turns === prompts.length) break;
    next?.();
  }
}
writeFileSync(out, lines.join("\n") + "\n");
console.error(`wrote ${lines.length} messages to ${out}`);
