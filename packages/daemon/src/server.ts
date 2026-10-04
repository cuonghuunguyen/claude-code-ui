// HTTP server for the built web app plus the WebSocket endpoint at /ws.
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createServer, type IncomingMessage } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { EFFORTS, imageBlock, MAX_TERMINAL_INPUT_BYTES, MAX_UPLOAD_BYTES, PERMISSION_MODES, permissionModesFor, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ClientMessage, type FsEntry, type ListResult, type ModelInfo, type RewindMode, type ServerMessage, type SessionListItem } from "@claude-ui/protocol";
import { deleteSession, getSessionInfo, getSessionMessages, getSubagentMessages, listSessions, listSubagents, renameSession, tagSession, type query as sdkQuery, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { searchFiles } from "./search.ts";
import { gitStatus } from "./git.ts";
import { createNotifier, type Push } from "./push.ts";
import { createProjects, trim, type Projects } from "./projects.ts";
import { createPlanTracker } from "./plan-usage.ts";
import { listModels, queuedQuery, Session, transcriptModel, type SessionSettings, type Transcript } from "./session.ts";
import { createTerminals } from "./terminals.ts";
import { ConfigError, createConfig, runCli, timed, type CliRunner, type McpRequest, type SkillsRequest } from "./config.ts";
import { createPlugins, type PluginsRequest } from "./plugins.ts";

const REWIND_MODES: RewindMode[] = ["code", "conversation", "both"];

/** sessions.json keeps the settings of this many sessions (most recently changed). */
export const MAX_SETTINGS = 1000;
/** session.list waits this long for the model list (auto mode of new sessions) before it replies without it. */
export const MODEL_LIST_WAIT_MS = 2000;

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
  /** Subagent run transcripts (`<session>/subagents/agent-<id>.jsonl`); not in getSessionMessages(). */
  listSubagents?: typeof listSubagents;
  getSubagentMessages?: typeof getSubagentMessages;
  renameSession?: typeof renameSession;
  tagSession?: typeof tagSession;
  deleteSession?: typeof deleteSession;
};

/** SDK session tag that marks an archived session (no archive flag of its own; ADR 0001: no store of ours). */
const ARCHIVED_TAG = "archived";

const LOCAL_HOSTNAMES = ["127.0.0.1", "localhost"];

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

// ponytail: the SDK's project folder name for cwds up to 200 chars; longer ones get a hash suffix and are not found.
const transcriptFile = (projectsDir: string, cwd: string, sessionId: string) => join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);

/**
 * Permission mode of the last prompt and effort of the last reply in a session's raw transcript (getSessionMessages() drops
 * both fields): the restore fallback when sessions.json has no entry. Absent fields stay undefined.
 */
function transcriptSettings(projectsDir: string, cwd: string, sessionId: string): { permissionMode?: unknown; effort?: unknown } {
  let lines: string[];
  try {
    lines = readFileSync(transcriptFile(projectsDir, cwd, sessionId), "utf8").split("\n");
  } catch {
    return {};
  }
  const found: { permissionMode?: unknown; effort?: unknown } = {};
  for (let i = lines.length - 1; i >= 0 && (found.permissionMode === undefined || found.effort === undefined); i--) {
    const line = lines[i]!;
    if (!line.includes('"permissionMode"') && !line.includes('"effort"')) continue;
    try {
      const e = JSON.parse(line) as { type?: string; isSidechain?: boolean; permissionMode?: unknown; effort?: unknown };
      if (e.isSidechain) continue;
      if (e.type === "user" && found.permissionMode === undefined) found.permissionMode = e.permissionMode;
      if (e.type === "assistant" && found.effort === undefined) found.effort = e.effort;
    } catch {
      // A line cut by a concurrent write.
    }
  }
  return found;
}

/**
 * getSubagentMessages() keeps only the run transcript's last parentUuid chain (SDK 0.3.285). Parallel tool calls branch: each
 * parallel tool_use of one API message is its own assistant line chained off the previous one, each tool_result a child of its
 * tool_use line, so the calls and results off the leaf chain are lost. Puts back, from the raw `agent-<id>.jsonl`, each lost
 * assistant line of an API message the output has and each lost tool_result, right after its parent (the nearest ancestor
 * that is kept or put back; attachment lines in between are skipped).
 */
async function withParallelCalls(file: string | undefined, messages: SessionMessage[]): Promise<SessionMessage[]> {
  if (!file) return messages;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return messages;
  }
  type Line = { type: SessionMessage["type"]; uuid: string; parentUuid?: string; message?: { id?: unknown; content?: unknown }; timestamp?: string };
  const have = new Set(messages.map((m) => m.uuid));
  const apiIds = new Set<unknown>(messages.flatMap((m) => (m.type === "assistant" && (m.message as { id?: unknown })?.id) || []));
  const parentOf = new Map<string, string>();
  const lost = new Map<string, Line>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line) as Line;
      if (!e.uuid) continue;
      if (e.parentUuid) parentOf.set(e.uuid, e.parentUuid);
      if (have.has(e.uuid)) continue;
      const content = e.message?.content;
      const result = e.type === "user" && Array.isArray(content) && content.some((b) => (b as { type?: unknown })?.type === "tool_result");
      if (result || (e.type === "assistant" && apiIds.has(e.message?.id))) lost.set(e.uuid, e);
    } catch {
      // A line cut by a concurrent write.
    }
  }
  if (!lost.size) return messages;
  const children = new Map<string, Line[]>();
  for (const e of lost.values()) {
    let p = e.parentUuid;
    for (let i = 0; p && !have.has(p) && !lost.has(p) && i < parentOf.size; i++) p = parentOf.get(p);
    if (p) children.set(p, [...(children.get(p) ?? []), e]);
  }
  const out: SessionMessage[] = [];
  const add = (m: SessionMessage) => {
    out.push(m);
    for (const e of children.get(m.uuid) ?? []) add({ ...m, type: e.type, uuid: e.uuid, message: e.message, timestamp: e.timestamp } as SessionMessage);
  };
  messages.forEach(add);
  return out;
}

/** Names, sizes and mtimes of every transcript under `projectsDir`; undefined when it cannot be read. */
function transcriptStamp(projectsDir: string) {
  try {
    const parts: string[] = [];
    for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const path = join(projectsDir, dir.name);
      for (const f of readdirSync(path)) {
        if (!f.endsWith(".jsonl")) continue;
        try {
          const st = statSync(join(path, f));
          parts.push(`${dir.name}/${f}:${st.size}:${st.mtimeMs}`);
        } catch {
          // Deleted meanwhile.
        }
      }
    }
    return parts.join("\n");
  } catch {
    return undefined;
  }
}

/**
 * Time of the last user or assistant entry in a session's transcript, read from its end. Not the file mtime: on exit
 * the CLI appends metadata (`last-prompt`, `cost-state`), so every live session looks just used after a daemon restart.
 * Undefined when the file or such an entry is not found (e.g. the entry is further back than `TAIL_BYTES`).
 */
function lastMessageAt(projectsDir: string, cwd: string, sessionId: string) {
  // Not found (long cwd): the list falls back to the file mtime.
  const file = transcriptFile(projectsDir, cwd, sessionId);
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
 * `listCache`: reuse the last transcript scan while no transcript file under `projectsDir` changed (default: on with the
 * SDK's own listSessions()).
 * `hostnames`: hostnames besides loopback that browsers may reach the daemon by, e.g. a `tailscale serve` name (ADR 0003).
 * `cli`: runs the Claude Code CLI for config writes (default: the SDK-bundled binary). `configHoldMs`: config query hold.
 * `configPollMs`: pause between the reads that confirm a skill state change.
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
  listCache?: boolean;
  hostnames?: string[];
  cli?: CliRunner;
  configHoldMs?: number;
  configPollMs?: number;
}) {
  const hostnames = new Set([...LOCAL_HOSTNAMES, ...(opts.hostnames ?? [])]);
  const logEpoch = randomUUID();
  /**
   * fs.upload parent: one private (0700, mkdtemp) folder per daemon. Made up front: every session gets it as an
   * additional directory, so Claude reads an attachment without asking.
   */
  const uploadParent = opts.uploadDir ?? mkdtempSync(join(tmpdir(), "claude-ui-"));
  mkdirSync(uploadParent, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, Session>();
  // Insertion order = last change order: the oldest entries go first past MAX_SETTINGS.
  const settings: Record<string, SessionSettings> = readJson(opts.settingsFile) ?? {};
  /** Rewrites sessions.json atomically (tmp + rename): a crash mid-write keeps the previous file. */
  const saveSettings = () => {
    if (!opts.settingsFile) return;
    const ids = Object.keys(settings);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SETTINGS))) delete settings[id];
    const tmp = `${opts.settingsFile}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(settings), { mode: 0o600 });
      renameSync(tmp, opts.settingsFile);
    } catch (err) {
      console.error("saving session settings failed:", err);
    }
  };
  // Account-wide, so not a session event: every connection gets each change.
  const plan = createPlanTracker({ onChange: (usage) => broadcast({ type: "plan_usage", usage }), read: () => queuedQuery(plan.refresh, opts.query) });
  /** Options of every session: settings changes are saved under its ID. */
  const sessionOpts = (id: () => string, initial: Partial<SessionSettings>) => ({
    ...initial,
    plan,
    allowBypass: opts.allowBypass,
    supportsAuto,
    uploadDir: uploadParent,
    query: opts.query,
    readTranscript,
    onSettings: (s: SessionSettings) => {
      delete settings[id()];
      settings[id()] = s;
      saveSettings();
    },
  });
  const restoring = new Map<string, Promise<Session | undefined>>();
  // Sessions whose delete is in progress (session.delete).
  const deleting = new Set<string>();
  const history = { listSessions, getSessionInfo, getSessionMessages, listSubagents, getSubagentMessages, renameSession, tagSession, deleteSession, ...opts.history };
  const projectsDir = opts.projectsDir ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const projects = opts.projects ?? createProjects();
  const connections = new Set<WebSocket>();
  const terminals = createTerminals();
  const broadcast = (m: ServerMessage) => connections.forEach((ws) => send(ws, m));
  const config = createConfig({ query: opts.query, cli: opts.cli, holdMs: opts.configHoldMs, pollMs: opts.configPollMs, onChanged: (kind, cwd) => broadcast({ type: "config.changed", kind, cwd }) });
  const plugins = createPlugins({
    cli: opts.cli ?? runCli,
    // Plugins are user- or project-wide: every live query reloads, as the extension reloads every open session.
    reload: async () => {
      const live = [...sessions.values()].filter((s) => s.liveQuery());
      const results = await Promise.allSettled(live.map((s) => timed(s.reloadPlugins())));
      const failed = live.filter((s, i) => results[i]!.status === "rejected" && (console.error(`session ${s.id}: reloadPlugins failed:`, (results[i] as PromiseRejectedResult).reason), true)).map((s) => s.id);
      const errorCount = results.reduce((n, r) => n + (r.status === "fulfilled" ? (r.value ?? 0) : 0), 0);
      return { reloaded: live.length - failed.length, failed, errorCount };
    },
    restart: (id) => {
      const s = sessions.get(id);
      if (!s) throw new ConfigError("not_found", `unknown session ${id}`);
      s.restartQuery();
    },
    onChanged: (cwd, reload) => {
      config.dropAll();
      broadcast({ type: "config.changed", kind: "plugins", cwd, ...(reload && { reloadFailed: reload.failed }) });
    },
  });
  const root = resolve(opts.webRoot);
  // ponytail: model list cached for the daemon lifetime; a login/plan change needs a daemon restart.
  let models: ReturnType<typeof listModels> | undefined;
  // Sync copy for SessionInfo.permissionModes: every path that builds a SessionInfo awaits modelList() first.
  let known: ModelInfo[] = [];
  const modelList = () =>
    (models ??= listModels(opts.query).then((l) => (known = l))).catch((e) => {
      models = undefined;
      throw e;
    });
  const supportsAuto = (model: string) => known.some((m) => m.value === model && m.supportsAutoMode);
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

  /** Adds the project of a session the user opened or created; other clients refresh their list. A failed write is only logged: the session works. */
  function addProject(cwd: string) {
    if (projects.has(cwd)) return;
    try {
      projects.open(cwd);
      broadcast({ type: "sessions.changed" });
    } catch (err) {
      console.error("saving projects failed:", err);
    }
  }

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
  /** Main chain and subagent runs of a session's transcript. An unreadable run transcript leaves that run out, not the session. */
  async function readTranscript(id: string, cwd: string): Promise<Transcript> {
    const main = await history.getSessionMessages(id, { dir: cwd });
    const agents = await history.listSubagents(id, { dir: cwd }).catch((err) => (console.error(`listing subagent runs of ${id} failed:`, err), []));
    const dir = transcriptFile(projectsDir, cwd, id).replace(/\.jsonl$/, "/subagents");
    let files: string[] = [];
    try {
      if (agents.length) files = readdirSync(dir, { recursive: true, encoding: "utf8" });
    } catch {
      // No raw run files: the SDK output as is.
    }
    const runFile = (a: string) => {
      const f = files.find((f) => basename(f) === `agent-${a}.jsonl`);
      return f && join(dir, f);
    };
    const runs = await Promise.all(
      agents.map((a) =>
        history
          .getSubagentMessages(id, a, { dir: cwd })
          .then((m) => withParallelCalls(runFile(a), m))
          .catch((err) => (console.error(`reading subagent run ${a} of ${id} failed:`, err), [])),
      ),
    );
    return { main, runs };
  }

  /**
   * Live mirror: while a connection is subscribed to a session, a changed size or mtime of its transcript (stat polling
   * like fs.watch) syncs the session. `stamps`: the transcript's size and mtime at the last sync or restore; a first
   * subscriber syncs when it changed meanwhile. ponytail: one poll per watched session, no cap.
   */
  const mirrors = new Map<string, { subscribers: number; file: string; listener: (curr: Stats) => void }>();
  const stamps = new Map<string, string>();
  const stampOf = (st: Stats) => `${st.size}:${st.mtimeMs}`;
  const statStamp = (file: string) => {
    try {
      return stampOf(statSync(file));
    } catch {
      return "0:0";
    }
  };
  function mirror(s: Session) {
    let m = mirrors.get(s.id);
    if (!m) {
      const file = transcriptFile(projectsDir, s.cwd, s.id);
      // Also called once with zeroed stats for a missing file: no change then.
      const sync = (stamp: string) => {
        if (stamps.get(s.id) === stamp) return;
        stamps.set(s.id, stamp);
        void s.sync();
      };
      const listener = (curr: Stats) => sync(stampOf(curr));
      mirrors.set(s.id, (m = { subscribers: 0, file, listener }));
      watchFile(file, { interval: WATCH_INTERVAL_MS }, listener);
      sync(statStamp(file));
    }
    const watch = m;
    watch.subscribers++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--watch.subscribers) return;
      unwatchFile(watch.file, watch.listener);
      mirrors.delete(s.id);
    };
  }

  /** Adds a session and follows its live events (not its history) for pushes. */
  function track(s: Session) {
    sessions.set(s.id, s);
    s.subscribe(Infinity, notifier.observe);
    return s;
  }

  // listSessions() reads every transcript under ~/.claude/projects (hundreds of MB): one scan at a time.
  // Requests during a scan share one queued scan, so a reply is never older than its request.
  // Each listSessions() call also grows the daemon RSS by ~4 MB that it never returns (SDK 0.3.285, heap flat; probe in
  // development-docs/FIX-C/ls-probe.log): while no transcript changed (names, sizes, mtimes), the last result is reused.
  let scan: ReturnType<typeof listSessions> | undefined;
  let nextScan: ReturnType<typeof listSessions> | undefined;
  let lastScan: { stamp: string; result: Awaited<ReturnType<typeof listSessions>> } | undefined;
  const listCache = opts.listCache ?? !opts.history?.listSessions;
  function transcripts(): ReturnType<typeof listSessions> {
    if (!scan) {
      // Taken before the scan: a file written during it changes the next stamp.
      const stamp = listCache ? transcriptStamp(projectsDir) : undefined;
      if (stamp !== undefined && lastScan?.stamp === stamp) return Promise.resolve(lastScan.result);
      return (scan = history
        .listSessions()
        .then((result) => ((lastScan = stamp === undefined ? undefined : { stamp, result }), result))
        .finally(() => (scan = undefined)));
    }
    return (nextScan ??= scan.catch(() => {}).then(() => ((nextScan = undefined), transcripts())));
  }

  async function list(): Promise<ListResult> {
    // The model list starts a CLI: not waiting longer than this offers no auto mode until it is there.
    await new Promise<void>((done) => {
      const t = setTimeout(done, MODEL_LIST_WAIT_MS);
      modelList().catch(() => {}).then(() => (clearTimeout(t), done()));
    });
    const items = new Map<string, SessionListItem>();
    const all = await transcripts();
    // Entries of sessions deleted outside this daemon (CLI, file removed): no transcript and not live.
    const known = new Set(all.map((t) => t.sessionId));
    const stale = Object.keys(settings).filter((id) => !known.has(id) && !sessions.has(id));
    if (stale.length) stale.forEach((id) => delete settings[id]), saveSettings();
    for (const t of all) {
      if (!t.cwd || !allowed(t.cwd)) continue;
      const live = sessions.get(t.sessionId)?.info() ?? { state: "closed" as const, model: "default", permissionMode: "default" as const, effort: "default" as const, permissionModes: [] };
      items.set(t.sessionId, { ...live, id: t.sessionId, cwd: t.cwd, title: t.summary, lastActivity: lastMessageAt(projectsDir, t.cwd, t.sessionId) ?? t.lastModified, archived: t.tag === ARCHIVED_TAG, transcript: true });
    }
    // Sessions of this run that have no transcript yet (no prompt sent).
    for (const s of sessions.values())
      if (!items.has(s.id)) items.set(s.id, { ...s.info(), title: "New session", lastActivity: s.createdAt, archived: false, transcript: false });
    const listed = [...items.values()];
    // Upgrade from "every transcript cwd is a project": the projects with saved claude-ui state stay, once.
    if (!projects.seeded)
      try {
        projects.seed(listed.filter((s) => s.id in settings));
      } catch (err) {
        // In memory it holds; the next start seeds again.
        console.error("saving projects failed:", err);
      }
    // An added project whose directory is gone or left the roots is not listed (its New session would fail).
    const open = projects.list(listed).filter((cwd) => allowed(cwd));
    const shown = new Set(open);
    return {
      projects: open,
      recentProjects: projects.recent(listed),
      sessions: listed.filter((s) => shown.has(trim(s.cwd))).sort((a, b) => b.lastActivity - a.lastActivity),
      permissionModes: permissionModesFor({ allowBypass: opts.allowBypass, supportsAuto: supportsAuto("default") }),
    };
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
        // Before the read: a write during it changes the stamp, so the first subscriber syncs it.
        stamps.set(id, statStamp(transcriptFile(projectsDir, info.cwd, id)));
        const { main: messages, runs } = await readTranscript(id, info.cwd);
        await modelList().catch(() => {});
        // The model row whose resolved ID the transcript last used ("default" first); the ID itself when none matches.
        const used = transcriptModel(messages);
        // No entry (sessions.json lost, a session of the terminal CLI): mode and effort the transcript last recorded.
        const saved = settings[id] ?? { model: undefined, ...transcriptSettings(projectsDir, info.cwd, id) };
        const model = isModel(saved?.model) ? saved.model : used && ((await modelList().catch(() => [])).find((m) => m.resolvedModel === used)?.value ?? used);
        // A mode the daemon does not enable now (bypass without CLAUDE_UI_ALLOW_BYPASS) falls back to the default.
        const modes = permissionModesFor({ allowBypass: opts.allowBypass, supportsAuto: supportsAuto(model ?? "default") });
        const permissionMode = modes.includes(saved.permissionMode as never) ? (saved.permissionMode as SessionSettings["permissionMode"]) : undefined;
        const effort = EFFORTS.includes(saved.effort as never) ? (saved.effort as SessionSettings["effort"]) : undefined;
        // Each run's messages name the Agent call that started it (parent_tool_use_id), so after the main transcript they nest by it.
        return track(Session.restore(id, info.cwd, [...messages, ...runs.flat()], sessionOpts(() => id, { model, permissionMode, effort })));
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
    if (!isOwnOrigin(req, hostnames)) return reject("403 Forbidden");
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
          await modelList().catch(() => {});
          const s: Session = track(new Session(cwd, sessionOpts(() => s.id, { model: msg.model })));
          addProject(cwd);
          return reply({ session: s.info() });
        }
        case "session.subscribe": {
          const s = await find(msg.sessionId);
          if (!s || ws.readyState !== ws.OPEN) return;
          // Only an explicit open (link, notification) adds the project; a reconnect resubscribe must not bring back a removed one.
          if (msg.addProject === true) addProject(s.cwd);
          unsubscribes.get(s.id)?.();
          // Different epoch: the client's seqs belong to an earlier daemon run, so replay everything.
          const since = msg.logEpoch === logEpoch ? msg.sinceSeq : 0;
          reply({ logEpoch, seq: s.seq(), session: s.info() });
          const stop = s.subscribe(since, (e) => send(ws, e));
          const release = mirror(s);
          unsubscribes.set(s.id, () => (stop(), release()));
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
          // Sync before prompt: the prompt continues after the terminal CLI's turns (a running turn is steered as is).
          if (s.info().state === "idle") await s.sync();
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
        case "session.stopSubagent": {
          const s = await find(msg.sessionId);
          if (!s) return;
          try {
            if (!(await s.stopSubagent(msg.subagentId))) return fail("unknown_subagent", "no running subagent run with that ID");
          } catch (e) {
            return fail("stop_failed", (e as Error).message);
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
          // Other connected clients refresh their project list.
          broadcast({ type: "sessions.changed" });
          return reply({ cwd });
        }
        case "project.remove":
          if (typeof msg.cwd !== "string" || !isAbsolute(msg.cwd)) return fail("bad_cwd", "cwd must be an absolute path");
          try {
            projects.remove(msg.cwd);
          } catch (err) {
            return fail("fs_error", String(err));
          }
          broadcast({ type: "sessions.changed" });
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
          if (settings[msg.sessionId]) delete settings[msg.sessionId], saveSettings();
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
        case "git.status": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          return reply({ status: await gitStatus(cwd) });
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
              backlog: () => ws.bufferedAmount,
              exit: (exitCode) => (attached.delete(t.id), send(ws, { type: "terminal.exit", terminalId: t.id, exitCode })),
            });
            attached.get(t.id)?.();
            attached.set(t.id, detach);
            return reply({ buffer });
          }
          if (msg.type === "terminal.input") {
            if (typeof msg.data !== "string") return fail("bad_input", "data must be a string");
            if (Buffer.byteLength(msg.data) > MAX_TERMINAL_INPUT_BYTES) return fail("too_large", `terminal input larger than ${MAX_TERMINAL_INPUT_BYTES} bytes`);
            const err = terminals.write(t, msg.data);
            if (err) return fail(err, { input_backlog: "the shell has not read the earlier input yet; send again later", unknown_terminal: "the terminal is closed", write_failed: "writing to the terminal failed" }[err]);
          } else if (msg.type === "terminal.resize") {
            if (!isSize(msg.cols) || !isSize(msg.rows)) return fail("bad_size", "cols and rows must be integers from 1 to 1000");
            terminals.resize(t, msg.cols, msg.rows);
          } else terminals.close(t);
          return reply({});
        }
        case "mcp.list":
        case "mcp.toggle":
        case "mcp.reconnect":
        case "mcp.authenticate":
        case "mcp.oauthCallback":
        case "mcp.clearAuth":
        case "mcp.add":
        case "mcp.remove":
        case "plugins.list":
        case "plugins.install":
        case "plugins.uninstall":
        case "plugins.setEnabled":
        case "plugins.update":
        case "plugins.reload":
        case "plugins.restart":
        case "marketplace.list":
        case "marketplace.add":
        case "marketplace.remove":
        case "marketplace.update":
        case "skills.list":
        case "skills.setState": {
          if (typeof msg.cwd === "string" && isAbsolute(msg.cwd) && !existsSync(msg.cwd))
            return fail("bad_cwd", `Working directory not found: ${msg.cwd}. If this session's folder was deleted, re-open the project and try again.`);
          const cwd = allowed(msg.cwd);
          if (!cwd || !statSync(cwd).isDirectory()) return fail("cwd_not_allowed", `not a directory inside the allowlisted roots: ${msg.cwd}`);
          if (!msg.type.startsWith("mcp.") && !msg.type.startsWith("skills."))
            try {
              return reply(await plugins.handle(msg as PluginsRequest, cwd));
            } catch (e) {
              return fail(e instanceof ConfigError ? e.code : "plugins_failed", (e as Error).message);
            }
          // The session's running query when it runs in that project; otherwise the project's config query.
          const s = "sessionId" in msg && typeof msg.sessionId === "string" ? sessions.get(msg.sessionId) : undefined;
          try {
            const live = s?.cwd === cwd ? s.liveQuery() : undefined;
            return reply(msg.type.startsWith("skills.") ? await config.skills(msg as SkillsRequest, cwd, live) : await config.mcp(msg as McpRequest, cwd, live));
          } catch (e) {
            return fail(e instanceof ConfigError ? e.code : msg.type.startsWith("skills.") ? "skills_failed" : "mcp_failed", (e as Error).message);
          }
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
 * must be loopback or a configured hostname: a cross-site page has a foreign Origin, a DNS-rebinding page has a foreign Host.
 */
function isOwnOrigin(req: IncomingMessage, hostnames: Set<string>) {
  const { origin, host } = req.headers;
  if (!origin || !host) return false;
  try {
    const o = new URL(origin);
    return (o.protocol === "http:" || o.protocol === "https:") && o.host === host && hostnames.has(o.hostname);
  } catch {
    return false;
  }
}

function send(ws: WebSocket, m: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
}
