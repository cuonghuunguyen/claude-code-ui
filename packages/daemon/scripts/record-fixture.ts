// Records raw SDK messages of a real multi-turn streaming session into a JSONL fixture for adapter and conformance tests.
// Usage: npm run record-fixture -w @claude-ui/daemon -- <out.jsonl> [prompt...]                      plain turns (the prompts, or two default ones)
//        npm run record-fixture -w @claude-ui/daemon -- <out.jsonl> --scenario permission|question|interrupt|subagent|inline
// Scenario runs add two kinds of line to the SDK messages, in the order they happened (see scripts/README.md):
//   {"type":"__can_use_tool","toolName","toolUseID","input","reply"}  the SDK asked `canUseTool` and the recorder answered `reply`
//   {"type":"__action","action":"interrupt"}                           the recorder called `query.interrupt()`
// Subscription login only (ADR 0002): the run refuses to start while an API key variable is set.
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { query, type CanUseTool, type PermissionResult, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { runInlineClaude, type InlineClaudeDeps } from "../src/inline-claude.ts";

type Scenario = { prompts: string[]; canUseTool?: (tool: string, input: Record<string, unknown>) => PermissionResult; interruptAfterDeltas?: number; /** The prompt runs as an inline task of the daemon (inline-claude.ts), not as a session turn: the file holds the messages of that run's query. */ inline?: boolean };

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
  // A subagent (Agent tool) that reads a file of the scratch folder (a read in the folder asks for no permission).
  subagent: { prompts: ["Start one subagent with the Agent tool (type general-purpose, run in the foreground: run_in_background false) that reads the file notes.txt with its Read tool and reports the first line. After it reported, reply with one short sentence. Use no other tool."], canUseTool: (_tool, input) => ({ behavior: "allow", updatedInput: input }) },
  // The query of an inline task run: the daemon's own runner (runInlineClaude) with the real SDK, granted Read only.
  inline: { prompts: ["Read the file notes.txt and reply with its first line in one short sentence."], canUseTool: (_tool, input) => ({ behavior: "allow", updatedInput: input }), inline: true },
};

const argv = process.argv.slice(2);
const flag = argv.indexOf("--scenario");
const name = flag >= 0 ? argv.splice(flag, 2)[1] : undefined;
if (flag >= 0 && !name) (console.error("--scenario needs a name"), process.exit(2));
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
// The subagent and inline scenarios read this file.
if (scenario) writeFileSync(join(cwd, "notes.txt"), "first line of the notes\nsecond line\n");
if (scenario?.inline) {
  // The runner calls `query` once with the prompt text; the messages it reads are the recording.
  const tee: InlineClaudeDeps["query"] = (p) => {
    const inner = query(p);
    const gen = (async function* () {
      for await (const m of inner) {
        lines.push(JSON.stringify(m));
        yield m;
      }
    })();
    return Object.assign(gen, { close: () => inner.close() }) as never;
  };
  const text = prompts[0]!;
  const result = await runInlineClaude(
    {
      query: tee,
      parent: () => ({ cwd, permissionMode: "default", allowBypass: false }),
      parentQuery: () => undefined,
      defaultModel: () => "haiku",
      emit: () => {},
      canUseTool: async (toolName, toolInput, o) => {
        const reply = scenario.canUseTool!(toolName, toolInput);
        lines.push(JSON.stringify({ type: "__can_use_tool", toolName, toolUseID: o.toolUseID, input: toolInput, reply }));
        return reply;
      },
      gitDirty: async () => undefined,
      env: () => process.env,
      runs: new Map(),
    },
    { text, title: text.slice(0, 60), tools: ["Read"], mcp: [], maxTurns: 5, model: "haiku" },
    { signal: new AbortController().signal, toolUseId: "toolu_inline" },
  );
  console.error("inline result:", result.status, result.turns, result.model);
} else {
const q = query({
  prompt: input(),
  options: {
    sessionId: randomUUID(),
    cwd,
    ...(scenario ? { model: "haiku", permissionMode: "default" as const } : {}),
    ...(canUseTool && { canUseTool }),
    includePartialMessages: true,
    ...(scenario ? { forwardSubagentText: true, env: { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", CLAUDE_CODE_ENABLE_TASKS: "0", CLAUDE_CODE_FORK_SUBAGENT: "0" } } : {}),
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
}
// Machine-specific text of a scenario run: the scratch folder (also in its dashed form, the CLI's project key) is named /work/proj, the home folder /home/user, the CLI's temp folder /tmp/claude-user.
// The CLI's scratchpad folder carries the user id (`/private/tmp/claude-<uid>/...`): named /tmp/claude-user.
const text = (scenario ? lines.join("\n").replaceAll(cwd, "/work/proj").replaceAll(cwd.replaceAll("/", "-"), "-work-proj").replaceAll(homedir(), "/home/user").replace(/\/private\/tmp\/claude-\d+/g, "/tmp/claude-user") : lines.join("\n")) + "\n";
writeFileSync(out, text);
console.error(`wrote ${lines.length} lines to ${out}`);
