// HTTP server for the built web app plus the WebSocket endpoint at /ws.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "@claude-ui/protocol";
import type { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { Session } from "./session.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function createDaemon(opts: { webRoot: string; query?: typeof sdkQuery }) {
  const logEpoch = randomUUID();
  const sessions = new Map<string, Session>();
  const root = resolve(opts.webRoot);

  const http = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return void res.writeHead(400).end("malformed URL");
    }
    let file = resolve(join(root, path));
    if (!file.startsWith(root + sep) && file !== root) return void res.writeHead(403).end();
    // SPA fallback: unknown paths serve index.html.
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
    if (!existsSync(file)) return void res.writeHead(404).end("web app not built: run npm run build");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (ws) => {
    const unsubscribes = new Map<string, () => void>();
    ws.on("close", () => unsubscribes.forEach((u) => u()));
    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return send(ws, { type: "error", code: "bad_json", message: "invalid JSON" });
      }
      if (typeof msg !== "object" || msg === null || Array.isArray(msg))
        return send(ws, { type: "error", code: "bad_message", message: "message must be a JSON object" });
      const reply = (result: unknown) => send(ws, { type: "reply", reqId: msg.reqId, result });
      const fail = (code: string, message: string) => send(ws, { type: "error", reqId: msg.reqId, code, message });
      const find = (id: string) => sessions.get(id) ?? void fail("unknown_session", `no session ${id}`);

      switch (msg.type) {
        case "session.create": {
          if (typeof msg.cwd !== "string" || !existsSync(msg.cwd) || !statSync(msg.cwd).isDirectory())
            return fail("bad_cwd", `not a directory: ${msg.cwd}`);
          const s = new Session(msg.cwd, { model: msg.model, query: opts.query });
          sessions.set(s.id, s);
          return reply({ session: s.info() });
        }
        case "session.subscribe": {
          const s = find(msg.sessionId);
          if (!s) return;
          unsubscribes.get(s.id)?.();
          // Different epoch: the client's seqs belong to an earlier daemon run, so replay everything.
          const since = msg.logEpoch === logEpoch ? msg.sinceSeq : 0;
          reply({ logEpoch });
          unsubscribes.set(s.id, s.subscribe(since, (e) => send(ws, e)));
          return;
        }
        case "session.prompt": {
          const s = find(msg.sessionId);
          if (!s) return;
          if (typeof msg.text !== "string" || !msg.text.trim()) return fail("bad_prompt", "empty prompt");
          if (!s.isLive()) return fail("session_not_live", `session ${s.id} is ${s.info().state}`);
          s.prompt(msg.text);
          return reply({});
        }
        default:
          return fail("unknown_type", `unknown message type ${(msg as { type?: string }).type}`);
      }
    });
  });

  return http;
}

function send(ws: WebSocket, m: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
}
