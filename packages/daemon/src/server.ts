// HTTP server for the built web app plus the WebSocket endpoint at /ws.
import { closeSync, createReadStream, existsSync, fstatSync, ftruncateSync, mkdirSync, readdirSync, readFileSync, statSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { homedir, hostname as osHostname, tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { createAdapter, EFFORTS, imageBlock, LOCAL_SIDE, MAX_SEARCH_CHARS, MAX_TERMINAL_INPUT_BYTES, MIN_SEARCH_CHARS, MAX_UPLOAD_BYTES, PERMISSION_MODES, permissionModesFor, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type ClientMessage, type FsEntry, type ListResult, type MediaReadResult, type ModelInfo, type RewindMode, type SessionIdsResult, type ServerMessage, type SessionListItem, type SlashCommand, type Worktree } from "@claude-ui/protocol";
import { deleteSession, getSessionInfo, getSessionMessages, getSubagentMessages, listSessions, listSubagents, renameSession, tagSession, type query as sdkQuery, type SDKMessage, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { searchFiles } from "./search.ts";
import { foreignPointer, refusedPath, winPathKind } from "./remote-path.ts";
import { openChecked, OPEN_READ, OPEN_WRITE, readAll, real, sameFile, writeAll } from "./fd-check.ts";
import { MEDIA_BLOB_CACHE_MAX, MEDIA_BLOB_MAX, MEDIA_CHUNK, MEDIA_HEADERS, MEDIA_TTL_MS, mediaType, parseRange } from "./media.ts";
import { createPerf, setPerf, type PerfMonitor } from "./perf.ts";
import { createWorktree, gitBlobRead, gitBlobRef, gitDiff, gitDirsOf, gitEscapes, gitFileAt, gitLog, gitRefs, gitShow, gitStatus, listWorktrees, removeWorktree, WorktreeError, worktreeStatus, type CreateWorktreeOptions } from "./git.ts";
import { createNotifier, type Push } from "./push.ts";
import { readDefaultMode } from "./default-mode.ts";
import { createSettings, type AppSettings } from "./settings.ts";
import { createProjects, trim, type Projects } from "./projects.ts";
import { createPlanTracker, usesOauthToken } from "./plan-usage.ts";
import { CONTINUE_PROMPT, createAutoContinue } from "./auto-continue.ts";
import { listModels, queuedQuery, Session, transcriptModel, type SessionSettings, type Transcript } from "./session.ts";
import { createTerminals } from "./terminals.ts";
import { ConfigError, createConfig, runCli, timed, type CliRunner, type McpRequest, type SkillsRequest } from "./config.ts";
import { createPlugins, redact, type PluginsRequest } from "./plugins.ts";
import { searchTranscripts } from "./content-search.ts";
import { cliTurnRunning, interleaveRuns, JsonlTail, parseJsonl, transcriptEnd } from "./transcript.ts";
import { createRouter, type Sides } from "./sides.ts";
import { createSessionSettings } from "./session-settings.ts";
import { createUploads, SESSION_DIR } from "./uploads.ts";
import { createUpdater, type Updater } from "./update.ts";
import { createOrchestration } from "./orchestration.ts";
import type { AddressInfo } from "node:net";
import { serveStatic } from "./static.ts";
import { lastEntryTime, listSessionsOffThread, mapLimit, transcriptStamp } from "./session-scan.ts";

export { MAX_SETTINGS } from "./session-settings.ts";

/**
 * What the connection handler and the keep-alive pinger use of a socket. Both a `ws` WebSocket and a side's SideSocket (sides.ts)
 * satisfy it; typing the handler against `ws.WebSocket` and casting a SideSocket to it hid a missing ping()/terminate() (GH-263).
 */
export interface Conn {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(): void;
  ping(): void;
  terminate(): void;
  on(event: "message", listener: (data: RawData) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "pong" | "close", listener: () => void): unknown;
}
// Compile-time check: a real ws socket satisfies Conn (wss.on/emit are loosely typed, so nothing else would notice a new Conn member it lacks).
void ((w: WebSocket): Conn => w);

const REWIND_MODES: RewindMode[] = ["code", "conversation", "both"];

/** SDK title of a transcript whose only prompt is /clear (or its aliases /reset, /new). */
const CLEARED = /^\/(clear|reset|new)$/;
/** session.list waits this long for the model list (auto mode of new sessions) before it replies without it. */
export const MODEL_LIST_WAIT_MS = 2000;

/** ws maxPayload (default 100 MiB): a prompt with two images at MAX_UPLOAD_BYTES as base64, plus the JSON around them. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Larger files are not opened in the editor. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** UTF-8 text of a file's bytes; a UTF-16 BOM or NUL means binary-ish, invalid UTF-8 is refused (a lossy decode would be written back by a save). */
function decodeText(buf: Buffer): { content: string } | { code: "binary" | "not_utf8" } {
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return { code: "not_utf8" };
  if (buf.includes(0)) return { code: "binary" };
  try {
    // ignoreBOM keeps the BOM in the content.
    return { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf) };
  } catch {
    return { code: "not_utf8" };
  }
}
// ponytail: stat polling, robust to atomic rename-writes and WSL; fs.watch per directory if many tabs make polling costly.
const WATCH_INTERVAL_MS = 1000;
/** Idle close of unheld sessions (docs/spec.md "Idle close"): the one place of the timeout and the scan interval. */
export const IDLE_CLOSE_MS = 10 * 60_000;
/** Orphaned upload folders are looked for this often (uploads.ts sweep). */
const UPLOAD_SWEEP_MS = 6 * 3600_000;
const IDLE_CHECK_MS = 60_000;

/** A new connection gets a fresh plan usage read when the last one is older (reset times pass without a turn). */
const PLAN_STALE_MS = 5 * 60_000;
const PING_MS = 15_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Bytes read from a transcript's end to find its last message; more than a few large tool results. */
const TAIL_BYTES = 256 * 1024;
/**
 * What `git worktree list` of `cwd` reads, from file stats only (no process): the shared HEAD, the worktrees folder and each
 * worktree's HEAD and checkout path. A worktree added, removed or moved (from a terminal too), or a checkout changes it;
 * a commit on a branch does not (the list shows branch names). "-" without a readable `.git`.
 */
function worktreeStamp(cwd: string) {
  const dirs = gitDirsOf(cwd);
  if (!dirs) return "-";
  const stamp = (p: string) => {
    try {
      const st = statSync(p);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return "-";
    }
  };
  // The checkout's path (a `git worktree move` rewrites only it) and its `.git` file (gone when the folder was deleted).
  // A relative path (worktree.useRelativePaths) is relative to the gitdir file's folder.
  const checkout = (gitdirFile: string) => {
    try {
      const path = readFileSync(gitdirFile, "utf8").trim();
      if (foreignPointer(path, gitdirFile)) return "-";
      return `${path}@${stamp(resolve(dirname(gitdirFile), path))}`;
    } catch {
      return "-";
    }
  };
  const wts = join(dirs.common, "worktrees");
  let names: string[] = [];
  try {
    names = readdirSync(wts).sort();
  } catch {
    // No linked worktree yet.
  }
  return [dirs.common, stamp(join(dirs.common, "HEAD")), stamp(wts), ...names.flatMap((n) => [n, stamp(join(wts, n, "HEAD")), checkout(join(wts, n, "gitdir"))])].join("|");
}

/** Transcript path → last message time for the file version (mtime, size) it was read from. */
/** `listed`: the transcript scan's mtime and size when the file was read (lastMessageAt skips the open while they hold). */
const lastMessageCache = new Map<string, { version: string; listed?: string; at: number | undefined }>();

// ponytail: the SDK's project folder name for cwds up to 200 chars; longer ones get a hash suffix and are not found.
const transcriptFile = (projectsDir: string, cwd: string, sessionId: string) => join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);

/**
 * Permission mode of the last prompt and effort of the last reply in a session's raw transcript (getSessionMessages() drops
 * both fields): the restore fallback when sessions.json has no entry. Absent fields stay undefined. Reads the raw lines readTranscript
 * parsed (GH-274: no second read of the file).
 */
function transcriptSettings(entries: readonly unknown[]): { permissionMode?: unknown; effort?: unknown } {
  const found: { permissionMode?: unknown; effort?: unknown } = {};
  for (let i = entries.length - 1; i >= 0 && (found.permissionMode === undefined || found.effort === undefined); i--) {
    const e = entries[i] as { type?: string; isSidechain?: boolean; permissionMode?: unknown; effort?: unknown } | null;
    if (!e || typeof e !== "object" || e.isSidechain) continue;
    if (e.type === "user" && found.permissionMode === undefined && "permissionMode" in e) found.permissionMode = e.permissionMode;
    if (e.type === "assistant" && found.effort === undefined && "effort" in e) found.effort = e.effort;
  }
  return found;
}

/**
 * getSubagentMessages() keeps only the run transcript's last parentUuid chain (SDK 0.3.285). Parallel tool calls branch: each
 * parallel tool_use of one API message is its own assistant line chained off the previous one, each tool_result a child of its
 * tool_use line, so the calls and results off the leaf chain are lost. Puts back, from the raw `agent-<id>.jsonl`, each lost
 * assistant line of an API message the output has and each lost tool_result whose parent (the nearest ancestor, attachment
 * lines in between skipped) is kept or put back. Output in raw file order: a run does not rewind, so that is the API order.
 */
async function withParallelCalls(file: string | undefined, messages: SessionMessage[]): Promise<SessionMessage[]> {
  if (!file) return messages;
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    return messages;
  }
  type Line = { type: SessionMessage["type"]; uuid: string; parentUuid?: string; message?: { id?: unknown; content?: unknown }; timestamp?: string };
  const have = new Set(messages.map((m) => m.uuid));
  const apiIds = new Set<unknown>(messages.flatMap((m) => (m.type === "assistant" && (m.message as { id?: unknown })?.id) || []));
  const parentOf = new Map<string, string>();
  const lost = new Map<string, Line>();
  const index = new Map<string, number>();
  for (const raw of await parseJsonl(buf)) {
    const e = raw as Line;
    if (!e?.uuid) continue;
    index.set(e.uuid, index.size);
    if (e.parentUuid) parentOf.set(e.uuid, e.parentUuid);
    if (have.has(e.uuid)) continue;
    const content = e.message?.content;
    const result = e.type === "user" && Array.isArray(content) && content.some((b) => (b as { type?: unknown })?.type === "tool_result");
    if (result || (e.type === "assistant" && apiIds.has(e.message?.id))) lost.set(e.uuid, e);
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
  return out.sort((a, b) => (index.get(a.uuid) ?? 0) - (index.get(b.uuid) ?? 0));
}

/**
 * Time of the last user or assistant entry in a session's transcript, read from its end. Not the file mtime: on exit
 * the CLI appends metadata (`last-prompt`, `cost-state`), so every live session looks just used after a daemon restart.
 * Undefined when the file or such an entry is not found (e.g. the entry is further back than `TAIL_BYTES`).
 */
async function lastMessageAt(projectsDir: string, cwd: string, sessionId: string, scanned?: { lastModified: number; fileSize?: number }) {
  const file = transcriptFile(projectsDir, cwd, sessionId);
  const listed = scanned?.fileSize !== undefined ? `${scanned.lastModified}:${scanned.fileSize}` : undefined;
  const hit = listed && lastMessageCache.get(file);
  if (hit && hit.listed === listed) return hit.at;
  const read = await lastEntryTime(file, TAIL_BYTES);
  if (!read) return undefined;
  lastMessageCache.set(file, { version: read.version, listed, at: read.at });
  return read.at;
}

/**
 * `roots`: allowlisted directories for session cwds, the session list and the directory picker (docs/spec.md "Security").
 * `push`: Web Push sender; without it push.* requests fail. `allowBypass`: sessions may switch to bypassPermissions.
 * `uploadDir`: parent of the per-session upload folders (default: a fresh mkdtemp folder, tests); main.ts passes defaultUploadsDir().
 * `projectsDir`: the SDK's transcript folder (default: `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`).
 * `settingsFile`: JSON file keeping each session's model, permission mode and effort for a restore after a restart
 * (the SDK transcript has mode and effort only per prompt); none = not kept.
 * `projects`: known projects store; in memory when omitted.
 * `listCache`: reuse the last transcript scan while no transcript file under `projectsDir` changed (default: on with the
 * SDK's own listSessions()).
 * `hostnames`: hostnames besides loopback that browsers may reach the daemon by, e.g. a `tailscale serve` name (ADR 0003).
 * `cli`: runs the Claude Code CLI for config writes (default: the SDK-bundled binary). `configHoldMs`: config query hold.
 * `configPollMs`: pause between the reads that confirm a skill state change.
 * `modelListWaitMs`: how long session.list waits for the model list (default MODEL_LIST_WAIT_MS).
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
  /** Orphan sweep of the upload parent: first run after 60 s, then every `uploadSweepMs` (default 6 h); 0 = off (tests). */
  uploadSweepMs?: number;
  /** Delay of the first sweep (default 60 s); tests shorten it. */
  uploadSweepFirstMs?: number;
  projectsDir?: string;
  settingsFile?: string;
  /** The Claude user config folder (`settings.json` holds `permissions.defaultMode`); default: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeDir?: string;
  projects?: Projects;
  /** App-wide settings (settings.json); in memory when omitted. Readers call `get()` each time. */
  appSettings?: AppSettings;
  /** Test seam (GH-164): delays of auto-continue.ts. */
  autoContinue?: { graceMs?: number; gapMs?: number; retryMs?: number };
  listCache?: boolean;
  /** Interval of the WebSocket ping that drops a half-open socket (default 15 s; tests use a few hundred ms). */
  pingMs?: number;
  /** The Claude login is CLAUDE_CODE_OAUTH_TOKEN (plan-usage.ts fallback); default: whether the env var is set. Never its value. */
  oauthToken?: boolean;
  hostnames?: string[];
  /** Name shown for this computer in Settings (default: the OS host name); `desktopForcedOff`: started with --no-os-notify. */
  host?: string;
  desktopForcedOff?: boolean;
  /** List once when the server starts listening (model list, transcript scan, last-message times), so the first browser connect does not pay for them (GH-276). */
  warmUp?: boolean;
  cli?: CliRunner;
  configHoldMs?: number;
  configPollMs?: number;
  modelListWaitMs?: number;
  /** Idle close of unheld sessions (docs/spec.md "Idle close"); 0: off. Default IDLE_CLOSE_MS. */
  idleCloseMs?: number;
  /** Longest wait for one media piece from a side before its GET is cut (default 30 s; tests shorten it). */
  sideCallTimeoutMs?: number;
  /** WSL distros and Docker containers this daemon routes to (sides.ts). */
  sides?: Sides;
  /** Whether this daemon runs older code than is on disk (build-info.ts): worker_start and worker_list report it, a new connection shows it. */
  buildInfo?: { version?: string; stale(): string | undefined };
  /** Test seam (GH-272): the performance monitor (default: a real one, on unless the `performance.monitor` setting is off). */
  perf?: PerfMonitor;
  /** How long worker_stop and worker_close wait for a stopped worker to leave running/needs_input (orchestration.ts); tests shorten it. */
  stopWaitMs?: number;
  /** Update checks and installs (update.ts); none: no update_available, update.* fail. Checks start with the daemon. */
  update?: Omit<Parameters<typeof createUpdater>[0], "busy" | "broadcast">;
}) {
  const hostnames = new Set([...LOCAL_HOSTNAMES, ...(opts.hostnames ?? [])]);
  const logEpoch = randomUUID();
  /** fs.upload storage: one private folder per session; a session gets only its own as an additional directory, so Claude reads an attachment without asking (uploads.ts). */
  const uploads = createUploads({ dir: opts.uploadDir });
  const sessions = new Map<string, Session>();
  const settings = createSessionSettings({ file: opts.settingsFile });
  /** A failed save keeps the change in memory for the run (session-settings.ts). */
  const saveSettings = (change: () => void) => {
    try {
      change();
    } catch (err) {
      console.error("saving session settings failed:", err);
    }
  };
  // Account-wide, so not a session event: every connection gets each change.
  const plan = createPlanTracker({ onChange: (usage) => broadcast({ type: "plan_usage", usage }), read: () => queuedQuery(plan.refresh, opts.query), oauthToken: opts.oauthToken ?? usesOauthToken() });
  /** Options of every session: settings changes are saved under its ID. */
  const sessionOpts = (initial: Partial<SessionSettings>) => ({
    ...initial,
    plan,
    // The plan fallback only while the plan says rejected: another 429 (per-model, credits) during a warning is no usage limit.
    onLimitStop: (id: string, resetsAt: number | undefined) => autoContinue.schedule(id, resetsAt ?? (plan.current()?.status === "rejected" ? plan.current()?.statusResetsAt : undefined)),
    allowBypass: opts.allowBypass,
    supportsAuto,
    uploadDir: (id: string) => {
      try {
        return uploads.dirFor(id);
      } catch (e) {
        console.error(`session ${id}: upload folder failed:`, e);
        return undefined;
      }
    },
    query: opts.query,
    readTranscript,
    // The stale-turn check reads only the transcript's tail, not the chain and its subagent runs (GH-239).
    transcriptEnd: (id: string, cwd: string) => transcriptEnd(transcriptFile(projectsDir, transcriptCwd(id, cwd), id)),
    cliTurnRunning: (id: string) => cliTurnRunning(claudeDir, id),
    // Only the fields this change set: a daemon on another port may have changed the others of the same session (GH-91).
    onSettings: (s: SessionSettings, id: string, fields: (keyof SessionSettings)[]) => saveSettings(() => settings.set(id, s, fields)),
    // /clear: the new session is listed; tabs that show the old one follow its session_cleared part.
    onCleared: (heir: Session) => {
      track(heir);
      broadcast({ type: "sessions.changed" });
    },
    worker: (id: string) => !!settings.get(id)?.coordinatorId,
    mcpServers: (id: string) => orchestration.mcpServers(id),
    toolPolicy: (tool: string, mcpServer?: { name: string; source: string }) => orchestration.toolPolicy(tool, mcpServer),
    permissionCard: (id: string, tool: string, input: Record<string, unknown>, mcp?: { name: string; source: string }) => orchestration.permissionCard(id, tool, input, mcp),
  });
  const restoring = new Map<string, Promise<Session | undefined>>();
  // Sessions whose delete is in progress (session.delete).
  const deleting = new Set<string>();
  const history = { listSessions: listSessionsOffThread, getSessionInfo, getSessionMessages, listSubagents, getSubagentMessages, renameSession, tagSession, deleteSession, ...opts.history };
  const claudeDir = opts.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  const projectsDir = opts.projectsDir ?? join(claudeDir, "projects");
  const projects = opts.projects ?? createProjects();
  const appSettings = opts.appSettings ?? createSettings();
  // The monitor follows the `performance.monitor` setting: on start, on settings.set, and on its 10 s tick (another daemon's change to off).
  const perfMon = opts.perf ?? createPerf({ version: opts.buildInfo?.version, poll: () => appSettings.get().performance.monitor });
  setPerf(perfMon);
  perfMon.setEnabled(appSettings.get().performance.monitor);
  const autoContinue = createAutoContinue({
    ...opts.autoContinue,
    enabled: () => appSettings.get().usageLimit.autoContinue,
    show: (id, at) => sessions.get(id)?.setContinueAt(at),
    send: async (id, wanted) => {
      const s = sessions.get(id);
      if (!s || s.info().state !== "idle") return false;
      const err = await sendPrompt(s, CONTINUE_PROMPT, [], wanted);
      if (!err) console.log(`session ${id}: sent continue after the usage limit reset`);
      return !err;
    },
  });
  const connections = new Set<Conn>();
  const terminals = createTerminals();
  const broadcast = (m: ServerMessage) => connections.forEach((ws) => send(ws, m));
  // ponytail: side sessions are not counted; a restart ends their running turns too.
  const updater: Updater | undefined =
    opts.update && createUpdater({ ...opts.update, busy: () => ({ sessions: [...sessions.values()].filter((s) => s.working()).length, terminals: terminals.count() }), broadcast });
  updater?.start();
  const config = createConfig({ query: opts.query, cli: opts.cli, holdMs: opts.configHoldMs, pollMs: opts.configPollMs, onChanged: (kind, cwd) => (commandCache.clear(), broadcast({ type: "config.changed", kind, cwd })) });
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
      commandCache.clear();
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
  /** UNC roots (configured and canonical form): the only UNC paths that may reach the file system (GH-282: an SMB lookup sends the NTLM hash). */
  const uncRoots = [...opts.roots, ...roots].filter((r) => winPathKind(r) === "unc");
  const refused = (p: string) => refusedPath(p, uncRoots);
  const inRoots = (path: string) =>
    roots.some((r) => {
      const rel = relative(r, path);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  /** A repository (top, git dirs: GH-290) that is not entirely inside the roots: no git request may read it. */
  const gitOutside = (cwd: string) => gitEscapes(cwd, (p) => inRoots(real(p) ?? p));
  /** The canonical path when it is an existing path inside a root. */
  const allowed = (path: unknown) => {
    const p = typeof path === "string" && isAbsolute(path) && !refused(path) ? real(path) : undefined;
    return p && inRoots(p) ? p : undefined;
  };

  /**
   * A transcript's cwd as sessions and projects use it. The Windows CLI writes it as its caller typed it (VS Code: c:\users\me);
   * the canonical path keeps that session in its project. Elsewhere as written: the transcript folder name derives from it.
   */
  const sessionCwd = (cwd: string) => (process.platform === "win32" && allowed(cwd)) || cwd;
  /** The cwd a restored session's transcript was written under (as the CLI typed it): a junction or subst drive differs from sessionCwd in more than case. */
  const transcriptCwds = new Map<string, string>();
  const transcriptCwd = (id: string, cwd: string) => transcriptCwds.get(id) ?? cwd;

  /** A missing absolute path whose nearest existing ancestor is allowed: deleted inside the roots (outside them, existence stays hidden). */
  const missingInRoots = (path: unknown) => {
    if (typeof path !== "string" || !isAbsolute(path) || refused(path) || existsSync(path)) return false;
    let dir = dirname(resolve(path));
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    return !!allowed(dir);
  };

  /** Worktree paths inside the roots of the added projects, as of the last session.list: their sessions show under the project. */
  let worktreePaths = new Set<string>();
  /**
   * A linked worktree whose main checkout is an added project: it shows under that project, also when made (from a terminal)
   * after the last session.list.
   */
  const ofAddedRepository = (cwd: string) => {
    const dirs = gitDirsOf(cwd);
    if (!dirs || dirs.own === dirs.common || basename(dirs.common) !== ".git") return false;
    const main = allowed(dirname(dirs.common));
    return !!main && projects.has(main);
  };
  /**
   * Adds the project of a session the user opened or created (not a worktree of an added project: it shows under that one);
   * other clients refresh their list. A failed write is only logged: the session works.
   */
  function addProject(cwd: string) {
    if (projects.has(cwd) || worktreePaths.has(cwd) || ofAddedRepository(cwd)) return;
    try {
      projects.open(cwd);
      broadcast({ type: "sessions.changed" });
    } catch (err) {
      console.error("saving projects failed:", err);
    }
  }

  /**
   * `git worktree list` of each project, reused by session.list while its worktreeStamp holds: a list runs on every turn start
   * and end, and starting a process blocks the event loop (on Windows tens of ms each), so one per project per list stalled
   * every reply with a few dozen projects. The stamp is file stats only, so every list is current (terminal changes too).
   */
  const worktreeLists = new Map<string, { stamp: string; list: Promise<Worktree[] | null> }>();
  const worktreesOf = (cwd: string) => {
    // Taken before the read: a change during it gives the next list another stamp, which reads again.
    const stamp = worktreeStamp(cwd);
    const hit = worktreeLists.get(cwd);
    if (hit?.stamp === stamp) return hit.list;
    const sp = perfMon.span("worktree.list");
    const entry = { stamp, list: gitOutside(cwd).then((out) => (out ? null : listWorktrees(cwd))).finally(() => sp.end()) };
    worktreeLists.set(cwd, entry);
    // A failed read of a git folder (spawn error, killed process) is not kept: the next list reads again.
    void entry.list.then((l) => l === null && stamp !== "-" && worktreeLists.get(cwd) === entry && worktreeLists.delete(cwd));
    return entry.list;
  };

  /**
   * git.status of a folder, shared by the requests that arrive while it runs: the web app asks up to three times for the same
   * folder when a session opens (status bar, header, changes), and every git process start blocks the event loop on Windows.
   */
  const statusReads = new Map<string, ReturnType<typeof gitStatus>>();
  const statusOf = (cwd: string) => {
    let read = statusReads.get(cwd);
    if (!read) statusReads.set(cwd, (read = gitOutside(cwd).then((out) => (out ? null : gitStatus(cwd))).finally(() => statusReads.delete(cwd))));
    return read;
  };

  /** New worktree of `cwd`'s repository (roots enforced); other clients refresh their list. */
  const createIn = async (cwd: string, o: Pick<CreateWorktreeOptions, "name" | "branch" | "base" | "onCreated"> = {}) => {
    // The new path is no project: a session created in it (worker_start) must not add it.
    const r = await createWorktree(cwd, { ...o, allowed: (p) => inRoots(real(p) ?? p), claudeDir, onCreated: (r) => { worktreePaths.add(r.path); o.onCreated?.(r); } });
    broadcast({ type: "sessions.changed" });
    return r;
  };
  /** Worktrees being removed: no session or terminal may start in them meanwhile (`worktree_removing`). */
  const removing = new Set<string>();
  const isRemoving = (cwd: string) => [...removing].some((p) => cwd === p || cwd.startsWith(p.endsWith(sep) ? p : p + sep));
  /** Refused while a session in it runs or needs input; idle live sessions and its terminals close first (transcripts stay). */
  const removeIn = async (cwd: string, path: string) => {
    // Blocked from the start so no session slips in during git's checks; only paths that can be managed (the main checkout never is).
    if (path.includes(`${sep}.claude${sep}worktrees${sep}`)) removing.add(path);
    try {
      // After the mark: this check awaits, and a session or terminal must not start in the worktree meanwhile.
      if (await gitOutside(cwd)) throw new WorktreeError("cwd_not_allowed", "The repository is outside the allowed roots");
      await removeWorktree(cwd, path, (p) => inRoots(real(p) ?? p), async () => {
        const live = [...sessions.values()].filter((s) => isRemoving(s.cwd));
        if (live.some((s) => ["running", "needs_input"].includes(s.info().state))) throw new WorktreeError("has_sessions_running", "A session in this worktree is running or needs input: stop it first");
        for (const s of live) {
          sessions.delete(s.id);
          touched.delete(s.id);
          await s.close().catch(() => {});
        }
        // Its terminals too: a shell running in the folder keeps Windows from deleting it ("Permission denied").
        await terminals.closeIn(isRemoving);
      });
      broadcast({ type: "sessions.changed" });
    } finally {
      removing.delete(path);
    }
  };

  const daemonInfo = () => ({ host: opts.host ?? osHostname(), ...(opts.buildInfo?.version && { version: opts.buildInfo.version }), ...(opts.desktopForcedOff && { desktopForcedOff: true as const }) });
  /** Session a connection shows while its tab is focused and visible. */
  const focused = new Map<Conn, string>();
  /** Sessions a connection's page shows in-app notification cards for (GH-158): its one channel, so no push or desktop notification goes out for them. */
  const covered = new Map<Conn, Set<string>>();
  const pushTitleOf = async (sessionId: string) => {
    const info = await history.getSessionInfo(sessionId).catch(() => undefined);
    return info?.summary || basename(sessions.get(sessionId)?.cwd ?? "") || "Claude";
  };
  const notifier = createNotifier({
    suppressed: (id) => [...focused.values()].includes(id) || [...covered.values()].some((s) => s.has(id)),
    // A group's push (workers blocked on the same request) carries its tag and the coordinator's title.
    push: async (sessionId, body, { titleSession, ...extra } = {}) => void (await opts.push?.send({ sessionId, title: await pushTitleOf(titleSession ?? sessionId), body, ...extra })),
    // A request that settled: the same tag, silent (Web Push must show every push; one that only closes would show "updated in the background").
    replace: async (sessionId, body, tag) => void (await opts.push?.send({ sessionId, title: await pushTitleOf(sessionId), body, ...(tag && { tag }), silent: true, replace: true })),
    group: (id) => settings.get(id)?.coordinatorId,
  });
  /**
   * Per session: its transcript entries read so far (JsonlTail), the main chain built from them for a file stamp, and each
   * subagent run's messages for its file stamp. Kept only while a live mirror watches the session: a one-shot read (restore,
   * cleared title, a prompt without subscriber) parses into a cache it drops. Dropped when the mirror stops or on delete.
   */
  type Cache = { tail: JsonlTail; stamp?: string; main?: SessionMessage[]; runs: Map<string, { stamp: string; messages: SessionMessage[] }> };
  const caches = new Map<string, Cache>();
  const fileStamp = async (file: string | undefined) => (file ? stat(file).then(stampOf, () => undefined) : undefined);
  /**
   * Main chain and subagent runs of a session's transcript. An unreadable run transcript leaves that run out, not the session.
   * Stat-gated: the main chain is rebuilt only after its file changed, from the lines appended since the last read; a run is
   * read again only after its file changed. A transcript not at the expected path (long cwd) is read whole by the SDK.
   */
  async function readTranscript(id: string, listedCwd: string): Promise<Transcript> {
    const cwd = transcriptCwd(id, listedCwd);
    const cache: Cache = caches.get(id) ?? { tail: new JsonlTail(), runs: new Map() };
    if (mirrors.has(id)) caches.set(id, cache);
    const file = transcriptFile(projectsDir, cwd, id);
    // Taken before the read: a write during it changes the stamp, so the next read takes it.
    const stamp = await fileStamp(file);
    let main: SessionMessage[];
    if (stamp === undefined) main = await history.getSessionMessages(id, { dir: cwd });
    else if (stamp === cache.stamp && cache.main) main = cache.main;
    else {
      await cache.tail.read(file);
      main = await history.getSessionMessages(id, { dir: cwd, sessionStore: cache.tail.store() });
      Object.assign(cache, { stamp, main });
    }
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
      agents.map(async (a) => {
        const f = runFile(a);
        const runStamp = await fileStamp(f);
        const cached = cache.runs.get(a);
        if (runStamp !== undefined && cached?.stamp === runStamp) return cached.messages;
        return history
          .getSubagentMessages(id, a, { dir: cwd })
          .then((m) => withParallelCalls(f, m))
          .then((messages) => (runStamp !== undefined && cache.runs.set(a, { stamp: runStamp, messages }), messages))
          .catch((err) => (console.error(`reading subagent run ${a} of ${id} failed:`, err), []));
      }),
    );
    return { main, runs, entries: stamp === undefined ? undefined : cache.tail.entries };
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
      const file = transcriptFile(projectsDir, transcriptCwd(s.id, s.cwd), s.id);
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
      caches.delete(s.id);
    };
  }

  // session.commands: the list per cwd, one throwaway CLI per cwd and minute (a plugin change shows within it).
  const commandCache = new Map<string, { at: number; list: Promise<SlashCommand[]> }>();
  const commandsOf = (cwd: string) => {
    const hit = commandCache.get(cwd);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
    const list = queuedQuery((q) => q.supportedCommands(), opts.query, { cwd, persistSession: false }).then(
      (l) => (createAdapter().commands(l)[0] as { commands: SlashCommand[] }).commands,
    );
    commandCache.set(cwd, { at: Date.now(), list });
    list.catch(() => commandCache.delete(cwd));
    return list;
  };

  /** Adds a session and follows its live events (not its history) for pushes and for its coordinator. */
  /** Holding subscriptions (a tab shows the session) per session, all connections. */
  const holds = new Map<string, number>();
  /** Last event or last hold release per session: the idle close counts from it. */
  const touched = new Map<string, number>();
  const unhold = (id: string) => {
    const n = (holds.get(id) ?? 1) - 1;
    if (n > 0) holds.set(id, n);
    else holds.delete(id);
    touched.set(id, Date.now());
  };

  function track(s: Session) {
    sessions.set(s.id, s);
    s.subscribe(Infinity, notifier.observe);
    s.subscribe(Infinity, (e) => orchestration.observe(s, e));
    s.subscribe(Infinity, () => touched.set(s.id, Date.now()));
    return s;
  }

  /** session.prompt's checks and send; the reason when the prompt is not taken. `images`: checked with imageBlock(). */
  async function sendPrompt(s: Session, text: string, images: string[] = [], stillWanted?: () => boolean): Promise<{ code: string; message: string } | undefined> {
    const notLive = () => ({ code: "session_not_live", message: `session ${s.id} is ${s.info().state}` });
    if (!s.isLive()) return notLive();
    // Sync before prompt: the prompt continues after the terminal CLI's turns (a running turn is steered as is).
    if (s.info().state === "idle") await s.sync();
    if (!s.isLive()) return notLive();
    // A message the user sent while the sync ran cancelled an automatic continue: send nothing (GH-164).
    if (stillWanted && !stillWanted()) return { code: "cancelled", message: "cancelled" };
    // The web app holds the prompt while it shows the external turn; this covers a client that has not seen it yet.
    if (s.externalTurnRunning()) return { code: "external_turn", message: "A terminal CLI turn is running in this session" };
    if (s.bashRunning()) return { code: "bash_running", message: "A shell command is running in this session; stop it first" };
    try {
      s.prompt(text, images);
    } catch (err) {
      return { code: "prompt_failed", message: (err as Error).message };
    }
  }

  const orchestration = createOrchestration({
    links: settings,
    settings: () => appSettings.get().orchestration,
    sessions,
    find: findSession,
    create: (cwd, initial) => {
      if (isRemoving(cwd)) throw new Error("This worktree is being removed");
      const s = track(new Session(cwd, sessionOpts(initial)));
      addProject(cwd);
      // worker_start writes the link right after this call (no await): the refresh lists the worker with it.
      queueMicrotask(() => broadcast({ type: "sessions.changed" }));
      return s;
    },
    prompt: async (s, text) => (autoContinue.cancel(s.id), (await sendPrompt(s, text))?.message),
    allowed: (path) => allowed(path),
    sideOf: (path) => {
      const id = opts.sides?.pathSide(path);
      return id && id !== LOCAL_SIDE ? opts.sides!.list().find((s) => s.id === id)?.label : undefined;
    },
    isProject: (path) => projects.has(path),
    createWorktree: (repo, o) => createIn(repo, o),
    port: () => (http.address() as AddressInfo | null)?.port,
    heldElsewhere: (id) => cliTurnRunning(claudeDir, id, true),
    models: () => known,
    remove: async (id) => {
      const err = await deleteSessionById(id);
      if (err?.code !== "unknown_session") return err;
      // Nothing to delete (transcript gone, not loaded): the worker's link still lists it and holds its name.
      if (settings.get(id)) saveSettings(() => settings.delete([id]));
      broadcast({ type: "sessions.changed", deleted: id });
      return undefined;
    },
    stopWaitMs: opts.stopWaitMs,
    buildNote: () => opts.buildInfo?.stale(),
  });

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
      return (scan = (async () => {
        const stamp = listCache ? await transcriptStamp(projectsDir) : undefined;
        if (stamp !== undefined && lastScan?.stamp === stamp) return lastScan.result;
        const result = await history.listSessions();
        lastScan = stamp === undefined ? undefined : { stamp, result };
        return result;
      })().finally(() => (scan = undefined)));
    }
    return (nextScan ??= scan.catch(() => {}).then(() => ((nextScan = undefined), transcripts())));
  }

  /** First prompt of a session cleared into, by ID; found once, it stays. */
  const clearedTitles = new Map<string, string>();
  /**
   * The SDK titles a session cleared into (/clear) "/clear" until it finds a prompt in the transcript's head read window, which
   * a background task's notification turn can fill: its first prompt from the transcript, none yet "New session".
   */
  /** Cleared sessions read without a prompt, by ID: the scan's mtime and size then; not read again while they hold. */
  const untitledAt = new Map<string, string>();
  async function clearedTitle(id: string, cwd: string, scanned?: { lastModified: number; fileSize?: number }) {
    if (clearedTitles.has(id)) return clearedTitles.get(id)!;
    // A /clear that was never prompted stays "New session": without this, every list read each such transcript again.
    const stamp = scanned?.fileSize !== undefined ? `${scanned.lastModified}:${scanned.fileSize}` : undefined;
    if (stamp && untitledAt.get(id) === stamp) return "New session";
    const main = await readTranscript(id, cwd).then((t) => t.main, () => []);
    const adapter = createAdapter();
    const prompt = main.flatMap((m) => adapter.convert(m as SDKMessage)).find((p) => p.type === "user_text");
    if (!prompt) {
      if (stamp) untitledAt.set(id, stamp);
      return "New session";
    }
    untitledAt.delete(id);
    clearedTitles.set(id, prompt.text);
    return prompt.text;
  }

  /** A session's title as list() gives it: the SDK summary, a cleared session's first prompt, "New session" without transcript. */
  async function titleOf(s: Session) {
    if (s.untitled()) return "New session";
    const info = await history.getSessionInfo(s.id).catch(() => undefined);
    if (!info) return "New session";
    return CLEARED.test(info.summary) ? clearedTitle(s.id, info.cwd ?? s.cwd) : info.summary;
  }

  /**
   * session.list: every tab asks on each sessions.changed, turn start and end and focus, often at once. Requests that arrive
   * while a list runs share one list that starts after it (so it still sees what changed before them), not one list each.
   */
  let listing: Promise<ListResult> | undefined;
  let nextListing: Promise<ListResult> | undefined;
  function list(): Promise<ListResult> {
    if (!listing) return (listing = listNow().finally(() => (listing = undefined)));
    return (nextListing ??= listing.catch(() => {}).then(() => ((nextListing = undefined), list())));
  }

  /** session.ids: what findSession could restore, without reading any transcript (the cached scan, one realpath per cwd). */
  async function sessionIds(): Promise<string[]> {
    const ok = new Map<string, boolean>();
    const inRootsCwd = (cwd: string) => (ok.has(cwd) ? ok.get(cwd)! : (ok.set(cwd, !!allowed(cwd)), ok.get(cwd)!));
    const ids = new Set((await transcripts()).filter((t) => t.cwd && inRootsCwd(t.cwd)).map((t) => t.sessionId));
    for (const id of sessions.keys()) ids.add(id);
    for (const id of deleting) ids.delete(id);
    return [...ids];
  }

  async function listNow(): Promise<ListResult> {
    // The model list starts a CLI: not waiting longer than this offers no auto mode until it is there.
    await new Promise<void>((done) => {
      const t = setTimeout(done, opts.modelListWaitMs ?? MODEL_LIST_WAIT_MS);
      modelList().catch(() => {}).then(() => (clearTimeout(t), done()));
    });
    const items = new Map<string, SessionListItem>();
    const all = await transcripts();
    // One read of sessions.json per list: settings.get() reads the file again on every call (json-file.ts), once per transcript here.
    const linked = new Map(settings.entries());
    // A coordinator is a session with a worker.
    const coordinators = new Set([...linked.values()].flatMap((l) => (l.coordinatorId && l.name ? [l.coordinatorId] : [])));
    const links = (id: string) => {
      const l = linked.get(id);
      return { ...(coordinators.has(id) && { coordinator: true as const }), ...(l?.coordinatorId && l.name && { coordinatorId: l.coordinatorId, workerName: l.name }) };
    };
    // Entries of sessions deleted outside this daemon (CLI, file removed): no transcript and not live (session-settings.ts prune).
    const known = new Set(all.map((t) => t.sessionId));
    saveSettings(() => settings.prune((id) => known.has(id) || sessions.has(id)));
    // One realpath per distinct cwd per list, not two per transcript: each is a blocking call (slow on Windows), and hundreds of
    // transcripts share a few dozen cwds.
    const canonical = new Map<string, string | undefined>();
    const allowedCwd = (cwd: string) => (canonical.has(cwd) ? canonical.get(cwd) : (canonical.set(cwd, allowed(cwd)), canonical.get(cwd)));
    const lastAt = new Map(await mapLimit(all, 8, async (t) => [t.sessionId, t.cwd && allowedCwd(t.cwd) ? await lastMessageAt(projectsDir, t.cwd, t.sessionId, t) : undefined] as const));
    for (const t of all) {
      if (!t.cwd || !allowedCwd(t.cwd)) continue;
      const live = sessions.get(t.sessionId)?.info() ?? { state: "closed" as const, model: "default", permissionMode: "default" as const, effort: "default" as const, permissionModes: [] };
      const title = CLEARED.test(t.summary) ? (sessions.get(t.sessionId)?.untitled() ? "New session" : await clearedTitle(t.sessionId, t.cwd, t)) : t.summary;
      items.set(t.sessionId, { ...live, id: t.sessionId, cwd: (process.platform === "win32" && allowedCwd(t.cwd)) || t.cwd, title, lastActivity: lastAt.get(t.sessionId) ?? t.lastModified, archived: t.tag === ARCHIVED_TAG, transcript: true, ...links(t.sessionId) });
    }
    // Sessions of this run that have no transcript yet (no prompt sent).
    for (const s of sessions.values())
      if (!items.has(s.id)) items.set(s.id, { ...s.info(), title: "New session", lastActivity: s.createdAt, archived: false, transcript: false, ...links(s.id) });
    const listed = [...items.values()];
    // Upgrade from "every transcript cwd is a project": the projects with saved claude-ui state stay, once.
    if (!projects.seeded)
      try {
        const saved = new Set(settings.ids());
        projects.seed(listed.filter((s) => saved.has(s.id)));
      } catch (err) {
        // In memory it holds; the next start seeds again.
        console.error("saving projects failed:", err);
      }
    // An added project whose directory is gone or left the roots is not listed (its New session would fail).
    const open = projects.list(listed).filter((cwd) => allowed(cwd));
    const worktrees: Record<string, Worktree[]> = {};
    await Promise.all(
      open.map(async (cwd) => {
        const found = (await worktreesOf(cwd))?.map((w) => ({ ...w, path: real(w.path) ?? w.path }));
        // A subfolder of a repository (mono/pa, a folder of a dotfiles home) is no worktree: listed as a non-git project.
        if (found?.some((w) => w.path === (real(cwd) ?? cwd))) worktrees[cwd] = found.map((w) => (inRoots(w.path) ? w : { ...w, outsideRoots: true }));
      }),
    );
    worktreePaths = new Set(Object.values(worktrees).flatMap((l) => l.filter((w) => !w.outsideRoots).map((w) => w.path)));
    // Sessions of a project's worktrees show under the project (outside the roots there are none: `listed` has only allowed cwds).
    const shown = new Set([...open, ...worktreePaths]);
    const topIds = new Set(listed.filter((s) => shown.has(trim(s.cwd))).map((s) => s.id));
    return {
      projects: open,
      recentProjects: projects.recent(listed).filter((r) => !shown.has(r.cwd)),
      worktrees,
      // A worker of a listed coordinator shows under it, also when the user removed the worker's project.
      sessions: listed.filter((s) => topIds.has(s.id) || (s.coordinatorId && topIds.has(s.coordinatorId))).sort((a, b) => b.lastActivity - a.lastActivity),
      permissionModes: permissionModesFor({ allowBypass: opts.allowBypass, supportsAuto: supportsAuto("default") }),
    };
  }

  /** `permissions.defaultMode` of the Claude settings for `cwd`, when this daemon offers it for `model` (bypass needs the daemon flag, auto a model with support). */
  const defaultModeFor = (cwd: string, model = "default") => {
    const mode = readDefaultMode(claudeDir, cwd);
    return permissionModesFor({ allowBypass: opts.allowBypass, supportsAuto: supportsAuto(model) }).find((m) => m === mode);
  };

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
        transcriptCwds.set(id, info.cwd);
        // Before the read: a write during it changes the stamp, so the first subscriber syncs it.
        stamps.set(id, statStamp(transcriptFile(projectsDir, info.cwd, id)));
        const { main: messages, runs, entries } = await readTranscript(id, info.cwd);
        await modelList().catch(() => {});
        // Its worktree is being removed: no live session in a directory about to go.
        if (isRemoving(info.cwd)) return undefined;
        // The model row whose resolved ID the transcript last used ("default" first); the ID itself when none matches.
        const used = transcriptModel(messages);
        // No entry (sessions.json lost, a session of the terminal CLI): mode and effort the transcript last recorded.
        const saved = settings.get(id) ?? { model: undefined, ...transcriptSettings(entries ?? []) };
        const model = isModel(saved?.model) ? saved.model : used && ((await modelList().catch(() => [])).find((m) => m.resolvedModel === used)?.value ?? used);
        // A mode the daemon does not enable now (bypass without CLAUDE_UI_ALLOW_BYPASS) falls back to the default.
        const modes = permissionModesFor({ allowBypass: opts.allowBypass, supportsAuto: supportsAuto(model ?? "default") });
        const permissionMode = modes.includes(saved.permissionMode as never) ? (saved.permissionMode as SessionSettings["permissionMode"]) : undefined;
        const effort = EFFORTS.includes(saved.effort as never) ? (saved.effort as SessionSettings["effort"]) : undefined;
        // Each run's messages name the Agent call that started it (parent_tool_use_id): they go right after that call's result, inside its turn.
        // A run whose call was compacted away renders nowhere: only its edits are kept (for the changes tab). Every message read stays known,
        // so the first sync does not log the pruned ones after all.
        const read = [...messages, ...runs.flat()].map((m) => m.uuid);
        return track(Session.restore(id, sessionCwd(info.cwd), interleaveRuns(messages, runs, { pruneOrphans: true }), sessionOpts({ model, permissionMode, effort }), read));
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

  /** A live session whose CLI reads the folder of `id` (itself or, after /clear, its parent's folder). */
  const folderInUse = (id: string) => [...sessions.values()].some((s) => s.uploadOwner === id);

  /** session.delete, also the web app's Remove and worker_remove: the error to report, or undefined once the session is gone. */
  async function deleteSessionById(id: string): Promise<{ code: string; message: string } | undefined> {
    // A restore already in flight would put the session back after the delete; let it finish, then close it below.
    await restoring.get(id);
    const at = await locate(id);
    if (!at) return { code: "unknown_session", message: `no session ${id}` };
    const state = at.live?.info().state;
    if (state === "running" || state === "needs_input") return { code: "session_running", message: "stop the session before deleting it" };
    // The CLI exits first: it writes session metadata on exit, which would recreate the transcript. A failed delete keeps the transcript.
    autoContinue.cancel(id);
    deleting.add(id);
    sessions.delete(id);
    touched.delete(id);
    try {
      await at.live?.close();
      if (at.transcript) await history.deleteSession(id, { dir: at.cwd });
    } catch (e) {
      return { code: "delete_failed", message: (e as Error).message };
    } finally {
      deleting.delete(id);
    }
    caches.delete(id);
    // The folder of a session whose CLI a /clear heir still uses stays with the heir.
    if (!folderInUse(id)) await uploads.remove(id).catch((e) => console.error(`session ${id}: removing its uploads failed:`, e));
    if (settings.get(id)) saveSettings(() => settings.delete([id]));
    broadcast({ type: "sessions.changed", deleted: id });
    return undefined;
  }

  const digest = (t: string) => createHash("sha256").update(t).digest();
  const expected = digest(opts.token);
  const isToken = (t: string | undefined) => t !== undefined && timingSafeEqual(digest(t), expected);
  const hasToken = (req: IncomingMessage) =>
    (req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .some((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX) && isToken(p.slice(TOKEN_PROTOCOL_PREFIX.length)));

  /** Piece of a media file: undefined when it can no longer be read (gone, outside the roots, side stopped). */
  type MediaRead = (offset: number, length: number) => Promise<MediaReadResult | undefined>;
  /** fs.media capabilities: nonce -> a hub file (canonical path, streamed from disk) or bytes read in pieces (a file at a commit, a side's file), issuing connection, last use. */
  const media = new Map<string, { src: { kind: "file"; path: string } | { kind: "bytes"; read: MediaRead; mime: string; name: string }; ws: Conn; used: number; live?: Set<ServerResponse> }>();
  const mediaHead = (type: string, name: string, size: number, start: number, end: number, ranged: boolean) => ({
    ...MEDIA_HEADERS,
    "content-type": type,
    "content-length": size === 0 ? 0 : end - start + 1,
    ...(ranged && { "content-range": `bytes ${start}-${end}/${size}` }),
    "content-disposition": `${type === "image/svg+xml" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
  });
  /** A bytes entry: size from a first empty read, then the range in MEDIA_CHUNK pieces, one at a time, waiting for drain. A piece that fails, is short, or sees another size or mtime (the file changed) cuts the response. */
  const serveBytes = async (req: IncomingMessage, res: ServerResponse, src: { read: MediaRead; mime: string; name: string }) => {
    const head = await src.read(0, 0);
    if (!head) return void res.writeHead(404).end();
    const { size, mtime } = head;
    const r = parseRange(req.headers.range, size);
    if (r === "unsatisfiable") return void res.writeHead(416, { ...MEDIA_HEADERS, "content-range": `bytes */${size}` }).end();
    const start = r?.start ?? 0;
    const end = r?.end ?? size - 1;
    res.writeHead(r ? 206 : 200, mediaHead(src.mime, src.name, size, start, end, !!r));
    if (req.method === "HEAD" || size === 0) return void res.end();
    let closed = false;
    res.on("close", () => (closed = true));
    for (let at = start; at <= end; ) {
      const want = Math.min(MEDIA_CHUNK, end + 1 - at);
      const p = await src.read(at, want);
      if (closed) return;
      const data = p && p.size === size && p.mtime === mtime ? Buffer.from(p.data, "base64") : undefined;
      if (!data || data.length !== want) return void res.destroy();
      at += want;
      if (!res.write(data)) await new Promise<void>((ok) => (res.once("drain", ok), res.once("close", ok)));
    }
    res.end();
  };
  const mediaEntry = (nonce: string) => {
    const e = media.get(nonce);
    if (e && Date.now() - e.used < MEDIA_TTL_MS) return e; // closing the connection deletes its nonces
    media.delete(nonce);
    return undefined;
  };
  /** GET /media/<nonce>/<name>: the file comes only from the nonce entry; <name> is cosmetic. */
  const serveMedia = (req: IncomingMessage, res: ServerResponse, nonce: string) => {
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
    const site = req.headers["sec-fetch-site"];
    let hostOk = false;
    try {
      hostOk = hostnames.has(new URL("http://" + req.headers.host).hostname);
    } catch {}
    if (!hostOk || (req.headers.origin && !isOwnOrigin(req, hostnames)) || (site && site !== "same-origin" && site !== "none")) return void res.writeHead(403).end();
    const entry = mediaEntry(nonce);
    if (!entry) return void res.writeHead(404).end();
    entry.used = Date.now();
    if (entry.src.kind === "bytes") {
      // The connection's close ends a response still waiting on a side's piece.
      const live = (entry.live ??= new Set());
      live.add(res);
      res.once("close", () => live.delete(res));
      return void serveBytes(req, res, entry.src).catch(() => res.destroy());
    }
    const path = entry.src.path;
    const type = mediaType(path);
    if (!type || allowed(path) !== path) return void res.writeHead(404).end();
    let fd: number;
    let size: number;
    try {
      // ponytail: the open file must be the canonical path's file (device and inode, no link component): a swapped directory is detected. Remaining limit: hard links (a second name for an outside file). O_NONBLOCK keeps a swapped-in FIFO from blocking the open (fstat isFile then refuses it).
      fd = openChecked(path, OPEN_READ);
      const st = fstatSync(fd);
      if (!st.isFile()) {
        closeSync(fd);
        return void res.writeHead(404).end();
      }
      size = st.size;
    } catch {
      return void res.writeHead(404).end();
    }
    const r = parseRange(req.headers.range, size);
    if (r === "unsatisfiable") {
      closeSync(fd);
      return void res.writeHead(416, { ...MEDIA_HEADERS, "content-range": `bytes */${size}` }).end();
    }
    const start = r?.start ?? 0;
    const end = r?.end ?? size - 1;
    res.writeHead(r ? 206 : 200, mediaHead(type, basename(path), size, start, end, !!r));
    if (req.method === "HEAD" || size === 0) {
      closeSync(fd);
      return void res.end();
    }
    const stream = createReadStream("", { fd, start, end });
    res.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };

  const http = createServer((req, res) => {
    let path: string;
    const rawPath = (req.url ?? "/").split("?")[0] ?? "";
    if (rawPath.startsWith("/media/")) {
      const m = /^\/media\/([0-9a-f]{32})\/[^/]*$/.exec(rawPath);
      return m ? serveMedia(req, res, m[1]!) : void res.writeHead(404).end();
    }
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return void res.writeHead(400).end("malformed URL");
    }
    // Pairing probe: a browser cannot read the 401 of a rejected WebSocket upgrade, so it asks here (client.ts).
    if (path === "/auth") return void res.writeHead(isToken(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]) ? 204 : 401).end();
    serveStatic(req, res, root, path);
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

  // A side's start, failure or stop changes the side list every client shows.
  opts.sides?.onChange(() => broadcast({ type: "sessions.changed" }));
  if (opts.warmUp) http.once("listening", () => void list().catch((e) => console.warn("warm-up list failed:", (e as Error).message)));
  /** This daemon has the session: live, or a transcript inside the roots. */
  const isLocalSession = async (id: string) => sessions.has(id) || (UUID.test(id) && !!allowed((await history.getSessionInfo(id).catch(() => undefined))?.cwd));

  // Ping each socket every interval; one that did not pong since the previous tick is half-open (phone asleep, wifi gone, no FIN):
  // terminate it so its close handler runs (focused tab, subscriptions, watches), else its stale "focused" entry mutes push.
  const answered = new WeakSet<Conn>();
  // A socket that cannot be pinged or terminated must not take the process down (an uncaught exception in this timer): drop it instead.
  const drop = (ws: Conn) => {
    try {
      ws.terminate();
    } catch (err) {
      console.warn("ws: drop:", (err as Error).message);
      connections.delete(ws);
      try {
        ws.close();
      } catch {}
    }
  };
  const pinger = setInterval(() => {
    for (const ws of [...connections]) {
      if (!answered.has(ws)) {
        drop(ws);
        continue;
      }
      answered.delete(ws);
      try {
        ws.ping();
      } catch {
        drop(ws);
      }
    }
  }, opts.pingMs ?? PING_MS).unref();
  http.on("close", () => clearInterval(pinger));

  wss.on("connection", (ws: Conn) => {
    connections.add(ws);
    answered.add(ws);
    ws.on("pong", () => answered.add(ws));
    const usage = plan.current();
    if (usage !== undefined) send(ws, { type: "plan_usage", usage });
    if (plan.age() > PLAN_STALE_MS) void plan.reread();
    updater?.messages().forEach((m) => send(ws, m));
    const stale = opts.buildInfo?.stale();
    if (stale) send(ws, { type: "daemon_stale", note: stale });
    const unsubscribes = new Map<string, () => void>();
    // fs.watch: watched path as the client gave it → canonical path and its stat listener.
    // fs.media: key (canonical path, "blob\0cwd\0hash\0path", "<side>\0cwd\0hash\0path") -> nonce issued to this connection.
    const mediaNonces = new Map<string, string>();
    /** Files at a commit that media.read read (a commit's file never changes): least recently used first, at most MEDIA_BLOB_CACHE_MAX bytes per connection. */
    const blobs = new Map<string, Buffer>();
    const blobCached = (key: string) => {
      const b = blobs.get(key);
      if (b) (blobs.delete(key), blobs.set(key, b));
      return b;
    };
    const blobKeep = (key: string, buf: Buffer) => {
      blobs.set(key, buf);
      let total = 0;
      blobs.forEach((b) => (total += b.length));
      for (const [k, b] of blobs) {
        if (total <= MEDIA_BLOB_CACHE_MAX || k === key) break;
        blobs.delete(k);
        total -= b.length;
      }
    };
    const nonceFor = (key: string) => mediaNonces.get(key) ?? (mediaNonces.set(key, randomBytes(16).toString("hex")), mediaNonces.get(key)!);
    const watched = new Map<string, { real: string; listener: (curr: Stats, prev: Stats) => void }>();
    // Attached terminals: ID → detach.
    const attached = new Map<string, () => void>();
    let searching: AbortController | undefined;
    const unwatchAll = () => {
      watched.forEach((w) => unwatchFile(w.real, w.listener));
      watched.clear();
    };
    // Without a listener a socket error (e.g. a frame above maxPayload) is thrown and the daemon exits; ws closes the socket itself.
    ws.on("error", (err) => console.warn("ws:", err.message));
    ws.on("close", () => {
      router?.close();
      connections.delete(ws);
      mediaNonces.forEach((n) => (media.get(n)?.live?.forEach((r) => r.destroy()), media.delete(n)));
      blobs.clear();
      unsubscribes.forEach((u) => u());
      unwatchAll();
      attached.forEach((d) => d());
      searching?.abort();
      focused.delete(ws);
      covered.delete(ws);
    });
    const onMessage = async (data: RawData) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return send(ws, { type: "error", code: "bad_json", message: "invalid JSON" });
      }
      if (typeof msg !== "object" || msg === null || Array.isArray(msg))
        return send(ws, { type: "error", code: "bad_message", message: "message must be a JSON object" });
      if (msg.type === "ping") return send(ws, { type: "reply", reqId: msg.reqId, result: {} });
      // Timed here, before the router, so a request a side serves or the router answers itself is attributed too.
      const end = perfMon.request(String(msg.type), typeof (msg as { cwd?: unknown }).cwd === "string" ? (msg as { cwd: string }).cwd : undefined);
      try {
        if (router) return await router.handle(msg as ClientMessage & Record<string, unknown>);
        return await local(msg, (m) => send(ws, m));
      } finally {
        end();
      }
    };
    /** Handles a message in this daemon; its reply or error goes to `out`, events and streams to this connection. */
    type MediaFail = { code: string; message: string; size?: number };
    /** media.read and fs.media {hash}: a piece of a media file or of a file at a commit, with the roots and extension checks. */
    const readMedia = async (m: { path: unknown; cwd?: unknown; hash?: unknown; offset: number; length: number }): Promise<MediaReadResult | MediaFail> => {
      if (typeof m.path !== "string") return { code: "bad_request", message: "path must be a string" };
      const mime = mediaType(m.path);
      if (m.hash !== undefined) {
        const cwd = allowed(m.cwd);
        if (!cwd) return { code: "cwd_not_allowed", message: `outside the allowlisted roots: ${String(m.cwd)}` };
        if (!mime) return { code: "unsupported_type", message: `not an image, video or audio file: ${m.path}` };
        const key = `${cwd}\0${String(m.hash)}\0${m.path}`;
        try {
          let buf = blobCached(key);
          // Size only (the first read of every GET): git cat-file -s, no blob read.
          if (!buf && m.length === 0) return { data: "", size: (await gitBlobRef(cwd, m.hash as string, m.path, (p) => inRoots(real(p) ?? p), MEDIA_BLOB_MAX)).size, mtime: 0, mime };
          if (!buf) {
            buf = await gitBlobRead(await gitBlobRef(cwd, m.hash as string, m.path, (p) => inRoots(real(p) ?? p), MEDIA_BLOB_MAX));
            blobKeep(key, buf);
          }
          return { data: buf.subarray(m.offset, m.offset + m.length).toString("base64"), size: buf.length, mtime: 0, mime };
        } catch (e) {
          return { code: e instanceof WorktreeError ? e.code : "git_failed", message: (e as Error).message, size: e instanceof WorktreeError ? e.size : undefined };
        }
      }
      const file = allowed(m.path);
      if (!file) return missingInRoots(m.path) ? { code: "not_found", message: `no such file: ${m.path}` } : { code: "path_not_allowed", message: `outside the allowlisted roots: ${m.path}` };
      const fileMime = mediaType(file);
      if (!fileMime) return { code: "unsupported_type", message: `not an image, video or audio file: ${m.path}` };
      let fh;
      try {
        // Same open as GET /media (no-follow, non-blocking: see the ponytail there).
        fh = await open(file, OPEN_READ);
      } catch (err) {
        return { code: "fs_error", message: String(err) };
      }
      try {
        if (!sameFile(fh.fd, file)) return { code: "path_not_allowed", message: `changed during the request: ${m.path}` };
        const st = await fh.stat();
        if (!st.isFile()) return { code: "not_a_file", message: `not a file: ${m.path}` };
        const n = Math.max(0, Math.min(m.length, st.size - m.offset));
        const buf = Buffer.alloc(n);
        const got = n ? (await fh.read(buf, 0, n, m.offset)).bytesRead : 0;
        return { data: buf.subarray(0, got).toString("base64"), size: st.size, mtime: st.mtimeMs, mime: fileMime };
      } finally {
        await fh.close();
      }
    };
    const isPiece = (o: unknown, l: unknown) => Number.isSafeInteger(o) && (o as number) >= 0 && Number.isSafeInteger(l) && (l as number) >= 0 && (l as number) <= MEDIA_CHUNK;
    /** fs.media of a side's file or commit: the side checks it (media.read, length 0); the hub issues its own URL and reads the bytes from the side per GET. */
    const sideMedia = async (id: string, msg: Extract<ClientMessage, { type: "fs.media" }>, call: (m: ClientMessage) => Promise<ServerMessage>): Promise<ServerMessage> => {
      const args = { path: msg.path, ...(msg.hash !== undefined && { cwd: msg.cwd, hash: msg.hash }) };
      const ask = (offset: number, length: number) => call({ type: "media.read", reqId: "", ...args, offset, length } as ClientMessage);
      const head = await ask(0, 0);
      if (head.type !== "reply") return { ...head, reqId: msg.reqId } as ServerMessage;
      const r = head.result as MediaReadResult;
      // The type comes from the extension here, never from the side's reply.
      const mime = mediaType(msg.path);
      if (!mime) return { type: "error", reqId: msg.reqId, code: "unsupported_type", message: `not an image, video or audio file: ${msg.path}` };
      const name = msg.path.split(/[\\/]/).pop() ?? "";
      const nonce = nonceFor(`${id}\0${msg.cwd ?? ""}\0${msg.hash ?? ""}\0${msg.path}`);
      const read: MediaRead = async (offset, length) => {
        const a = await ask(offset, length);
        return a.type === "reply" ? (a.result as MediaReadResult) : undefined;
      };
      media.set(nonce, { src: { kind: "bytes", read, mime, name }, ws, used: Date.now() });
      return { type: "reply", reqId: msg.reqId, result: { url: `/media/${nonce}/${encodeURIComponent(name)}?v=${msg.hash ?? r.mtime}`, mime, size: r.size, mtime: r.mtime } };
    };
    const local = async (msg: ClientMessage, out: (m: ServerMessage) => void) => {
      const reply = (result: unknown) => out({ type: "reply", reqId: msg.reqId, result });
      const fail = (code: string, message: string, size?: number) => out({ type: "error", reqId: msg.reqId, code, message, size });
      /** An fs.read/fs.write failure: a path that changed during the request is refused; a directory is not a file. */
      const fsFail = (err: unknown, path: string) => {
        const code = (err as { code?: string }).code;
        if (code === "ECHANGED") return fail("path_not_allowed", `changed during the request: ${path}`);
        if (code === "EISDIR") return fail("not_a_file", `not a file: ${path}`);
        return fail("fs_error", String(err));
      };
      const find = async (id: string) => (await findSession(id)) ?? void fail("unknown_session", `no session ${id}`);

      switch (msg.type) {
        case "session.create": {
          if (typeof msg.cwd === "string" && refused(msg.cwd)) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (typeof msg.cwd !== "string" || !existsSync(msg.cwd) || !statSync(msg.cwd).isDirectory())
            return fail("bad_cwd", `not a directory: ${msg.cwd}`);
          if (msg.model !== undefined && !isModel(msg.model)) return fail("bad_model", "model must be a non-empty string");
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (isRemoving(cwd)) return fail("worktree_removing", "This worktree is being removed");
          await modelList().catch(() => {});
          // A removal may have started during the await: no live session in a deleted directory.
          if (isRemoving(cwd) || !existsSync(cwd)) return fail("worktree_removing", "This worktree is being removed");
          // The draft token of the new-session tab's uploads: the session gets their id, and with it their folder (one claim per token).
          const claimed = typeof msg.draft === "string" ? uploads.claim(msg.draft) : undefined;
          if (msg.draft !== undefined && !claimed) console.log("session.create: draft uploads not claimed");
          const s = track(new Session(cwd, sessionOpts({ model: msg.model, permissionMode: defaultModeFor(cwd, msg.model) }), claimed ? { id: claimed } : undefined));
          addProject(cwd);
          return reply({ session: s.info() });
        }
        case "session.defaultMode": {
          const cwd = typeof msg.cwd === "string" && allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          await modelList().catch(() => {});
          return reply({ mode: defaultModeFor(cwd) ?? "default" });
        }
        case "session.commands": {
          const cwd = typeof msg.cwd === "string" && allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          try {
            return reply({ commands: await commandsOf(cwd) });
          } catch (e) {
            return fail("commands_failed", (e as Error).message);
          }
        }
        case "session.subscribe": {
          const span = perfMon.span("session.open");
          try {
            const s = await find(msg.sessionId);
            const title = s && (await titleOf(s));
            if (!s || ws.readyState !== ws.OPEN) return;
            // Only an explicit open (link, notification) adds the project; a reconnect resubscribe must not bring back a removed one.
            if (msg.addProject === true) addProject(s.cwd);
            unsubscribes.get(s.id)?.();
            // A plain subscribe holds the session's CLI (idle close) until it is released; `background` only follows.
            const hold = msg.background !== true;
            const keep = (stop: () => void, release: () => void) => {
              if (hold) holds.set(s.id, (holds.get(s.id) ?? 0) + 1);
              unsubscribes.set(s.id, () => (stop(), release(), hold && unhold(s.id)));
            };
            // Different epoch: the client's seqs belong to an earlier daemon run, so replay everything.
            const since = msg.logEpoch === logEpoch ? msg.sinceSeq : 0;
            // Paged, first subscribe or new epoch: a snapshot (last page) instead of the replay; reply, snapshot and subscribe in one synchronous step.
            if (msg.paged === true && since === 0) {
              const { seq, snapshot } = s.snapshot(typeof msg.from === "string" ? msg.from : undefined);
              reply({ logEpoch, seq, session: s.info(), title: title!, snapshot });
              const stop = s.subscribe(seq, (e) => send(ws, e));
              return keep(stop, mirror(s));
            }
            reply({ logEpoch, seq: s.seq(), session: s.info(), title: title! });
            const stop = s.subscribe(since, (e) => send(ws, e));
            return keep(stop, mirror(s));
          } finally {
            span.end();
          }
        }
        case "session.page":
        case "session.edits": {
          const s = await find(msg.sessionId);
          if (!s) return;
          if (msg.logEpoch !== logEpoch) return fail("stale_epoch", "the daemon restarted since this view was loaded");
          if (typeof msg.before !== "string") return fail("bad_request", "before must be a part id");
          if (msg.type === "session.edits") {
            const parts = s.edits(msg.before);
            return parts ? reply({ parts }) : fail("unknown_cursor", `no part ${msg.before}`);
          }
          if (msg.until !== undefined && (typeof msg.until !== "string" || msg.until.length > 200)) return fail("bad_request", "until must be a string of at most 200 characters");
          const page = s.page(msg.before, msg.until);
          return page ? reply({ page }) : fail("unknown_cursor", `no part ${msg.before}`);
        }
        case "session.media": {
          const s = await find(msg.sessionId);
          if (!s) return;
          if (typeof msg.partId !== "string" || msg.partId.length > 200 || !Number.isInteger(msg.index) || msg.index < 0) return fail("bad_request", "partId must be a part id and index a non-negative integer");
          const dataUrl = s.media(msg.partId, msg.index);
          return dataUrl ? reply({ dataUrl }) : fail("unknown_media", `no media ${msg.index} in part ${msg.partId}`);
        }
        case "session.unsubscribe": {
          // No find(): this must not restore a session.
          unsubscribes.get(msg.sessionId)?.();
          unsubscribes.delete(msg.sessionId);
          return reply({});
        }
        case "session.prompt": {
          const s = await find(msg.sessionId);
          if (!s) return;
          autoContinue.cancel(s.id);
          const images = msg.images ?? [];
          if (!Array.isArray(images) || !images.every((i) => imageBlock(i)))
            return fail("bad_images", "images must be base64 data URLs of type png, jpeg, gif or webp");
          if (typeof msg.text !== "string" || (!msg.text.trim() && !images.length)) return fail("bad_prompt", "empty prompt");
          const err = await sendPrompt(s, msg.text, images);
          return err ? fail(err.code, err.message) : reply({});
        }
        case "session.bash": {
          const s = await find(msg.sessionId);
          if (!s) return;
          autoContinue.cancel(s.id);
          if (typeof msg.command !== "string" || !msg.command.trim()) return fail("bad_command", "empty command");
          if (!allowed(s.cwd)) return fail("cwd_not_allowed", `outside the allowlisted roots: ${s.cwd}`);
          const notLive = () => fail("session_not_live", `session ${s.id} is ${s.info().state}`);
          if (!s.isLive()) return notLive();
          if (s.info().state === "idle") await s.sync();
          if (!s.isLive()) return notLive();
          if (s.externalTurnRunning()) return fail("external_turn", "A terminal CLI turn is running in this session");
          try {
            s.bash(msg.command);
          } catch (e) {
            return fail("bash_failed", (e as Error).message);
          }
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
          let owner: string | undefined;
          if (msg.sessionId !== undefined) {
            if (typeof msg.sessionId !== "string" || !SESSION_DIR.test(msg.sessionId) || deleting.has(msg.sessionId) || !(await locate(msg.sessionId)))
              return fail("unknown_session", "no such session");
            // After /clear the heir's CLI still reads its parent's folder: the file goes where the CLI can read it.
            owner = sessions.get(msg.sessionId)?.uploadOwner ?? msg.sessionId;
          } else if (msg.draft !== undefined) {
            owner = uploads.ownerOfDraft(msg.draft);
            if (!owner) return typeof msg.draft === "string" && uploads.draftClaimed(msg.draft) ? fail("draft_claimed", "draft already used; use a new draft or the sessionId") : fail("bad_upload", "draft must be 64 hex characters");
          } else return fail("bad_upload", "sessionId or draft required; reload the page");
          const buf = Buffer.from(msg.data, "base64");
          if (buf.length > MAX_UPLOAD_BYTES) return fail("too_large", `larger than ${MAX_UPLOAD_BYTES} bytes: ${msg.name}`);
          try {
            return reply({ path: uploads.store(owner, msg.name, buf) });
          } catch (err) {
            return fail("fs_error", String(err));
          }
        }
        case "session.cancelContinue": {
          // No find(): a cancel must not restore a session.
          autoContinue.cancel(msg.sessionId);
          return reply({});
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
        case "session.ids":
          return reply({ ids: await sessionIds() } satisfies SessionIdsResult);
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
        case "perf.report":
          return reply({ daemon: perfMon.report() });
        case "perf.clear":
          perfMon.clear();
          return reply({});
        case "settings.get":
          return reply({ settings: appSettings.get(), daemon: daemonInfo() });
        case "settings.set": {
          try {
            const settings = appSettings.set(msg.patch);
            if (!settings.usageLimit.autoContinue) autoContinue.clear();
            perfMon.setEnabled(settings.performance.monitor);
            broadcast({ type: "settings_changed", settings });
            return reply({ settings, daemon: daemonInfo() });
          } catch (err) {
            return fail("bad_settings", (err as Error).message);
          }
        }
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
          const err = await deleteSessionById(msg.sessionId);
          return err ? fail(err.code, err.message) : reply({});
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
          if (msg.type === "session.rewind") autoContinue.cancel(s.id);
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
          return reply({ paths: (await searchFiles(cwd, msg.query)).filter((p) => allowed(join(cwd, p))) });
        }
        case "sessions.search": {
          // One search per connection: a newer query (or an empty one, the palette closing) stops the running scan.
          searching?.abort();
          searching = undefined;
          if (typeof msg.query !== "string" || (msg.cwd !== undefined && typeof msg.cwd !== "string")) return fail("bad_query", "query must be a string");
          const query = msg.query.trim();
          if (query.length < MIN_SEARCH_CHARS) return reply({ scannedFiles: 0, scannedBytes: 0, ms: 0 });
          if (query.length > MAX_SEARCH_CHARS) return fail("bad_query", `query longer than ${MAX_SEARCH_CHARS} characters`);
          const cwd = msg.cwd === undefined ? undefined : allowed(msg.cwd);
          if (msg.cwd !== undefined && !cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          const ctl = (searching = new AbortController());
          // Only transcripts whose cwd is inside the roots (as session.list); newest first. Many transcripts share a cwd: allowed() once each.
          const ok = new Map<string, string | undefined>();
          const inside = (c: string) => (ok.has(c) ? ok.get(c) : (ok.set(c, allowed(c)), ok.get(c)));
          const files = (await transcripts())
            .filter((t) => t.cwd && inside(t.cwd) && !deleting.has(t.sessionId) && (!cwd || trim(inside(t.cwd)!) === trim(cwd)))
            .sort((a, b) => b.lastModified - a.lastModified)
            .map((t) => ({ sessionId: t.sessionId, cwd: sessionCwd(t.cwd!), title: redact(t.summary), file: transcriptFile(projectsDir, transcriptCwd(t.sessionId, t.cwd!), t.sessionId) }));
          const done = await searchTranscripts(files, query, (r) => out({ type: "sessions.search.result", reqId: msg.reqId, ...r }), { signal: ctl.signal });
          if (searching === ctl) searching = undefined;
          // No query text in the log (it may hold a secret).
          console.log(`sessions.search: ${done.scannedFiles} files, ${Math.round(done.scannedBytes / 1e6)} MB, ${done.ms} ms, first result ${done.firstMs ?? "-"} ms${done.stopped ? `, stopped: ${done.stopped}` : ""}`);
          return reply(done);
        }
        case "git.status": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          return reply({ status: await statusOf(cwd) });
        }
        case "git.refs": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          return reply({ refs: await gitRefs(cwd, (p) => inRoots(real(p) ?? p)) });
        }
        case "git.log":
        case "git.diff":
        case "git.commit":
        case "git.fileAt": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          const inside = (p: string) => inRoots(real(p) ?? p);
          // No filter text in the log (it may hold a secret).
          try {
            if (msg.type === "git.log") return reply({ log: await gitLog(cwd, { skip: msg.skip, limit: msg.limit, ref: msg.ref, author: msg.author, text: msg.text, fresh: msg.fresh === true, allowed: inside }) });
            if (msg.type === "git.diff") return reply({ diff: await gitDiff(cwd, { base: msg.base, ref: msg.ref, allowed: inside }) });
            if (msg.type === "git.commit") {
              const c = await gitShow(cwd, msg.hash, inside);
              return c ? reply({ commit: c }) : fail("not_git", "Not in a git repository");
            }
            const buf = await gitFileAt(cwd, msg.hash, msg.path, inside, MAX_FILE_BYTES);
            const t = decodeText(buf);
            return "code" in t ? fail(t.code, `${t.code === "binary" ? "binary file" : "not UTF-8 text"}: ${msg.path}`, buf.length) : reply({ content: t.content });
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message, e instanceof WorktreeError ? e.size : undefined);
          }
        }
        case "worktree.create":
        case "worktree.status":
        case "worktree.remove": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (msg.type === "worktree.create" && msg.name !== undefined && typeof msg.name !== "string") return fail("bad_name", "name must be a string");
          if (msg.type !== "worktree.remove" && (await gitOutside(cwd))) return fail("cwd_not_allowed", "The repository is outside the allowed roots");
          const path = msg.type === "worktree.create" ? undefined : allowed(msg.path);
          if (msg.type !== "worktree.create" && !path) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.path}`);
          try {
            if (msg.type === "worktree.create") return reply(await createIn(cwd, { name: msg.name || undefined }));
            if (msg.type === "worktree.status") return reply(await worktreeStatus(cwd, path!));
            await removeIn(cwd, path!);
            return reply({});
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "push.key":
          return opts.push ? reply({ publicKey: opts.push.publicKey }) : fail("push_unavailable", "push is not configured");
        case "push.subscribe":
          if (!opts.push) return fail("push_unavailable", "push is not configured");
          return opts.push.subscribe(msg.subscription) ? reply({}) : fail("bad_subscription", "subscription needs an https endpoint and keys");
        case "push.focus":
          if (msg.sessionId !== undefined && typeof msg.sessionId !== "string") return fail("bad_request", "sessionId must be a string");
          if (msg.covered !== undefined && !(Array.isArray(msg.covered) && msg.covered.length <= 2000 && msg.covered.every((x) => typeof x === "string" && x.length <= 200)))
            return fail("bad_request", "covered must be an array of at most 2000 session ids");
          if (msg.sessionId === undefined) focused.delete(ws);
          else focused.set(ws, msg.sessionId);
          if (msg.covered === undefined) covered.delete(ws);
          else covered.set(ws, new Set(msg.covered));
          return reply({});
        case "fs.read": {
          const file = allowed(msg.path);
          // A missing file whose nearest existing ancestor is allowed (deleted after an Edit, also with its directory): the changes tab shows it deleted.
          if (!file && missingInRoots(msg.path)) return fail("not_found", `no such file: ${msg.path}`);
          if (!file) return fail("path_not_allowed", `outside the allowlisted roots: ${msg.path}`);
          let fd: number | undefined;
          try {
            fd = openChecked(file, OPEN_READ);
            const st = fstatSync(fd);
            if (!st.isFile()) return fail("not_a_file", `not a file: ${msg.path}`);
            if (st.size > MAX_FILE_BYTES) return fail("too_large", `larger than ${MAX_FILE_BYTES} bytes: ${msg.path}`, st.size);
            const t = decodeText(readAll(fd, st.size));
            if ("code" in t) return fail(t.code, `${t.code === "binary" ? "binary file" : "not UTF-8 text"}: ${msg.path}`, st.size);
            const content = t.content;
            return reply({ content, mtime: st.mtimeMs });
          } catch (err) {
            return fsFail(err, msg.path);
          } finally {
            if (fd !== undefined) closeSync(fd);
          }
        }
        case "media.read": {
          if (!isPiece(msg.offset, msg.length)) return fail("bad_request", `offset and length must be integers, length at most ${MEDIA_CHUNK}`);
          const r = await readMedia(msg);
          return "code" in r ? fail(r.code, r.message, r.size) : reply(r);
        }
        case "fs.media": {
          if (msg.hash !== undefined) {
            const r = await readMedia({ ...msg, offset: 0, length: 0 });
            if ("code" in r) return fail(r.code, r.message, r.size);
            const nonce = nonceFor(`blob\0${allowed(msg.cwd)}\0${msg.hash}\0${msg.path}`);
            const args = { path: msg.path, cwd: msg.cwd, hash: msg.hash };
            const read: MediaRead = (offset, length) => readMedia({ ...args, offset, length }).then((x) => ("code" in x ? undefined : x));
            const name = msg.path.split(/[\\/]/).pop() ?? "";
            media.set(nonce, { src: { kind: "bytes", read, mime: r.mime, name }, ws, used: Date.now() });
            return reply({ url: `/media/${nonce}/${encodeURIComponent(name)}?v=${msg.hash}`, mime: r.mime, size: r.size, mtime: 0 });
          }
          const file = allowed(msg.path);
          if (!file && missingInRoots(msg.path)) return fail("not_found", `no such file: ${msg.path}`);
          if (!file) return fail("path_not_allowed", `outside the allowlisted roots: ${msg.path}`);
          try {
            const st = statSync(file);
            if (!st.isFile()) return fail("not_a_file", `not a file: ${msg.path}`);
            const mime = mediaType(file);
            if (!mime) return fail("unsupported_type", `not an image, video or audio file: ${msg.path}`);
            const nonce = nonceFor(file);
            media.set(nonce, { src: { kind: "file", path: file }, ws, used: Date.now() });
            return reply({ url: `/media/${nonce}/${encodeURIComponent(basename(file))}?v=${st.mtimeMs}`, mime, size: st.size, mtime: st.mtimeMs });
          } catch (err) {
            return fail("fs_error", String(err));
          }
        }
        case "fs.write": {
          // Existing files only: the editor edits what the tree shows.
          const file = allowed(msg.path);
          if (!file) return fail("path_not_allowed", `outside the allowlisted roots: ${msg.path}`);
          if (typeof msg.content !== "string") return fail("bad_content", "content must be a string");
          let fd: number | undefined;
          try {
            fd = openChecked(file, OPEN_WRITE);
            const st = fstatSync(fd);
            if (!st.isFile()) return fail("not_a_file", `not a file: ${msg.path}`);
            if (msg.baseMtime !== undefined && st.mtimeMs !== msg.baseMtime)
              return fail("conflict", `changed on disk since it was read: ${msg.path}`);
            const data = Buffer.from(msg.content);
            ftruncateSync(fd, 0);
            writeAll(fd, data);
            // Closed first: NTFS may set the write time when the handle closes, and the editor keeps this value as its next baseMtime.
            closeSync(fd);
            fd = undefined;
            return reply({ mtime: statSync(file).mtimeMs });
          } catch (err) {
            return fsFail(err, msg.path);
          } finally {
            if (fd !== undefined) closeSync(fd);
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
          if (isRemoving(cwd)) return fail("worktree_removing", "This worktree is being removed");
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
          if (missingInRoots(msg.cwd))
            return fail("bad_cwd", `Working directory not found: ${msg.cwd}. If this session's folder was deleted, re-open the project and try again.`);
          const cwd = allowed(msg.cwd);
          if (!cwd || !statSync(cwd).isDirectory()) return fail("cwd_not_allowed", `not a directory inside the allowlisted roots: ${msg.cwd}`);
          if (!msg.type.startsWith("mcp.") && !msg.type.startsWith("skills."))
            try {
              const r = await plugins.handle(msg as PluginsRequest, cwd);
              if (!msg.type.endsWith(".list")) commandCache.clear();
              return reply(r);
            } catch (e) {
              return fail(e instanceof ConfigError ? e.code : "plugins_failed", (e as Error).message);
            }
          // The session's running query when it runs in that project; otherwise the project's config query.
          const s = "sessionId" in msg && typeof msg.sessionId === "string" ? sessions.get(msg.sessionId) : undefined;
          try {
            const live = s?.cwd === cwd ? s.liveQuery() : undefined;
            const r = msg.type.startsWith("skills.") ? await config.skills(msg as SkillsRequest, cwd, live) : await config.mcp(msg as McpRequest, cwd, live);
            if (msg.type === "skills.setState") commandCache.clear();
            return reply(r);
          } catch (e) {
            return fail(e instanceof ConfigError ? e.code : msg.type.startsWith("skills.") ? "skills_failed" : "mcp_failed", (e as Error).message);
          }
        }
        case "update.install":
        case "update.restart": {
          if (!updater) return fail("update_unavailable", "updates are off (source checkout, --no-update-check or not started by claude-ui)");
          try {
            return reply(msg.type === "update.install" ? { installed: await updater.install() } : { waitingFor: updater.restart(msg.now === true) });
          } catch (e) {
            return fail("update_failed", (e as Error).message);
          }
        }
        default:
          return fail("unknown_type", `unknown message type ${(msg as { type?: string }).type}`);
      }
    };
    const router =
      opts.sides &&
      createRouter({
        sides: opts.sides,
        send: (m) => send(ws, m),
        local: (msg) => local(msg, (m) => send(ws, m)),
        localCall: (msg) =>
          new Promise<ServerMessage>((resolve) =>
            local(msg, resolve).catch((err) => (console.error("request handler failed:", err), resolve({ type: "error", reqId: msg.reqId, code: "internal_error", message: "request failed" }))),
          ),
        isLocalSession,
        media: sideMedia,
        mediaTimeoutMs: opts.sideCallTimeoutMs,
      });
    // A handler that throws fails its request: a rejected promise nobody awaits would end the process (Node's default).
    ws.on("message", (data) =>
      onMessage(data).catch((err) => {
        console.error("request handler failed:", err);
        let reqId: unknown;
        try {
          reqId = JSON.parse(String(data)).reqId;
        } catch {}
        send(ws, { type: "error", reqId: typeof reqId === "string" ? reqId : undefined, code: "internal_error", message: "request failed" });
      }),
    );
  });

  /** Serves a connection that is not a WebSocket of this server: a side's virtual connection (sides.ts runSide). */
  // Typed as Conn, so a SideSocket without what the handler uses (ping, terminate, ...) fails to compile.
  const accept = (ws: Conn) => void wss.emit("connection", ws, undefined);
  // A blocked worker_wait ends with a tool error instead of hanging until the CLI is gone.
  const idleCloseMs = opts.idleCloseMs ?? IDLE_CLOSE_MS;
  // ponytail: one scan per minute over all sessions; fine for tens of sessions.
  const reaper =
    idleCloseMs > 0
      ? setInterval(() => {
          const now = Date.now();
          for (const s of sessions.values())
            if (!holds.get(s.id) && s.liveQuery() && now - (touched.get(s.id) ?? 0) >= idleCloseMs && !orchestration.waitingOnWorkers(s.id) && s.releaseQuery())
              console.log(`session ${s.id}: idle ${Math.round(idleCloseMs / 60_000)} min without a tab, CLI closed`);
        }, Math.min(IDLE_CHECK_MS, idleCloseMs)).unref()
      : undefined;
  const sweepMs = opts.uploadSweepMs ?? UPLOAD_SWEEP_MS;
  const sweepUploads = () =>
    uploads
      .sweep(async (id) => sessions.has(id) || restoring.has(id) || uploads.hasDraftId(id) || folderInUse(id) || (await history.getSessionInfo(id).catch(() => true)) !== undefined)
      .then((gone) => gone.length && console.log(`uploads: removed ${gone.length} orphaned folder(s)`))
      .catch((e) => console.error("uploads: sweep failed:", e));
  const firstSweep = sweepMs > 0 ? setTimeout(() => void sweepUploads(), opts.uploadSweepFirstMs ?? 60_000).unref() : undefined;
  const sweeper = sweepMs > 0 ? setInterval(() => void sweepUploads(), sweepMs).unref() : undefined;
  http.on("close", () => (orchestration.shutdown(), clearInterval(reaper), clearTimeout(firstSweep), clearInterval(sweeper), perfMon.close()));
  // transcriptCaches: sessions whose parsed transcript the daemon holds (tests). orchestration: its tools (tests).
  return Object.assign(http, { accept, transcriptCaches: () => [...caches.keys()], orchestration });
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

function send(ws: Conn, m: ServerMessage) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
}
