// HTTP server for the built web app plus the WebSocket endpoint at /ws.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { imageBlock, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ClientMessage, type ServerMessage } from "@claude-ui/protocol";
import { getSessionInfo, getSessionMessages, type query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { listModels, Session } from "./session.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

type History = { getSessionInfo: typeof getSessionInfo; getSessionMessages: typeof getSessionMessages };

// ponytail: loopback only; add the remote-access hostname here once that is decided (ADR 0003).
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

export function createDaemon(opts: { webRoot: string; token: string; query?: typeof sdkQuery; history?: History }) {
  const logEpoch = randomUUID();
  const sessions = new Map<string, Session>();
  const restoring = new Map<string, Promise<Session | undefined>>();
  const history = opts.history ?? { getSessionInfo, getSessionMessages };
  const root = resolve(opts.webRoot);
  // ponytail: model list cached for the daemon lifetime; a login/plan change needs a daemon restart.
  let models: ReturnType<typeof listModels> | undefined;

  /** A session of this daemon run, or one rebuilt from its SDK transcript (ADR 0001). Concurrent calls share one restore. */
  function findSession(id: string): Promise<Session | undefined> {
    const live = sessions.get(id);
    if (live) return Promise.resolve(live);
    // The ID becomes a transcript file name; only a UUID may reach the SDK.
    if (typeof id !== "string" || !UUID.test(id)) return Promise.resolve(undefined);
    let p = restoring.get(id);
    if (!p) {
      p = (async () => {
        const info = await history.getSessionInfo(id);
        if (!info?.cwd) return undefined;
        const s = Session.restore(id, info.cwd, await history.getSessionMessages(id, { dir: info.cwd }), { query: opts.query });
        sessions.set(id, s);
        return s;
      })()
        .catch((err) => void console.error(`restoring session ${id} failed:`, err))
        .finally(() => restoring.delete(id));
      restoring.set(id, p);
    }
    return p;
  }

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

  const wss = new WebSocketServer({ noServer: true, handleProtocols: () => WS_PROTOCOL });
  const digest = (t: string) => createHash("sha256").update(t).digest();
  const expected = digest(opts.token);
  const hasToken = (req: IncomingMessage) =>
    (req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .some((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX) && timingSafeEqual(digest(p.slice(TOKEN_PROTOCOL_PREFIX.length)), expected));

  http.on("upgrade", (req, socket, head) => {
    // Never put request headers in these responses: they carry the token.
    const reject = (status: string) => void socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.on("error", () => socket.destroy());
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") return reject("404 Not Found");
    if (!isOwnOrigin(req)) return reject("403 Forbidden");
    if (!hasToken(req)) return reject("401 Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const unsubscribes = new Map<string, () => void>();
    ws.on("close", () => unsubscribes.forEach((u) => u()));
    ws.on("message", async (data) => {
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
      const find = async (id: string) => (await findSession(id)) ?? void fail("unknown_session", `no session ${id}`);

      switch (msg.type) {
        case "session.create": {
          if (typeof msg.cwd !== "string" || !existsSync(msg.cwd) || !statSync(msg.cwd).isDirectory())
            return fail("bad_cwd", `not a directory: ${msg.cwd}`);
          if (msg.model !== undefined && !isModel(msg.model)) return fail("bad_model", "model must be a non-empty string");
          const s = new Session(msg.cwd, { model: msg.model, query: opts.query });
          sessions.set(s.id, s);
          return reply({ session: s.info() });
        }
        case "session.subscribe": {
          const s = await find(msg.sessionId);
          if (!s || ws.readyState !== ws.OPEN) return;
          unsubscribes.get(s.id)?.();
          // Different epoch: the client's seqs belong to an earlier daemon run, so replay everything.
          const since = msg.logEpoch === logEpoch ? msg.sinceSeq : 0;
          reply({ logEpoch, session: s.info() });
          unsubscribes.set(s.id, s.subscribe(since, (e) => send(ws, e)));
          return;
        }
        case "session.prompt": {
          const s = await find(msg.sessionId);
          if (!s) return;
          const images = msg.images ?? [];
          if (!Array.isArray(images) || !images.every((i) => imageBlock(i)))
            return fail("bad_images", "images must be base64 data URLs of type png, jpeg, gif or webp");
          if (typeof msg.text !== "string" || (!msg.text.trim() && !images.length)) return fail("bad_prompt", "empty prompt");
          if (!s.isLive()) return fail("session_not_live", `session ${s.id} is ${s.info().state}`);
          s.prompt(msg.text, images);
          return reply({});
        }
        case "session.setModel": {
          const s = await find(msg.sessionId);
          if (!s) return;
          if (!isModel(msg.model)) return fail("bad_model", "model must be a non-empty string");
          if (!s.isLive()) return fail("session_not_live", `session ${s.id} is ${s.info().state}`);
          try {
            await s.setModel(msg.model);
          } catch (e) {
            return fail("set_model_failed", (e as Error).message);
          }
          return reply({ session: s.info() });
        }
        case "models.list": {
          models ??= listModels(opts.query);
          try {
            return reply({ models: await models });
          } catch (e) {
            models = undefined;
            return fail("models_failed", (e as Error).message);
          }
        }
        default:
          return fail("unknown_type", `unknown message type ${(msg as { type?: string }).type}`);
      }
    });
  });

  return http;
}

const isModel = (m: unknown): m is string => typeof m === "string" && m.trim() !== "";

/**
 * The Origin must be the origin the browser used to reach this daemon (its Host header), and that host
 * must be loopback: a cross-site page has a foreign Origin, a DNS-rebinding page has a foreign Host.
 */
function isOwnOrigin(req: IncomingMessage) {
  const { origin, host } = req.headers;
  if (!origin || !host) return false;
  try {
    const o = new URL(origin);
    return (o.protocol === "http:" || o.protocol === "https:") && o.host === host && LOCAL_HOSTNAMES.has(o.hostname);
  } catch {
    return false;
  }
}

function send(ws: WebSocket, m: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
}
