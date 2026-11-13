// HTTP server for the built web app plus the WebSocket endpoint at /ws.
import { planDirs } from "./plan-dirs.ts";
import { closeSync, createReadStream, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unwatchFile, watchFile, writeFileSync, type Stats } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { homedir, hostname as osHostname, tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { ALL_CAPABILITIES, CHUNK_BYTES, createAdapter, editorLabel, parseEditorCommand, EFFORTS, ENGINES, type Engine as EngineName, type AsideOpenResult, type PromptResult, type EditorId, imageBlock, LOCAL_SIDE, MAX_SEARCH_CHARS, MAX_TERMINAL_INPUT_BYTES, MIN_SEARCH_CHARS, MAX_UPLOAD_BYTES, PERMISSION_MODES, permissionModesFor, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type BackMark, BACK_BRIEF_MAX, BACK_MARKS_MAX, BACK_TAG, type ClientMessage, type FsEntry, type FsGrepResult, type ListResult, type MediaReadResult, type ModelInfo, type PermissionMode, type RewindMode, type SessionIdsResult, type ServerMessage, type SessionListItem, type SlashCommand, type Worktree } from "@claude-ui/protocol";
import { deleteSession, forkSession, getSessionInfo, getSessionMessages, getSubagentMessages, listSessions, listSubagents, renameSession, tagSession, type query as sdkQuery, type SDKMessage, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ARTIFACT_ASSET_HEADERS, ARTIFACT_PREVIEW_MAX, artifactHeaders, assetKey, assetRequestAllowed, scratchpadOf, type ArtifactAsset } from "./artifact-preview.ts";
import { configDir } from "./token.ts";
import { createLocalHistory, HistoryError } from "./local-history.ts";
import { createSleepWatch, SLEEP_CHECK_MS, SLEEP_KEEP_MS, type Slept } from "./sleep-watch.ts";
import { asideDisallowed, asideForkPoint, portListening } from "./aside.ts";
import { createReplaceUndo, replaceInFiles, ReplaceError, undoReplace } from "./replace.ts";
import { clearSearchCache, searchFiles } from "./search.ts";
import { findInFiles, GREP_LIMITS, GrepError, matcher, parseGlobs } from "./grep.ts";
import { createReposCache } from "./repos-cache.ts";
import { foreignPointer, refusedPath, winPathKind } from "./remote-path.ts";
import { copyEntry, createEntry, deleteEntry, duplicateFile, readFileChunk, renameEntry, walkEntry, writeFileChunk, type FsOpsContext } from "./fs-ops.ts";
import { openChecked, OPEN_READ, OPEN_WRITE, readAll, readdirChecked, real, sameFile, writeAll } from "./fd-check.ts";
import { MEDIA_BLOB_CACHE_MAX, MEDIA_BLOB_MAX, MEDIA_CHUNK, MEDIA_HEADERS, MEDIA_TTL_MS, mediaType, parseRange } from "./media.ts";
import { performance } from "node:perf_hooks";
import { createPerf, setPerf, type PerfMonitor } from "./perf.ts";
import { createJira, JiraError, jiraOrigin } from "./jira.ts";
import { createSecrets, type Secrets } from "./secrets.ts";
import { createWorktree, listBranches, pullRequestBranches, gitBlame, gitBlobRead, gitBlobRef, gitDiff, gitDirsOf, gitEscapes, gitFileAt, gitLog, gitOperationOf, gitRefs, gitShow, gitStatus, gitTopOf, isHash, classify, limiter, listRepos, listWorktrees, lowPriority, removeWorktree, WorktreeError, worktreeStatus, cachedStatuses, markRepoStale, markWorktreeStale, type CreateWorktreeOptions } from "./git.ts";
import { gitBranch, gitFetch, gitPull, gitPush } from "./git-remote.ts";
import { createWarmCommitMessage, generateCommitMessage, instructionFor, promptFor } from "./commit-message.ts";
import { gitAbort, gitBranchCreate, gitCheckout, gitCommitAction, gitCommitDiff, gitCommitFiles, gitCommitMenu, gitContinue, gitMergeRebase, gitRollback, gitRollbackHunk, gitRollbackPreview, gitStash, gitStashList, gitStashPush } from "./git-write.ts";
import { createNotifier, type Push } from "./push.ts";
import { readDefaultMode } from "./default-mode.ts";
import { createSettings, type AppSettings } from "./settings.ts";
import { brokenState, createOpenCodeEngine, ProviderStateBroken, loadOpenCodeHistory, OPENCODE_CAPABILITIES, OPENCODE_MODES, openCodeModels, primaryAgents } from "./opencode-engine.ts";
import { createOpenCodeServer, OpenCodeError } from "./opencode-server.ts";
import { checkLogin, listProviders, loginError } from "./opencode-providers.ts";
import { createProjects, trim, type Projects } from "./projects.ts";
import { claudeBin } from "./claude-bin.ts";
import { claudeEnv, setClaudeToken } from "./claude-env.ts";
import { TEST_ARGS, TEST_TIMEOUT_MS, testOutcome } from "./claude-test.ts";
import { createPlanTracker, RESET_GRACE_MS, usesOauthToken } from "./plan-usage.ts";
import { createPromptQueue } from "./prompt-queue.ts";
import { briefPrompt, checkSet, find as findMark, total as marksTotal, upsert as upsertMark } from "./back-marks.ts";
import { createBackReminders, TICK_MS as BACK_TICK_MS, type Due } from "./back-reminders.ts";
import { CONTINUE_GAP_MS, CONTINUE_PROMPT, createAutoContinue } from "./auto-continue.ts";
import { listModels, queuedQuery, Session, transcriptModel, type SessionSettings, type Transcript } from "./session.ts";
import { createTerminals } from "./terminals.ts";
import { ConfigError, createConfig, runCli, timed, type CliRunner, type McpRequest, type SkillsRequest } from "./config.ts";
import { createPlugins, redact, type PluginsRequest } from "./plugins.ts";
import { addonAssetHeaders, addonHeaders, createAddons, type AddonsRequest } from "./addons.ts";
import { searchTranscripts } from "./content-search.ts";
import { cliTurnRunning, interleaveRuns, JsonlTail, parseJsonl, transcriptEnd } from "./transcript.ts";
import type { KeepAwake } from "./keep-awake.ts";
import { customCommand, EDITORS, findOnPath, isOpenWith, openCommand, type Launcher, type OpenCommand } from "./open-external.ts";
import { createRouter, type Sides } from "./sides.ts";
import { createSessionSettings } from "./session-settings.ts";
import { createUploads, SESSION_DIR } from "./uploads.ts";
import { createUpdater, type Updater } from "./update.ts";
import { createOrchestration } from "./orchestration.ts";
import type { AddressInfo } from "node:net";
import { serveAppIcon } from "./app-icon.ts";
import { serveStatic } from "./static.ts";
import { VISUALIZE_HEADERS, VISUALIZE_SHELL, visualizePluginDir } from "./visualize.ts";
import { lastEntryTime, listSessionsOffThread, mapLimit, transcriptStamp } from "./session-scan.ts";

/** The reply field with the folders of the session's plan files (a side's own reply carries its own). */
const planDirsOf = (s: object) => {
  const dirs = (s as { planDirs?: () => string[] | undefined }).planDirs?.();
  return dirs ? { planDirs: dirs } : {};
};

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
  on(event: "pong", listener: () => void): unknown;
  on(event: "close", listener: (code?: number) => void): unknown;
}
// Compile-time check: a real ws socket satisfies Conn (wss.on/emit are loosely typed, so nothing else would notice a new Conn member it lacks).
void ((w: WebSocket): Conn => w);

const REWIND_MODES: RewindMode[] = ["code", "conversation", "both"];

/** SDK title of a transcript whose only prompt is /clear (or its aliases /reset, /new). */
const CLEARED = /^\/(clear|reset|new)$/;
/** session.list waits this long for the model list (auto mode of new sessions) before it replies without it. */
export const MODEL_LIST_WAIT_MS = 2000;
/** The longest `session.list` waits for the OpenCode server (it may start, or hang, for the first list). */
const OPENCODE_LIST_WAIT_MS = 3000;

/** ws maxPayload (default 100 MiB): a prompt with two images at MAX_UPLOAD_BYTES as base64, plus the JSON around them. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Transcript restores running at once. */
const MAX_RESTORES = 2;

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
const LAG_TICK_MS = 500;
const LAG_LOG_MS = 1_000;
const MEM_LOG_MS = 10 * 60_000;
const mb = (n: number) => Math.round(n / 2 ** 20);

/** An OpenCode session id: it reaches a request path, so only this shape does. */
const OPENCODE_ID = /^ses_[A-Za-z0-9]+$/;
type OpenCodeSessionRow = { id: string; directory: string; title: string; time: { created: number; updated: number; archived?: number } };
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
  /** Aside (docs/spec.md "Aside"): copies the owner transcript up to a message into a new session. */
  forkSession?: typeof forkSession;
};

const OPENCODE_RESTART_BUSY = "OpenCode is busy: a turn runs, a login waits or a session is being created. Restart it when that is done.";
const PROVIDERS_BROKEN_BUSY = "OpenCode's provider list is broken. It is reloaded when no OpenCode turn runs: press Retry then.";
/** SDK session tag that marks an archived session (no archive flag of its own; ADR 0001: no store of ours). */
const ARCHIVED_TAG = "archived";

const LOCAL_HOSTNAMES = ["127.0.0.1", "localhost"];
/** A connection whose browser runs on this machine: a local Host name and a loopback peer (a Tailscale or LAN Host, and a side's virtual connection, are not). */
const sameMachine = (req: IncomingMessage | undefined) => {
  try {
    return !!req && [...LOCAL_HOSTNAMES, "[::1]"].includes(new URL("http://" + req.headers.host).hostname) && /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? "");
  } catch {
    return false;
  }
};

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
  /** Hub only: addons and their checkouts (docs/spec.md "Addons"). Unset: addons.* fail addons_unavailable. */
  addonsDir?: string;
  /** Directory no Artifact preview (page or supporting file) may read: the daemon's config dir (token, settings). Default configDir(). */
  privateDir?: string;
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
  /** Period of the pass that deletes Asides of daemons on other ports that stopped (default 60 s); tests shorten it. */
  asideSweepMs?: number;
  /** Delay of the first sweep (default 60 s); tests shorten it. */
  uploadSweepFirstMs?: number;
  projectsDir?: string;
  settingsFile?: string;
  /** The Claude user config folder (`settings.json` holds `permissions.defaultMode`); default: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeDir?: string;
  projects?: Projects;
  /** App-wide settings (settings.json); in memory when omitted. Readers call `get()` each time. */
  appSettings?: AppSettings;
  /** Local history store (GH-565); main.ts passes `<configDir>/history`. Default: a fresh folder in the temp dir (tests; created on first entry). */
  historyDir?: string;
  /** Write-only secrets (secrets.json, GH-447: the Jira token); in memory when omitted. */
  secrets?: Secrets;
  /** Test seam: `command` replaces the PATH lookup of `opencode` (argv prefix), `env` is added to the OpenCode child's environment. */
  opencode?: { command?: string[]; env?: () => NodeJS.ProcessEnv; startTimeoutMs?: number; /** How long `session.list` waits for OpenCode (default 3 s). */ listWaitMs?: number };
  /** Test seam (GH-447): the fetch of the Jira client. */
  jiraFetch?: typeof fetch;
  /** Test seam (GH-164): delays of auto-continue.ts. */
  autoContinue?: { graceMs?: number; gapMs?: number; retryMs?: number };
  listCache?: boolean;
  /** Interval of the WebSocket ping that drops a half-open socket (default 15 s; tests use a few hundred ms). */
  pingMs?: number;
  /** The Claude login is CLAUDE_CODE_OAUTH_TOKEN (plan-usage.ts fallback); default: whether the env var is set. Never its value. */
  oauthToken?: boolean;
  /** Test seam: the program `terminal.create {login}` runs (default: the SDK's bundled Claude CLI, called with `auth login`). */
  claudeBin?: string;
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
  /** GH-523: the sleep inhibitor (keep-awake.ts); none: no keep awake (a side, tests). */
  keepAwake?: KeepAwake;
  /** GH-612: fs.openExternal. `run` starts the OS command, `editors` lists the installed editors; none (a side, tests without it): the request and the editor list are absent. */
  openExternal?: { run: (c: OpenCommand) => Promise<void>; editors: () => Map<EditorId, Launcher>; /** A daemon in WSL: the Windows form of a path (`wslpath -w`); it opens reveal and default in Windows and trusts its attached Hubs. */ winPath?: (path: string) => Promise<string> };
  /** GH-518: sleep detection (Hub only; a Side runs on the Hub's machine). `everyMs` and `now` are test seams. */
  watchSleep?: { everyMs?: number; now?: () => number };
  /** GH-523: this daemon's own sessions start or stop running (a side reports it to its hub). */
  onRunning?: (running: boolean) => void;
  /** GH-622: a Hub started by another Hub's attach (a Side): it keeps no Back marks (they are the Hub's settings) and runs no reminders; back.* is refused there. */
  attached?: boolean;
  /** Test seam (GH-622): the reminder tick (default 30 s) and clock. */
  backReminders?: { everyMs?: number; now?: () => number };
  /** Whether this daemon runs older code than is on disk (build-info.ts): worker_start and worker_list report it, a new connection shows it. */
  buildInfo?: { version?: string; stale(): string | undefined };
  /** Test seam (GH-272): the performance monitor (default: a real one, on unless the `performance.monitor` setting is off). */
  perf?: PerfMonitor;
  /** How long worker_stop and worker_close wait for a stopped worker to leave running/needs_input (orchestration.ts); tests shorten it. */
  stopWaitMs?: number;
  /** GH-553: the OS launcher shortcut (shortcut.ts); none: launcher.shortcut fails (a side, another OS). */
  shortcut?: { installed(): boolean; set(on: boolean): Promise<boolean> };
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
  const plan = createPlanTracker({ onChange: (usage) => broadcast({ type: "plan_usage", usage }), read: () => queuedQuery(plan.refresh, opts.query), oauthToken: opts.oauthToken ?? (() => usesOauthToken(claudeEnv())), account: () => accountName() });
  /** Options of every session: settings changes are saved under its ID. */
  const sessionOpts = (initial: Partial<SessionSettings>) => ({
    ...initial,
    plan,
    promptSuggestions: () => appSettings.get().focus.nextForYou,
    chrome: () => appSettings.get().chrome.enabled,
    visualizePlugin: () => (appSettings.get().chat.visualize ? visualizePluginDir() : undefined),
    // The plan fallback only while the plan says rejected: another 429 (per-model, credits) during a warning is no usage limit.
    onLimitStop: (id: string, resetsAt: number | undefined) => {
      const at = resetsAt ?? (plan.current()?.status === "rejected" ? plan.current()?.statusResetsAt : undefined);
      sessions.get(id)?.setLimitStop(at);
      autoContinue.schedule(id, at);
      // Queued messages wait for the reset (after an automatic continue), else for the user: sending into the limit would burn them one by one.
      queue.hold(id, at ? at + (opts.autoContinue?.graceMs ?? RESET_GRACE_MS) + (opts.autoContinue?.gapMs ?? CONTINUE_GAP_MS) : undefined);
    },
    allowBypass: opts.allowBypass,
    onFileEdit: (path: string, original: string) => localHistory.before(path, "agent", original),
    // `live` of the session list changed (CLI started or dropped).
    onLiveChange: () => broadcast({ type: "sessions.changed" }),
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
    planDirs: (cwd: string) => planDirs(claudeDir, cwd),
    // Only the fields this change set: a daemon on another port may have changed the others of the same session (GH-91).
    onSettings: (s: SessionSettings, id: string, fields: (keyof SessionSettings)[]) => saveSettings(() => settings.set(id, s, fields)),
    // /clear: the new session is listed; tabs that show the old one follow its session_cleared part.
    onCleared: (heir: Session, from: Session) => {
      track(heir);
      // Workers, queued events and the server's binding follow the live query (orchestration "/clear").
      orchestration.handOver(from.id, heir.id);
      broadcast({ type: "sessions.changed" });
    },
    worker: (id: string) => !!settings.get(id)?.coordinatorId,
    mcpServers: (id: string) => orchestration.mcpServers(id),
    agent: (id: string) => settings.get(id)?.agent,
    disallowedTools: (id: string) => asideDisallowed(settings.get(id)),
    toolPolicy: (tool: string, mcpServer?: { name: string; source: string }) => orchestration.toolPolicy(tool, mcpServer),
    preflight: (id: string, tool: string, input: Record<string, unknown>, mcp?: { name: string; source: string }) => orchestration.preflight(id, tool, input, mcp),
    permissionCard: (id: string, tool: string, input: Record<string, unknown>, mcp?: { name: string; source: string }) => orchestration.permissionCard(id, tool, input, mcp),
  });
  const restoring = new Map<string, Promise<Session | undefined>>();
  // Sessions whose delete is in progress (session.delete).
  const deleting = new Set<string>();
  // Claude sessions whose transcript this run has seen (listed or restored): one that is gone later was deleted outside the daemon.
  const hadTranscript = new Set<string>();
  const history = { listSessions: listSessionsOffThread, getSessionInfo, getSessionMessages, listSubagents, getSubagentMessages, renameSession, tagSession, deleteSession, forkSession, ...opts.history };
  const claudeDir = opts.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  const projectsDir = opts.projectsDir ?? join(claudeDir, "projects");
  const projects = opts.projects ?? createProjects();
  const appSettings = opts.appSettings ?? createSettings();
  /** GH-668: the ready Haiku process of Generate; used only while `git.commitMessageWarm` is on. */
  const warmCommit = createWarmCommitMessage(opts.query);
  /** The OpenCode server: started on first use (docs/spec.md "OpenCode engine"), stopped with the daemon. */
  const openCode = createOpenCodeServer({ path: () => appSettings.get().opencode.path, ...opts.opencode });
  /** Directory and title of each OpenCode session this daemon listed, created or opened. */
  const openCodeMeta = new Map<string, { cwd: string; title: string }>();
  const openCodeFail = (err: unknown) => (err instanceof OpenCodeError ? { code: err.code, message: err.message } : { code: "opencode_failed", message: (err as Error).message });
  /**
   * Orchestration MCP of OpenCode sessions (docs/spec.md "Orchestration"): OpenCode connects to `/opencode-mcp` of this daemon with a
   * per-session bearer token (token -> session id); one stateful transport and server per token, a new `initialize` replaces both.
   */
  const mcpRoutes = new Map<string, { id: string; live?: { transport: StreamableHTTPServerTransport; server: McpServer }; init?: Promise<boolean> }>();
  const dropMcp = (token: string) => {
    void mcpRoutes.get(token)?.live?.server.close().catch(() => {});
    mcpRoutes.delete(token);
  };
  const openCodeEngine = createOpenCodeEngine(openCode, {
    onTitle: (id, title) => {
      const m = openCodeMeta.get(id);
      if (!m || m.title === title) return;
      openCodeMeta.set(id, { ...m, title });
      broadcast({ type: "sessions.changed" });
    },
    mcp: {
      // The local OpenCode server always reaches the daemon on 127.0.0.1 (it listens there or on 0.0.0.0).
      url: () => {
        const a = http.address();
        return a && typeof a === "object" ? `http://127.0.0.1:${a.port}/opencode-mcp` : undefined;
      },
      token: (id) => {
        for (const [t, r] of mcpRoutes) if (r.id === id) return t;
        const t = randomBytes(32).toString("base64url");
        mcpRoutes.set(t, { id });
        return t;
      },
      drop: (id) => {
        for (const [t, r] of mcpRoutes) if (r.id === id) dropMcp(t);
      },
    },
  });
  async function serveOpenCodeMcp(req: IncomingMessage, res: ServerResponse) {
    // The token before any body read.
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const route = token === undefined ? undefined : [...mcpRoutes].find(([t]) => timingSafeEqual(digest(t), digest(token)))?.[1];
    if (!route) return void res.writeHead(401).end();
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req as AsyncIterable<Buffer>) {
        if ((size += c.length) > 4 << 20) return void res.writeHead(413).end();
        chunks.push(c);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return void res.writeHead(400).end();
      }
    }
    if (isInitializeRequest(body)) {
      // One initialize at a time per token: a second one would replace a transport that is still connecting (leak).
      const prev = route.init;
      const run = (async () => {
        await prev?.catch(() => {});
        // OpenCode connects again (its restart, a dispose): a new MCP session.
        void route.live?.server.close().catch(() => {});
        route.live = undefined;
        const server = orchestration.mcpServerFor(route.id);
        if (!server) return false;
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        await server.connect(transport);
        route.live = { transport, server };
        return true;
      })();
      route.init = run;
      if (!(await run)) return void res.writeHead(404).end();
    }
    if (!route.live) return void res.writeHead(404).end();
    await route.live.transport.handleRequest(req, res, body);
  }
  /** One OAuth wait (`opencode.loginFinish`) per provider; a cancel or a new login aborts it. */
  const oauthWaits = new Map<string, AbortController>();
  /** Login and logout change OpenCode's provider set; `POST /global/dispose` makes its instances read it, but cancels running turns: it waits for idle. */
  let providersStale = false;
  const openCodeBusy = () => [...sessions.values()].some((s) => OPENCODE_ID.test(s.id) && (s.currentState() !== "idle" || s.pendingCount() > 0));
  async function flushProviders() {
    if (!providersStale || openCodeBusy() || !openCode.running()) return;
    providersStale = false;
    // Clients drop their OpenCode model list only after OpenCode read the new providers.
    await openCode.request("/global/dispose", { method: "POST" }).then(() => (openCodeEngine.dropLimits(), broadcast({ type: "opencode.providersChanged" })), (err) => (providersStale = true, console.error("OpenCode dispose failed:", (err as Error).message)));
  }
  /** OpenCode sessions being created (POST /session in flight): a restart of OpenCode's server would lose them. */
  let openCodeCreating = 0;
  let openCodeRestarts = 0;
  let openCodeRestart: Promise<void> | undefined;
  /** A restart of OpenCode's server now would lose a turn, an OAuth login or a session creation. */
  const openCodeHeld = () => openCodeBusy() || oauthWaits.size > 0 || openCodeCreating > 0;
  /** Stops OpenCode's server (the next request starts it again; open sessions resync on the new event stream) and drops its cached limits. One at a time. */
  const restartOpenCode = () =>
    (openCodeRestart ??= (async () => {
      await openCode.reset();
      openCodeEngine.dropLimits();
      openCodeRestarts++;
    })().finally(() => (openCodeRestart = undefined)));
  /**
   * OpenCode's model list. Only a read that still answers 499 after the folder's instance was disposed means the provider state is broken server-wide
   * (nothing else clears it): then OpenCode's server restarts, unless a turn, an OAuth login or a session creation would be lost. A refused or failed
   * folder repair, or a busy server, is `models_failed` with the reason. One restart at a time; a caller that saw the break before a restart reads again.
   */
  async function openCodeModelsRepaired(cwd?: string): Promise<ModelInfo[]> {
    const seen = openCodeRestarts;
    try {
      return await openCodeModels(openCodeEngine, cwd);
    } catch (err) {
      if (err instanceof ProviderStateBroken) {
        if (seen === openCodeRestarts) {
          if (openCodeHeld()) throw new Error(PROVIDERS_BROKEN_BUSY);
          await restartOpenCode();
        } else await openCodeRestart;
        return openCodeModels(openCodeEngine, cwd);
      }
      throw brokenState(err) ? new Error(PROVIDERS_BROKEN_BUSY) : err;
    }
  }
  const refreshProviders = () => ((providersStale = true), flushProviders());
  const openCodeSessionOpts = (initial: Partial<SessionSettings>) => ({ ...sessionOpts(initial), engine: openCodeEngine });
  /** A new OpenCode session in `cwd` with the rules of its mode (tracked, its project added); undefined when the folder is being removed meanwhile. Throws OpenCode's error. */
  async function createOpenCodeSession(cwd: string, initial: { model?: string; permissionMode: PermissionMode; effort?: SessionSettings["effort"] }): Promise<Session | undefined> {
    // No timeout: the first request of a cold folder boots its instance (> 3 s) and the user waits for the session; a timeout would lose the created session for good.
    // `resend`: a create cut off by a server that died is sent again to the next server; at worst (it died after creating) an empty session is left over.
    const permission = await openCodeEngine.block(initial.permissionMode, cwd); // may reject: before the counter goes up
    openCodeCreating++;
    const row = await openCode.request<OpenCodeSessionRow>("/session", { method: "POST", directory: cwd, timeoutMs: 0, resend: true, body: { permission } }).finally(() => openCodeCreating--);
    if (isRemoving(cwd) || !existsSync(cwd)) return undefined;
    const s = track(new Session(cwd, openCodeSessionOpts(initial), { id: row.id }));
    openCodeMeta.set(s.id, { cwd, title: row.title });
    addProject(cwd);
    return s;
  }
  /** Settings `sessions.engine`: the Engine of the last created session. */
  const rememberEngine = (engine: EngineName) => {
    if (appSettings.get().sessions.engine === engine) return;
    try {
      broadcastSettings(appSettings.set({ sessions: { engine } }));
    } catch (err) {
      console.error("saving the last engine failed:", err);
    }
  };
  /** The undo records of applied `fs.replace` calls (docs/spec.md "Editor"), shared by every connection. */
  const replaceUndo = createReplaceUndo();
  /** Local history (local-history.ts): `before()` is the one entry point for every write that replaces file content (editor save, agent Edit/Write, git writes). */
  const localHistory = createLocalHistory({ dir: opts.historyDir ?? join(tmpdir(), `claude-ui-history-${randomUUID()}`), settings: () => appSettings.get().history, allowed: (p) => allowed(p) });
  const secrets = opts.secrets ?? createSecrets();
  const jira = createJira({ config: () => appSettings.get().jira, token: (o) => secrets.jiraToken(o), ...(opts.jiraFetch && { fetch: opts.jiraFetch }) });
  /** `settings.get` / `settings.set` / `jira.token` reply: the settings, the daemon, whether a Jira token is saved (never the token). */
  const settingsReply = (settings = appSettings.get()) => ({ settings, daemon: daemonInfo(), jiraToken: !!secrets.jiraToken(jiraOrigin(settings.jira.url)), claudeAccounts: secrets.claudeAccounts(), ...(secrets.jiraTokenReset() && { jiraTokenReset: true as const }) });
  /** The Claude account of the settings as the CLI env takes it: undefined = Default, null = CLI login, a token; an unknown id (removed, hand edit) is Default. */
  const accountToken = () => {
    const a = appSettings.get().claude.account;
    return a === "cli" ? null : a ? secrets.claudeToken(a) : undefined;
  };
  const accountName = () => {
    const a = appSettings.get().claude.account;
    return a === "cli" ? "CLI login" : a ? secrets.claudeAccounts().find((x) => x.id === a)?.name : undefined;
  };
  setClaudeToken(accountToken());
  /** `claude.account.test` in flight by account id: a second request awaits the same CLI run. */
  const accountTests = new Map<string, Promise<ReturnType<typeof testOutcome>>>();
  const testAccount = (id: string, token: string, env: NodeJS.ProcessEnv) => {
    let p = accountTests.get(id);
    if (!p) {
      // Throwaway CLI config: the test touches neither ~/.claude nor the keychain login (the env token wins).
      const dir = mkdtempSync(join(tmpdir(), "claude-ui-test-"));
      p = (async () => testOutcome(await (opts.cli ?? runCli)(TEST_ARGS, dir, "", TEST_TIMEOUT_MS, { ...env, CLAUDE_CONFIG_DIR: dir }), token))().finally(() => {
        rmSync(dir, { recursive: true, force: true });
        accountTests.delete(id);
      });
      accountTests.set(id, p);
    }
    return p;
  };
  const broadcastSettings = (settings = appSettings.get()) => {
    const r = settingsReply(settings);
    broadcast({ type: "settings_changed", settings, jiraToken: r.jiraToken, claudeAccounts: r.claudeAccounts });
  };
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
  /** `git.repos` replies: dropped whenever the session list or the settings change (docs/spec.md "git.repos"). */
  const reposCache = createReposCache();
  /** git.repos of `cwd`, cached 10 s; fs.search uses it too (an error there: no nested repositories). */
  /** Open files of each cwd's last git.repos: fs.search reuses them so both share one cache key (one scan per 10 s). */
  const lastOpen = new Map<string, string[]>();
  const reposOf = (cwd: string, open: string[], fresh = false) => {
    const settings = appSettings.get().git;
    const key = [cwd, JSON.stringify(settings), [...open].sort().join("\0")].join("\0");
    return reposCache.get(key, () => listRepos(cwd, { settings, openFiles: open, refused, allowed: (p) => inRoots(real(p) ?? p) }), fresh);
  };
  const broadcast = (m: ServerMessage) => {
    if (m.type === "sessions.changed" || m.type === "settings_changed") (reposCache.clear(), clearSearchCache());
    connections.forEach((ws) => send(ws, m));
  };
  // ponytail: side sessions are not counted; a restart ends their running turns too.
  const updater: Updater | undefined =
    opts.update && createUpdater({ ...opts.update, busy: () => ({ sessions: [...sessions.values()].filter((s) => s.working()).length, terminals: terminals.count() }), broadcast });
  updater?.start();
  const config = createConfig({ query: opts.query, cli: opts.cli, holdMs: opts.configHoldMs, pollMs: opts.configPollMs, onChanged: (kind, cwd) => (commandCache.clear(), broadcast({ type: "config.changed", kind, cwd })) });
  const plugins = createPlugins({
    cli: opts.cli ?? runCli,
    // Plugins are user- or project-wide: every live query reloads, as the extension reloads every open session.
    reload: async () => {
      const live = [...sessions.values()].filter((s) => s.live());
      const results = await Promise.allSettled(live.map((s) => timed(s.reloadPlugins())));
      const failed = live.filter((s, i) => results[i]!.status === "rejected" && (console.error(`session ${s.id}: reloadPlugins failed:`, (results[i] as PromiseRejectedResult).reason), true)).map((s) => s.id);
      const errorCount = results.reduce((n, r) => n + (r.status === "fulfilled" ? (r.value ?? 0) : 0), 0);
      // A session counts as reloaded only when reloadPlugins() resolved to a number (OpenCode and a Claude session without a live query resolve undefined).
      const reloaded = results.filter((r) => r.status === "fulfilled" && r.value !== undefined).length;
      return { reloaded, failed, errorCount };
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
  const addons = opts.addonsDir ? createAddons({ dir: opts.addonsDir, file: join(opts.addonsDir, "addons.json"), onChanged: () => broadcast({ type: "config.changed", kind: "addons", cwd: "" }) }) : undefined;
  const root = resolve(opts.webRoot);
  // Model list cached until the Claude login or account changes (claudeLoginChanged).
  let models: ReturnType<typeof listModels> | undefined;
  // Sync copy for SessionInfo.permissionModes: every path that builds a SessionInfo awaits modelList() first.
  let known: ModelInfo[] = [];
  const modelList = () =>
    (models ??= listModels(opts.query).then((l) => (known = l))).catch((e) => {
      models = undefined;
      throw e;
    });
  /** The Claude login or account changed: models, plan usage and live CLIs are read again. */
  const claudeLoginChanged = () => {
    models = undefined;
    known = [];
    for (const s of sessions.values()) if (!s.releaseQuery()) s.staleLogin = true;
    void plan.reset();
    broadcast({ type: "config.changed", kind: "models", cwd: "" });
  };
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

  /** A live session's cwd or a worktree being removed is this path or below it: the tree may not delete or rename it (GH-360). */
  const fsOps: FsOpsContext = {
    allowed,
    refused,
    missingInRoots: (p) => missingInRoots(p),
    roots,
    busy: (t) => {
      const under = (cwd: string) => {
        const rel = relative(t, real(cwd) ?? cwd);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      };
      return [...sessions.values()].some((s) => under(s.cwd)) || [...removing].some(under) || terminals.any(under);
    },
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
    const entry = { stamp, list: listWorktrees(cwd, (p) => inRoots(real(p) ?? p)).finally(() => sp.end()) };
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
    if (!read) statusReads.set(cwd, (read = gitStatus(cwd, { allowed: (p) => inRoots(real(p) ?? p), ignoreSubmodules: appSettings.get().git.ignoreSubmodules }).finally(() => statusReads.delete(cwd))));
    return read;
  };

  /** New worktree of `cwd`'s repository (roots enforced); other clients refresh their list. */
  const createIn = async (cwd: string, o: Pick<CreateWorktreeOptions, "name" | "branch" | "base" | "checkout" | "onCreated"> = {}) => {
    // The new path is no project: a session created in it (worker_start) must not add it.
    const r = await createWorktree(cwd, { ...o, allowed: (p) => inRoots(real(p) ?? p), claudeDir, onCreated: (r) => { worktreePaths.add(r.path); return o.onCreated?.(r); } });
    markRepoStale(cwd);
    broadcast({ type: "sessions.changed" });
    return r;
  };
  /** Network git calls (fetch) of Clean up: at most 2 at a time, apart from the local git slot (a fetch may run for minutes). */
  const netSlot = limiter(2);
  /** Worktrees being removed: no session or terminal may start in them meanwhile (`worktree_removing`). */
  const removing = new Set<string>();
  const inDir = (cwd: string, p: string) => cwd === p || cwd.startsWith(p.endsWith(sep) ? p : p + sep);
  const isRemoving = (cwd: string) => [...removing].some((p) => inDir(cwd, p));
  /** An added project's worktrees with real paths, `outsideRoots` marked; undefined for a non-git project or a subfolder of a repository (listed as a non-git project). */
  const projectWorktrees = async (cwd: string): Promise<Worktree[] | undefined> => {
    const found = (await worktreesOf(cwd))?.map((w) => ({ ...w, path: real(w.path) ?? w.path }));
    if (!found?.some((w) => w.path === (real(cwd) ?? cwd))) return undefined;
    return found.map((w) => ({ ...(inRoots(w.path) ? w : { ...w, outsideRoots: true }), ...(isRemoving(w.path) && { removing: true as const }) }));
  };
  /** Refused while a session in it runs or needs input; idle live sessions and its terminals close first (transcripts stay). */
  const removeIn = async (cwd: string, path: string, o: { expectSafe?: boolean; expect?: { uncommitted: number; ahead: number; ignored?: number }; deleteBranch?: boolean }) => {
    const marked: string[] = [];
    let announced = false;
    // Early block for a worktree this app made, so no session slips in during git's own checks; the lock's mark below covers any other path.
    if (path.includes(`${sep}.claude${sep}worktrees${sep}`)) {
      marked.push(path);
      removing.add(path);
    }
    try {
      if (await gitOutside(cwd)) throw new WorktreeError("cwd_not_allowed", "The repository is outside the allowed roots");
      // The mark is set inside the repository lock once the worktree is validated (main, locked and symlink are refused before it), before any further await.
      const result = await removeWorktree(cwd, path, (p) => inRoots(real(p) ?? p), { ...o, mark: (w) => {
        for (const m of new Set([w.path, path])) {
          if (!marked.includes(m)) marked.push(m);
          removing.add(m);
        }
        // Clients show the row as Removing… from the first validated mark on.
        if (!announced) (announced = true), broadcast({ type: "sessions.changed" });
      }, beforeRemove: async () => {
        const live = [...sessions.values()].filter((s) => isRemoving(s.cwd));
        if (live.some((s) => ["running", "needs_input"].includes(s.info().state))) throw new WorktreeError("has_sessions_running", "A session in this worktree is running or needs input: stop it first");
        for (const s of live) {
          sessions.delete(s.id);
          syncRunning();
          queue.drop(s.id);
          touched.delete(s.id);
          await s.close().catch(() => {});
        }
        if (live.some((s) => OPENCODE_ID.test(s.id))) void flushProviders();
        // Its terminals too: a shell running in the folder keeps Windows from deleting it ("Permission denied").
        await terminals.closeIn(isRemoving);
      } });
      return result;
    } finally {
      markRepoStale(cwd);
      for (const m of marked) removing.delete(m);
      // Success and failure alike: every client drops the Removing… flag.
      broadcast({ type: "sessions.changed" });
    }
  };

  // GH-523: "running" as the web's anySessionRunning: a live session that runs or waits for the user; a Side reports its own.
  let localWas = false;
  const syncRunning = () => {
    const local = [...sessions.values()].some((s) => ["running", "needs_input"].includes(s.info().state));
    if (local !== localWas) (localWas = local), opts.onRunning?.(local);
    opts.keepAwake?.update(appSettings.get().power.keepAwake && (local || !!opts.sides?.anyRunning()));
  };
  opts.keepAwake?.onStatus(() => broadcastSettings());
  opts.sides?.onRunning(syncRunning);
  // GH-518: the last sleep found while a session ran; each new connection gets it once.
  let slept: Slept | undefined;
  const sleepWatch = opts.watchSleep && createSleepWatch({ now: opts.watchSleep.now, running: () => localWas || !!opts.sides?.anyRunning(), onSleep: (s) => ((slept = s), broadcast({ type: "daemon_slept", ...s })) });
  const sleepTimer = sleepWatch && setInterval(sleepWatch.check, opts.watchSleep!.everyMs ?? SLEEP_CHECK_MS);
  sleepTimer?.unref();
  const daemonInfo = () => ({ host: opts.host ?? osHostname(), ...(opts.buildInfo?.version && { version: opts.buildInfo.version }), ...(opts.desktopForcedOff && { desktopForcedOff: true as const }), ...(usesOauthToken(process.env) && { claudeEnvToken: true as const }), ...(opts.keepAwake && { keepAwake: opts.keepAwake.status() }), ...(opts.shortcut && { shortcut: { installed: opts.shortcut.installed() } }), ...(opts.openExternal && { editors: [...[...opts.openExternal.editors().keys()].map((id) => ({ id: id as EditorId | "custom", label: EDITORS[id].label })), ...(appSettings.get().editor.command ? [{ id: "custom" as const, label: editorLabel(appSettings.get().editor) }] : [])] }) });
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
    // Settings › Orchestration › Notifications from workers (GH-387): read per push, so a change applies to the next event.
    quiet: (id) => !appSettings.get().orchestration.workerNotifications && !!settings.get(id)?.coordinatorId,
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

  const queue = createPromptQueue({
    ready: (id) => !!sessions.get(id)?.takesQueued() && !autoContinue.isScheduled(id),
    send: async (id, item) => {
      const s = sessions.get(id);
      if (!s) return { code: "session_not_live", message: `no session ${id}` };
      const err = item.bash ? await runBash(s, item.text) : await sendPrompt(s, item.text, item.images);
      if (!err && !item.bash) autoContinue.cancel(id);
      return err;
    },
    show: (id, items, held) => sessions.get(id)?.setQueue(items, held),
  });

  // ---- GH-622 "I'll be back": Back marks, the brief turn and reminders (docs/spec.md "I'll be back") ----
  /** The brief turn running per session (started by the tag line of its prompt): the mark's part id and the last assistant text so far. */
  const briefs = new Map<string, { partId: string; at: number; text?: string }>();
  /** Changes one mark under the settings file's change() and tells every browser; false when the mark is gone (Done). */
  function editMark(sessionId: string, partId: string, fn: (m: BackMark) => void): boolean {
    let found = false;
    try {
      appSettings.changeMarks((marks) => {
        const m = findMark(marks, sessionId, partId);
        if (!m) return;
        found = true;
        fn(m);
      });
    } catch (err) {
      console.error("saving back marks failed:", err);
    }
    if (found) broadcastSettings();
    return found;
  }
  // `at`: the mark's time when the brief turn started; a mark removed and made again meanwhile is another mark, the old turn's end must not touch it.
  const briefFailed = (sessionId: string, partId: string, why: string, at?: number) =>
    editMark(sessionId, partId, (m) => void (m.at === (at ?? m.at) && ((m.briefState = "failed"), (m.briefError = why.slice(0, 200)))));
  /** The brief of a finished turn replaces the old one; an empty answer is a failure. */
  const briefDone = (sessionId: string, partId: string, text: string | undefined, at: number) => {
    const t = text?.trim().slice(0, BACK_BRIEF_MAX);
    if (!t) return briefFailed(sessionId, partId, "The brief was empty", at);
    editMark(sessionId, partId, (m) => void (m.at === at && ((m.brief = { text: t, at: Date.now() }), delete m.briefState, delete m.briefError)));
  };
  /** Sends the brief turn of a mark now (an idle session) or queues it behind the running turn and the queued items. */
  async function startBrief(s: Session, partId: string, refresh: boolean) {
    const mark = findMark(appSettings.get().back.marks, s.id, partId);
    if (!mark) return;
    const text = briefPrompt(partId, mark.title, refresh);
    // Always through the queue: it sends at once when the session takes a prompt, and it honours a usage-limit pause and a scheduled auto-continue (a direct send would bypass both).
    editMark(s.id, partId, (m) => ((m.briefState = "queued"), delete m.briefError));
    const r = queue.enqueue(s.id, { text, images: [], brief: partId });
    if (typeof r !== "string") return void briefFailed(s.id, partId, r.message);
    // A closed or errored session: the queue shows its pause (the panel says why) instead of a brief that stays queued without a reason.
    queue.setNotLive(s.id, !s.isLive());
  }
  /** Follows a session's events for its brief turn: starts at the tagged prompt, takes the last assistant text, ends at the result. */
  function observeBrief(s: Session, e: { part: { type: string } }) {
    const part = e.part as { type: string; text?: string; streaming?: boolean; isError?: boolean; state?: string };
    const cap = briefs.get(s.id);
    if (part.type === "user_text") {
      const tag = BACK_TAG.exec((part.text ?? "").split("\n")[0] ?? "");
      const partId = tag?.[1];
      // Another prompt (a steer) during the brief turn: its text would become the brief.
      if (!partId && cap) (briefs.delete(s.id), briefFailed(s.id, cap.partId, "Another message arrived during the brief", cap.at));
      if (!partId) return;
      const m = findMark(appSettings.get().back.marks, s.id, partId);
      if (!m || (m.briefState !== "queued" && m.briefState !== "running")) return;
      briefs.set(s.id, { partId, at: m.at });
      if (m.briefState === "queued") editMark(s.id, partId, (x) => (x.briefState = "running"));
    } else if (!cap) return;
    else if (part.type === "assistant_text") cap.text = part.text;
    else if (part.type === "turn_result") {
      briefs.delete(s.id);
      if (part.isError) briefFailed(s.id, cap.partId, "The brief turn failed", cap.at);
      else briefDone(s.id, cap.partId, cap.text, cap.at);
    } else if (part.type === "turn_interrupted") (briefs.delete(s.id), briefFailed(s.id, cap.partId, "The brief turn was stopped", cap.at));
    else if (part.type === "session_state" && (part.state === "error" || part.state === "closed")) (briefs.delete(s.id), briefFailed(s.id, cap.partId, part.state === "error" ? "The session stopped with an error" : "The session closed", cap.at));
  }
  /** A brief item the user deleted from the queue (or Done removed): the mark says so. */
  const briefDropped = (sessionId: string, item: { brief?: string } | undefined) => item?.brief && briefFailed(sessionId, item.brief, "Removed from queue");
  /** Done or a deleted session: the queued brief leaves the queue. A running brief turn goes on; its answer is dropped (the mark is gone). */
  const dropQueuedBrief = (sessionId: string, partId: string) => {
    const item = queue.items(sessionId).find((i) => i.brief === partId);
    if (item) queue.take(sessionId, item.id);
  };
  // A restart ends every queued or running brief (the queue lives in memory): the mark shows the fallback.
  if (!opts.attached) {
    const stuck = Object.entries(appSettings.get().back.marks).flatMap(([id, l]) => l.filter((m) => m.briefState === "queued" || m.briefState === "running").map((m) => [id, m.partId] as const));
    if (stuck.length) {
      try {
        appSettings.changeMarks((marks) => stuck.forEach(([id, p]) => {
          const m = findMark(marks, id, p);
          if (m) (m.briefState = "failed"), (m.briefError = "Interrupted by a restart");
        }));
      } catch (err) {
        console.error("saving back marks failed:", err);
      }
    }
  }
  const clock = opts.backReminders?.now ?? Date.now;
  const hhmm = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const nextLine = (m: BackMark) => /^Next:\s*(.+)$/im.exec(m.brief?.text ?? "")?.[1]?.trim();
  /** remindedAt first (a crash then loses the notification, never sends it twice), then one push (grouped for several) for the sessions no page covers with an in-app card. */
  async function fireBack(items: Due[]) {
    const now = clock();
    const fired = new Set<string>();
    appSettings.changeMarks((marks) => {
      for (const { sessionId, mark } of items) {
        const m = findMark(marks, sessionId, mark.partId);
        if (m && m.remindedAt === undefined) (m.remindedAt = now), fired.add(`${sessionId}\0${m.partId}`);
      }
    });
    broadcastSettings();
    const send: Due[] = [];
    for (const it of items) {
      if (!fired.has(`${it.sessionId}\0${it.mark.partId}`)) continue;
      const info = await history.getSessionInfo(it.sessionId).catch(() => undefined);
      if (info?.tag === ARCHIVED_TAG) continue;
      // The quiet rule: a page in front shows the in-app card (one event, one channel).
      if ([...covered.values()].some((c) => c.has(it.sessionId)) || [...focused.values()].includes(it.sessionId)) continue;
      send.push(it);
    }
    if (!send.length || !opts.push) return;
    const late = (m: BackMark) => (now - (m.remindAt ?? now) > 2 * BACK_TICK_MS ? ` (was due ${hhmm(m.remindAt!)})` : "");
    if (send.length === 1) {
      const { sessionId, mark } = send[0]!;
      await opts.push.send({ sessionId, title: `Come back: ${await pushTitleOf(sessionId)}`, body: `${mark.note || nextLine(mark) || mark.title}${late(mark)}`, tag: `back-${mark.partId}`, backPart: mark.partId });
      return;
    }
    const titles = [...new Set(await Promise.all(send.map((i) => pushTitleOf(i.sessionId))))];
    await opts.push.send({ sessionId: send[0]!.sessionId, title: `${send.length} replies to come back to`, body: `${titles.slice(0, 2).join(", ")}${titles.length > 2 ? ", …" : ""}`, tag: "back" });
  }
  const backReminders = opts.attached ? undefined : createBackReminders({ marks: () => appSettings.get().back.marks, fire: fireBack, now: clock, everyMs: opts.backReminders?.everyMs });

  function track(s: Session) {
    sessions.set(s.id, s);
    s.subscribe(Infinity, (e) => {
      const t = e.part.type;
      if (t === "session_cleared") queue.move(s.id, (e.part as { sessionId: string }).sessionId);
      else if (t === "session_state" || t === "external_turn" || t === "bash") {
        if (t === "session_state") (queue.setNotLive(s.id, !s.isLive()), syncRunning());
        queue.kick(s.id);
        // A turn may have changed files (an untracked file is in no fingerprint): its worktree is checked again.
        if (t === "session_state" && (e.part as { state?: string }).state === "idle") (markWorktreeStale(s.cwd), OPENCODE_ID.test(s.id) && void flushProviders());
      }
    });
    s.subscribe(Infinity, notifier.observe);
    s.subscribe(Infinity, (e) => observeBrief(s, e));
    s.subscribe(Infinity, (e) => orchestration.observe(s, e));
    s.subscribe(Infinity, () => touched.set(s.id, Date.now()));
    return s;
  }

  /** session.prompt's checks and send; the reason when the prompt is not taken. `images`: checked with imageBlock(). */
  async function sendPrompt(s: Session, text: string, images: string[] = [], stillWanted?: () => boolean, out?: PromptResult): Promise<{ code: string; message: string } | undefined> {
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
      if (s.prompt(text, images) === undefined && out) out.local = true;
    } catch (err) {
      return { code: "prompt_failed", message: (err as Error).message };
    }
  }

  /** session.bash's checks and run; the reason when the command does not run now. `session_busy`/`external_turn`: it can be queued. */
  async function runBash(s: Session, command: string): Promise<{ code: string; message: string } | undefined> {
    if (!allowed(s.cwd)) return { code: "cwd_not_allowed", message: `outside the allowlisted roots: ${s.cwd}` };
    const notLive = () => ({ code: "session_not_live", message: `session ${s.id} is ${s.info().state}` });
    if (!s.isLive()) return notLive();
    if (s.info().state === "idle") await s.sync();
    if (!s.isLive()) return notLive();
    if (s.externalTurnRunning()) return { code: "external_turn", message: "A terminal CLI turn is running in this session" };
    if (!s.takesQueued()) return { code: "session_busy", message: "A shell command cannot run during a turn; it runs when the turn ends" };
    try {
      s.bash(command);
    } catch (e) {
      return { code: "bash_failed", message: (e as Error).message };
    }
    autoContinue.cancel(s.id);
  }

  const orchestration = createOrchestration({
    links: settings,
    held: (id) => !!holds.get(id),
    settings: () => appSettings.get().orchestration,
    sessions,
    find: findSession,
    create: async (cwd, initial, engine) => {
      if (isRemoving(cwd)) throw new Error("This worktree is being removed");
      const s = engine === "opencode" ? await createOpenCodeSession(cwd, { model: initial.model, permissionMode: initial.permissionMode ?? "default", effort: initial.effort }) : track(new Session(cwd, sessionOpts(initial)));
      if (!s) throw new Error("This worktree is being removed");
      addProject(cwd);
      // worker_start writes the link right after this call (no await): the refresh lists the worker with it.
      queueMicrotask(() => broadcast({ type: "sessions.changed" }));
      return s;
    },
    prompt: async (s, text, stillWanted) => (autoContinue.cancel(s.id), (await sendPrompt(s, text, [], stillWanted))?.message),
    allowed: (path) => allowed(path),
    sideOf: (path) => {
      const id = opts.sides?.pathSide(path);
      return id && id !== LOCAL_SIDE ? opts.sides!.list().find((s) => s.id === id)?.label : undefined;
    },
    projects: () => projects.list([]).filter((cwd) => allowed(cwd)),
    worktrees: (cwd) => projectWorktrees(cwd),
    removing: (path) => isRemoving(path),
    createWorktree: (repo, o) => createIn(repo, o),
    port: () => (http.address() as AddressInfo | null)?.port,
    heldElsewhere: (id) => cliTurnRunning(claudeDir, id, true),
    openCodeAgents: async (cwd) => primaryAgents(await openCodeEngine.agents(cwd)).map((a) => a.name),
    agents: (cwd) => queuedQuery((q) => q.supportedAgents(), opts.query, { cwd, persistSession: false }).then((l) => l.map((a) => a.name)),
    models: () => known,
    openCodeModels: () => openCodeModels(openCodeEngine),
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
  // A running session writes its transcript every turn: with the same file set, only the changed files are read again
  // (getSessionInfo, two 64 KB reads each), not all of them; a file added or removed scans all again.
  type Scanned = Awaited<ReturnType<typeof listSessions>>;
  let scan: ReturnType<typeof listSessions> | undefined;
  let nextScan: ReturnType<typeof listSessions> | undefined;
  let lastScan: { stamp: Map<string, string>; result: Scanned } | undefined;
  const listCache = opts.listCache ?? !opts.history?.listSessions;
  /** `last.result` with the entries of the `changed` files read again; undefined when only a full scan gives the same list. */
  async function patchScan(last: Scanned, changed: string[], stamp: Map<string, string>): Promise<Scanned | undefined> {
    const idOf = (file: string) => file.slice(file.lastIndexOf("/") + 1, -".jsonl".length);
    const count = new Map<string, number>();
    for (const f of stamp.keys()) count.set(idOf(f), (count.get(idOf(f)) ?? 0) + 1);
    const ids = changed.map(idOf);
    // A session in two project folders, or one the SDK left out of the list (filtered): its entry needs the full scan's rules.
    if (ids.some((id) => count.get(id) !== 1 || last.filter((t) => t.sessionId === id).length !== 1)) return undefined;
    const infos = await mapLimit(ids, 8, (id) => history.getSessionInfo(id).catch(() => undefined));
    if (infos.some((i, n) => i?.sessionId !== ids[n])) return undefined;
    const fresh = new Map(infos.map((i) => [i!.sessionId, i!]));
    return last.map((t) => fresh.get(t.sessionId) ?? t).sort((a, b) => b.lastModified - a.lastModified);
  }
  function transcripts(): ReturnType<typeof listSessions> {
    if (!scan) {
      // Taken before the scan: a file written during it changes the next stamp.
      return (scan = (async () => {
        const stamp = listCache ? await transcriptStamp(projectsDir) : undefined;
        const last = lastScan;
        if (stamp && last && stamp.size === last.stamp.size && [...stamp.keys()].every((f) => last.stamp.has(f))) {
          const changed = [...stamp].filter(([f, v]) => last.stamp.get(f) !== v).map(([f]) => f);
          const sp = perfMon.span("session.scan");
          const result = changed.length ? await patchScan(last.result, changed, stamp) : last.result;
          sp.end();
          if (result) return (lastScan = { stamp, result }).result;
        }
        const sp = perfMon.span("session.scanAll");
        const result = await history.listSessions();
        sp.end();
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
    if (OPENCODE_ID.test(s.id)) return openCodeMeta.get(s.id)?.title ?? "New session";
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
    for (const id of openCodeMeta.keys()) ids.add(id);
    for (const id of deleting) ids.delete(id);
    return [...ids];
  }

  /** The error text of the last failed OpenCode listing: logged once per change, not on every list. */
  let openCodeListError: string | undefined;
  /**
   * OpenCode sessions of `cwds` (docs/spec.md "OpenCode engine"). Only when the server runs or the last created session was OpenCode's, so a Claude-only
   * user never starts it. shortcut: a user whose last engine is Claude sees OpenCode-TUI sessions only after the server started in this daemon run.
   * `ran`: the listing answered for every folder (an entry missing from it is gone); a failing OpenCode lists none and never fails the Claude list.
   */
  async function listOpenCode(cwds: string[], linked: Map<string, Partial<SessionSettings>>, links: (id: string) => object) {
    const none = () => ({ items: [] as SessionListItem[], ids: new Set<string>(), ran: false });
    if (!openCode.running() && appSettings.get().sessions.engine !== "opencode") return none();
    // Not answering within the wait: no OpenCode items and no prune (`ran` false); the start goes on and the next list has them. The late result is dropped.
    // Before OpenCode's first answer the list does not wait: projects and Claude sessions show at once on page load.
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const late = new Promise<ReturnType<typeof none>>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        const text = "OpenCode did not answer the session list in time";
        if (openCodeAnswered && text !== openCodeListError) console.error(`listing OpenCode sessions failed: ${text}`);
        openCodeListError = text;
        resolve(none());
      }, openCodeAnswered ? (opts.opencode?.listWaitMs ?? OPENCODE_LIST_WAIT_MS) : 0);
    });
    try {
      const read = readOpenCodeList(cwds, linked, links);
      const r = await Promise.race([read, late]);
      // The list that did not wait: clients ask again once OpenCode answered.
      // No pile-up: one read per folder is in flight and it has at most one push. A folder that stays slow for several reads can push once per read.
      if (!r.ran && timedOut && !lateRefresh) lateRefresh = read.then((x) => x.ran && broadcast({ type: "sessions.changed" })).finally(() => (lateRefresh = undefined));
      return r;
    } finally {
      clearTimeout(timer);
    }
  }
  /** OpenCode answered a session list once in this run. */
  let openCodeAnswered = false;
  /** The late push of a list that did not wait is pending. */
  let lateRefresh: Promise<unknown> | undefined;
  /** The `GET /session` of a folder in flight: concurrent lists, and a list that starts while an earlier one still waits, share it (the requests are never aborted, so they would pile up on a slow OpenCode). */
  const sessionReads = new Map<string, Promise<OpenCodeSessionRow[]>>();
  const readSessions = (cwd: string) => {
    let p = sessionReads.get(cwd);
    if (!p) sessionReads.set(cwd, (p = openCode.request<OpenCodeSessionRow[]>("/session?roots=true", { directory: cwd, timeoutMs: 0 }).finally(() => sessionReads.delete(cwd))));
    return p;
  };
  async function readOpenCodeList(cwds: string[], linked: Map<string, Partial<SessionSettings>>, links: (id: string) => object) {
    const out = { items: [] as SessionListItem[], ids: new Set<string>(), ran: false };
    try {
      // No timeout: a cold OpenCode answers after its folder's first load (> 3 s). `list()` waits `listWaitMs` for it; the late answer is pushed as `sessions.changed` (listOpenCode).
      const rows = await mapLimit(cwds, 4, async (cwd) => [cwd, await readSessions(cwd)] as const);
      openCodeListError = undefined;
      openCodeAnswered = true;
      out.ran = true;
      for (const [cwd, list] of rows)
        for (const row of list) {
          const loaded = sessions.get(row.id);
          const saved = linked.get(row.id);
          const savedMode = OPENCODE_MODES.find((m) => m === saved?.permissionMode) ?? "default";
          // Plan is the plan agent (GH-684): a saved plan mode lists as default + agent plan.
          const mode = savedMode === "plan" ? "default" : savedMode;
          const agent = savedMode === "plan" ? "plan" : (saved?.agent ?? "build");
          const info = loaded?.info() ?? { id: row.id, cwd, state: "closed" as const, model: saved?.model ?? "default", permissionMode: mode, agent, effort: saved?.effort ?? "default", permissionModes: openCodeEngine.permissionModes({ allowBypass: opts.allowBypass }), capabilities: OPENCODE_CAPABILITIES, engine: "opencode" as const };
          openCodeMeta.set(row.id, { cwd, title: row.title });
          out.ids.add(row.id);
          out.items.push({ ...info, id: row.id, cwd, title: row.title, lastActivity: row.time.updated, archived: !!row.time.archived, transcript: true, live: false, ...links(row.id) });
        }
    } catch (err) {
      const text = (err as Error).message;
      if (text !== openCodeListError) console.error("listing OpenCode sessions failed:", text);
      openCodeListError = text;
    }
    return out;
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
    const known = new Set(all.map((t) => t.sessionId));
    // One realpath per distinct cwd per list, not two per transcript: each is a blocking call (slow on Windows), and hundreds of
    // transcripts share a few dozen cwds.
    const canonical = new Map<string, string | undefined>();
    const allowedCwd = (cwd: string) => (canonical.has(cwd) ? canonical.get(cwd) : (canonical.set(cwd, allowed(cwd)), canonical.get(cwd)));
    const lastAt = new Map(await mapLimit(all, 8, async (t) => [t.sessionId, t.cwd && allowedCwd(t.cwd) ? await lastMessageAt(projectsDir, t.cwd, t.sessionId, t) : undefined] as const));
    for (const t of all) {
      // An Aside is not a session of the list until Keep as session.
      if (!t.cwd || !allowedCwd(t.cwd) || linked.get(t.sessionId)?.ownerId) continue;
      const loaded = sessions.get(t.sessionId);
      const live = loaded?.info() ?? { state: "closed" as const, model: "default", permissionMode: "default" as const, effort: "default" as const, permissionModes: [], capabilities: ALL_CAPABILITIES, engine: "claude" as const };
      const title = CLEARED.test(t.summary) ? (sessions.get(t.sessionId)?.untitled() ? "New session" : await clearedTitle(t.sessionId, t.cwd, t)) : t.summary;
      if (sessions.has(t.sessionId)) hadTranscript.add(t.sessionId);
      items.set(t.sessionId, { ...live, id: t.sessionId, cwd: (process.platform === "win32" && allowedCwd(t.cwd)) || t.cwd, title, lastActivity: lastAt.get(t.sessionId) ?? t.lastModified, archived: t.tag === ARCHIVED_TAG, transcript: true, ...(!loaded?.live() && { live: false as const }), ...links(t.sessionId) });
    }
    // A loaded session whose transcript existed and is gone, with no CLI process: deleted outside the daemon (docs/spec.md "Sessions").
    const gone = new Set<string>();
    for (const s of [...sessions.values()])
      if (hadTranscript.has(s.id) && !known.has(s.id) && !s.live() && !linked.get(s.id)?.ownerId && !deleting.has(s.id) && !(await history.getSessionInfo(s.id).catch(() => undefined)) && (await dropGone(s.id))) gone.add(s.id);
    // Sessions whose transcript was never seen in this run (no prompt sent, or its first prompt failed before the CLI wrote one).
    for (const s of sessions.values())
      if (!gone.has(s.id) && !items.has(s.id) && !linked.get(s.id)?.ownerId) items.set(s.id, { ...s.info(), title: "New session", lastActivity: s.createdAt, archived: false, transcript: false, ...(!s.live() && { live: false as const }), ...links(s.id) });
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
        const l = await projectWorktrees(cwd);
        if (l) worktrees[cwd] = l;
      }),
    );
    worktreePaths = new Set(Object.values(worktrees).flatMap((l) => l.filter((w) => !w.outsideRoots).map((w) => w.path)));
    // Sessions of a project's worktrees show under the project (outside the roots there are none: `listed` has only allowed cwds).
    const shown = new Set([...open, ...worktreePaths]);
    const oc = await listOpenCode([...shown], linked, links);
    const byId = new Map(listed.map((s) => [s.id, s]));
    for (const s of oc.items) byId.set(s.id, s);
    const all2 = [...byId.values()];
    // Entries of sessions deleted outside this daemon (CLI, file removed): no transcript and not live (session-settings.ts prune).
    // An OpenCode entry stays unless this list asked OpenCode and it did not return the session.
    saveSettings(() => settings.prune((id) => known.has(id) || sessions.has(id) || (OPENCODE_ID.test(id) && !(oc.ran && !oc.ids.has(id)))));
    const topIds = new Set(all2.filter((s) => shown.has(trim(s.cwd))).map((s) => s.id));
    return {
      engines: [
        { engine: "claude", capabilities: ALL_CAPABILITIES, permissionModes: permissionModesFor({ allowBypass: opts.allowBypass, supportsAuto: supportsAuto("default") }) },
        { engine: "opencode", capabilities: OPENCODE_CAPABILITIES, permissionModes: openCodeEngine.permissionModes({ allowBypass: opts.allowBypass }) },
      ],
      projects: open,
      recentProjects: projects.recent(listed).filter((r) => !shown.has(r.cwd)),
      worktrees,
      // A worker of a listed coordinator shows under it, also when the user removed the worker's project.
      sessions: all2.filter((s) => topIds.has(s.id) || (s.coordinatorId && topIds.has(s.coordinatorId))).sort((a, b) => b.lastActivity - a.lastActivity),
      permissionModes: permissionModesFor({ allowBypass: opts.allowBypass, supportsAuto: supportsAuto("default") }),
    };
  }

  /** `permissions.defaultMode` of the Claude settings for `cwd`, else Settings `sessions.defaultMode`, when this daemon offers it for `model` (bypass needs the daemon flag, auto a model with support). */
  const defaultModeFor = (cwd: string, model = "default") => {
    const mode = readDefaultMode(claudeDir, cwd) ?? appSettings.get().sessions.defaultMode;
    return permissionModesFor({ allowBypass: opts.allowBypass, supportsAuto: supportsAuto(model) }).find((m) => m === mode);
  };

  /** An OpenCode session rebuilt from its stored messages. Its folder: the one listed or created, else asked of OpenCode. */
  async function restoreOpenCode(id: string): Promise<Session | undefined> {
    const known = openCodeMeta.get(id);
    // shortcut: a session of a folder not seen yet is found only when OpenCode answers `GET /session/{id}` without a directory (unverified against a real server).
    const row = await openCode.request<OpenCodeSessionRow>(`/session/${id}`, { directory: known?.cwd, timeoutMs: 0 }).catch(() => undefined);
    const cwd = row && allowed(known?.cwd ?? row.directory);
    if (!row || !cwd || isRemoving(cwd)) return undefined;
    const history = await loadOpenCodeHistory(openCode, id, cwd);
    openCodeMeta.set(id, { cwd, title: row.title });
    const saved = settings.get(id);
    const permissionMode = OPENCODE_MODES.includes(saved?.permissionMode as never) ? (saved!.permissionMode as SessionSettings["permissionMode"]) : undefined;
    const effort = EFFORTS.includes(saved?.effort as never) ? (saved!.effort as SessionSettings["effort"]) : undefined;
    const model = isModel(saved?.model) ? saved.model : undefined;
    return track(Session.restore(id, cwd, history as never, openCodeSessionOpts({ model, permissionMode, effort })));
  }

  /** Transcript restores run a few at a time: hundreds at once (a page reconnecting after a restart) starve the event loop for every other request. */
  const restoreQueue: { id: string; background: boolean; start: () => void }[] = [];
  let restoreActive = 0;
  function restoreSlot<T>(id: string, background: boolean, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      restoreQueue.push({
        id,
        background,
        start: () => {
          restoreActive++;
          fn().then(resolve, reject).finally(() => (restoreActive--, pumpRestores()));
        },
      });
      pumpRestores();
    });
  }
  function pumpRestores() {
    while (restoreActive < MAX_RESTORES && restoreQueue.length) {
      const i = restoreQueue.findIndex((q) => !q.background);
      restoreQueue.splice(i < 0 ? 0 : i, 1)[0]!.start();
    }
  }

  /** A session of this daemon run, or one rebuilt from its SDK transcript (ADR 0001). Concurrent calls share one restore. */
  /** `background`: a follow without a hold; its restore waits behind foreground ones. */
  function findSession(id: string, background = false): Promise<Session | undefined> {
    // Its transcript still exists until the delete ends; a restore now would bring the session back.
    if (deleting.has(id)) return Promise.resolve(undefined);
    const live = sessions.get(id);
    if (live) return Promise.resolve(live);
    // The ID becomes a transcript file name or a request path; only a UUID may reach the SDK, only `ses_…` OpenCode.
    if (typeof id !== "string" || (!UUID.test(id) && !OPENCODE_ID.test(id))) return Promise.resolve(undefined);
    let p = restoring.get(id);
    // A foreground ask for a restore that waits in the queue moves it ahead of the background ones.
    if (p && !background) for (const q of restoreQueue) if (q.id === id) q.background = false;
    if (!p && OPENCODE_ID.test(id)) {
      p = restoreOpenCode(id)
        .catch((err) => void console.error(`restoring session ${id} failed:`, err))
        .finally(() => restoring.delete(id));
      restoring.set(id, p);
    }
    if (!p) {
      p = restoreSlot(id, background, async () => {
        const info = await history.getSessionInfo(id);
        if (!info?.cwd || !allowed(info.cwd)) return undefined;
        transcriptCwds.set(id, info.cwd);
        hadTranscript.add(id);
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
      })
        .catch((err) => void console.error(`restoring session ${id} failed:`, err))
        .finally(() => restoring.delete(id));
      restoring.set(id, p);
    }
    return p;
  }

  /** Working directory and transcript of a listed session (live or inside the roots); undefined when unknown. */
  async function locate(id: string) {
    const live = sessions.get(id);
    // OpenCode: the folder it was listed, created or opened in; its store is OpenCode's.
    if (typeof id === "string" && OPENCODE_ID.test(id)) {
      const cwd = live?.cwd ?? openCodeMeta.get(id)?.cwd;
      return cwd && allowed(cwd) ? { cwd, live, transcript: false } : undefined;
    }
    if (!live && (typeof id !== "string" || !UUID.test(id))) return undefined;
    const info = await history.getSessionInfo(id).catch(() => undefined);
    const cwd = live?.cwd ?? (info?.cwd && allowed(info.cwd));
    return cwd ? { cwd, live, transcript: !!info } : undefined;
  }

  /** A live session whose CLI reads the folder of `id` (itself or, after /clear, its parent's folder). */
  const folderInUse = (id: string) => [...sessions.values()].some((s) => s.uploadOwner === id);

  /** session.delete, also the web app's Remove and worker_remove: the error to report, or undefined once the session is gone. */
  async function deleteSessionById(id: string, force = false): Promise<{ code: string; message: string } | undefined> {
    // A restore already in flight would put the session back after the delete; let it finish, then close it below.
    for (const q of restoreQueue) if (q.id === id) q.background = false;
    await restoring.get(id);
    const at = await locate(id);
    if (!at) return { code: "unknown_session", message: `no session ${id}` };
    const state = at.live?.info().state;
    // `force` (an Aside popup closing): Session.close() ends the CLI and abandons its pending requests.
    if (!force && (state === "running" || state === "needs_input")) return { code: "session_running", message: "stop the session before deleting it" };
    // The CLI exits first: it writes session metadata on exit, which would recreate the transcript. A failed delete keeps the transcript.
    autoContinue.cancel(id);
    queue.drop(id);
    deleting.add(id);
    sessions.delete(id);
    syncRunning();
    orchestration.forget(id);
    touched.delete(id);
    try {
      await at.live?.close();
      if (OPENCODE_ID.test(id)) await openCode.request(`/session/${id}`, { method: "DELETE", directory: at.cwd });
      else if (at.transcript) await history.deleteSession(id, { dir: at.cwd });
    } catch (e) {
      return { code: "delete_failed", message: (e as Error).message };
    } finally {
      deleting.delete(id);
      // A model refresh held back by this running OpenCode session no longer waits for it.
      if (OPENCODE_ID.test(id)) void flushProviders();
    }
    caches.delete(id);
    openCodeMeta.delete(id);
    // The folder of a session whose CLI a /clear heir still uses stays with the heir.
    if (!folderInUse(id)) await uploads.remove(id).catch((e) => console.error(`session ${id}: removing its uploads failed:`, e));
    if (settings.get(id)) saveSettings(() => settings.delete([id]));
    briefs.delete(id);
    if (appSettings.get().back.marks[id]) {
      try {
        appSettings.changeMarks((marks) => void delete marks[id]);
        broadcastSettings();
      } catch (e) {
        console.error(`session ${id}: removing its back marks failed:`, e);
      }
    }
    broadcast({ type: "sessions.changed", deleted: id });
    return undefined;
  }

  /**
   * Unloads a session whose transcript was deleted outside the daemon. Memory only: never `deleteSessionById` (its transcript lookup
   * could delete a file that reappeared). Uploads, back marks, briefs and the sessions.json entry stay, as for any session deleted
   * outside the daemon (the settings prune handles the entry). False when the session started again or is being deleted meanwhile.
   */
  async function dropGone(id: string): Promise<boolean> {
    const s = sessions.get(id);
    if (!s || s.live() || deleting.has(id) || settings.get(id)?.ownerId) return false;
    sessions.delete(id);
    syncRunning();
    autoContinue.cancel(id);
    queue.drop(id);
    orchestration.forget(id);
    touched.delete(id);
    caches.delete(id);
    stamps.delete(id);
    transcriptCwds.delete(id);
    hadTranscript.delete(id);
    await s.close().catch((e) => console.error(`session ${id}: closing after its transcript was deleted failed:`, e));
    broadcast({ type: "sessions.changed", deleted: id });
    return true;
  }

  /** An Aside's owner (link not dropped by Keep as session). */
  const asideOf = (id: string) => settings.get(id)?.ownerId;

  /**
   * Asides never kept, left by a closed browser or a restart of this daemon (same port) or by a daemon of another port that no
   * longer listens: thrown away (docs/spec.md "Aside"). foreignOnly: only links of other ports (own-port links race with aside.open).
   */
  let cleaningAsides = false;
  async function cleanupAsides({ foreignOnly = false } = {}) {
    // No port of its own (a --side daemon): it cannot tell its links from the hub's, whose live Asides it would delete.
    const port = (http.address() as AddressInfo | null)?.port;
    if (cleaningAsides || port === undefined) return;
    cleaningAsides = true;
    try {
      for (const [id] of [...settings.entries()]) {
        const l = settings.get(id);
        if (!l?.ownerId || sessions.has(id)) continue;
        const foreign = l.port !== undefined && l.port !== port;
        if (foreignOnly && !foreign) continue;
        // Probed right before the delete, on the link as it is now: a daemon may have started on that port since the pass began.
        if (foreign && (await portListening(l.port!))) continue;
        if (settings.get(id)?.port !== l.port || sessions.has(id)) continue;
        try {
          const err = await deleteSessionById(id, true);
          if (err?.code === "unknown_session") saveSettings(() => settings.delete([id]));
          else if (err) console.error(`aside ${id}: cleanup failed: ${err.message}`);
        } catch (e) {
          console.error(`aside ${id}: cleanup failed:`, e);
        }
      }
    } finally {
      cleaningAsides = false;
    }
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
  const media = new Map<string, { src: { kind: "file"; path: string } | { kind: "artifact"; named: string; path: string; page: string; confine: string[]; assets: Map<string, { named: string; path: string; type: string }> } | { kind: "bytes"; read: MediaRead; mime: string; name: string }; ws: Conn; used: number; live?: Set<ServerResponse> }>();
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
  /** Host, Origin and Sec-Fetch-Site of a /media or /artifact request: the own host names, own origin, same-origin or direct navigation only. */
  const hostOk = (req: IncomingMessage) => {
    try {
      return hostnames.has(new URL("http://" + req.headers.host).hostname);
    } catch {
      return false;
    }
  };
  const requestOk = (req: IncomingMessage) => {
    const site = req.headers["sec-fetch-site"];
    return hostOk(req) && !(req.headers.origin && !isOwnOrigin(req, hostnames)) && !(site && site !== "same-origin" && site !== "none");
  };
  const privateDir = real(opts.privateDir ?? configDir());
  const within = (path: string, dir: string) => {
    const rel = relative(dir, path);
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
  };
  /** The uploads folder (docs/spec.md "Uploads") may lie inside the config dir (POSIX): it is exempt from the config-dir deny, and nothing else in the config dir is. */
  /** This session's scratchpad as the CLI names it (scratchpadOf), when that folder exists as a plain directory inside <tmp>/claude: its real path. Anything else (the CLI changed its convention, a link) gives undefined: the preview then confines to the cwd only, never wider. */
  const scratchpadRoot = (cwd: string, sessionId: string) => {
    const d = scratchpadOf(cwd, sessionId, tmpdir());
    if (!d) return undefined;
    try {
      const l = lstatSync(d);
      if (l.isSymbolicLink() || !l.isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    const r = real(d);
    const base = real(join(tmpdir(), "claude"));
    return r && base && within(r, base) ? r : undefined;
  };
  const uploadsReal = (() => {
    const u = real(uploads.parent);
    return u && privateDir && u !== privateDir && within(u, privateDir) ? u : undefined;
  })();
  /** The canonical file of a named Artifact page, or why not (GH-175): no UNC/device path, the named file itself no symlink, a regular file within the cap. */
  const checkArtifact = (named: string, kind: "page" | "asset" = "page", confine: string[] = []): { path: string; size: number; mtime: number } | { code: string; message: string } => {
    if (refused(named)) return { code: "path_not_allowed", message: `refused path: ${named}` };
    let l;
    try {
      l = lstatSync(named);
    } catch {
      return { code: "not_found", message: `file is gone: ${named}` };
    }
    if (l.isSymbolicLink()) return { code: "path_not_allowed", message: `a symlink: ${named}` };
    if (!l.isFile()) return { code: "not_a_file", message: `not a file: ${named}` };
    if (kind === "asset" && l.nlink > 1) return { code: "path_not_allowed", message: `hard-linked file: ${named}` };
    const path = real(named);
    if (!path || refused(path)) return { code: "path_not_allowed", message: `refused path: ${named}` };
    if (privateDir && within(path, privateDir) && !(uploadsReal && within(path, uploadsReal))) return { code: "path_not_allowed", message: `refused path: ${named}` };
    // A supporting file must lie in the session's cwd or the page's directory (GH-335): a file the model names elsewhere is never served.
    if (kind === "asset" && !confine.some((d) => within(path, d))) return { code: "path_not_allowed", message: `outside the project and the page's directory: ${named}` };
    if (kind === "page" && !/\.html?$/i.test(path)) return { code: "unsupported_type", message: `not an HTML page: ${named}` };
    if (l.size > ARTIFACT_PREVIEW_MAX) return { code: "too_large", message: `larger than 16 MiB: ${named}` };
    return { path, size: l.size, mtime: l.mtimeMs };
  };
  /** Streams an open file of exactly `size` bytes (never past it, even if it grows) as the response body. */
  const streamFile = (req: IncomingMessage, res: ServerResponse, fd: number, size: number, head: Record<string, string | number>) => {
    res.writeHead(200, { ...head, "content-length": size });
    if (req.method === "HEAD" || size === 0) {
      closeSync(fd);
      return void res.end();
    }
    const stream = createReadStream("", { fd, start: 0, end: size - 1 });
    res.on("close", () => stream.destroy());
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };
  /** Opens a checked artifact file: no-follow, device/inode match as /media; undefined when it is not a regular file within the cap. */
  const openArtifact = (path: string, asset = false) => {
    try {
      const fd = openChecked(path, OPEN_READ);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > ARTIFACT_PREVIEW_MAX || (asset && st.nlink > 1)) {
        closeSync(fd);
        return undefined;
      }
      return { fd, size: st.size };
    } catch {
      return undefined;
    }
  };
  /** GET /artifact/<nonce>/<page name | published path> (GH-175, GH-335): the page in a sandbox CSP (iframe only), or a supporting file named in the same publish (a subresource load only). Lookup is by key, never a file system path. */
  const serveArtifact = (req: IncomingMessage, res: ServerResponse, nonce: string, rest: string) => {
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
    const entry = mediaEntry(nonce);
    if (!entry || entry.src.kind !== "artifact") return void res.writeHead(404).end();
    const key = assetKey(rest);
    if (key === undefined) return void res.writeHead(404).end();
    const src = entry.src;
    if (key !== src.page) {
      const h = req.headers;
      if (!hostOk(req) || !assetRequestAllowed({ origin: h.origin, dest: h["sec-fetch-dest"] as string | undefined, mode: h["sec-fetch-mode"] as string | undefined }, isOwnOrigin(req, hostnames))) return void res.writeHead(403).end();
      const a = src.assets.get(key);
      if (!a) return void res.writeHead(404).end();
      entry.used = Date.now();
      const c = checkArtifact(a.named, "asset", src.confine);
      if ("code" in c || c.path !== a.path) return void res.writeHead(404).end();
      const f = openArtifact(c.path, true);
      if (!f) return void res.writeHead(404).end();
      return streamFile(req, res, f.fd, f.size, { ...ARTIFACT_ASSET_HEADERS, "content-type": a.type, ...(a.type === "image/svg+xml" && { "content-disposition": "attachment" }) });
    }
    const dest = req.headers["sec-fetch-dest"];
    if (!requestOk(req) || (dest && dest !== "iframe")) return void res.writeHead(403).end();
    entry.used = Date.now();
    const c = checkArtifact(src.named);
    if ("code" in c || c.path !== src.path) return void res.writeHead(404).end();
    const f = openArtifact(c.path);
    if (!f) return void res.writeHead(404).end();
    const base = src.assets.size ? `http://${new URL("http://" + req.headers.host).host}/artifact/${nonce}/` : undefined;
    streamFile(req, res, f.fd, f.size, artifactHeaders(base));
  };
  /** GET /addon/<nonce>/<name>/<path> (GH-516): a file of an enabled addon. HTML only as a frame (addon CSP); other files as subresources. */
  const serveAddon = (req: IncomingMessage, res: ServerResponse, nonce: string, name: string, rest: string) => {
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
    const f = addons && nonce === addons.nonce ? addons.serve(name, rest) : undefined;
    if (!f) return void res.writeHead(404).end();
    const h = req.headers;
    const dest = h["sec-fetch-dest"] as string | undefined;
    if (f.html) {
      if (!requestOk(req) || (dest && dest !== "iframe")) return void res.writeHead(403).end();
    } else if (!hostOk(req) || !assetRequestAllowed({ origin: h.origin, dest, mode: h["sec-fetch-mode"] as string | undefined }, isOwnOrigin(req, hostnames))) return void res.writeHead(403).end();
    const o = openArtifact(f.path, !f.html);
    if (!o) return void res.writeHead(404).end();
    const base = `http://${new URL("http://" + h.host).host}/addon/${nonce}/${name}/`;
    streamFile(req, res, o.fd, o.size, f.html ? addonHeaders(base, f.net) : { ...addonAssetHeaders, "content-type": f.type, ...(f.type === "image/svg+xml" && { "content-disposition": "attachment" }) });
  };
  /** GET /media/<nonce>/<name>: the file comes only from the nonce entry; <name> is cosmetic. */
  const serveMedia = (req: IncomingMessage, res: ServerResponse, nonce: string) => {
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
    if (!requestOk(req)) return void res.writeHead(403).end();
    const entry = mediaEntry(nonce);
    if (!entry || entry.src.kind === "artifact") return void res.writeHead(404).end(); // a preview nonce never serves under /media
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
    if (rawPath === "/opencode-mcp") return void serveOpenCodeMcp(req, res).catch((err) => (console.error("opencode-mcp failed:", (err as Error).message), res.headersSent || res.writeHead(500), res.end()));
    if (rawPath.startsWith("/media/")) {
      const m = /^\/media\/([0-9a-f]{32})\/[^/]*$/.exec(rawPath);
      return m ? serveMedia(req, res, m[1]!) : void res.writeHead(404).end();
    }
    if (rawPath.startsWith("/artifact/")) {
      const m = /^\/artifact\/([0-9a-f]{32})\/(.*)$/.exec(rawPath);
      return m ? serveArtifact(req, res, m[1]!, m[2]!) : void res.writeHead(404).end();
    }
    if (rawPath === "/visualize") {
      if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
      const dest = req.headers["sec-fetch-dest"];
      if (!requestOk(req) || (dest && dest !== "iframe")) return void res.writeHead(403).end();
      return void res.writeHead(200, VISUALIZE_HEADERS).end(req.method === "HEAD" ? undefined : VISUALIZE_SHELL);
    }
    if (rawPath.startsWith("/addon/")) {
      const m = /^\/addon\/([0-9a-f]{32})\/([a-z0-9-]{1,64})\/(.+)$/.exec(rawPath);
      return m ? serveAddon(req, res, m[1]!, m[2]!, m[3]!) : void res.writeHead(404).end();
    }
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return void res.writeHead(400).end("malformed URL");
    }
    // Pairing probe: a browser cannot read the 401 of a rejected WebSocket upgrade, so it asks here (client.ts).
    if (path === "/auth") return void res.writeHead(isToken(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]) ? 204 : 401).end();
    if (serveAppIcon(req, res, root, path, () => appSettings.get().app)) return;
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
  opts.sides?.onChange(() => (broadcast({ type: "sessions.changed" }), syncRunning()));
  http.once("listening", () => void cleanupAsides());
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
        console.warn(`${new Date().toISOString()} ws: no pong in ${(opts.pingMs ?? PING_MS) / 1000}s, dropped (${connections.size - 1} left)`);
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
  // Perf log: an event loop blocked ≥1 s delays every reply and pong (a page probe times out, a socket is dropped).
  let lagAt = performance.now();
  const lagWatch = setInterval(() => {
    const t = performance.now();
    const late = t - lagAt - LAG_TICK_MS;
    lagAt = t;
    if (late < LAG_LOG_MS) return;
    const m = process.memoryUsage();
    console.warn(`${new Date().toISOString()} perf: event loop blocked ${Math.round(late)}ms, rss ${mb(m.rss)}MB, heap ${mb(m.heapUsed)}MB, ${connections.size} sockets`);
  }, LAG_TICK_MS).unref();
  // Perf log: memory every 10 min, to see a leak over a day.
  const memLog = setInterval(() => {
    const m = process.memoryUsage();
    console.log(`${new Date().toISOString()} perf: rss ${mb(m.rss)}MB, heap ${mb(m.heapUsed)}/${mb(m.heapTotal)}MB, ${connections.size} sockets, ${sessions.size} sessions`);
  }, MEM_LOG_MS).unref();
  http.on("close", () => (clearInterval(pinger), clearInterval(lagWatch), clearInterval(memLog)));

  wss.on("connection", (ws: Conn, req?: IncomingMessage) => {
    const sameBrowser = sameMachine(req);
    // A WSL daemon's attached Hub is the Windows Hub of this machine, which checked its own browser (ADR 0011).
    const sameHost = sameBrowser || (virtual.has(ws) && !!opts.openExternal?.winPath);
    // Before `connections.add`: a sleep found now is broadcast to the others, then sent once to this connection below.
    sleepWatch?.check();
    connections.add(ws);
    answered.add(ws);
    const openedAt = Date.now();
    ws.on("pong", () => answered.add(ws));
    const usage = plan.current();
    if (usage !== undefined) send(ws, { type: "plan_usage", usage });
    if (plan.age() > PLAN_STALE_MS) void plan.reread();
    updater?.messages().forEach((m) => send(ws, m));
    const stale = opts.buildInfo?.stale();
    if (stale) send(ws, { type: "daemon_stale", note: stale });
    if (slept && (opts.watchSleep?.now ?? Date.now)() - slept.at > SLEEP_KEEP_MS) slept = undefined;
    if (slept) send(ws, { type: "daemon_slept", ...slept });
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
    /** The running `fs.grep` of this connection: stopped by a newer one and the close. */
    let grepping: AbortController | undefined;
    /** The running `fs.replace` dry run of this connection (a newer one and the close stop it), and whether an apply or undo is running. */
    let replacing: AbortController | undefined;
    let writingReplace = false;
    /** The running `git.commitMessage` of this connection: stopped by `git.commitMessageCancel`, a newer one, and the close. */
    let generating: AbortController | undefined;
    /** Clean up scans (`worktree.status` with `scan`) of this connection: aborted by `worktree.cancel` and when it closes. */
    const scans = new Map<string, AbortController>();
    const unwatchAll = () => {
      watched.forEach((w) => unwatchFile(w.real, w.listener));
      watched.clear();
    };
    // Without a listener a socket error (e.g. a frame above maxPayload) is thrown and the daemon exits; ws closes the socket itself.
    ws.on("error", (err) => console.warn("ws:", err.message));
    ws.on("close", (code) => {
      console.log(`${new Date().toISOString()} ws: closed${code ? ` code ${code}` : ""} after ${Math.round((Date.now() - openedAt) / 1000)}s (${connections.size - 1} left)`);
      router?.close();
      connections.delete(ws);
      mediaNonces.forEach((n) => (media.get(n)?.live?.forEach((r) => r.destroy()), media.delete(n)));
      blobs.clear();
      unsubscribes.forEach((u) => u());
      unwatchAll();
      attached.forEach((d) => d());
      searching?.abort();
      grepping?.abort();
      replacing?.abort();
      generating?.abort();
      scans.forEach((a) => a.abort());
      scans.clear();
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
      if (msg.type === "ping" && msg.note) console.warn(`${new Date().toISOString()} ws: page reconnected after: ${String(msg.note).slice(0, 300)}`);
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
    const NOT_TOP = "Not a repository top";
    /** `exact: true` and `cwd` is not its repository's top (an uninitialised submodule folder would answer for the superproject). Both sides canonical. */
    const notTop = async (m: { exact?: unknown }, cwd: string) => m.exact === true && (await gitTopOf(cwd)) !== cwd;
    /** Handles a message in this daemon; its reply or error goes to `out`, events and streams to this connection. */
    type MediaFail = { code: string; message: string; size?: number };
    /** media.read and fs.media {hash}: a piece of a media file or of a file at a commit, with the roots and extension checks. */
    const readMedia = async (m: { path: unknown; cwd?: unknown; hash?: unknown; exact?: unknown; offset: number; length: number }): Promise<MediaReadResult | MediaFail> => {
      if (typeof m.path !== "string") return { code: "bad_request", message: "path must be a string" };
      const mime = mediaType(m.path);
      if (m.hash !== undefined) {
        const cwd = allowed(m.cwd);
        if (!cwd) return { code: "cwd_not_allowed", message: `outside the allowlisted roots: ${String(m.cwd)}` };
        if (await notTop(m, cwd)) return { code: "not_git", message: NOT_TOP };
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
      const args = { path: msg.path, ...(msg.hash !== undefined && { cwd: msg.cwd, hash: msg.hash, ...(msg.exact === true && { exact: true }) }) };
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
      /** fs.write and history.restore: the conflict check, the history entry of the content being replaced, then the write. */
      const writeChecked = (file: string, path: string, content: string, baseMtime: number | undefined, reason: "save" | "restore" = "save") => {
        let fd: number | undefined;
        try {
          fd = openChecked(file, OPEN_WRITE);
          const st = fstatSync(fd);
          if (!st.isFile()) return fail("not_a_file", `not a file: ${path}`);
          if (baseMtime !== undefined && st.mtimeMs !== baseMtime) return fail("conflict", `changed on disk since it was read: ${path}`);
          localHistory.before(file, reason);
          const data = Buffer.from(content);
          ftruncateSync(fd, 0);
          writeAll(fd, data);
          // Closed first: NTFS may set the write time when the handle closes, and the editor keeps this value as its next baseMtime.
          closeSync(fd);
          fd = undefined;
          clearSearchCache();
          return reply({ mtime: statSync(file).mtimeMs });
        } catch (err) {
          return fsFail(err, path);
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      };
      const find = async (id: string, background = false) => (await findSession(id, background)) ?? void fail("unknown_session", `no session ${id}`);

      switch (msg.type) {
        case "session.create": {
          if (typeof msg.cwd === "string" && refused(msg.cwd)) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (typeof msg.cwd !== "string" || !existsSync(msg.cwd) || !statSync(msg.cwd).isDirectory())
            return fail("bad_cwd", `not a directory: ${msg.cwd}`);
          if (msg.model !== undefined && !isModel(msg.model)) return fail("bad_model", "model must be a non-empty string");
          if (msg.engine !== undefined && !(ENGINES as readonly unknown[]).includes(msg.engine)) return fail("bad_request", `engine must be one of ${ENGINES.join(", ")}`);
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (isRemoving(cwd)) return fail("worktree_removing", "This worktree is being removed");
          if (msg.engine === "opencode") {
            // OpenCode's own permission config decides (GH-705); sessions.defaultMode is Claude's.
            // The new-session tab's draft uploads are not claimed: OpenCode chooses the session id (docs/spec.md "OpenCode engine").
            let s: Session | undefined;
            try {
              s = await createOpenCodeSession(cwd, { model: msg.model, permissionMode: "config" });
            } catch (err) {
              const e = openCodeFail(err);
              return fail(e.code, e.message);
            }
            if (!s) return fail("worktree_removing", "This worktree is being removed");
            rememberEngine("opencode");
            return reply({ session: s.info() });
          }
          await modelList().catch(() => {});
          // A removal may have started during the await: no live session in a deleted directory.
          if (isRemoving(cwd) || !existsSync(cwd)) return fail("worktree_removing", "This worktree is being removed");
          // The draft token of the new-session tab's uploads: the session gets their id, and with it their folder (one claim per token).
          const claimed = typeof msg.draft === "string" ? uploads.claim(msg.draft) : undefined;
          if (msg.draft !== undefined && !claimed) console.log("session.create: draft uploads not claimed");
          const s = track(new Session(cwd, sessionOpts({ model: msg.model, permissionMode: defaultModeFor(cwd, msg.model) }), claimed ? { id: claimed } : undefined));
          addProject(cwd);
          rememberEngine("claude");
          return reply({ session: s.info() });
        }
        case "opencode.status":
          return reply(await openCode.status());
        case "opencode.restart":
          if (openCodeHeld()) return fail("opencode_busy", OPENCODE_RESTART_BUSY);
          await restartOpenCode();
          broadcast({ type: "opencode.providersChanged" });
          return reply({});
        case "opencode.providers":
        case "opencode.login":
        case "opencode.loginFinish":
        case "opencode.loginCancel":
        case "opencode.logout": {
          // Credentials pass straight to OpenCode: never logged, never in an error text.
          const provider = "provider" in msg && typeof msg.provider === "string" ? msg.provider : "";
          const field = (m: string) => fail("invalid_input", m);
          let wait: AbortController | undefined;
          const cleanWait = () => wait && oauthWaits.get(provider) === wait && oauthWaits.delete(provider);
          try {
            if (msg.type === "opencode.loginCancel") return (oauthWaits.get(provider)?.abort(), oauthWaits.delete(provider), reply({}));
            // Registered before the slow list: a loginCancel in that window must reach this wait.
            wait = msg.type === "opencode.loginFinish" ? new AbortController() : undefined;
            if (wait) (oauthWaits.get(provider)?.abort(), oauthWaits.set(provider, wait));
            const providers = await listProviders(openCode).catch((err) => (cleanWait(), Promise.reject(err)));
            if (wait?.signal.aborted) return fail("cancelled", "Login cancelled");
            if (msg.type === "opencode.providers") return reply({ providers });
            if (msg.type === "opencode.logout") {
              if (!providers.some((p) => p.id === provider)) return field("provider: Unknown provider");
              await openCode.request(`/auth/${encodeURIComponent(provider)}`, { method: "DELETE" });
              await refreshProviders();
              return reply({ providers: await listProviders(openCode) });
            }
            const api = msg.type === "opencode.login" && providers.find((p) => p.id === provider)?.methods[msg.method as number]?.type === "api";
            const c = checkLogin(msg, providers, api ? "api" : "oauth");
            if ("error" in c) return (cleanWait(), field(c.error));
            const base = `/provider/${encodeURIComponent(provider)}/oauth`;
            if (msg.type === "opencode.login" && api) {
              await openCode.request(`/auth/${encodeURIComponent(provider)}`, { method: "PUT", body: { type: "api", key: c.key, ...(c.inputs && Object.keys(c.inputs).length && { metadata: c.inputs }) } });
              await refreshProviders();
              return reply({ providers: await listProviders(openCode) });
            }
            if (msg.type === "opencode.login") {
              oauthWaits.get(provider)?.abort();
              const r = await openCode.request<{ url: string; method: "auto" | "code"; instructions?: string } | null>(`${base}/authorize`, { method: "POST", body: { method: msg.method, ...(c.inputs && { inputs: c.inputs }) } });
              if (!r?.url) return fail("login_failed", "OpenCode gave no login page for this method.");
              return reply({ url: r.url, mode: r.method, instructions: r.instructions ?? "" });
            }
            const ctl = wait!;
            try {
              await openCode.request(`${base}/callback`, { method: "POST", body: { method: msg.method, ...(typeof msg.code === "string" && msg.code && { code: msg.code }) }, timeoutMs: 15 * 60_000, signal: ctl.signal });
            } catch (err) {
              if (ctl.signal.aborted) return fail("cancelled", "Login cancelled");
              throw err;
            } finally {
              if (oauthWaits.get(provider) === ctl) oauthWaits.delete(provider);
            }
            await refreshProviders();
            return reply({ providers: await listProviders(openCode) });
          } catch (err) {
            if (err instanceof OpenCodeError) return fail(err.code, err.message);
            return fail("login_failed", loginError(err));
          }
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
            return reply({ commands: await (msg.engine === "opencode" ? openCodeEngine.commands(cwd) : commandsOf(cwd)) });
          } catch (e) {
            return fail("commands_failed", (e as Error).message);
          }
        }
        case "session.agents": {
          const cwd = typeof msg.cwd === "string" && allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          try {
            if (typeof msg.sessionId === "string") void (await find(msg.sessionId))?.refreshAgents();
            return reply({ agents: msg.engine === "opencode" ? primaryAgents(await openCodeEngine.agents(cwd)).map(({ name, description }) => ({ name, ...(description && { description }) })) : [] });
          } catch (e) {
            return fail("agents_failed", (e as Error).message);
          }
        }
        case "session.subscribe": {
          const span = perfMon.span("session.open");
          try {
            const s = await find(msg.sessionId, msg.background === true);
            const title = s && (await titleOf(s));
            if (!s || ws.readyState !== ws.OPEN) return;
            // Only an explicit open (link, notification) adds the project; a reconnect resubscribe must not bring back a removed one.
            if (msg.addProject === true) addProject(s.cwd);
            unsubscribes.get(s.id)?.();
            // A plain subscribe holds the session's CLI (idle close) until it is released; `background` only follows.
            // An Aside is held by any subscriber: its popup is open (a reconnect resubscribes in the background otherwise).
            const hold = msg.background !== true || !!asideOf(s.id);
            const keep = (stop: () => void, release: () => void) => {
              if (hold) holds.set(s.id, (holds.get(s.id) ?? 0) + 1);
              unsubscribes.set(s.id, () => (stop(), release(), hold && unhold(s.id)));
            };
            // Different epoch: the client's seqs belong to an earlier daemon run, so replay everything.
            const since = msg.logEpoch === logEpoch ? msg.sinceSeq : 0;
            // Paged, first subscribe or new epoch: a snapshot (last page) instead of the replay; reply, snapshot and subscribe in one synchronous step.
            if (msg.paged === true && since === 0) {
              const { seq, snapshot } = s.snapshot(typeof msg.from === "string" ? msg.from : undefined);
              reply({ logEpoch, seq, session: s.info(), title: title!, snapshot, ...planDirsOf(s) });
              const stop = s.subscribe(seq, (e) => send(ws, e));
              return keep(stop, mirror(s));
            }
            reply({ logEpoch, seq: s.seq(), session: s.info(), title: title!, ...planDirsOf(s) });
            const stop = s.subscribe(since, (e) => send(ws, e));
            return keep(stop, mirror(s));
          } finally {
            span.end();
          }
        }
        case "session.page":
        case "session.edits":
        case "session.artifacts": {
          const s = await find(msg.sessionId);
          if (!s) return;
          if (msg.logEpoch !== logEpoch) return fail("stale_epoch", "the daemon restarted since this view was loaded");
          if (typeof msg.before !== "string") return fail("bad_request", "before must be a part id");
          if (msg.type === "session.edits" || msg.type === "session.artifacts") {
            const parts = msg.type === "session.edits" ? s.edits(msg.before) : s.artifacts(msg.before);
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
        case "artifact.preview": {
          const s = await find(msg.sessionId);
          if (!s) return;
          if (typeof msg.partId !== "string" || msg.partId.length > 200) return fail("bad_request", "partId must be a part id");
          const f = s.artifactFile(msg.partId);
          if ("code" in f) return fail(f.code, f.message);
          const c = checkArtifact(f.path);
          if ("code" in c) return fail(c.code, c.message);
          const page = basename(c.path);
          // The project folder; the page's directory only when the page itself is in the project, in this session's upload folder or in this session's Claude scratchpad (a page elsewhere must not widen it).
          const cwdReal = real(s.cwd);
          const upReal = real(join(uploads.parent, msg.sessionId));
          const spReal = scratchpadRoot(s.cwd, msg.sessionId);
          const confine = [cwdReal, ...[cwdReal, upReal, spReal].filter((r) => r !== undefined && within(c.path, r)).map(() => dirname(c.path))].filter((d) => d !== undefined);
          const assets = new Map<string, { named: string; path: string; type: string }>();
          const unavailable = [...f.unavailable];
          for (const a of f.assets as ArtifactAsset[]) {
            const ac = a.key === page ? undefined : checkArtifact(a.path, "asset", confine);
            if (!ac || "code" in ac) unavailable.push(a.key);
            else assets.set(a.key, { named: a.path, path: ac.path, type: a.type });
          }
          const nonce = nonceFor(`artifact\0${msg.sessionId}\0${msg.partId}`);
          media.set(nonce, { src: { kind: "artifact", named: f.path, path: c.path, page, confine, assets }, ws, used: Date.now() });
          return reply({ url: `/artifact/${nonce}/${encodeURIComponent(page)}?v=${c.mtime}`, size: c.size, mtime: c.mtime, title: f.title, ...(unavailable.length > 0 && { unavailable }) });
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
          const out: PromptResult = {};
          const err = await sendPrompt(s, msg.text, images, undefined, out);
          // A refused prompt keeps a usage-limit pause.
          if (!err) queue.release(s.id);
          return err ? fail(err.code, err.message) : reply(out);
        }
        case "session.enqueue": {
          const s = await find(msg.sessionId);
          if (!s) return;
          const images = msg.images ?? [];
          if (!Array.isArray(images) || !images.every((i) => imageBlock(i)))
            return fail("bad_images", "images must be base64 data URLs of type png, jpeg, gif or webp");
          if (typeof msg.text !== "string" || (!msg.text.trim() && !images.length)) return fail("bad_prompt", "empty prompt");
          if (!s.isLive()) return fail("session_not_live", `session ${s.id} is ${s.info().state}`);
          const r = queue.enqueue(s.id, { text: msg.text, images });
          return typeof r === "string" ? reply({ itemId: r }) : fail(r.code, r.message);
        }
        case "session.dequeue": {
          // In memory only: a session not loaded has no queue, and find() would restore it from disk.
          const s = sessions.get(msg.sessionId);
          if (!s) return fail("unknown_item", "queued message not found (already sent?)");
          const item = queue.take(s.id, msg.itemId);
          briefDropped(s.id, item);
          return item ? reply({ text: item.text, images: item.images, ...(item.bash && { bash: true }) }) : fail("unknown_item", "queued message not found (already sent?)");
        }
        case "session.sendQueued": {
          const s = sessions.get(msg.sessionId);
          if (!s || !queue.items(s.id).some((i) => i.id === msg.itemId)) return fail("unknown_item", "queued message not found (already sent?)");
          const queued = queue.items(s.id).find((i) => i.id === msg.itemId);
          const bash = queued?.bash;
          // A brief turn never steers into a running turn: Send now only while the session takes a prompt.
          if (queued?.brief && !s.takesQueued()) return fail("session_busy", "The brief waits for the current turn to end");
          const err = await queue.sendNow(s.id, msg.itemId);
          // A refused Send now (any reason) leaves a scheduled auto-continue alone.
          if (err) return fail(err.code, err.message);
          // A shell command does not end a usage-limit pause; only a prompt does (runBash cancelled the auto-continue).
          if (!bash) {
            autoContinue.cancel(s.id);
            queue.release(s.id);
          }
          return reply({});
        }
        case "session.bash": {
          const s = await find(msg.sessionId);
          if (!s) return;
          if (typeof msg.command !== "string" || !msg.command.trim()) return fail("bad_command", "empty command");
          // A send of the queue is in flight (a prompt awaiting its sync): the command goes behind it, in submit order.
          const err = queue.sending(s.id) ? { code: "session_busy", message: "queue sending" } : await runBash(s, msg.command);
          if (err?.code === "session_busy" || err?.code === "external_turn") {
            const r = queue.enqueue(s.id, { text: msg.command.trim(), images: [], bash: true });
            return typeof r === "string" ? reply({ itemId: r }) : fail(r.code, r.message);
          }
          return err ? fail(err.code, err.message) : reply({});
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
        case "session.setAgent": {
          const s = await find(msg.sessionId);
          if (!s) return;
          if (typeof msg.agent !== "string" || !msg.agent || msg.agent.length > 200) return fail("bad_agent", "agent must be a non-empty string");
          if (!s.isLive()) return fail("session_not_live", `session ${s.id} is ${s.info().state}`);
          try {
            await s.setAgent(msg.agent);
          } catch (e) {
            return fail("set_failed", (e as Error).message);
          }
          return reply({ session: s.info() });
        }
        case "session.setPermissionMode":
        case "session.setEffort": {
          const s = await find(msg.sessionId);
          if (!s) return;
          if (msg.type === "session.setPermissionMode" && !PERMISSION_MODES.includes(msg.mode) && !OPENCODE_MODES.includes(msg.mode)) return fail("bad_mode", `unknown permission mode ${msg.mode}`);
          if (msg.type === "session.setEffort" && !EFFORTS.includes(msg.effort)) return fail("bad_effort", `unknown effort ${msg.effort}`);
          try {
            await (msg.type === "session.setPermissionMode" ? s.setPermissionMode(msg.mode) : s.setEffort(msg.effort));
          } catch (e) {
            return fail("set_failed", (e as Error).message);
          }
          // An Aside stops being read-only with a mode change; the next CLI start has the editing tools.
          if (msg.type === "session.setPermissionMode" && settings.get(s.id)?.readOnly) {
            saveSettings(() => settings.set(s.id, { readOnly: undefined }, ["readOnly"]));
            // shortcut: while a turn runs the edits stay off until its CLI ends (idle close, restart); restart at turn end if users ask.
            if (s.info().state === "idle" && s.live()) s.restartQuery();
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
            const path = uploads.store(owner, msg.name, buf);
            clearSearchCache();
            return reply({ path });
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
        case "session.backgroundShell": {
          if (typeof msg.toolUseId !== "string") return fail("bad_request", "toolUseId required");
          const s = await find(msg.sessionId);
          if (!s) return;
          try {
            if (!(await s.backgroundShell(msg.toolUseId))) return fail("unknown_shell", "no foreground Bash call with that ID runs");
          } catch (e) {
            return fail("background_failed", (e as Error).message);
          }
          return reply({});
        }
        case "session.shellOutput": {
          if (typeof msg.toolUseId !== "string") return fail("bad_request", "toolUseId required");
          const s = await find(msg.sessionId);
          if (!s) return;
          let r;
          try {
            r = await s.shellOutput(msg.toolUseId);
          } catch (e) {
            return fail("no_output", (e as Error).message);
          }
          return r ? reply(r) : fail("no_output", "Output is not available");
        }
        case "session.stopShell": {
          if (typeof msg.toolUseId !== "string") return fail("bad_request", "toolUseId required");
          const s = await find(msg.sessionId);
          if (!s) return;
          try {
            if (!(await s.stopShell(msg.toolUseId))) return fail("unknown_shell", "no running shell with that ID");
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
          const { choices } = msg;
          // Each list is the chosen labels and the Other text: bounded like the answers a user can type.
          if (choices !== undefined && (typeof choices !== "object" || !choices || Array.isArray(choices) || Object.values(choices).some((l) => !Array.isArray(l) || l.length > 50 || l.some((v) => typeof v !== "string" || v.length > 10_000))))
            return fail("bad_request", "choices must map a question text to at most 50 strings");
          const settled = [...sessions.values()].some((s) => s.answer(msg.requestId, answers, undefined, choices));
          return reply({ settled });
        }
        case "models.list": {
          try {
            if (msg.engine !== "opencode") return reply({ models: await modelList() });
            const cwd = msg.cwd === undefined ? undefined : allowed(msg.cwd);
            if (msg.cwd !== undefined && !cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
            return reply({ models: await openCodeModelsRepaired(cwd) });
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
          return reply(settingsReply());
        case "jira.token": {
          if (msg.token !== null && typeof msg.token !== "string") return fail("bad_settings", "token must be a string or null");
          try {
            secrets.setJiraToken(msg.token === null ? null : msg.token.trim(), jiraOrigin(appSettings.get().jira.url));
          } catch (err) {
            return fail("bad_settings", (err as Error).message);
          }
          broadcastSettings();
          return reply(settingsReply());
        }
        case "claude.account.add": {
          if (typeof msg.name !== "string" || typeof msg.token !== "string") return fail("bad_settings", "name and token must be strings");
          try {
            secrets.addClaudeAccount(msg.name.trim(), msg.token.trim());
          } catch (err) {
            return fail("bad_settings", (err as Error).message);
          }
          broadcastSettings();
          return reply(settingsReply());
        }
        case "claude.account.remove": {
          if (typeof msg.id !== "string") return fail("bad_settings", "id must be a string");
          try {
            const active = appSettings.get().claude.account === msg.id;
            secrets.removeClaudeAccount(msg.id);
            if (active) appSettings.set({ claude: { account: "" } });
            setClaudeToken(accountToken());
            if (active) claudeLoginChanged();
          } catch (err) {
            return fail("bad_settings", (err as Error).message);
          }
          broadcastSettings();
          return reply(settingsReply());
        }
        case "claude.account.test": {
          const token = typeof msg.id === "string" ? secrets.claudeToken(msg.id) : undefined;
          if (!token) return fail("bad_settings", "Claude account: unknown account");
          const env = { ...claudeEnv(process.env, token), CLAUDE_CODE_MAX_RETRIES: "0" };
          if (!usesOauthToken(env)) return fail("bad_settings", "a cloud provider (Bedrock, Vertex, Foundry) is on in the daemon environment: token accounts are not used");
          try {
            const o = await testAccount(msg.id, token, env);
            return o.ok ? reply({}) : fail(o.code, o.message);
          } catch (e) {
            if (e instanceof ConfigError) return fail("claude_test_failed", e.message.replaceAll(token, "***"));
            throw e;
          }
        }
        case "jira.test":
        case "jira.search": {
          if (msg.type === "jira.search" && msg.text !== undefined && (typeof msg.text !== "string" || msg.text.length > 500)) return fail("bad_request", "text must be a string of at most 500 characters");
          try {
            return reply(msg.type === "jira.test" ? await jira.test() : { tickets: await jira.search(msg.text) });
          } catch (e) {
            if (e instanceof JiraError) return fail(e.code, e.message);
            throw e;
          }
        }
        case "settings.set": {
          // The command runs on the daemon machine's desktop: a remote browser must not plant it for the local user's next click.
          if (msg.patch?.editor !== undefined && !sameHost) return fail("not_local", "Only a browser on the daemon machine can change the editor command");
          try {
            const picked = msg.patch?.claude?.account;
            if (picked !== undefined && picked !== "" && picked !== "cli" && !secrets.claudeAccounts().some((a) => a.id === picked)) return fail("bad_settings", "Claude account: unknown account");
            const before = appSettings.get().claude.account;
            const openCodePath = appSettings.get().opencode.path;
            const settings = appSettings.set(msg.patch);
            if (msg.patch?.git?.commitMessageWarm !== undefined) (settings.git.commitMessageWarm ? warmCommit.prewarm() : warmCommit.stop());
            if (settings.opencode.path !== openCodePath) void restartOpenCode().then(() => broadcast({ type: "opencode.providersChanged" }));
            if (settings.claude.account !== before) (setClaudeToken(accountToken()), claudeLoginChanged());
            const origin = jiraOrigin(settings.jira.url);
            const urlPatched = msg.patch?.jira?.url !== undefined;
            // GH-487: a token saved without URL takes the first URL set here (never a hand edit), in one write; a token of another origin is dropped (cleanup, it is never sent anyway).
            if (urlPatched && origin) secrets.bindJiraToken(origin);
            const bound = secrets.jiraTokenOrigin();
            if (bound !== undefined && bound !== origin) secrets.setJiraToken(null);
            if (urlPatched && !origin) secrets.endJiraTokenReset();
            if (!settings.usageLimit.autoContinue) autoContinue.clear();
            if (!settings.focus.nextForYou) for (const s of sessions.values()) s.clearSuggestion();
            perfMon.setEnabled(settings.performance.monitor);
            if (!settings.power.keepAwake) opts.keepAwake?.reset();
            syncRunning();
            broadcastSettings(settings);
            return reply(settingsReply(settings));
          } catch (err) {
            return fail("bad_settings", (err as Error).message);
          }
        }
        case "back.set":
        case "back.done":
        case "back.brief": {
          if (opts.attached) return fail("back_unsupported", "Back marks are kept by the Hub; mark this reply on the Hub");
          if (typeof msg.sessionId !== "string" || typeof msg.partId !== "string") return fail("bad_request", "sessionId and partId must be strings");
          const s = await find(msg.sessionId);
          if (!s) return;
          const marks = appSettings.get().back.marks;
          if (msg.type === "back.done") {
            // Existing mark or not: Done is idempotent. A queued brief leaves the queue; a running one ends into nothing.
            dropQueuedBrief(s.id, msg.partId);
            try {
              appSettings.changeMarks((m) => {
                const list = m[s.id]?.filter((x) => x.partId !== msg.partId);
                if (list?.length) m[s.id] = list;
                else delete m[s.id];
              });
            } catch (e) {
              return fail("save_failed", (e as Error).message);
            }
            broadcastSettings();
            return reply({});
          }
          if (msg.type === "back.brief") {
            const m = findMark(marks, s.id, msg.partId);
            if (!m) return fail("unknown_mark", "no such mark");
            if (m.briefState === "queued" || m.briefState === "running") return fail("brief_busy", "a brief is already being written");
            await startBrief(s, msg.partId, !!m.brief);
            return reply({});
          }
          const bad = checkSet(msg);
          if (bad) return fail("bad_request", bad);
          const exists = !!findMark(marks, s.id, msg.partId);
          if (!exists && marksTotal(marks) >= BACK_MARKS_MAX) return fail("too_many_marks", `at most ${BACK_MARKS_MAX} marks`);
          let isNew = false;
          try {
            appSettings.changeMarks((m) => {
              const list = (m[s.id] ??= []);
              const r = upsertMark(list, msg as { partId: string; title: string }, clock());
              isNew = r.isNew;
              // In the same write: the first settings_changed already shows the pending brief, not the fallback.
              if (isNew) r.mark.briefState = "queued";
            });
          } catch (e) {
            return fail("save_failed", (e as Error).message);
          }
          broadcastSettings();
          if (isNew) void startBrief(s, msg.partId, false).catch((e) => briefFailed(s.id, msg.partId, (e as Error).message));
          return reply({});
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
            if (OPENCODE_ID.test(msg.sessionId)) {
              // Archive: `time.archived` set; 0 clears it (null is accepted but keeps it, verified on 1.18.35).
              await openCode.request(`/session/${msg.sessionId}`, { method: "PATCH", directory: at.cwd, body: msg.type === "session.rename" ? { title } : { time: { archived: msg.archived ? Date.now() : 0 } } });
              if (msg.type === "session.rename") openCodeMeta.set(msg.sessionId, { cwd: at.cwd, title });
            } else if (msg.type === "session.rename") await history.renameSession(msg.sessionId, title, { dir: at.cwd });
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
        case "aside.open": {
          if (typeof msg.text !== "string" || !msg.text.trim()) return fail("bad_prompt", "text must be a non-empty string");
          const owner = await find(msg.sessionId);
          if (!owner) return;
          const text = msg.text.trim();
          const title = text.split("\n")[0]!.trim().slice(0, 80);
          if (OPENCODE_ID.test(owner.id)) {
            let forkId: string | undefined;
            try {
              const at = { directory: owner.cwd };
              const stored = await openCode.request<{ info: { id: string; role: string; time?: { completed?: number } } }[]>(`/session/${owner.id}/message`, at);
              // After a rewind the cut messages stay stored until the next prompt: the fork ends before the cut.
              const revert = (await openCode.request<{ revert?: { messageID: string } | null }>(`/session/${owner.id}`, at)).revert?.messageID;
              const cut = revert ? stored.findIndex((m) => m.info.id === revert) : -1;
              const kept = cut < 0 ? stored : stored.slice(0, cut);
              if (!kept.length) return fail("aside_unavailable", "An aside needs a message in this session first");
              // A running turn is cut off at its unfinished assistant message; a finished history is forked whole.
              const messageID = cut < 0 ? stored.find((m) => m.info.role === "assistant" && !m.info.time?.completed)?.info.id : revert;
              forkId = (await openCode.request<OpenCodeSessionRow>(`/session/${owner.id}/fork`, { ...at, method: "POST", body: { messageID } })).id;
              openCodeMeta.set(forkId, { cwd: owner.cwd, title });
              await openCode.request(`/session/${forkId}`, { ...at, method: "PATCH", body: { title } });
              const oi = owner.info();
              saveSettings(() => settings.set(forkId!, { ownerId: owner.id, readOnly: true, port: (http.address() as AddressInfo | null)?.port, model: oi.model, permissionMode: "default", effort: oi.effort }));
              const s = await findSession(forkId);
              if (!s) throw new Error("the fork could not be restored");
              const from = s.prompt(text) ?? "";
              return reply({ session: s.info(), title, from } satisfies AsideOpenResult);
            } catch (e) {
              if (forkId) {
                const err = await deleteSessionById(forkId, true).catch(() => undefined);
                if (err) saveSettings(() => settings.delete([forkId!]));
              }
              return fail("aside_failed", (e as Error).message);
            }
          }
          let main: Awaited<ReturnType<typeof readTranscript>>["main"] = [];
          try {
            if (!owner.untitled()) main = (await readTranscript(owner.id, owner.cwd)).main;
          } catch (e) {
            return fail("aside_failed", `Could not read the session: ${(e as Error).message}`);
          }
          const at = asideForkPoint(main);
          if (!at) return fail("aside_unavailable", "An aside needs a reply in this session first");
          const dir = transcriptCwd(owner.id, owner.cwd);
          let id: string | undefined;
          try {
            // The owner's transcript is only read: a running owner turn and an external turn are not touched.
            id = (await history.forkSession!(owner.id, { dir, upToMessageId: at, title })).sessionId;
            const oi = owner.info();
            // Right after the fork, no await between: a list scan reads the link after its transcript scan.
            saveSettings(() => settings.set(id!, { ownerId: owner.id, readOnly: true, port: (http.address() as AddressInfo | null)?.port, model: oi.model, permissionMode: "default", effort: oi.effort }));
            const s = await findSession(id);
            if (!s) throw new Error("the fork could not be restored");
            const from = s.prompt(text) ?? "";
            return reply({ session: s.info(), title, from } satisfies AsideOpenResult);
          } catch (e) {
            if (id) {
              const err = await deleteSessionById(id, true).catch(() => undefined);
              if (err?.code === "unknown_session" || !(await locate(id))) saveSettings(() => settings.delete([id!]));
            }
            return fail("aside_failed", (e as Error).message);
          }
        }
        case "aside.close": {
          if (typeof msg.sessionId !== "string" || !asideOf(msg.sessionId)) return fail("not_an_aside", "this session is not an aside");
          const err = await deleteSessionById(msg.sessionId, true);
          if (err?.code === "unknown_session") return saveSettings(() => settings.delete([msg.sessionId])), reply({});
          return err ? fail(err.code, err.message) : reply({});
        }
        case "aside.keep": {
          if (typeof msg.sessionId !== "string" || !asideOf(msg.sessionId)) return fail("not_an_aside", "this session is not an aside");
          saveSettings(() => settings.set(msg.sessionId, { ownerId: undefined }, ["ownerId"]));
          broadcast({ type: "sessions.changed" });
          return reply({});
        }
        case "worker.close":
        case "worker.remove": {
          if (typeof msg.sessionId !== "string") return fail("bad_request", "sessionId must be a string");
          const err = await orchestration.userOp(msg.type === "worker.close" ? "close" : "remove", msg.sessionId);
          return err ? fail(err.code, err.message) : reply({});
        }
        case "fs.list": {
          if (msg.path === undefined)
            return reply({ entries: roots.map((r): FsEntry => ({ name: r, path: r, isDir: true })) });
          const dir = allowed(msg.path);
          if (!dir) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.path}`);
          try {
            const entries = readdirChecked(dir).map(
              (e): FsEntry => ({ name: e.name, path: join(dir, e.name), isDir: e.isDirectory() }),
            );
            return reply({ entries: entries.sort((a, b) => a.name.localeCompare(b.name)) });
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ECHANGED") return fail("path_not_allowed", "changed during the request");
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
          return reply({ paths: (await searchFiles(cwd, msg.query, 50, (await reposOf(cwd, lastOpen.get(cwd) ?? []).then((r) => r.repos, () => [])), (p) => inRoots(real(p) ?? p))).filter((p) => allowed(join(cwd, p))) });
        }
        case "fs.grep": {
          grepping?.abort();
          grepping = undefined;
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (typeof msg.query !== "string" || (msg.globs !== undefined && typeof msg.globs !== "string") || [msg.regex, msg.includeIgnored].some((b) => b !== undefined && typeof b !== "boolean")) return fail("bad_query", "query and globs must be strings, regex and includeIgnored booleans");
          if (!msg.query.trim()) return reply({ files: [], matches: 0, ms: 0, includeIgnored: false, git: false } satisfies FsGrepResult);
          if (msg.query.length > MAX_SEARCH_CHARS) return fail("bad_query", `query longer than ${MAX_SEARCH_CHARS} characters`);
          const globs = parseGlobs(msg.globs);
          if (typeof globs === "string") return fail("bad_glob", globs);
          const ctl = (grepping = new AbortController());
          try {
            const repos = await reposOf(cwd, lastOpen.get(cwd) ?? []).then((r) => r.repos, () => []);
            const r = await findInFiles(cwd, { query: msg.query, regex: !!msg.regex, globs, includeIgnored: msg.includeIgnored }, { signal: ctl.signal, allowed: (p) => !!allowed(p), repoAllowed: (p) => inRoots(real(p) ?? p), repos });
            // No query text in the log (it may hold a secret).
            console.log(`fs.grep: ${r.files.length} files, ${r.matches} matches, ${r.ms} ms${r.stopped ? `, stopped: ${r.stopped}` : ""}`);
            return reply(r);
          } catch (e) {
            return fail(e instanceof GrepError ? e.code : "fs_error", (e as Error).message);
          } finally {
            if (grepping === ctl) grepping = undefined;
          }
        }
        case "fs.replace":
        case "fs.replaceUndo": {
          const isUndo = msg.type === "fs.replaceUndo";
          const dry = !isUndo && msg.dryRun === true;
          if (dry) {
            replacing?.abort();
            replacing = undefined;
          }
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          const strs = (v: unknown, max: number) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string");
          if (isUndo) {
            if (typeof msg.id !== "string" || msg.id.length > 100 || (msg.unsaved !== undefined && !strs(msg.unsaved, 200))) return fail("bad_request", "id must be a string and unsaved at most 200 strings");
          } else {
            if (typeof msg.query !== "string" || !msg.query.trim() || msg.query.length > MAX_SEARCH_CHARS) return fail("bad_request", `query must be a non-blank string of at most ${MAX_SEARCH_CHARS} characters`);
            if (typeof msg.replace !== "string" || [msg.regex, msg.dryRun].some((b) => b !== undefined && typeof b !== "boolean")) return fail("bad_request", "replace must be a string, regex and dryRun booleans");
            const files: unknown = msg.files;
            const lineCount = Array.isArray(files) ? files.reduce((n: number, f: { lines?: unknown[] }) => n + (Array.isArray(f?.lines) ? f.lines.length : Infinity), 0) : Infinity;
            if (!Array.isArray(files) || files.length < 1 || files.length > GREP_LIMITS.files || lineCount > GREP_LIMITS.matches)
              return fail("bad_request", `files must list 1 to ${GREP_LIMITS.files} files and at most ${GREP_LIMITS.matches} lines`);
            const okFile = (f: { path?: unknown; lines?: unknown; mtime?: unknown; size?: unknown }) =>
              typeof f?.path === "string" && Array.isArray(f.lines) && f.lines.every((n) => Number.isSafeInteger(n) && (n as number) >= 1) && [f.mtime, f.size].every((v) => v === undefined || typeof v === "number");
            if (!files.every(okFile)) return fail("bad_request", "each file needs a path, line numbers from 1, and numeric mtime and size");
            try {
              matcher(msg.query, !!msg.regex);
            } catch (e) {
              return fail("bad_regex", (e as Error).message);
            }
          }
          if (!dry) {
            if (writingReplace) return fail("busy", "Another replace or undo is running");
            writingReplace = true;
          }
          const ctl = dry ? (replacing = new AbortController()) : undefined;
          const o = { allowed, snapshot: (f: string, why: "replace" | "restore") => localHistory.before(f, why), undo: replaceUndo, afterWrite: clearSearchCache };
          try {
            const r = isUndo ? await undoReplace(cwd, msg.id, msg.unsaved ?? [], o) : await replaceInFiles(cwd, { query: msg.query, regex: !!msg.regex, replace: msg.replace, dryRun: dry, files: msg.files }, { ...o, signal: ctl?.signal });
            // Counts only: the query and the replacement may hold a secret.
            console.log(`${msg.type}${dry ? " (dry run)" : ""}: ${r.files.length} files listed, ${r.changedFiles} changed, ${r.changedLines} lines`);
            return reply(r);
          } catch (e) {
            return fail(e instanceof ReplaceError ? e.code : "fs_error", (e as Error).message);
          } finally {
            if (!dry) writingReplace = false;
            if (ctl && replacing === ctl) replacing = undefined;
          }
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
          // An Aside's transcript copies its owner's: its hits would duplicate the owner's.
          const linked = new Map(settings.entries());
          const files = (await transcripts())
            .filter((t) => t.cwd && inside(t.cwd) && !deleting.has(t.sessionId) && !linked.get(t.sessionId)?.ownerId && (!cwd || trim(inside(t.cwd)!) === trim(cwd)))
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
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          return reply({ status: await statusOf(cwd) });
        }
        case "git.refs": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          return reply({ refs: await gitRefs(cwd, (p) => inRoots(real(p) ?? p)) });
        }
        case "git.repos": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          const files = msg.openFiles;
          if (files !== undefined && (!Array.isArray(files) || files.length > 50 || files.some((f) => typeof f !== "string" || f.length > 4096 || f.includes("\0")))) return fail("bad_request", "openFiles must be at most 50 paths");
          const open = (files ?? []).filter((f) => isAbsolute(f) && !refused(f));
          if (lastOpen.size > 64) lastOpen.clear();
          lastOpen.set(cwd, open);
          return reply(await reposOf(cwd, open, msg.fresh === true));
        }
        case "git.log":
        case "git.diff":
        case "git.commit":
        case "git.blame":
        case "git.fileAt": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          const inside = (p: string) => inRoots(real(p) ?? p);
          // No filter text in the log (it may hold a secret).
          try {
            if (msg.type === "git.log") return reply({ log: await gitLog(cwd, { skip: msg.skip, limit: msg.limit, ref: msg.ref, author: msg.author, text: msg.text, fresh: msg.fresh === true, path: msg.path, allowed: inside }) });
            if (msg.type === "git.diff") return reply({ diff: await gitDiff(cwd, { base: msg.base, ref: msg.ref, allowed: inside, ignoreSubmodules: appSettings.get().git.ignoreSubmodules }) });
            if (msg.type === "git.commit") {
              const c = await gitShow(cwd, msg.hash, inside);
              return c ? reply({ commit: c }) : fail("not_git", "Not in a git repository");
            }
            if (msg.type === "git.blame") return reply({ blame: await gitBlame(cwd, msg.path, inside, MAX_FILE_BYTES) });
            const buf = await gitFileAt(cwd, msg.hash, msg.path, inside, MAX_FILE_BYTES);
            const t = decodeText(buf);
            return "code" in t ? fail(t.code, `${t.code === "binary" ? "binary file" : "not UTF-8 text"}: ${msg.path}`, buf.length) : reply({ content: t.content });
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message, e instanceof WorktreeError ? e.size : undefined);
          }
        }
        case "git.fetch": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          if (msg.defaultRemote !== undefined && typeof msg.defaultRemote !== "boolean") return fail("bad_request", "defaultRemote must be a boolean");
          const inside = (p: string) => inRoots(real(p) ?? p);
          // Output and URLs are never logged.
          try {
            const remote = await (msg.defaultRemote ? netSlot(() => gitFetch(cwd, { allowed: inside, defaultRemote: true })) : gitFetch(cwd, { allowed: inside }));
            markRepoStale(cwd);
            return reply({ remote });
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.commitFiles": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          // Paths, message and output are never logged. A hook may have changed files even when the commit failed.
          try {
            const committed = await gitCommitFiles(cwd, { paths: msg.paths, message: msg.message, amend: msg.amend, push: msg.push, allowed: (p) => inRoots(real(p) ?? p) });
            markRepoStale(cwd);
            return reply({ committed });
          } catch (e) {
            if (e instanceof WorktreeError ? e.code === "git_failed" : true) markRepoStale(cwd);
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.rollbackPreview":
        case "git.rollback":
        case "git.rollbackHunk": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          // Paths and output are never logged. A failed git call may have changed files too.
          const o = { allowed: (p: string) => inRoots(real(p) ?? p), snapshot: localHistory.before };
          try {
            if (msg.type === "git.rollbackPreview") return reply({ preview: await gitRollbackPreview(cwd, { paths: msg.paths, ...o }) });
            const rolledBack = msg.type === "git.rollback" ? await gitRollback(cwd, { paths: msg.paths, token: msg.token, deleteAdded: msg.deleteAdded, ...o }) : await gitRollbackHunk(cwd, { path: msg.path, hunk: msg.hunk, maxBytes: MAX_FILE_BYTES, ...o });
            markRepoStale(cwd);
            return reply({ rolledBack });
          } catch (e) {
            if (msg.type !== "git.rollbackPreview" && (e instanceof WorktreeError ? e.code === "git_failed" : true)) markRepoStale(cwd);
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.merge":
        case "git.rebase": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          // Output is never logged. A hook may have changed files even when the run failed.
          try {
            const written = await gitMergeRebase(cwd, msg.type === "git.merge" ? "merge" : "rebase", { ref: msg.ref, local: msg.local, headRef: msg.headRef, headHash: msg.headHash, argv: msg.argv, allowed: (p) => inRoots(real(p) ?? p) });
            markRepoStale(cwd);
            return reply({ written });
          } catch (e) {
            if (e instanceof WorktreeError ? e.code === "git_failed" : true) markRepoStale(cwd);
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.continue":
        case "git.abort": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          try {
            const written = await (msg.type === "git.continue" ? gitContinue : gitAbort)(cwd, { kind: msg.kind, allowed: (p) => inRoots(real(p) ?? p), snapshot: localHistory.before });
            markRepoStale(cwd);
            return reply({ written });
          } catch (e) {
            if (e instanceof WorktreeError ? e.code === "git_failed" : true) markRepoStale(cwd);
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.commitMenu": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          try {
            return reply({ commitMenu: await gitCommitMenu(cwd, { hash: msg.hash, hard: msg.hard, allowed: (p) => inRoots(real(p) ?? p) }) });
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.undoCommit":
        case "git.revert":
        case "git.cherryPick":
        case "git.reset": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          // Output is never logged. A hook may have changed files even when the run failed.
          try {
            const action = msg.type === "git.undoCommit" ? "undo" : msg.type === "git.cherryPick" ? "cherryPick" : msg.type === "git.revert" ? "revert" : "reset";
            const written = await gitCommitAction(cwd, action, { hash: msg.hash, headRef: msg.headRef, headHash: msg.headHash, argv: msg.argv, mode: msg.type === "git.reset" ? msg.mode : undefined, dirty: msg.type === "git.reset" ? msg.dirty : undefined, snapshot: localHistory.before, allowed: (p) => inRoots(real(p) ?? p) });
            markRepoStale(cwd);
            return reply({ written });
          } catch (e) {
            if (e instanceof WorktreeError ? e.code === "git_failed" : true) markRepoStale(cwd);
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.branchCreate":
        case "git.checkout": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          try {
            const o = { allowed: (p: string) => inRoots(real(p) ?? p), snapshot: localHistory.before };
            const written = await (msg.type === "git.checkout" ? gitCheckout(cwd, { ref: msg.ref, smart: msg.smart, ...o }) : gitBranchCreate(cwd, { name: msg.name, at: msg.at, checkout: msg.checkout, smart: msg.smart, ...o }));
            markRepoStale(cwd);
            return reply({ written });
          } catch (e) {
            if (e instanceof WorktreeError ? e.code === "git_failed" : true) markRepoStale(cwd);
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.operation": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          try {
            return reply({ operation: await gitOperationOf(cwd, (p) => inRoots(real(p) ?? p)) });
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.stashList": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          try {
            return reply({ stashes: await gitStashList(cwd, { allowed: (p) => inRoots(real(p) ?? p) }) });
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.stashPush":
        case "git.stashApply":
        case "git.stashPop":
        case "git.stashDrop": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          const inside = (p: string) => inRoots(real(p) ?? p);
          const VERB = { "git.stashApply": "apply", "git.stashPop": "pop", "git.stashDrop": "drop" } as const;
          // Output is never logged. A hook may have changed files even when the run failed.
          try {
            const written = msg.type === "git.stashPush"
              ? await gitStashPush(cwd, { message: msg.message, includeUntracked: msg.includeUntracked, allowed: inside })
              : await gitStash(cwd, VERB[msg.type], { index: msg.index, hash: msg.hash, allowed: inside, snapshot: localHistory.before });
            markRepoStale(cwd);
            return reply({ written });
          } catch (e) {
            if (e instanceof WorktreeError ? e.code === "git_failed" : true) markRepoStale(cwd);
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "git.commitMessageCancel":
          generating?.abort();
          return reply({});
        case "git.commitMessage": {
          // Before any await or early return: a cancel or a close at any moment aborts this request.
          generating?.abort();
          const ctl = (generating = new AbortController());
          try {
            const cwd = allowed(msg.cwd);
            if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
            if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
            // `project` is only a key of the settings map: never a path.
            if (msg.project !== undefined && (typeof msg.project !== "string" || msg.project.length > 4096 || msg.project.includes("\0"))) return fail("bad_request", "project must be a project folder");
            // Paths, diff, instruction and reply are never logged.
            const d = await gitCommitDiff(cwd, { paths: msg.paths, allowed: (p) => inRoots(real(p) ?? p) });
            if (!d) return fail("not_git", NOT_TOP);
            const prompt = promptFor(instructionFor(appSettings.get().git, msg.project), d);
            const message = await generateCommitMessage({ cwd, prompt, signal: ctl.signal, query: opts.query, ...(appSettings.get().git.commitMessageWarm && { warm: warmCommit }) });
            return reply({ message, ...(d.cut && { truncated: true }) });
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          } finally {
            if (generating === ctl) generating = undefined;
          }
        }
        case "git.branch":
        case "git.push":
        case "git.pull": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (await notTop(msg, cwd)) return fail("not_git", NOT_TOP);
          const inside = (p: string) => inRoots(real(p) ?? p);
          try {
            if (msg.type === "git.branch") return reply({ branch: await gitBranch(cwd, msg.ref, { allowed: inside }) });
            if (typeof msg.ref !== "string" || !isHash(msg.local) || !Array.isArray(msg.argv) || !msg.argv.every((a) => typeof a === "string") || (msg.type === "git.push" && msg.lease !== undefined && !isHash(msg.lease))) return fail("bad_request", "ref, local, lease and argv must be a branch, full commit hashes and the shown command");
            // Output and URLs are never logged.
            const remote = msg.type === "git.push" ? await gitPush(cwd, { ref: msg.ref, local: msg.local, argv: msg.argv, lease: msg.lease, tracking: msg.tracking, allowed: inside }) : await gitPull(cwd, { ref: msg.ref, local: msg.local, argv: msg.argv, tracking: msg.tracking, allowed: inside });
            markRepoStale(cwd);
            return reply({ remote });
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "worktree.branches": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (msg.fetch !== undefined && typeof msg.fetch !== "boolean") return fail("bad_request", "fetch must be a boolean");
          try {
            return reply(await listBranches(cwd, { allowed: (p) => inRoots(real(p) ?? p), claudeDir, fetch: msg.fetch === true }));
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "worktree.pr": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (typeof msg.url !== "string" || msg.url.length > 2000) return fail("bad_request", "url must be a string of at most 2000 characters");
          try {
            return reply(await pullRequestBranches(cwd, msg.url, { allowed: (p) => inRoots(real(p) ?? p) }));
          } catch (e) {
            return fail(e instanceof WorktreeError ? e.code : "git_failed", (e as Error).message);
          }
        }
        case "worktree.cancel": {
          if (typeof msg.scan !== "string" || !msg.scan || msg.scan.length > 64) return fail("bad_request", "scan must be a string of at most 64 characters");
          // The aborted id stays (a request that arrives later is cancelled too), the oldest ones go past 1000.
          const ac = scans.get(msg.scan) ?? new AbortController();
          ac.abort();
          scans.set(msg.scan, ac);
          if (scans.size > 1000) scans.delete(scans.keys().next().value!);
          return reply({});
        }
        case "worktree.cached": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (!Array.isArray(msg.paths) || msg.paths.length > 500) return fail("bad_request", "paths must be an array of at most 500 paths");
          const paths = msg.paths.filter((p): p is string => typeof p === "string" && !!allowed(p));
          const statuses = await cachedStatuses(paths);
          for (const [p, st] of Object.entries(statuses)) {
            const running = [...sessions.values()].filter((s) => inDir(s.cwd, p) && ["running", "needs_input"].includes(s.info().state)).length;
            statuses[p] = classify({ ...st, running, blocked: st.blocked ?? (isRemoving(p) ? "removing" : running ? "sessions_running" : undefined) });
          }
          return reply({ statuses });
        }
        case "worktree.create":
        case "worktree.status":
        case "worktree.remove": {
          const cwd = allowed(msg.cwd);
          if (!cwd) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
          if (msg.type === "worktree.create" && msg.name !== undefined && typeof msg.name !== "string") return fail("bad_name", "name must be a string");
          if (msg.type === "worktree.create" && msg.branch !== undefined && typeof msg.branch !== "string") return fail("bad_name", "branch must be a string");
          if (msg.type === "worktree.create" && ((msg.base !== undefined && typeof msg.base !== "string") || (msg.checkout !== undefined && typeof msg.checkout !== "string"))) return fail("bad_request", "base and checkout must be strings");
          if (msg.type !== "worktree.remove" && (await gitOutside(cwd))) return fail("cwd_not_allowed", "The repository is outside the allowed roots");
          // A path that is itself a link is refused before `allowed` resolves it; git.ts checks the path git registers too.
          if (msg.type !== "worktree.create" && typeof msg.path === "string" && isAbsolute(msg.path) && !refused(msg.path) && lstatSync(msg.path, { throwIfNoEntry: false })?.isSymbolicLink()) return fail("not_removable", "The worktree path is a symbolic link");
          const path = msg.type === "worktree.create" ? undefined : allowed(msg.path);
          if (msg.type !== "worktree.create" && !path) return fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.path}`);
          if (msg.type === "worktree.status" && msg.scan !== undefined && !(typeof msg.scan === "string" && msg.scan && msg.scan.length <= 64)) return fail("bad_request", "scan must be a string of at most 64 characters");
          if (msg.type === "worktree.remove") {
            for (const k of ["expectSafe", "deleteBranch"] as const) if (msg[k] !== undefined && typeof msg[k] !== "boolean") return fail("bad_request", "expectSafe and deleteBranch must be booleans");
            const x = msg.expect as Record<string, unknown> | undefined;
            if (x !== undefined && !(x && typeof x === "object" && ["uncommitted", "ahead", "ignored"].every((k) => (k === "ignored" && x[k] === undefined) || (Number.isInteger(x[k]) && (x[k] as number) >= 0)))) return fail("bad_request", "expect must hold counts uncommitted and ahead, and optionally ignored");
          }
          try {
            if (msg.type === "worktree.create") return reply(await createIn(cwd, { name: msg.name || undefined, ...(msg.branch !== undefined && { branch: msg.branch }), ...(msg.base && { base: msg.base }), ...(msg.checkout !== undefined && { checkout: msg.checkout }) }));
            if (msg.type === "worktree.status") {
              // Always a fresh read (never the cache): the cache only feeds `worktree.cached`, which the dialogs show as Checking… until this lands.
              const check = () => worktreeStatus(cwd, msg.path, (p) => inRoots(real(p) ?? p));
              let st: Awaited<ReturnType<typeof worktreeStatus>>;
              if (msg.scan === undefined) st = await check();
              else {
                // The ids are the client's: one per Clean up; requests with the same id share one abort.
                const ac = scans.get(msg.scan) ?? new AbortController();
                scans.set(msg.scan, ac);
                if (ac.signal.aborted) return fail("cancelled", "cancelled");
                st = await lowPriority(ac.signal, check);
                if (ac.signal.aborted) return fail("cancelled", "cancelled");
              }
              const running = [...sessions.values()].filter((s) => inDir(s.cwd, path!) && ["running", "needs_input"].includes(s.info().state)).length;
              return reply(classify({ ...st, running, blocked: st.blocked ?? (isRemoving(path!) ? "removing" : running ? "sessions_running" : undefined) }));
            }
            return reply(await removeIn(cwd, msg.path, { expectSafe: msg.expectSafe === true, expect: msg.expect, deleteBranch: msg.deleteBranch === true }));
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
        case "fs.openExternal": {
          if (!opts.openExternal) return fail("unknown_type", "fs.openExternal is not available here");
          if (!sameHost) return fail("not_local", "Open in an app only works from a browser on the daemon machine");
          if (!isOpenWith(msg.with)) return fail("bad_request", `unknown with: ${String(msg.with)}`);
          const root = allowed(msg.cwd);
          if (!root) return fail("cwd_not_allowed", `outside the allowlisted roots: ${String(msg.cwd)}`);
          const target = allowed(msg.path);
          if (!target) return missingInRoots(msg.path) ? fail("not_found", `no such file: ${msg.path}`) : fail("path_not_allowed", `outside the allowlisted roots: ${String(msg.path)}`);
          try {
            const isDir = statSync(target).isDirectory();
            if (msg.with === "default" && isDir) return fail("bad_request", "a folder has no default app");
            if (msg.with === "custom") {
              // From the hub's own settings, never from the message.
              const argv = parseEditorCommand(appSettings.get().editor.command);
              const env = process.env;
              try {
                await opts.openExternal.run(customCommand(argv, target, root, isDir, process.platform, (n) => findOnPath({ platform: process.platform, env, exists: existsSync }, n)));
              } catch (err) {
                return fail((err as { code?: string }).code === "editor_missing" ? "editor_missing" : "open_failed", (err as Error).message);
              }
              return reply({});
            }
            const launcher = msg.with === "reveal" || msg.with === "default" ? undefined : opts.openExternal.editors().get(msg.with);
            if (msg.with !== "reveal" && msg.with !== "default" && !launcher) return fail("editor_missing", `${EDITORS[msg.with].label} is not installed`);
            const wslPath = msg.with === "reveal" || msg.with === "default" ? await opts.openExternal.winPath?.(target) : undefined;
            await opts.openExternal.run(openCommand(process.platform, msg.with, target, root, isDir, launcher, wslPath));
            return reply({});
          } catch (err) {
            return fail("open_failed", (err as Error).message);
          }
        }
        case "fs.write": {
          // Existing files only: the editor edits what the tree shows.
          const file = allowed(msg.path);
          if (!file) return fail("path_not_allowed", `outside the allowlisted roots: ${msg.path}`);
          if (typeof msg.content !== "string") return fail("bad_content", "content must be a string");
          return writeChecked(file, msg.path, msg.content, msg.baseMtime);
        }
        case "history.list":
        case "history.read":
        case "history.restore":
        case "history.rename":
        case "history.delete":
        case "history.create": {
          try {
            if (msg.type === "history.list") return reply({ entries: await localHistory.list(msg.path) });
            if (msg.type === "history.create") return reply({ entry: await localHistory.create(msg.path, msg.label) });
            if (typeof msg.id !== "string") return fail("bad_request", "id must be a string");
            if (msg.type === "history.read") return reply({ content: await localHistory.read(msg.path, msg.id) });
            if (msg.type === "history.rename") return await localHistory.rename(msg.path, msg.id, msg.label), reply({});
            if (msg.type === "history.delete") return await localHistory.remove(msg.path, msg.id), reply({});
            const content = await localHistory.read(msg.path, msg.id);
            const file = allowed(msg.path)!;
            // The conflict check comes first inside writeChecked; the current content is snapshotted there, with reason restore.
            return writeChecked(file, msg.path, content, msg.baseMtime, "restore");
          } catch (e) {
            if (e instanceof HistoryError) return fail(e.code, e.message);
            throw e;
          }
        }
        case "fs.create": {
          const r = createEntry(fsOps, msg.path, msg.dir === true);
          if (!("code" in r)) clearSearchCache();
          return "code" in r ? fail(r.code, r.message) : reply(r);
        }
        case "fs.rename": {
          if (msg.dir !== undefined && typeof msg.dir !== "string") return fail("bad_request", "dir must be a string");
          const r = await renameEntry(fsOps, msg.path, msg.name, msg.dir, msg.replace === true, (f) => localHistory.before(f, "paste"));
          if (!("code" in r)) clearSearchCache();
          return "code" in r ? fail(r.code, r.message) : reply(r);
        }
        case "fs.delete": {
          const r = await deleteEntry(fsOps, msg.path, msg.dryRun === true);
          if (!("code" in r)) clearSearchCache();
          return "code" in r ? fail(r.code, r.message) : reply(r);
        }
        case "fs.walk": {
          const r = await walkEntry(fsOps, msg.path);
          return "code" in r ? fail(r.code, r.message) : reply(r);
        }
        case "fs.copy": {
          const r = await copyEntry(fsOps, msg.from, msg.to);
          if (!("code" in r)) clearSearchCache();
          return "code" in r ? fail(r.code, r.message) : reply(r);
        }
        case "fs.readChunk": {
          if (!Number.isSafeInteger(msg.offset) || msg.offset < 0 || !Number.isSafeInteger(msg.length) || msg.length < 1 || msg.length > CHUNK_BYTES) return fail("bad_request", "offset and length must be integers, length 1..CHUNK_BYTES");
          const r = await readFileChunk(fsOps, msg.path, msg.offset, msg.length);
          return "code" in r ? fail(r.code, r.message) : reply(r);
        }
        case "fs.writeChunk": {
          if (!Number.isSafeInteger(msg.offset) || msg.offset < 0 || typeof msg.data !== "string" || msg.data.length > Math.ceil(CHUNK_BYTES / 3) * 4 + 4) return fail("bad_request", "offset must be an integer, data a base64 string of at most CHUNK_BYTES");
          if (msg.mode !== undefined && !Number.isSafeInteger(msg.mode)) return fail("bad_request", "mode must be an integer");
          const r = await writeFileChunk(fsOps, msg.path, msg.offset, Buffer.from(msg.data, "base64"), msg.mode);
          if (!("code" in r) && msg.offset === 0) clearSearchCache();
          return "code" in r ? fail(r.code, r.message) : reply(r);
        }
        case "fs.duplicate": {
          const r = await duplicateFile(fsOps, msg.path);
          if (!("code" in r)) clearSearchCache();
          return "code" in r ? fail(r.code, r.message) : reply(r);
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
            const canon = allowed(path);
            if (!canon || watched.has(path)) continue;
            // Parent folder dev/ino (not the file's: an atomic rename-write changes the file's inode).
            const dir = dirname(canon);
            let id;
            try {
              id = statSync(dir, { bigint: true });
            } catch {
              continue;
            }
            // GH-323: a link or swapped folder ends the watch, nothing is sent. A deleted file (real undefined) still reports.
            const listener = (curr: Stats, prev: Stats) => {
              const r = real(canon);
              const now = statSync(dir, { bigint: true, throwIfNoEntry: false });
              if ((r !== undefined && r !== canon) || !now || now.dev !== id.dev || now.ino !== id.ino) {
                unwatchFile(canon, listener);
                watched.delete(path);
              } else if (curr.mtimeMs !== prev.mtimeMs) send(ws, { type: "fs.changed", path, mtime: curr.mtimeMs });
            };
            watchFile(canon, { interval: WATCH_INTERVAL_MS }, listener);
            watched.set(path, { real: canon, listener });
          }
          return reply({ watching: [...watched.keys()] });
        }
        case "terminal.create": {
          const cwd = allowed(msg.cwd);
          if (!cwd || !statSync(cwd).isDirectory()) return fail("cwd_not_allowed", `not a directory inside the allowlisted roots: ${msg.cwd}`);
          if (isRemoving(cwd)) return fail("worktree_removing", "This worktree is being removed");
          if (!isSize(msg.cols) || !isSize(msg.rows)) return fail("bad_size", "cols and rows must be integers from 1 to 1000");
          if (msg.login !== undefined && msg.login !== true) return fail("bad_request", "login must be true");
          const full = terminals.limit(ws);
          if (full) return fail("too_many_terminals", full);
          try {
            const login = msg.login && { file: opts.claudeBin ?? claudeBin(), args: ["auth", "login"], title: "Claude login", onExit: (code: number) => code === 0 && claudeLoginChanged() };
            return reply({ terminal: terminals.create(cwd, msg.cols, msg.rows, ws, login || undefined) });
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
            const live = s?.cwd === cwd ? s.claudeQuery() : undefined;
            const r = msg.type.startsWith("skills.") ? await config.skills(msg as SkillsRequest, cwd, live) : await config.mcp(msg as McpRequest, cwd, live);
            if (msg.type === "skills.setState") commandCache.clear();
            return reply(r);
          } catch (e) {
            return fail(e instanceof ConfigError ? e.code : msg.type.startsWith("skills.") ? "skills_failed" : "mcp_failed", (e as Error).message);
          }
        }
        case "addons.list":
        case "addons.install":
        case "addons.checkUpdate":
        case "addons.update":
        case "addons.approve":
        case "addons.setEnabled":
        case "addons.uninstall":
        case "addons.pickRenderer": {
          if (!addons) return fail("addons_unavailable", "addons live on the Hub");
          try {
            return reply(await addons.handle(msg as AddonsRequest));
          } catch (e) {
            return fail(e instanceof ConfigError ? e.code : "addons_failed", (e as Error).message);
          }
        }
        case "update.check":
        case "update.install":
        case "update.restart": {
          if (!updater) return fail("update_unavailable", "updates are off (source checkout, --no-update-check or not started by claude-ui)");
          try {
            if (msg.type === "update.check") return reply(await updater.checkNow());
            return reply(msg.type === "update.install" ? { installed: await updater.install() } : { waitingFor: updater.restart(msg.now === true) });
          } catch (e) {
            return fail((e as { code?: string }).code ?? "update_failed", (e as Error).message);
          }
        }
        case "launcher.shortcut": {
          if (!opts.shortcut) return fail("shortcut_unavailable", "this daemon cannot make a launcher shortcut");
          if (typeof msg.on !== "boolean") return fail("bad_request", "on must be true or false");
          try {
            return reply({ installed: await opts.shortcut.set(msg.on) });
          } catch (e) {
            return fail("shortcut_failed", (e as Error).message);
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
        localSessionIds: async () => new Set([...(await sessionIds()).filter((id) => UUID.test(id)), ...sessions.keys()]),
        sameHost: sameBrowser,
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
  const virtual = new Set<Conn>();
  const accept = (ws: Conn) => (virtual.add(ws), ws.on("close", () => virtual.delete(ws)), void wss.emit("connection", ws, undefined));
  // A blocked worker_wait ends with a tool error instead of hanging until the CLI is gone.
  const idleCloseMs = opts.idleCloseMs ?? IDLE_CLOSE_MS;
  // ponytail: one scan per minute over all sessions; fine for tens of sessions.
  const reaper =
    idleCloseMs > 0
      ? setInterval(() => {
          const now = Date.now();
          for (const s of sessions.values()) {
            // An Aside whose popup is gone (browser closed, reload): thrown away, not only its CLI closed.
            if (asideOf(s.id) && !holds.get(s.id) && now - (touched.get(s.id) ?? 0) >= idleCloseMs && !["running", "needs_input"].includes(s.info().state)) {
              console.log(`session ${s.id}: aside without a popup for ${Math.round(idleCloseMs / 60_000)} min, deleted`);
              void deleteSessionById(s.id, true).then(
                (err) => console.log(`session ${s.id}: aside delete ${err ? `failed: ${err.message}` : "done"}`),
                (e) => console.error(`session ${s.id}: aside delete failed:`, e),
              );
              continue;
            }
            if (!holds.get(s.id) && s.live() && now - (touched.get(s.id) ?? 0) >= idleCloseMs && !orchestration.waitingOnWorkers(s.id) && s.releaseQuery()) {
              console.log(`session ${s.id}: idle ${Math.round(idleCloseMs / 60_000)} min without a tab, CLI closed`);
              orchestration.released(s.id);
            }
          }
        }, Math.min(IDLE_CHECK_MS, idleCloseMs)).unref()
      : undefined;
  // Links of daemons that stopped: every minute, whether idle close is on or not.
  const asideSweeper = setInterval(() => void cleanupAsides({ foreignOnly: true }), opts.asideSweepMs ?? IDLE_CHECK_MS).unref();
  const sweepMs = opts.uploadSweepMs ?? UPLOAD_SWEEP_MS;
  const sweepUploads = () =>
    uploads
      .sweep(async (id) => sessions.has(id) || restoring.has(id) || uploads.hasDraftId(id) || folderInUse(id) || (await history.getSessionInfo(id).catch(() => true)) !== undefined)
      .then((gone) => gone.length && console.log(`uploads: removed ${gone.length} orphaned folder(s)`))
      .catch((e) => console.error("uploads: sweep failed:", e));
  const firstSweep = sweepMs > 0 ? setTimeout(() => void sweepUploads(), opts.uploadSweepFirstMs ?? 60_000).unref() : undefined;
  const sweeper = sweepMs > 0 ? setInterval(() => void sweepUploads(), sweepMs).unref() : undefined;
  http.on("close", () => (clearInterval(sleepTimer), backReminders?.stop(), opts.keepAwake?.close(), orchestration.shutdown(), [...mcpRoutes.keys()].forEach(dropMcp), void openCode.close(), clearInterval(reaper), clearInterval(asideSweeper), clearTimeout(firstSweep), clearInterval(sweeper), perfMon.close(), warmCommit.stop()));
  // transcriptCaches: sessions whose parsed transcript the daemon holds (tests). orchestration: its tools (tests).
  return Object.assign(http, {
    accept,
    transcriptCaches: () => [...caches.keys()],
    orchestration,
    /** Attach server (ADR 0009): a turn runs. A turn that waits on a permission prompt or a question is idle (`needs_input`). */
    busy: () => [...sessions.values()].some((s) => s.info().state === "running"),
    /** Browser connections: the real WebSocket clients, not the virtual connections of attached Hubs. */
    browsers: () => connections.size - virtual.size,
    /** An attach-started Hub at the end of its Grace period: closes every session (the CLI ends, pending requests are abandoned) and terminal. */
    stopAll: async () => {
      await Promise.all([...sessions.values()].map((s) => s.close().catch(() => {})));
      await terminals.closeIn(() => true);
    },
  });
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
