// MCP servers dialog requests (docs/spec.md "Config dialogs"): live or config query, redaction, CLI argv, config.changed.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerMessage } from "@claude-ui/protocol";
import { TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL } from "@claude-ui/protocol";
import { createDaemon } from "../src/server.ts";
import { fakeQuery } from "./fake-query.ts";

const webRoot = mkdtempSync(join(tmpdir(), "web-"));
const project = realpathSync(mkdtempSync(join(tmpdir(), "mcp-")));
// No session ever runs here: every query in it is a config query.
const quiet = realpathSync(mkdtempSync(join(tmpdir(), "mcp-quiet-")));
const token = "t0ken-for-tests_abcdefghijklmnopqrstuvwxyz0";

/** As `mcpServerStatus()` answers, with secrets in config and full tool entries. */
const statuses = [
  { name: "ctx", status: "connected", scope: "user", config: { type: "http", url: "https://u:SECRET@mcp.example/mcp?key=SECRET&team=SECRET#top", headers: { Authorization: "Bearer SECRET" } }, tools: [{ name: "search", description: "Search docs", annotations: { readOnly: true, openWorld: true } }, { name: "drop", annotations: { destructive: true } }] },
  { name: "broken", status: "failed", scope: "project", error: "Connection closed", config: { type: "stdio", command: "false", args: ["--token", "SECRET"], env: { API_KEY: "SECRET" } } },
  { name: "drive", status: "needs-auth", scope: "claudeai", config: { type: "claudeai-proxy", url: "https://claude.ai/x", id: "mcprs_1" } },
  { name: "host", status: "connected", source: "sdk", config: { type: "sdk", name: "host" } },
  { name: "noconfig", status: "pending" },
];
type Call = { call: string; args: unknown[]; options: Options };
const mcpCalls: Call[] = [];
const started: Options[] = [];
const closedQueries: Options[] = [];

function mcpQuery(args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) {
  const options = args.options ?? {};
  started.push(options);
  const q = fakeQuery(args);
  const rec = (call: string, answer: (...a: unknown[]) => unknown = () => undefined) =>
    async (...a: unknown[]) => (mcpCalls.push({ call, args: a, options }), answer(...a));
  const close = q.close;
  return Object.assign(q, {
    mcpServerStatus: rec("mcpServerStatus", () => structuredClone(statuses)),
    toggleMcpServer: rec("toggleMcpServer"),
    reconnectMcpServer: rec("reconnectMcpServer"),
    mcpAuthenticate: rec("mcpAuthenticate", () => ({ authUrl: "https://auth.example/authorize?state=s", requiresUserAction: true, callbackExpected: true })),
    mcpClearAuth: rec("mcpClearAuth"),
    mcpSubmitOAuthCallbackUrl: rec("mcpSubmitOAuthCallbackUrl", (_n, url) => {
      if (!String(url).includes("code=")) throw new Error("Invalid callback URL — no authorization code, or it belongs to a different sign-in attempt (state mismatch). The flow is still open; retry");
    }),
    close: () => (closedQueries.push(options), close()),
  });
}

const cliCalls: { args: string[]; cwd: string }[] = [];
const cliResult = { code: 0, stdout: "", stderr: "" };
const HOLD_MS = 300;
const http = createDaemon({
  webRoot,
  roots: [webRoot, project, quiet],
  query: mcpQuery as never,
  token,
  cli: async (args, cwd) => (cliCalls.push({ args, cwd }), { ...cliResult }),
  configHoldMs: HOLD_MS,
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const { port } = http.address() as AddressInfo;
afterAll(() => void http.close());

function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [WS_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], { origin: `http://127.0.0.1:${port}` });
  const inbox: ServerMessage[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  const waitFor = (pred: (m: ServerMessage) => boolean) =>
    new Promise<ServerMessage>((resolve) => {
      const t = setInterval(() => {
        const m = inbox.find(pred);
        if (m) clearInterval(t), resolve(m);
      }, 5);
    });
  const request = async (msg: object) => {
    const reqId = Math.random().toString(36);
    ws.send(JSON.stringify({ ...msg, reqId }));
    return (await waitFor((m) => (m.type === "reply" || m.type === "error") && m.reqId === reqId)) as { type: string; result?: unknown; code?: string; message?: string };
  };
  return new Promise<{ ws: WebSocket; request: typeof request; inbox: ServerMessage[] }>((resolve) => ws.once("open", () => resolve({ ws, request, inbox })));
}

const configQueries = () => started.filter((o) => o.cwd === quiet);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mcp.*", () => {
  it("lists a live session's servers from its query, without sdk servers, servers without config, headers, env or tool descriptions", async () => {
    const c = await client();
    const { result } = (await c.request({ type: "session.create", cwd: project })) as unknown as { result: { session: { id: string } } };
    const id = result.session.id;
    await c.request({ type: "session.subscribe", sessionId: id, sinceSeq: 0 });
    await c.request({ type: "session.prompt", sessionId: id, text: "hi" });
    const r = await c.request({ type: "mcp.list", cwd: project, sessionId: id });
    expect(mcpCalls.at(-1)).toMatchObject({ call: "mcpServerStatus", options: { sessionId: id } });
    expect(r.result).toEqual({
      servers: [
        // Query-string values and a password in the URL may be tokens too.
        { name: "ctx", status: "connected", scope: "user", config: { type: "http", url: "https://u:***@mcp.example/mcp?key=***&team=***#top" }, tools: [{ name: "search", readOnly: true }, { name: "drop", destructive: true }] },
        { name: "broken", status: "failed", scope: "project", error: "Connection closed", config: { type: "stdio", command: "false" } },
        { name: "drive", status: "needs-auth", scope: "claudeai", config: { type: "claudeai-proxy", url: "https://claude.ai/x" } },
      ],
    });
    expect(JSON.stringify(r)).not.toContain("SECRET");
    c.ws.close();
  });

  it("without a live query starts one config query in the cwd, reuses it, and closes it after the hold", async () => {
    const c = await client();
    const before = configQueries().length;
    await c.request({ type: "mcp.list", cwd: quiet });
    await c.request({ type: "mcp.list", cwd: quiet, sessionId: "not-a-session" });
    expect(configQueries().length).toBe(before + 1);
    const q = configQueries().at(-1)!;
    expect(q).toMatchObject({ persistSession: false, settings: { disableAllHooks: true } });
    expect(closedQueries).not.toContain(q);
    await sleep(HOLD_MS + 100);
    expect(closedQueries).toContain(q);
    // The next request starts a new one.
    await c.request({ type: "mcp.list", cwd: quiet });
    expect(configQueries().length).toBe(before + 2);
    c.ws.close();
  });

  it("drops the held config query after a successful add or remove, so the next list sees the new config", async () => {
    const c = await client();
    await c.request({ type: "mcp.list", cwd: quiet });
    const before = configQueries().length;
    await c.request({ type: "mcp.add", cwd: quiet, name: "fresh", scope: "local", config: { transport: "http", url: "https://x.example/mcp", headers: [] } });
    const stale = configQueries().at(-1)!;
    expect(closedQueries).toContain(stale);
    await c.request({ type: "mcp.list", cwd: quiet });
    expect(configQueries().length).toBe(before + 1);
    await c.request({ type: "mcp.remove", cwd: quiet, name: "fresh", scope: "local" });
    await c.request({ type: "mcp.list", cwd: quiet });
    expect(configQueries().length).toBe(before + 2);
    c.ws.close();
  });

  it("an add or remove does not end an OAuth flow waiting on the held config query: its callback still reaches that query", async () => {
    const c = await client();
    await sleep(HOLD_MS + 100);
    const before = configQueries().length;
    await c.request({ type: "mcp.authenticate", cwd: quiet, name: "ctx" });
    const flow = configQueries().at(-1)!;
    expect(configQueries().length).toBe(before + 1);
    await c.request({ type: "mcp.add", cwd: quiet, name: "other", scope: "local", config: { transport: "http", url: "https://x.example/mcp", headers: [] } });
    expect(closedQueries).not.toContain(flow);
    // The next list reads the new config from a fresh query.
    await c.request({ type: "mcp.list", cwd: quiet });
    expect(configQueries().length).toBe(before + 2);
    await c.request({ type: "mcp.oauthCallback", cwd: quiet, name: "ctx", callbackUrl: "http://localhost:5555/callback?code=x&state=s" });
    expect(mcpCalls.at(-1)).toMatchObject({ call: "mcpSubmitOAuthCallbackUrl", options: flow });
    // The flow is over: its query closes.
    expect(closedQueries).toContain(flow);
    c.ws.close();
    await sleep(HOLD_MS + 100);
  });

  it("the waiting dialog's polls keep a detached OAuth flow alive past the hold: its callback still reaches that query", async () => {
    const c = await client();
    await sleep(HOLD_MS + 100);
    await c.request({ type: "mcp.authenticate", cwd: quiet, name: "ctx" });
    const flow = configQueries().at(-1)!;
    await c.request({ type: "mcp.add", cwd: quiet, name: "other2", scope: "local", config: { transport: "http", url: "https://x.example/mcp", headers: [] } });
    // Polls of the dialog go to the new held query for longer than one hold.
    for (let i = 0; i < 4; i++) {
      await sleep(HOLD_MS / 2);
      await c.request({ type: "mcp.list", cwd: quiet });
    }
    expect(closedQueries).not.toContain(flow);
    await c.request({ type: "mcp.oauthCallback", cwd: quiet, name: "ctx", callbackUrl: "http://localhost:5555/callback?code=x&state=s" });
    expect(mcpCalls.at(-1)).toMatchObject({ call: "mcpSubmitOAuthCallbackUrl", options: flow });
    c.ws.close();
    await sleep(HOLD_MS + 100);
  });

  it("toggles and reconnects a server and replies the fresh list", async () => {
    const c = await client();
    const t = await c.request({ type: "mcp.toggle", cwd: project, name: "broken", enabled: false });
    expect(mcpCalls.at(-2)).toMatchObject({ call: "toggleMcpServer", args: ["broken", false] });
    expect(mcpCalls.at(-1)!.call).toBe("mcpServerStatus");
    expect((t.result as unknown as { servers: unknown[] }).servers).toHaveLength(3);
    await c.request({ type: "mcp.reconnect", cwd: project, name: "broken" });
    expect(mcpCalls.at(-2)).toMatchObject({ call: "reconnectMcpServer", args: ["broken"] });
    c.ws.close();
  });

  it("authenticates: HTTP through the CLI, a claude.ai connector by its connectors page without asking the CLI", async () => {
    const c = await client();
    expect((await c.request({ type: "mcp.authenticate", cwd: project, name: "ctx" })).result).toEqual({ authUrl: "https://auth.example/authorize?state=s", requiresUserAction: true });
    expect(mcpCalls.at(-1)).toMatchObject({ call: "mcpAuthenticate", args: ["ctx"] });
    const n = mcpCalls.length;
    expect((await c.request({ type: "mcp.authenticate", cwd: project, name: "drive" })).result).toEqual({ authUrl: "https://claude.ai/customize/connectors", requiresUserAction: true });
    expect(mcpCalls.slice(n).map((x) => x.call)).not.toContain("mcpAuthenticate");
    expect(await c.request({ type: "mcp.authenticate", cwd: project, name: "broken" })).toMatchObject({ type: "error", message: 'Server type "stdio" does not support authentication' });
    expect(await c.request({ type: "mcp.authenticate", cwd: project, name: "nope" })).toMatchObject({ type: "error", message: 'Server "nope" not found' });
    // A connector the CLI leaves out of one status answer (reloading after a toggle) keeps the type of the last list.
    const drive = statuses.splice(2, 1)[0]!;
    try {
      expect((await c.request({ type: "mcp.authenticate", cwd: project, name: "drive" })).result).toEqual({ authUrl: "https://claude.ai/customize/connectors", requiresUserAction: true });
    } finally {
      statuses.splice(2, 0, drive);
    }
    c.ws.close();
  });

  it("submits a pasted callback URL and clears authentication of HTTP/SSE servers only", async () => {
    const c = await client();
    expect(await c.request({ type: "mcp.oauthCallback", cwd: project, name: "ctx", callbackUrl: "http://localhost:5555/callback?code=x&state=s" })).toMatchObject({ type: "reply" });
    expect(mcpCalls.at(-1)).toMatchObject({ call: "mcpSubmitOAuthCallbackUrl", args: ["ctx", "http://localhost:5555/callback?code=x&state=s"] });
    expect(await c.request({ type: "mcp.oauthCallback", cwd: project, name: "ctx", callbackUrl: "http://localhost:5555/callback" })).toMatchObject({ type: "error", message: expect.stringContaining("Invalid callback URL") });
    expect(await c.request({ type: "mcp.clearAuth", cwd: project, name: "ctx" })).toMatchObject({ type: "reply" });
    expect(mcpCalls.at(-1)).toMatchObject({ call: "mcpClearAuth", args: ["ctx"] });
    expect(await c.request({ type: "mcp.clearAuth", cwd: project, name: "drive" })).toMatchObject({ type: "error", message: "Cannot clear authentication for claudeai-proxy servers (uses session cookies)" });
    c.ws.close();
  });

  it("adds and removes servers with the CLI in the project cwd and tells every connection", async () => {
    const a = await client();
    const b = await client();
    const stdio = { transport: "stdio", command: "npx", args: ["-y", "pkg"], env: ["API_KEY=1", "B=2"] };
    expect(await a.request({ type: "mcp.add", cwd: project, name: "tools", scope: "local", config: stdio })).toMatchObject({ type: "reply", result: {} });
    expect(cliCalls.at(-1)).toEqual({ cwd: project, args: ["mcp", "add", "--scope", "local", "--transport", "stdio", "--env", "API_KEY=1", "--env", "B=2", "--", "tools", "npx", "-y", "pkg"] });
    await new Promise((r) => setTimeout(r, 20));
    expect(b.inbox).toContainEqual({ type: "config.changed", kind: "mcp", cwd: project });
    await a.request({ type: "mcp.add", cwd: project, name: "web", scope: "user", config: { transport: "http", url: "https://x.example/mcp", headers: ["Authorization: Bearer t"] } });
    expect(cliCalls.at(-1)!.args).toEqual(["mcp", "add", "--scope", "user", "--transport", "http", "--header", "Authorization: Bearer t", "--", "web", "https://x.example/mcp"]);
    await a.request({ type: "mcp.add", cwd: project, name: "old", scope: "project", config: { transport: "sse", url: "https://x.example/sse", headers: [] } });
    expect(cliCalls.at(-1)!.args).toEqual(["mcp", "add", "--scope", "project", "--transport", "sse", "--", "old", "https://x.example/sse"]);
    expect(await a.request({ type: "mcp.remove", cwd: project, name: "tools", scope: "local" })).toMatchObject({ type: "reply" });
    expect(cliCalls.at(-1)!.args).toEqual(["mcp", "remove", "--scope", "local", "--", "tools"]);
    a.ws.close();
    b.ws.close();
  });

  it("refuses a bad name, scope or config, a cwd outside the roots, and reports the CLI's error", async () => {
    const c = await client();
    const n = cliCalls.length;
    const http = { transport: "http", url: "https://x.example/mcp", headers: [] };
    expect(await c.request({ type: "mcp.add", cwd: project, name: "a b", scope: "local", config: http })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await c.request({ type: "mcp.add", cwd: project, name: "ok", scope: "global", config: http })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await c.request({ type: "mcp.add", cwd: project, name: "ok", scope: "local", config: { transport: "http", url: "", headers: [] } })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await c.request({ type: "mcp.add", cwd: project, name: "ok", scope: "local", config: { transport: "stdio", command: "x", args: [], env: ["NOVALUE"] } })).toMatchObject({ type: "error", code: "bad_request" });
    expect(await c.request({ type: "mcp.remove", cwd: "/etc", name: "ok", scope: "local" })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
    expect(await c.request({ type: "mcp.list", cwd: "/etc" })).toMatchObject({ type: "error", code: "cwd_not_allowed" });
    // Outside the roots the reply does not tell whether the path exists; inside them a deleted folder gets its own hint.
    expect(await c.request({ type: "mcp.list", cwd: "/etc/no-such-dir" })).toMatchObject({ type: "error", code: "cwd_not_allowed", message: "not a directory inside the allowlisted roots: /etc/no-such-dir" });
    expect(await c.request({ type: "mcp.list", cwd: join(project, "gone", "deeper") })).toMatchObject({ type: "error", code: "bad_cwd" });
    expect(cliCalls.length).toBe(n);
    Object.assign(cliResult, { code: 1, stderr: "MCP server ok already exists in local config\nmore" });
    expect(await c.request({ type: "mcp.add", cwd: project, name: "ok", scope: "local", config: http })).toMatchObject({ type: "error", message: "MCP server ok already exists in local config" });
    Object.assign(cliResult, { code: 0, stderr: "" });
    c.ws.close();
  });
});
