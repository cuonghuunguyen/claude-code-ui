// A fake Claude Code CLI for the scenarios that need what the real CLI does only sometimes (the Next for you suggestion): the daemon's Claude
// sessions run it in place of the SDK's bundled CLI when CLAUDE_UI_E2E_CLAUDE_CLI names this file (claude-engine.ts). It speaks the SDK's stream-json
// protocol on stdin/stdout and makes no model call. Run by the SDK as `node <this file> ...` (a .mjs path).
// A prompt: echo (replay-user-messages), system init, then the turn waits until the file FAKE_CLAUDE_GATE/next exists. The scenario writes it: its
// text is the prompt suggestion the CLI sends after the turn (assistant reply "Done.", result). Every control request is answered: initialize with
// empty lists, get_context_usage with an error (the daemon logs it), the rest with success.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sessionId = arg("--session-id") ?? arg("--resume") ?? randomUUID();
let mode = arg("--permission-mode") ?? "default";
const gate = process.env.FAKE_CLAUDE_GATE;
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let turns = 0;
let hookId; // hooks.PreToolUse[0].hookCallbackIds[0] of the initialize request (the daemon's one-shot approval hook, GH-711)
const waiting = new Map(); // request_id -> resolve of a control request this CLI sent to the SDK
const DENY = "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Git Destructive].";
const COMMAND = "git push --force origin main";
const textOf = (user) => {
  const c = user.message?.content;
  return typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text ?? "").join("\n") : "";
};

/** Waits for the scenario's go: the gate file's text is the suggestion. */
async function released() {
  const file = join(gate ?? ".", "next");
  for (;;) {
    if (gate && existsSync(file)) {
      const text = readFileSync(file, "utf8").trim();
      rmSync(file, { force: true });
      return text;
    }
    await sleep(50);
  }
}

async function turn(user) {
  const n = ++turns;
  out({ ...user, session_id: sessionId, uuid: user.uuid ?? randomUUID(), isReplay: true });
  out({ type: "system", subtype: "init", uuid: randomUUID(), session_id: sessionId, cwd: process.cwd(), model: "claude-haiku-4-5", permissionMode: mode, tools: [], mcp_servers: [], slash_commands: [], terminal_slash_commands: [], agents: [], skills: [], plugins: [], apiKeySource: "none", claude_code_version: "0.0.0-fake", output_style: "default" });
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const prompt = textOf(user);
  const retry = prompt.startsWith("Auto mode denied your");
  if (prompt.includes("DENY-PROBE") || retry) await bashCall(n, retry, usage);
  const suggestion = await released();
  out({ type: "assistant", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, message: { id: `msg_fake_${n}`, type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", stop_sequence: null, usage } });
  out({ type: "result", subtype: "success", uuid: randomUUID(), session_id: sessionId, is_error: false, duration_ms: 5, duration_api_ms: 5, num_turns: 1, result: "Done.", stop_reason: "end_turn", total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [] });
  if (suggestion) out({ type: "prompt_suggestion", suggestion, uuid: randomUUID(), session_id: sessionId });
}

const toolResult = (id, content, isError) => out({ type: "user", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, ...(isError ? { is_error: true } : {}), content }] } });
const denied = (id) => {
  out({ type: "system", subtype: "permission_denied", uuid: randomUUID(), session_id: sessionId, tool_name: "Bash", tool_use_id: id, decision_reason_type: "classifier", decision_reason: "[Git Destructive]", message: "denied" });
  toolResult(id, DENY, true);
};

/** Allow and retry (GH-711): the first Bash call is denied by the auto mode classifier; the retry asks the SDK's PreToolUse hook first. */
async function bashCall(n, retry, usage) {
  const id = `dn-${n}`;
  const input = { command: COMMAND, description: retry ? "Retry the force push" : "Force push main" };
  out({ type: "assistant", uuid: randomUUID(), session_id: sessionId, parent_tool_use_id: null, message: { id: `msg_fake_tool_${n}`, type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "tool_use", id, name: "Bash", input }], stop_reason: "tool_use", stop_sequence: null, usage } });
  let allowed = false;
  if (retry && hookId) {
    const request_id = randomUUID();
    const answer = new Promise((resolve) => waiting.set(request_id, resolve));
    out({ type: "control_request", request_id, request: { subtype: "hook_callback", callback_id: hookId, tool_use_id: id, input: { hook_event_name: "PreToolUse", session_id: sessionId, transcript_path: "", cwd: process.cwd(), tool_name: "Bash", tool_input: input, tool_use_id: id } } });
    const r = await answer;
    allowed = r?.hookSpecificOutput?.permissionDecision === "allow";
  }
  if (allowed) toolResult(id, "ran", false);
  else denied(id);
}

function control(m) {
  const { subtype } = m.request;
  if (subtype === "set_permission_mode") mode = m.request.mode;
  const ok = (response) => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
  if (subtype === "initialize") hookId = m.request.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0];
  if (subtype === "initialize") return ok({ commands: [], agents: [], models: [], account: {}, output_style: "default", available_output_styles: ["default"] });
  if (subtype === "get_context_usage") return out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "the fake CLI has no context usage" } });
  return ok({});
}

// Turns run one after another, like the CLI's own queue.
let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === "control_response") waiting.get(m.response?.request_id)?.(m.response?.response);
  else if (m.type === "control_request") control(m);
  else if (m.type === "user") queue = queue.then(() => turn(m));
}).on("close", () => process.exit(0));
