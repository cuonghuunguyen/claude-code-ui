// A local OpenAI-compatible chat model for the OpenCode 2 scenarios: no login and no provider. It answers by what the last user prompt names, so a
// scenario drives OpenCode's tools without a real model. Pure (no Playwright import).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Message = { role: string; content?: unknown };
const textOf = (m?: Message) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? (m.content as { text?: string }[]).map((c) => c.text ?? "").join("") : "");

/**
 * The model's turn for one request: after a tool result "done"; an inline task's own session (its system text) answers "inline answer"; a prompt naming
 * "inline task" calls claude-ui's `inline_task` (as OpenCode names it: `claude-ui-<id>_inline_task`); one naming "echo" runs `echo hi` with the shell tool;
 * anything else "OK". A request without tools (a title) answers "Scratch".
 */
export function fakeTurn(body: { messages?: Message[]; tools?: { function?: { name?: string } }[] }): { text: string } | { tool: string; args: Record<string, unknown> } {
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? "");
  const messages = body.messages ?? [];
  const user = textOf([...messages].reverse().find((m) => m.role === "user"));
  if (messages.at(-1)?.role === "tool") return { text: "done" };
  if (!tools.length) return { text: "Scratch" };
  if (messages.some((m) => textOf(m).includes("You run one delegated task"))) return { text: "inline answer" };
  const inline = tools.find((t) => /^claude-ui-.+_inline_task$/.test(t));
  if (/inline task/i.test(user)) return inline ? { tool: inline, args: { prompt: "Say hi", tools: ["Read"] } } : { text: "no inline_task tool" };
  if (/echo/i.test(user) && tools.includes("shell")) return { tool: "shell", args: { command: "echo hi", description: "Print hi" } };
  return { text: "OK" };
}

export type FakeModel = { port: number; stop: () => Promise<void> };

export async function startFakeModel(): Promise<FakeModel> {
  let n = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const turn = fakeTurn(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if ("text" in turn) (send({ role: "assistant", content: turn.text }), send({}, "stop"));
      else (send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${++n}`, type: "function", function: { name: turn.tool, arguments: JSON.stringify(turn.args) } }] }), send({}, "tool_calls"));
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, stop: () => new Promise((r) => server.close(() => r())) };
}

/** The OpenCode config (opencode.json) of a fake model on `port`: provider `fake`, model `m`, the default. */
export const fakeModelConfig = (port: number) => ({
  $schema: "https://opencode.ai/config.json",
  provider: { fake: { npm: "@ai-sdk/openai-compatible", name: "Fake", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "x" }, models: { m: { name: "Fake M", tool_call: true } } } },
  model: "fake/m",
});
