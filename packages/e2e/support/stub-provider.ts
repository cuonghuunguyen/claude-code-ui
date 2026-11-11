// A local OpenAI-compatible model provider that answers by a mode the scenario sets (GH-683: retry and unavailable-model states). No Playwright import.
import { createServer, type Server } from "node:http";

export type StubMode =
  | { kind: "ok" }
  /** 429 / 503 with `retry-after` (seconds), the failure OpenCode retries. */
  | { kind: "retry"; status: 429 | 503; retryAfter: number; message: string }
  /** 404 `model_not_found`: no retry. */
  | { kind: "model-404"; message: string };

export interface StubProvider {
  port: number;
  mode: StubMode;
  /** Chat-completion requests received so far, with the mode that answered each. */
  requests: { at: number; mode: string }[];
  stop(): Promise<void>;
}

export async function startStubProvider(): Promise<StubProvider> {
  const stub: StubProvider = { port: 0, mode: { kind: "ok" }, requests: [], stop: async () => undefined };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const mode = stub.mode;
      if (req.url?.includes("/models")) {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ data: [{ id: "m1" }] }));
      }
      stub.requests.push({ at: Date.now(), mode: mode.kind === "retry" ? String(mode.status) : mode.kind });
      if (mode.kind === "retry") {
        res.writeHead(mode.status, { "content-type": "application/json", "retry-after": String(mode.retryAfter) });
        return void res.end(JSON.stringify({ error: { message: mode.message, type: mode.status === 429 ? "rate_limit_error" : "server_error" } }));
      }
      if (mode.kind === "model-404") {
        res.writeHead(404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: { message: mode.message, type: "invalid_request_error", code: "model_not_found" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish?: string) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "Hello " }));
      res.write(chunk({ content: "from the stub." }));
      res.write(chunk({}, "stop"));
      res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  stub.port = typeof addr === "object" && addr ? addr.port : 0;
  stub.stop = () =>
    new Promise<void>((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    });
  return stub;
}

/** The OpenCode config (`<config home>/opencode/opencode.json`) that declares the stub as provider `stub` with the one model `m1`, and makes `model` the default. */
export const stubOpenCodeConfig = (port: number, model: string) => ({
  model,
  small_model: "stub/m1",
  provider: { stub: { npm: "@ai-sdk/openai-compatible", name: "Stub", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "stub" }, models: { m1: { name: "m1" } } } },
});
