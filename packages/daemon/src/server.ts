// HTTP server for the built web app plus the WebSocket endpoint at /ws.
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage } from "node:http";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { EFFORTS, imageBlock, MAX_UPLOAD_BYTES, PERMISSION_MODES, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ClientMessage, type FsEntry, type RewindMode, type ServerMessage, type SessionListItem } from "@claude-ui/protocol";
import { getSessionInfo, getSessionMessages, listSessions, type query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { searchFiles } from "./search.ts";
import { createNotifier, type Push } from "./push.ts";
import { listModels, Session, transcriptModel } from "./session.ts";

const REWIND_MODES: RewindMode[] = ["code", "conversation", "both"];

/** Larger files are not opened in the editor. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// ponytail: stat polling, robust to atomic rename-writes and WSL; fs.watch per directory if many tabs make polling costly.
const WATCH_INTERVAL_MS = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

type History = { listSessions: typeof listSessions; getSessionInfo: typeof getSessionInfo; getSessionMessages: typeof getSessionMessages };

// ponytail: loopback only; add the remote-access hostname here once that is decided (ADR 0003).
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

/** Canonical path (symlinks resolved), or undefined when it does not exist. */
function real(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * `roots`: allowlisted directories for session cwds, the session list and the directory picker (docs/spec.md "Security").
 * `push`: Web Push sender; without it push.* requests fail. `allowBypass`: sessions may switch to bypassPermissions.
 * `uploadDir`: parent of the fs.upload folders (default: the OS temp dir).
 */
export function createDaemon(opts: {
  webRoot: string;
  token: string;
  roots: string[];
  query?: typeof sdkQuery;
  history?: History;
  push?: Push;
  allowBypass?: boolean;
  uploadDir?: string;
}) {
  const logEpoch = randomUUID();
  /**
   * fs.upload parent: one private (0700, mkdtemp) folder per daemon. Made up front: every session gets it as an
   * additional directory, so Claude reads an attachment without asking.
   */
  const uploadParent = opts.uploadDir ?? mkdtempSync(join(tmpdir(), "claude-ui-"));
  mkdirSync(uploadParent, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, Session>();
  const restoring = new Map<string, Promise<Session | undefined>>();
  const history = opts.history ?? { listSessions, getSessionInfo, getSessionMessages };
  const root = resolve(opts.webRoot);
  // ponytail: model list cached for the daemon lifetime; a login/plan change needs a daemon restart.
  let models: ReturnType<typeof listModels> | undefined;
  const modelList = () =>
    (models ??= listModels(opts.query)).catch((e) => {
      models = undefined;
      throw e;
    });
  const roots = opts.roots.map(real).filter((r) => r !== undefined);
  const inRoots = (path: string) =>
    roots.some((r) => {
      const rel = relative(r, path);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  /** The canonical path when it is an existing path inside a root. */
  const allowed = (path: unknown) => {
    const p = typeof path === "string" && isAbsolute(path) ? real(path) : undefined;
    return p && inRoots(p) ? p : undefined;
  };

  /** Session a connection shows while its tab is focused and visible. */
  const focused = new Map<WebSocket, string>();
  const notifier = createNotifier({
    suppressed: (id) => [...focused.values()].includes(id),
    push: async (sessionId, body) => {
      const info = await history.getSessionInfo(sessionId).catch(() => undefined);
      const title = info?.summary || basename(sessions.get(sessionId)?.cwd ?? "") || "Claude";
      await opts.push?.send({ sessionId, title, body });
    },
  });
  /** Adds a session and follows its live events (not its history) for pushes. */
  function track(s: Session) {
    sessions.set(s.id, s);
    s.subscribe(Infinity, notifier.observe);
    return s;
  }

  async function list(): Promise<SessionListItem[]> {
    const items = new Map<string, SessionListItem>();
    for (const t of await history.listSessions()) {
      if (!t.cwd || !allowed(t.cwd)) continue;
      const live = sessions.get(t.sessionId)?.info() ?? { state: "closed" as const, model: "default", permissionMode: "default" as const, effort: "default" as const, permissionModes: [] };
      items.set(t.sessionId, { ...live, id: t.sessionId, cwd: t.cwd, title: t.summary, lastActivity: t.lastModified });
    }
    // Sessions of this run that have no transcript yet (no prompt sent).
    for (const s of sessions.values())
      if (!items.has(s.id)) items.set(s.id, { ...s.info(), title: "New session", lastActivity: s.createdAt });
    return [...items.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }

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
        if (!info?.cwd || !allowed(info.cwd)) return undefined;
        const messages = await history.getSessionMessages(id, { dir: info.cwd });
        // The model row whose resolved ID the transcript last used ("default" first); the ID itself when none matches.
        const used = transcriptModel(messages);
        const model = used && ((await modelList().catch(() => [])).find((m) => m.resolvedModel === used)?.value ?? used);
        return track(Session.restore(id, info.cwd, messages, { model, allowBypass: opts.allowBypass, uploadDir: uploadParent, query: opts.query }));
      })()
        .catch((err) => void console.error(`restoring session ${id} failed:`, err))
        .finally(() => restoring.delete(id));
      restoring.set(id, p);
    }
    return p;
  }

  const digest = (t: string) => createHash("sha256").update(t).digest();
  const expected = digest(opts.token);
  const isToken = (t: string | undefined) => t !== undefined && timingSafeEqual(digest(t), expected);
  const hasToken = (req: IncomingMessage) =>
    (req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .some((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX) && isToken(p.slice(TOKEN_PROTOCOL_PREFIX.length)));

  const http = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return void res.writeHead(400).end("malformed URL");
    }
    // Pairing probe: a browser cannot read the 401 of a rejected WebSocket upgrade, so it asks here (client.ts).
    if (path === "/auth") return void res.writeHead(isToken(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]) ? 204 : 401).end();
    let file = resolve(join(root, path));
    if (!file.startsWith(root + sep) && file !== root) return void res.writeHead(403).end();
    // SPA fallback: unknown paths serve index.html.
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
    if (!existsSync(file)) return void res.writeHead(404).end("web app not built: run npm run build");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true, handleProtocols: (offered) => (offered.has(WS_PROTOCOL) ? WS_PROTOCOL : false) });
  http.on("upgrade", (req, socket, head) => {
    // Never put request headers in these responses: they carry the token.
    const reject = (status: string) => void socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.on("error", () => socket.destroy());
    // String compare, not new URL: a malformed request target must not throw here (uncaught in an upgrade listener).
    if (req.url?.split("?")[0] !== "/ws") return reject("404 Not Found");
    if (!isOwnOrigin(req)) return reject("403 Forbidden");
    if (!hasToken(req)) return reject("401 Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws) => {
    const unsubscribes = new Map<string, () => void>();
    // fs.watch: watched path as the client gave it → canonical path and its stat listener.
    const watched = new Map<string, { real: string; listener: (curr: Stats, prev: Stats) => void }>();
    const unwatchAll = () => {
      watched.forEach((w) => unwatchFile(w.real, w.listener));
      watched.clear();
    };
    // Without a listener a socket error (e.g. a frame above maxPayload) is thrown and the daemon exits; ws closes the socket itself.
    ws.on("error", (err) => console.warn("ws:", err.message));
    ws.on("close", () => {
      unsubscribes.forEach((u) => u());
      unwatchAll();
      focused.delete(ws);
    });
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
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          const s = track(new Session(cwd, { model: msg.model, allowBypass: opts.allowBypass, uploadDir: uploadParent, query: opts.query }));
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
        case "session.setPermissionMode":
        case "session.setEffort": {
          const s = await find(msg.sessionId);
          if (!s) return;
          if (msg.type === "session.setPermissionMode" && !PERMISSION_MODES.includes(msg.mode)) return fail("bad_mode", `unknown permission mode ${msg.mode}`);
          if (msg.type === "session.setEffort" && !EFFORTS.includes(msg.effort)) return fail("bad_effort", `unknown effort ${msg.effort}`);
          try {
            await (msg.type === "session.setPermissionMode" ? s.setPermissionMode(msg.mode) : s.setEffort(msg.effort));
          } catch (e) {
            return fail("set_failed", (e as Error).message);
          }
          return reply({ session: s.info() });
        }
        case "fs.upload": {
          if (typeof msg.data !== "string" || typeof msg.name !== "string") return fail("bad_upload", "name and data (base64) required");
          // basename: the name must not climb out of the upload folder.
          const name = basename(msg.name).replace(/^\.+/, "") || "file";
          const buf = Buffer.from(msg.data, "base64");
          if (buf.length > MAX_UPLOAD_BYTES) return fail("too_large", `larger than ${MAX_UPLOAD_BYTES} bytes: ${name}`);
          try {
            // One folder per upload keeps the original name, so Claude sees it.
            // ponytail: uploads are never removed (spec: temp folder, OS temp cleanup); delete on session end if disk use matters.
            const file = join(mkdtempSync(join(uploadParent, "u-")), name);
            writeFileSync(file, buf, { mode: 0o600 });
            return reply({ path: file });
          } catch (err) {
            return fail("fs_error", String(err));
          }
        }
        case "session.interrupt": {
          const s = await find(msg.sessionId);
          if (!s) return;
          try {
            await s.interrupt();
          } catch (e) {
            return fail("interrupt_failed", (e as Error).message);
          }
          return reply({});
        }
        case "permission.respond": {
          if (typeof msg.requestId !== "string" || !["allow", "allow_always", "deny"].includes(msg.decision))
            return fail("bad_request", "requestId and decision (allow, allow_always, deny) required");
          if (msg.ruleIndex !== undefined && !Number.isInteger(msg.ruleIndex)) return fail("bad_request", "ruleIndex must be an integer");
          if (msg.message !== undefined && typeof msg.message !== "string") return fail("bad_request", "message must be a string");
          const u = msg.updatedInput as unknown;
          if (u !== undefined && (typeof u !== "object" || u === null || Array.isArray(u))) return fail("bad_request", "updatedInput must be an object");
          // requestIds are UUIDs unique across sessions; the first answer from any tab wins.
          const settled = [...sessions.values()].some((s) => s.respond(msg.requestId, msg));
          return reply({ settled });
        }
        case "question.respond": {
          const { answers } = msg;
          if (typeof msg.requestId !== "string" || typeof answers !== "object" || !answers || Object.values(answers).some((v) => typeof v !== "string"))
            return fail("bad_request", "requestId and answers (question text -> string) required");
          const settled = [...sessions.values()].some((s) => s.answer(msg.requestId, answers));
          return reply({ settled });
        }
        case "models.list": {
          try {
            return reply({ models: await modelList() });
          } catch (e) {
            return fail("models_failed", (e as Error).message);
          }
        }
        case "session.list":
          return reply({ sessions: await list() });
        case "fs.list": {
          if (msg.path === undefined)
            return reply({ entries: roots.map((r): FsEntry => ({ name: r, path: r, isDir: true })) });
          const dir = allowed(msg.path);
          if (!dir) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.path}`);
          try {
            const entries = readdirSync(dir, { withFileTypes: true }).map(
              (e): FsEntry => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }),
            );
            return reply({ entries: entries.sort((a, b) => a.name.localeCompare(b.name)) });
          } catch (err) {
            return fail("fs_error", String(err));
          }
        }
        case "session.rewindPreview":
        case "session.rewind": {
          const s = await find(msg.sessionId);
          if (!s) return;
          if (msg.type === "session.rewind" && !REWIND_MODES.includes(msg.mode)) return fail("bad_mode", `unknown rewind mode ${msg.mode}`);
          try {
            return reply(msg.type === "session.rewind" ? (await s.rewind(msg.userMessageId, msg.mode), {}) : await s.previewRewind(msg.userMessageId));
          } catch (err) {
            return fail("rewind_failed", (err as Error).message);
          }
        }
        case "fs.search": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (typeof msg.query !== "string") return fail("bad_query", "query must be a string");
          // A symlink pointing outside the roots is not offered: the SDK would read its target (like fs.read refuses it).
          return reply({ paths: searchFiles(cwd, msg.query).filter((p) => allowed(join(cwd, p))) });
        }
        case "push.key":
          return opts.push ? reply({ publicKey: opts.push.publicKey }) : fail("push_unavailable", "push is not configured");
        case "push.subscribe":
          if (!opts.push) return fail("push_unavailable", "push is not configured");
          return opts.push.subscribe(msg.subscription) ? reply({}) : fail("bad_subscription", "subscription needs an https endpoint and keys");
        case "push.focus":
          if (msg.sessionId === undefined) focused.delete(ws);
          else if (typeof msg.sessionId === "string") focused.set(ws, msg.sessionId);
          else return fail("bad_request", "sessionId must be a string");
          return reply({});
        case "fs.read": {
          const file = allowed(msg.path);
          if (!file) return fail("path_not_allowed", `outside the allowlisted roots: ${msg.path}`);
          try {
            const st = statSync(file);
            if (!st.isFile()) return fail("not_a_file", `not a file: ${msg.path}`);
            if (st.size > MAX_FILE_BYTES) return fail("too_large", `larger than ${MAX_FILE_BYTES} bytes: ${msg.path}`);
            const buf = readFileSync(file);
            if (buf.includes(0)) return fail("binary", `binary file: ${msg.path}`);
            let content: string;
            try {
              // Fatal: a lossy decode would turn invalid bytes into U+FFFD and a save would write that back. ignoreBOM keeps the BOM in the content.
              content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
            } catch {
              return fail("not_utf8", `not UTF-8 text: ${msg.path}`);
            }
            return reply({ content, mtime: st.mtimeMs });
          } catch (err) {
            return fail("fs_error", String(err));
          }
        }
        case "fs.write": {
          // Existing files only: the editor edits what the tree shows.
          const file = allowed(msg.path);
          if (!file) return fail("path_not_allowed", `outside the allowlisted roots: ${msg.path}`);
          if (typeof msg.content !== "string") return fail("bad_content", "content must be a string");
          try {
            const st = statSync(file);
            if (!st.isFile()) return fail("not_a_file", `not a file: ${msg.path}`);
            if (msg.baseMtime !== undefined && st.mtimeMs !== msg.baseMtime)
              return fail("conflict", `changed on disk since it was read: ${msg.path}`);
            writeFileSync(file, msg.content);
            return reply({ mtime: statSync(file).mtimeMs });
          } catch (err) {
            return fail("fs_error", String(err));
          }
        }
        case "fs.watch": {
          if (!Array.isArray(msg.paths)) return fail("bad_paths", "paths must be an array");
          // Only the diff: re-arming a kept path would take a new stat baseline and drop a change made since the last poll.
          for (const [path, w] of watched)
            if (!msg.paths.includes(path)) {
              unwatchFile(w.real, w.listener);
              watched.delete(path);
            }
          for (const path of msg.paths) {
            const real = allowed(path);
            if (!real || watched.has(path)) continue;
            const listener = (curr: Stats, prev: Stats) =>
              curr.mtimeMs !== prev.mtimeMs && send(ws, { type: "fs.changed", path, mtime: curr.mtimeMs });
            watchFile(real, { interval: WATCH_INTERVAL_MS }, listener);
            watched.set(path, { real, listener });
          }
          return reply({ watching: [...watched.keys()] });
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
