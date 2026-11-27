// Records raw SDK messages of a real multi-turn streaming session into a JSONL fixture for adapter and conformance tests.
// Usage: npm run record-fixture -w @claude-ui/daemon -- <out.jsonl> [prompt...]                      plain turns (the prompts, or two default ones)
//        npm run record-fixture -w @claude-ui/daemon -- <out.jsonl> --scenario permission|question|interrupt
// Scenario runs add two kinds of line to the SDK messages, in the order they happened (see scripts/README.md):
//   {"type":"__can_use_tool","toolName","toolUseID","input","reply"}  the SDK asked `canUseTool` and the recorder answered `reply`
//   {"type":"__action","action":"interrupt"}                           the recorder called `query.interrupt()`
// Subscription login only (ADR 0002): the run refuses to start while an API key variable is set.
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { query, type CanUseTool, type PermissionResult, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type Scenario = { prompts: string[]; canUseTool?: (tool: string, input: Record<string, unknown>) => PermissionResult; interruptAfterDeltas?: number };

const SCENARIOS: Record<string, Scenario> = {
  // A Bash call that writes (a read-only one such as echo runs without asking): the CLI asks, the recorder allows once.
  permission: {
    prompts: ["Run the shell command `touch conformance.txt` with the Bash tool, then confirm in one short sentence. Use no other tool."],
    canUseTool: (_tool, input) => ({ behavior: "allow", updatedInput: input }),
  },
  // AskUserQuestion: the recorder picks the first option of every question.
  question: {
    prompts: ["Use the AskUserQuestion tool to ask me whether I prefer red or blue (those two options). After my answer reply with one short sentence. Use no other tool."],
    canUseTool: (tool, input) => {
      if (tool !== "AskUserQuestion") return { behavior: "allow", updatedInput: input };
      const questions = (input as { questions: { question: string; options: { label: string }[] }[] }).questions;
      return { behavior: "allow", updatedInput: { questions, answers: Object.fromEntries(questions.map((q) => [q.question, q.options[0]!.label])) } };
    },
  },
  // A long answer, stopped by query.interrupt() after a few text deltas.
  interrupt: { prompts: ["Write a 600 word essay about rivers. Do not use tools."], interruptAfterDeltas: 3 },
};

const argv = process.argv.slice(2);
const flag = argv.indexOf("--scenario");
const name = flag >= 0 ? argv.splice(flag, 2)[1] : undefined;
const scenario = name ? SCENARIOS[name] : undefined;
if (name && !scenario) (console.error(`unknown scenario ${name}; one of ${Object.keys(SCENARIOS).join(", ")}`), process.exit(2));

const out = argv[0] ?? "fixture.jsonl";
const defaultPrompts = [
  "Reply with a markdown heading, a 3-item bullet list and a short ts code block about seq numbers. Do not use tools.",
  "Now reply with exactly one short sentence. Do not use tools.",
];
const prompts = scenario?.prompts ?? (argv.length > 1 ? argv.slice(1) : defaultPrompts);

for (const v of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) if (process.env[v]) (console.error(`${v} is set: unset it, recordings use the subscription login`), process.exit(2));

let next: (() => void) | undefined;
async function* input(): AsyncGenerator<SDKUserMessage> {
  for (const text of prompts) {
    yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    await new Promise<void>((r) => (next = r));
  }
}

const lines: string[] = [];
const canUseTool: CanUseTool | undefined = scenario?.canUseTool
  ? async (toolName, toolInput, o) => {
      const reply = scenario.canUseTool!(toolName, toolInput);
      lines.push(JSON.stringify({ type: "__can_use_tool", toolName, toolUseID: o.toolUseID, input: toolInput, reply }));
      return reply;
    }
  : undefined;

// A scratch folder: a recorded Bash call must not touch a real project.
const cwd = scenario ? realpathSync(mkdtempSync(join(tmpdir(), "record-claude-"))) : process.cwd();
const q = query({
  prompt: input(),
  options: {
    sessionId: randomUUID(),
    cwd,
    ...(scenario ? { model: "haiku", permissionMode: "default" as const } : {}),
    ...(canUseTool && { canUseTool }),
    includePartialMessages: true,
    settingSources: [],
    extraArgs: { "thinking-display": "summarized" },
  },
});
let turns = 0;
let deltas = 0;
let interrupted = false;
for await (const m of q as AsyncIterable<SDKMessage>) {
  lines.push(JSON.stringify(m));
  if (m.type === "system" && m.subtype === "init") console.error("apiKeySource:", m.apiKeySource);
  if (scenario?.interruptAfterDeltas && !interrupted && m.type === "stream_event" && (m.event as { delta?: { type?: string } }).delta?.type === "text_delta" && ++deltas >= scenario.interruptAfterDeltas) {
    interrupted = true;
    lines.push(JSON.stringify({ type: "__action", action: "interrupt" }));
    await q.interrupt();
  }
  if (m.type === "result") {
    console.error("result:", m.subtype, m.duration_ms, m.total_cost_usd);
    if (++turns === prompts.length) break;
    next?.();
  }
}
// Machine-specific text of a scenario run: the scratch folder (also in its dashed form, the CLI's project key) is named /work/proj, the home folder /home/user, the CLI's temp folder /tmp/claude-user.
// The CLI's scratchpad folder carries the user id (`/private/tmp/claude-<uid>/...`): named /tmp/claude-user.
const text = (scenario ? lines.join("\n").replaceAll(cwd, "/work/proj").replaceAll(cwd.replaceAll("/", "-"), "-work-proj").replaceAll(homedir(), "/home/user").replace(/\/private\/tmp\/claude-\d+/g, "/tmp/claude-user") : lines.join("\n")) + "\n";
writeFileSync(out, text);
console.error(`wrote ${lines.length} lines to ${out}`);
