// HTTP server for the built web app plus the WebSocket endpoint at /ws.
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer, type IncomingMessage } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { EFFORTS, imageBlock, MAX_TERMINAL_INPUT_BYTES, MAX_UPLOAD_BYTES, PERMISSION_MODES, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ClientMessage, type FsEntry, type ListResult, type RewindMode, type ServerMessage, type SessionListItem } from "@claude-ui/protocol";
import { deleteSession, getSessionInfo, getSessionMessages, listSessions, renameSession, tagSession, type query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { searchFiles } from "./search.ts";
import { createNotifier, type Push } from "./push.ts";
import { createProjects, trim, type Projects } from "./projects.ts";
import { createPlanTracker } from "./plan-usage.ts";
import { listModels, queuedQuery, Session, transcriptModel, type SessionSettings } from "./session.ts";
import { createTerminals } from "./terminals.ts";

const REWIND_MODES: RewindMode[] = ["code", "conversation", "both"];

/** ws maxPayload (default 100 MiB): a prompt with two images at MAX_UPLOAD_BYTES as base64, plus the JSON around them. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Larger files are not opened in the editor. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
// ponytail: stat polling, robust to atomic rename-writes and WSL; fs.watch per directory if many tabs make polling costly.
const WATCH_INTERVAL_MS = 1000;

/** A new connection gets a fresh plan usage read when the last one is older (reset times pass without a turn). */
const PLAN_STALE_MS = 5 * 60_000;

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

type History = {
  listSessions: typeof listSessions;
  getSessionInfo: typeof getSessionInfo;
  getSessionMessages: typeof getSessionMessages;
  renameSession?: typeof renameSession;
  tagSession?: typeof tagSession;
  deleteSession?: typeof deleteSession;
};

/** SDK session tag that marks an archived session (no archive flag of its own; ADR 0001: no store of ours). */
const ARCHIVED_TAG = "archived";

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

/** Bytes read from a transcript's end to find its last message; more than a few large tool results. */
const TAIL_BYTES = 256 * 1024;
/** Transcript path → last message time for the file version (mtime, size) it was read from. */
const lastMessageCache = new Map<string, { version: string; at: number | undefined }>();

/**
 * Time of the last user or assistant entry in a session's transcript, read from its end. Not the file mtime: on exit
 * the CLI appends metadata (`last-prompt`, `cost-state`), so every live session looks just used after a daemon restart.
 * Undefined when the file or such an entry is not found (e.g. the entry is further back than `TAIL_BYTES`).
 */
function lastMessageAt(projectsDir: string, cwd: string, sessionId: string) {
  // ponytail: the SDK's project folder name for cwds up to 200 chars; longer ones get a hash suffix and fall back to mtime.
  const file = join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const { size, mtimeMs } = fstatSync(fd);
    const version = `${mtimeMs}:${size}`;
    const cached = lastMessageCache.get(file);
    if (cached?.version === version) return cached.at;
    let at: number | undefined;
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
    readSync(fd, buf, 0, buf.length, size - buf.length);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"timestamp"')) continue;
      try {
        const e = JSON.parse(lines[i]) as { type?: string; timestamp?: string };
        const t = (e.type === "user" || e.type === "assistant") && Date.parse(e.timestamp ?? "");
        if (t) {
          at = t;
          break;
        }
      } catch {
        // The first line of the tail is cut.
      }
    }
    lastMessageCache.set(file, { version, at });
    return at;
  } catch {
    // No transcript at that path.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

/**
 * `roots`: allowlisted directories for session cwds, the session list and the directory picker (docs/spec.md "Security").
 * `push`: Web Push sender; without it push.* requests fail. `allowBypass`: sessions may switch to bypassPermissions.
 * `uploadDir`: parent of the fs.upload folders (default: the OS temp dir).
 * `projectsDir`: the SDK's transcript folder (default: `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`).
 * `settingsFile`: JSON file keeping each session's model, permission mode and effort for a restore after a restart
 * (the SDK transcript has mode and effort only per prompt); none = not kept.
 * `projects`: known projects store; in memory when omitted.
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
  projectsDir?: string;
  settingsFile?: string;
  projects?: Projects;
}) {
  const logEpoch = randomUUID();
  /**
   * fs.upload parent: one private (0700, mkdtemp) folder per daemon. Made up front: every session gets it as an
   * additional directory, so Claude reads an attachment without asking.
   */
  const uploadParent = opts.uploadDir ?? mkdtempSync(join(tmpdir(), "claude-ui-"));
  mkdirSync(uploadParent, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, Session>();
  // ponytail: entries are never removed and the whole file is rewritten per change; prune by transcript if it grows.
  const settings: Record<string, SessionSettings> = readJson(opts.settingsFile) ?? {};
  // Account-wide, so not a session event: every connection gets each change.
  const plan = createPlanTracker({ onChange: (usage) => broadcast({ type: "plan_usage", usage }), read: () => queuedQuery(plan.refresh, opts.query) });
  /** Options of every session: settings changes are saved under its ID. */
  const sessionOpts = (id: () => string, initial: Partial<SessionSettings>) => ({
    ...initial,
    plan,
    allowBypass: opts.allowBypass,
    uploadDir: uploadParent,
    query: opts.query,
    onSettings: (s: SessionSettings) => {
      if (!opts.settingsFile) return;
      settings[id()] = s;
      try {
        writeFileSync(opts.settingsFile, JSON.stringify(settings), { mode: 0o600 });
      } catch (err) {
        console.error("saving session settings failed:", err);
      }
    },
  });
  const restoring = new Map<string, Promise<Session | undefined>>();
  // Sessions whose delete is in progress (session.delete).
  const deleting = new Set<string>();
  const history = { listSessions, getSessionInfo, getSessionMessages, renameSession, tagSession, deleteSession, ...opts.history };
  const projectsDir = opts.projectsDir ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const projects = opts.projects ?? createProjects();
  const connections = new Set<WebSocket>();
  const terminals = createTerminals();
  const broadcast = (m: ServerMessage) => connections.forEach((ws) => send(ws, m));
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

  // listSessions() reads every transcript under ~/.claude/projects (hundreds of MB): one scan at a time.
  // Requests during a scan share one queued scan, so a reply is never older than its request.
  let scan: ReturnType<typeof listSessions> | undefined;
  let nextScan: ReturnType<typeof listSessions> | undefined;
  function transcripts(): ReturnType<typeof listSessions> {
    if (!scan) return (scan = history.listSessions().finally(() => (scan = undefined)));
    return (nextScan ??= scan.catch(() => {}).then(() => ((nextScan = undefined), transcripts())));
  }

  async function list(): Promise<ListResult> {
    const items = new Map<string, SessionListItem>();
    for (const t of await transcripts()) {
      if (!t.cwd || !allowed(t.cwd)) continue;
      const live = sessions.get(t.sessionId)?.info() ?? { state: "closed" as const, model: "default", permissionMode: "default" as const, effort: "default" as const, permissionModes: [] };
      items.set(t.sessionId, { ...live, id: t.sessionId, cwd: t.cwd, title: t.summary, lastActivity: lastMessageAt(projectsDir, t.cwd, t.sessionId) ?? t.lastModified, archived: t.tag === ARCHIVED_TAG, transcript: true });
    }
    // Sessions of this run that have no transcript yet (no prompt sent).
    for (const s of sessions.values())
      if (!items.has(s.id)) items.set(s.id, { ...s.info(), title: "New session", lastActivity: s.createdAt, archived: false, transcript: false });
    const all = [...items.values()];
    // An opened project whose directory is gone or left the roots is not listed (its New session would fail).
    const known = projects.list(all).filter((cwd) => allowed(cwd));
    const shown = new Set(known);
    return { projects: known, sessions: all.filter((s) => shown.has(trim(s.cwd))).sort((a, b) => b.lastActivity - a.lastActivity) };
  }

  /** A session of this daemon run, or one rebuilt from its SDK transcript (ADR 0001). Concurrent calls share one restore. */
  function findSession(id: string): Promise<Session | undefined> {
    // Its transcript still exists until the delete ends; a restore now would bring the session back.
    if (deleting.has(id)) return Promise.resolve(undefined);
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
        const saved = settings[id];
        const model = isModel(saved?.model) ? saved.model : used && ((await modelList().catch(() => [])).find((m) => m.resolvedModel === used)?.value ?? used);
        // A mode the daemon does not enable now (bypass without CLAUDE_UI_ALLOW_BYPASS) falls back to the default.
        const modes = PERMISSION_MODES.filter((m) => m !== "bypassPermissions" || opts.allowBypass);
        const permissionMode = saved && modes.includes(saved.permissionMode) ? saved.permissionMode : undefined;
        const effort = saved && EFFORTS.includes(saved.effort) ? saved.effort : undefined;
        return track(Session.restore(id, info.cwd, messages, sessionOpts(() => id, { model, permissionMode, effort })));
      })()
        .catch((err) => void console.error(`restoring session ${id} failed:`, err))
        .finally(() => restoring.delete(id));
      restoring.set(id, p);
    }
    return p;
  }

  /** Working directory and transcript of a listed session (live or inside the roots); undefined when unknown. */
  async function locate(id: string) {
    const live = sessions.get(id);
    if (!live && (typeof id !== "string" || !UUID.test(id))) return undefined;
    const info = await history.getSessionInfo(id).catch(() => undefined);
    const cwd = live?.cwd ?? (info?.cwd && allowed(info.cwd));
    return cwd ? { cwd, live, transcript: !!info } : undefined;
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

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, handleProtocols: (offered) => (offered.has(WS_PROTOCOL) ? WS_PROTOCOL : false) });
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
    connections.add(ws);
    const usage = plan.current();
    if (usage !== undefined) send(ws, { type: "plan_usage", usage });
    if (plan.age() > PLAN_STALE_MS) void plan.reread();
    const unsubscribes = new Map<string, () => void>();
    // fs.watch: watched path as the client gave it → canonical path and its stat listener.
    const watched = new Map<string, { real: string; listener: (curr: Stats, prev: Stats) => void }>();
    // Attached terminals: ID → detach.
    const attached = new Map<string, () => void>();
    const unwatchAll = () => {
      watched.forEach((w) => unwatchFile(w.real, w.listener));
      watched.clear();
    };
    // Without a listener a socket error (e.g. a frame above maxPayload) is thrown and the daemon exits; ws closes the socket itself.
    ws.on("error", (err) => console.warn("ws:", err.message));
    ws.on("close", () => {
      connections.delete(ws);
      unsubscribes.forEach((u) => u());
      unwatchAll();
      attached.forEach((d) => d());
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
          const s: Session = track(new Session(cwd, sessionOpts(() => s.id, { model: msg.model })));
          return reply({ session: s.info() });
        }
        case "session.subscribe": {
          const s = await find(msg.sessionId);
          if (!s || ws.readyState !== ws.OPEN) return;
          unsubscribes.get(s.id)?.();
          // Different epoch: the client's seqs belong to an earlier daemon run, so replay everything.
          const since = msg.logEpoch === logEpoch ? msg.sinceSeq : 0;
          reply({ logEpoch, seq: s.seq(), session: s.info() });
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
          return reply(await list());
        case "project.open": {
          const cwd = allowed(msg.cwd);
          if (!cwd || !statSync(cwd).isDirectory()) return fail("cwd_not_allowed", `not a directory inside the allowlisted roots: ${msg.cwd}`);
          try {
            projects.open(cwd);
          } catch (err) {
            return fail("fs_error", String(err));
          }
          return reply({ cwd });
        }
        case "project.remove":
          if (typeof msg.cwd !== "string" || !isAbsolute(msg.cwd)) return fail("bad_cwd", "cwd must be an absolute path");
          try {
            projects.remove(msg.cwd);
          } catch (err) {
            return fail("fs_error", String(err));
          }
          return reply({});
        case "session.rename":
        case "session.archive": {
          const title = msg.type === "session.rename" && typeof msg.title === "string" ? msg.title.trim() : "";
          // 200: the web title input's maxLength.
          if (msg.type === "session.rename" && (!title || title.length > 200)) return fail("bad_title", "title must be 1 to 200 characters");
          if (msg.type === "session.archive" && typeof msg.archived !== "boolean") return fail("bad_request", "archived must be a boolean");
          const at = await locate(msg.sessionId);
          if (!at) return fail("unknown_session", `no session ${msg.sessionId}`);
          try {
            if (msg.type === "session.rename") await history.renameSession(msg.sessionId, title, { dir: at.cwd });
            else await history.tagSession(msg.sessionId, msg.archived ? ARCHIVED_TAG : null, { dir: at.cwd });
          } catch (e) {
            // A session with no prompt yet has no transcript to write to.
            return fail(`${msg.type.slice("session.".length)}_failed`, (e as Error).message);
          }
          broadcast({ type: "sessions.changed" });
          return reply({});
        }
        case "session.delete": {
          // A restore already in flight would put the session back after the delete; let it finish, then close it below.
          await restoring.get(msg.sessionId);
          const at = await locate(msg.sessionId);
          if (!at) return fail("unknown_session", `no session ${msg.sessionId}`);
          const state = at.live?.info().state;
          if (state === "running" || state === "needs_input") return fail("session_running", "stop the session before deleting it");
          // The CLI exits first: it writes session metadata on exit, which would recreate the transcript. A failed delete keeps the transcript.
          deleting.add(msg.sessionId);
          sessions.delete(msg.sessionId);
          try {
            await at.live?.close();
            if (at.transcript) await history.deleteSession(msg.sessionId, { dir: at.cwd });
          } catch (e) {
            return fail("delete_failed", (e as Error).message);
          } finally {
            deleting.delete(msg.sessionId);
          }
          broadcast({ type: "sessions.changed", deleted: msg.sessionId });
          return reply({});
        }
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
          // A missing file whose nearest existing ancestor is allowed (deleted after an Edit, also with its directory): the changes tab shows it deleted.
          if (!file && typeof msg.path === "string" && isAbsolute(msg.path) && !existsSync(msg.path)) {
            let dir = dirname(resolve(msg.path));
            while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
            if (allowed(dir)) return fail("not_found", `no such file: ${msg.path}`);
          }
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
        case "terminal.create": {
          const cwd = allowed(msg.cwd);
          if (!cwd || !statSync(cwd).isDirectory()) return fail("cwd_not_allowed", `not a directory inside the allowlisted roots: ${msg.cwd}`);
          if (!isSize(msg.cols) || !isSize(msg.rows)) return fail("bad_size", "cols and rows must be integers from 1 to 1000");
          const full = terminals.limit(ws);
          if (full) return fail("too_many_terminals", full);
          try {
            return reply({ terminal: terminals.create(cwd, msg.cols, msg.rows, ws) });
          } catch (err) {
            return fail("spawn_failed", String(err));
          }
        }
        case "terminal.list": {
          const cwd = allowed(msg.cwd);
          return reply({ terminals: cwd ? terminals.list(cwd) : [] });
        }
        case "terminal.detach":
          attached.get(msg.terminalId)?.();
          attached.delete(msg.terminalId);
          return reply({});
        case "terminal.attach":
        case "terminal.input":
        case "terminal.resize":
        case "terminal.close": {
          const t = terminals.get(msg.terminalId);
          if (!t) return fail("unknown_terminal", `no terminal ${msg.terminalId}`);
          if (msg.type === "terminal.attach") {
            const { buffer, detach } = terminals.attach(t, {
              output: (data) => send(ws, { type: "terminal.output", terminalId: t.id, data }),
              exit: (exitCode) => (attached.delete(t.id), send(ws, { type: "terminal.exit", terminalId: t.id, exitCode })),
            });
            attached.get(t.id)?.();
            attached.set(t.id, detach);
            return reply({ buffer });
          }
          if (msg.type === "terminal.input") {
            if (typeof msg.data !== "string") return fail("bad_input", "data must be a string");
            if (Buffer.byteLength(msg.data) > MAX_TERMINAL_INPUT_BYTES) return fail("too_large", `terminal input larger than ${MAX_TERMINAL_INPUT_BYTES} bytes`);
            t.pty.write(msg.data);
          } else if (msg.type === "terminal.resize") {
            if (!isSize(msg.cols) || !isSize(msg.rows)) return fail("bad_size", "cols and rows must be integers from 1 to 1000");
            t.pty.resize(msg.cols, msg.rows);
          } else terminals.close(t);
          return reply({});
        }
        default:
          return fail("unknown_type", `unknown message type ${(msg as { type?: string }).type}`);
      }
    });
  });

  return http;
}

function readJson<T>(file: string | undefined): T | undefined {
  if (!file || !existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`ignoring unreadable ${file}:`, err);
    return undefined;
  }
}

const isSize = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1000;

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
