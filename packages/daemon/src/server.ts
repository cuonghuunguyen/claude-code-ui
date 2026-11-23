// HTTP server for the built web app plus the WebSocket endpoint at /ws.
import { planDirs } from "./plan-dirs.ts";
import { localSettingsFiles } from "./local-settings.ts";
import { closeSync, createReadStream, existsSync, fstatSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unwatchFile, watchFile, type Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir, hostname as osHostname, tmpdir } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { DEFAULT_ENGINE, createAdapter, type Settings, editorLabel, type Engine as EngineName, type PromptResult, type EditorId, imageBlock, LOCAL_SIDE, MAX_UPLOAD_BYTES, TOKEN_PROTOCOL_PREFIX, WS_PROTOCOL, type BackMark, BACK_BRIEF_MAX, BACK_TAG, type ClientMessage, type ListResult, type MediaReadResult, type ModelInfo, type ServerMessage, type SessionListItem, type SlashCommand, type Worktree } from "@claude-ui/protocol";
import { deleteSession, forkSession, getSessionInfo, getSessionMessages, getSubagentMessages, listSessions, listSubagents, renameSession, tagSession, type query as sdkQuery, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ARTIFACT_ASSET_HEADERS, ARTIFACT_PREVIEW_MAX, artifactHeaders, assetKey, assetRequestAllowed, scratchpadOf } from "./artifact-preview.ts";
import { configDir } from "./token.ts";
import { createLocalHistory} from "./local-history.ts";
import { createSleepWatch, SLEEP_CHECK_MS, SLEEP_KEEP_MS, type Slept } from "./sleep-watch.ts";
import { asideDisallowed, portListening } from "./aside.ts";
import { createReplaceUndo} from "./replace.ts";
import { clearSearchCache} from "./search.ts";
import { createReposCache } from "./repos-cache.ts";
import { foreignPointer, refusedPath, winPathKind } from "./remote-path.ts";
import { type FsOpsContext } from "./fs-ops.ts";
import { openChecked, OPEN_READ, real} from "./fd-check.ts";
import { MEDIA_CHUNK, MEDIA_HEADERS, MEDIA_TTL_MS, mediaType, parseRange } from "./media.ts";
import { performance } from "node:perf_hooks";
import { createPerf, setPerf, type PerfMonitor } from "./perf.ts";
import { connectAreas } from "./areas.ts";
import { WATCH_INTERVAL_MS } from "./area-files.ts";
import type { DaemonContext, MediaEntry, MediaRead } from "./daemon-context.ts";
import type { Connection } from "./dispatch.ts";
import { createJira, jiraOrigin } from "./jira.ts";
import { createSecrets, type Secrets } from "./secrets.ts";
import { createWorktree, gitDirsOf, gitEscapes, gitStatus, gitTopOf, limiter, listRepos, listWorktrees, originKeyOf, removeWorktree, WorktreeError, markRepoStale, markWorktreeStale, type CreateWorktreeOptions } from "./git.ts";
import { createWarmCommitMessage } from "./commit-message.ts";
import { createNotifier, type Push } from "./push.ts";
import { createSettings, type AppSettings } from "./settings.ts";
import { createCatalogues, EngineError, type CatalogueContext, type CatalogueList, type EngineCatalogue, type EngineRequest, type ListCtx } from "./engine-catalogue.ts";
import { ARCHIVED_TAG, createClaudeCatalogue, transcriptFile, type History } from "./claude-catalogue.ts";
import { createOpenCodeCatalogues } from "./opencode-catalogues.ts";
import { createProjects, trim, type Projects } from "./projects.ts";
import { claudeEnv, setClaudeToken } from "./claude-env.ts";
import { historySettings, inlineTaskSettings, jiraSettings, projectOverrides } from "./project-overrides.ts";
import { TEST_ARGS, TEST_TIMEOUT_MS, testOutcome } from "./claude-test.ts";
import { createPlanTrackers, RESET_GRACE_MS, usesOauthToken } from "./plan-usage.ts";
import { createPromptQueue } from "./prompt-queue.ts";
import { briefPrompt, find as findMark } from "./back-marks.ts";
import { createBackReminders, TICK_MS as BACK_TICK_MS, type Due } from "./back-reminders.ts";
import { CONTINUE_GAP_MS, CONTINUE_PROMPT, createAutoContinue } from "./auto-continue.ts";
import { listModels, queuedQuery, Session, type SessionSettings, type Transcript } from "./session.ts";
import { createTerminals } from "./terminals.ts";
import { ConfigError, createConfig, runCli, timed, type CliRunner} from "./config.ts";
import { createPlugins } from "./plugins.ts";
import { addonAssetHeaders, addonHeaders, createAddons } from "./addons.ts";
import { MAX_THEME_CSS, scopeCss } from "./addon-css.ts";
import { cliTurnRunning, JsonlTail, parseJsonl, transcriptEnd, withoutForkPrefix } from "./transcript.ts";
import type { KeepAwake } from "./keep-awake.ts";
import { EDITORS, type Launcher, type OpenCommand } from "./open-external.ts";
import { createRouter, type Sides } from "./sides.ts";
import { createListVersions } from "./list-versions.ts";
import { createSessionSettings } from "./session-settings.ts";
import { createUploads } from "./uploads.ts";
import { createFirstSend } from "./first-send.ts";
import { createUpdater, type Updater } from "./update.ts";
import { createOrchestration, SERVER as ORCHESTRATION_SERVER } from "./orchestration.ts";
import { createDaemonMcp, DAEMON_SERVER, ToolError } from "./daemon-mcp.ts";
import { createAgentTerminals, terminalPort } from "./agent-terminals.ts";
import { createForkGroups } from "./fork-guidance.ts";
import { createInlineTask } from "./inline-task.ts";
import type { AddressInfo } from "node:net";
import { serveAppIcon } from "./app-icon.ts";
import { serveStatic } from "./static.ts";
import { VISUALIZE_HEADERS, VISUALIZE_SHELL, visualizePluginDir } from "./visualize.ts";
import { listSessionsOffThread, patchScan, type Scanned, transcriptStamp } from "./session-scan.ts";

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

export { REPLAY_MAX_EVENTS } from "./area-sessions.ts";

/** ws maxPayload (default 100 MiB): a prompt with two images at MAX_UPLOAD_BYTES as base64, plus the JSON around them. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Transcript restores running at once. */
const MAX_RESTORES = 2;

/** Idle close of unheld sessions (docs/spec.md "Idle close"): the one place of the timeout and the scan interval. */
export const IDLE_CLOSE_MS = 10 * 60_000;
/** Orphaned upload folders are looked for this often (uploads.ts sweep). */
const UPLOAD_SWEEP_MS = 6 * 3600_000;
const IDLE_CHECK_MS = 60_000;

/** A new connection gets a fresh plan usage read when the last one is older (reset times pass without a turn). */
const PLAN_STALE_MS = 5 * 60_000;
const PING_MS = 15_000;
/** A socket without a pong for this many ticks is dropped even while it takes data or sends messages (a slow drip must not keep it forever). */
const PING_MAX_SILENT_TICKS = 8;
const LAG_TICK_MS = 500;
const LAG_LOG_MS = 1_000;
const MEM_LOG_MS = 10 * 60_000;
const mb = (n: number) => Math.round(n / 2 ** 20);


const LOCAL_HOSTNAMES = ["127.0.0.1", "localhost"];
/** A connection whose browser runs on this machine: a local Host name and a loopback peer (a Tailscale or LAN Host, and a side's virtual connection, are not). */
const sameMachine = (req: IncomingMessage | undefined) => {
  try {
    return !!req && [...LOCAL_HOSTNAMES, "[::1]"].includes(new URL("http://" + req.headers.host).hostname) && /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? "");
  } catch {
    return false;
  }
};

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
  /** This daemon's persistent identity for `daemon_hello` (main.ts: `loadDaemonId()`); default a random id per run. */
  daemonId?: string;
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
  /** opencode-adapters.json: which OpenCode adapter each session belongs to (ADR 0015). Default: in memory (tests). */
  opencodeAdaptersFile?: string;
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
  opencode?: { command?: string[]; env?: () => NodeJS.ProcessEnv; startTimeoutMs?: number; /** How long `session.list` waits for OpenCode (default 3 s). */ listWaitMs?: number; /** How long the MCP servers dialog waits for OpenCode before it shows the servers as pending (default 3 s). */ mcpWaitMs?: number };
  /** Test seam: replaces the built-in Claude and OpenCode catalogues (fake Engines need no process). */
  catalogues?: (ctx: CatalogueContext) => EngineCatalogue[];
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
  /** A background resubscribe behind by more events than this gets the snapshot (default REPLAY_MAX_EVENTS). */
  replayMaxEvents?: number;
  /** Update checks and installs (update.ts); none: no update_available, update.* fail. Checks start with the daemon. */
  update?: Omit<Parameters<typeof createUpdater>[0], "busy" | "broadcast">;
}) {
  const hostnames = new Set([...LOCAL_HOSTNAMES, ...(opts.hostnames ?? [])]);
  const logEpoch = randomUUID();
  const daemonId = opts.daemonId ?? randomUUID();
  /** The versions of the lists sent to pages (`session.list {since}` answers a delta, GH-767); one per daemon, a reconnect is a new connection. */
  const listVersions = createListVersions(logEpoch);
  /** fs.upload storage: one private folder per session; a session gets only its own as an additional directory, so Claude reads an attachment without asking (uploads.ts). */
  const uploads = createUploads({ dir: opts.uploadDir });
  const firstSend = createFirstSend();
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
  // Account-wide, so not a session event: every connection gets each change. One tracker per Claude account in use (GH-900): the global account and every
  // account a Project overrides it with. `account_usage` carries each; `plan_usage` stays the global account's (an older page shows only that).
  const plans = createPlanTrackers({
    onChange: (key, usage) => {
      broadcast({ type: "account_usage", key, usage });
      if (key === globalAccount()) broadcast({ type: "plan_usage", usage });
    },
    read: (key, refresh) => queuedQuery(refresh, opts.query, { env: claudeEnvOf(key) }),
    oauthToken: (key) => (key === globalAccount() ? opts.oauthToken : undefined) ?? usesOauthToken(claudeEnvOf(key)),
    name: (key) => accountNameOf(key),
  });
  /** Options of every session: settings changes are saved under its ID. */
  // Local settings files per cwd. `Session.snapshot()` is synchronous, so `planDirs` reads this cache; async paths refresh or warm it.
  const localFilesCache = new Map<string, string[]>();
  const localFiles = async (cwd: string) => {
    const files = await localSettingsFiles(cwd);
    localFilesCache.set(cwd, files);
    return files;
  };
  const cachedLocalFiles = (cwd: string) => localFilesCache.get(cwd) ?? [join(cwd, ".claude", "settings.local.json")];
  const sessionOpts = (initial: Partial<SessionSettings>) => ({
    ...initial,
    plan: (cwd: string) => plans.ensure(accountKeyOf(cwd)),
    promptSuggestions: () => appSettings.get().focus.nextForYou,
    chrome: () => appSettings.get().chrome.enabled,
    fork: () => appSettings.get().fork.enabled,
    claudeEnv: (cwd: string) => claudeEnvFor(cwd),
    visualizePlugin: () => (appSettings.get().chat.visualize ? visualizePluginDir() : undefined),
    // `resetsAt`: the event's, else the plan fallback of the Session's own account (claude-engine.ts).
    onLimitStop: (id: string, at: number | undefined) => {
      sessions.get(id)?.setLimitStop(at);
      autoContinue.schedule(id, at);
      // Queued messages wait for the reset (after an automatic continue), else for the user: sending into the limit would burn them one by one.
      queue.hold(id, at ? at + (opts.autoContinue?.graceMs ?? RESET_GRACE_MS) + (opts.autoContinue?.gapMs ?? CONTINUE_GAP_MS) : undefined);
    },
    allowBypass: opts.allowBypass,
    onFileEdit: (path: string, original: string) => localHistory.before(path, "agent", original),
    // `live` of the session list changed (CLI started or dropped).
    onLiveChange: (id: string) => {
      broadcast({ type: "sessions.changed" });
      orchestration.liveChanged(id);
    },
    supportsAuto,
    uploadDir: (id: string) => {
      try {
        return uploads.dirFor(id);
      } catch (e) {
        console.error(`session ${id}: upload folder failed:`, e);
        return undefined;
      }
    },
    subagentsDir: (id: string, cwd: string) => transcriptFile(projectsDir, transcriptCwd(id, cwd), id).replace(/\.jsonl$/, "/subagents"),
    query: opts.query,
    readTranscript,
    // The stale-turn check reads only the transcript's tail, not the chain and its subagent runs (GH-239).
    transcriptEnd: (id: string, cwd: string) => transcriptEnd(transcriptFile(projectsDir, transcriptCwd(id, cwd), id)),
    cliTurnRunning: (id: string) => cliTurnRunning(claudeDir, id),
    planDirs: (cwd: string) => planDirs(claudeDir, cwd, cachedLocalFiles(cwd)),
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
    mcpServers: (id: string, engine?: "claude" | "opencode") => {
      const o = orchestration.mcpServers(id);
      const d = daemonMcp.mcpServers(id, engine);
      return o || d ? { ...o, ...d } : undefined;
    },
    agent: (id: string) => settings.get(id)?.agent,
    disallowedTools: (id: string) => asideDisallowed(settings.get(id)),
    daemonMcp: { openCodeRules: (name: string, ask: "ask" | "allow" | "deny") => daemonMcp.openCodeRules(name, ask), timeoutMs: () => daemonMcp.timeoutMs() },
    toolPolicy: (tool: string, mcpServer?: { name: string; source: string }) => orchestration.toolPolicy(tool, mcpServer) ?? daemonMcp.toolPolicy(tool, mcpServer),
    preflight: (id: string, tool: string, input: Record<string, unknown>, mcp?: { name: string; source: string }) => orchestration.preflight(id, tool, input, mcp),
    permissionCard: (id: string, tool: string, input: Record<string, unknown>, mcp?: { name: string; source: string }) => orchestration.permissionCard(id, tool, input, mcp) ?? daemonMcp.permissionCard(id, tool, input, mcp),
  });
  const restoring = new Map<string, Promise<Session | undefined>>();
  // Sessions whose delete is in progress (session.delete).
  const deleting = new Set<string>();
  const history = { listSessions: listSessionsOffThread, getSessionInfo, getSessionMessages, listSubagents, getSubagentMessages, renameSession, tagSession, deleteSession, forkSession, ...opts.history };
  const claudeDir = opts.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  const projectsDir = opts.projectsDir ?? join(claudeDir, "projects");
  const projects = opts.projects ?? createProjects();
  const appSettings = opts.appSettings ?? createSettings();
  /** GH-668: the ready Haiku process of Generate; used only while `git.commitMessageWarm` is on. */
  const warmCommit = createWarmCommitMessage(opts.query);
  /**
   * Orchestration MCP of OpenCode sessions (docs/spec.md "Orchestration"): OpenCode connects to `/opencode-mcp` of this daemon with a
   * per-session bearer token (token -> session id); one stateful transport and server per token, a new `initialize` replaces both.
   */
  const mcpRoutes = new Map<string, { id: string; server: typeof ORCHESTRATION_SERVER | typeof DAEMON_SERVER; live?: { transport: StreamableHTTPServerTransport; server: McpServer }; init?: Promise<boolean> }>();
  const dropMcp = (token: string) => {
    void mcpRoutes.get(token)?.live?.server.close().catch(() => {});
    mcpRoutes.delete(token);
  };
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
        const server = route.server === DAEMON_SERVER ? daemonMcp.mcpServerFor(route.id) : orchestration.mcpServerFor(route.id);
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
  /** Settings `sessions.engine`: the Engine of the last created session; not when its Project sets the Engine itself (that choice must not become the global one). */
  const rememberEngine = (engine: EngineName, cwd: string) => {
    if (appSettings.get().sessions.engine === engine) return;
    if (projectOverrides(appSettings.get(), cwd).engine !== undefined) return;
    try {
      broadcastSettings(appSettings.set({ sessions: { engine } }));
    } catch (err) {
      console.error("saving the last engine failed:", err);
    }
  };
  /** The undo records of applied `fs.replace` calls (docs/spec.md "Editor"), shared by every connection. */
  const replaceUndo = createReplaceUndo();
  /** Local history (local-history.ts): `before()` is the one entry point for every write that replaces file content (editor save, agent Edit/Write, git writes). */
  const localHistory = createLocalHistory({ dir: opts.historyDir ?? join(tmpdir(), `claude-ui-history-${randomUUID()}`), settings: (path) => historySettings(appSettings.get(), path), allowed: (p) => allowed(p) });
  const secrets = opts.secrets ?? createSecrets();
  const jira = createJira({ config: (project) => jiraSettings(appSettings.get(), project), token: (o) => secrets.jiraToken(o), ...(opts.jiraFetch && { fetch: opts.jiraFetch }) });
  /** `settings.get` / `settings.set` / `jira.token` reply: the settings, the daemon, whether a Jira token is saved (never the token). */
  const settingsReply = (settings = appSettings.get()) => ({ settings, daemon: daemonInfo(), jiraToken: !!secrets.jiraToken(jiraOrigin(settings.jira.url)), jiraTokens: secrets.jiraOrigins(), projectPatch: true as const, claudeAccounts: secrets.claudeAccounts(), ...(secrets.jiraTokenReset() && { jiraTokenReset: true as const }) });
  /** The Claude account of the settings as the CLI env takes it: undefined = Default, null = CLI login, a token; an unknown id (removed, hand edit) is Default. */
  const accountToken = () => {
    const a = appSettings.get().claude.account;
    return a === "cli" ? null : a ? secrets.claudeToken(a) : undefined;
  };
  /** The CLI env of a session in `cwd`: its Project's Claude account when it overrides one (`""` = Default, `"cli"`, an account id; an unknown id is Default, as for the global setting), else the daemon's. */
  const claudeEnvFor = (cwd: string) => {
    const a = projectOverrides(appSettings.get(), cwd).account;
    return a === undefined ? claudeEnv() : claudeEnv(process.env, a === "cli" ? null : a ? secrets.claudeToken(a) : undefined);
  };
  /** An account setting as the CLI env takes it: `""` Default, `"cli"`, a token account id; an unknown id (removed, hand edit) is Default. */
  const accountKey = (a: string) => (a === "" || a === "cli" || secrets.claudeAccounts().some((x) => x.id === a) ? a : "");
  /** The Claude account key of the daemon's own setting. */
  const globalAccount = () => accountKey(appSettings.get().claude.account);
  /** The Claude account key a CLI started for `cwd` runs on: its Project's override, else the global one (`claudeEnvFor` is its env). */
  const accountKeyOf = (cwd: string) => accountKey(projectOverrides(appSettings.get(), cwd).account ?? appSettings.get().claude.account);
  const claudeEnvOf = (key: string) => claudeEnv(process.env, key === "cli" ? null : key ? secrets.claudeToken(key) : undefined);
  const accountNameOf = (key: string) => (key === "cli" ? "CLI login" : key ? secrets.claudeAccounts().find((x) => x.id === key)?.name : undefined);
  /** Account keys the settings name: the global one and every Project override. */
  const accountKeysOf = (settings: Settings) => [accountKey(settings.claude.account), ...Object.values(Object.hasOwn(settings.projects.overrides, "local") ? settings.projects.overrides.local! : {}).flatMap((o) => (o.account === undefined ? [] : [accountKey(o.account)]))];
  let lastGlobalAccount: string | undefined;
  /** Settings changed: one tracker per account in use. */
  const syncAccounts = () => {
    plans.sync(accountKeysOf(appSettings.get()));
    lastGlobalAccount = globalAccount();
  };
  /**
   * An override account changed (global change: `claudeLoginChanged`): the live CLI of each local Claude Session whose account differs from
   * `before`'s is replaced, idle now, busy at the end of its turn (the popover switcher is the way out of a usage limit).
   */
  const projectAccountsChanged = (before: Settings) => {
    syncAccounts();
    const after = appSettings.get();
    // The raw setting, not the key: a removed account (unknown id now) differs from Default, and its Sessions still run on its token.
    const raw = (settings: Settings, cwd: string) => projectOverrides(settings, cwd).account ?? settings.claude.account;
    for (const s of sessions.values()) {
      if (!s.live() || raw(before, s.cwd) === raw(after, s.cwd)) continue;
      if (!s.releaseQuery()) s.staleLogin = true;
      else console.log(`session ${s.id}: Project Claude account changed, CLI closed`);
    }
  };
  setClaudeToken(accountToken());
  syncAccounts();
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
    broadcast({ type: "settings_changed", settings, jiraToken: r.jiraToken, jiraTokens: r.jiraTokens, claudeAccounts: r.claudeAccounts });
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
    return reposCache.get(key, () => listRepos(cwd, { settings, openFiles: open, refused, allowed: inside }), fresh);
  };
  const broadcast = (m: ServerMessage) => {
    if (m.type === "sessions.changed" || m.type === "settings_changed") (reposCache.clear(), clearSearchCache());
    connections.forEach((ws) => send(ws, m));
  };
  // ponytail: side sessions are not counted; a restart ends their running turns too.
  const updater: Updater | undefined =
    opts.update && createUpdater({ ...opts.update, busy: () => ({ sessions: [...sessions.values()].filter((s) => s.working()).length, terminals: terminals.count() }), broadcast });
  updater?.start();
  const config = createConfig({ envFor: claudeEnvFor, query: opts.query, cli: opts.cli, holdMs: opts.configHoldMs, pollMs: opts.configPollMs, onChanged: (kind, cwd) => (commandCache.clear(), broadcast({ type: "config.changed", kind, cwd })) });
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
  const addons = opts.addonsDir ? createAddons({ dir: opts.addonsDir, file: join(opts.addonsDir, "addons.json"), onChanged: () => broadcast({ type: "config.changed", kind: "addons", cwd: "" }), appVersion: opts.buildInfo?.version }) : undefined;
  const root = resolve(opts.webRoot);
  // Model list per Claude account key (its subscription decides which models and auto mode it offers), cached until the login or an account changes (claudeLoginChanged).
  const modelCaches = new Map<string, { list?: ReturnType<typeof listModels>; known: ModelInfo[]; loaded?: true }>();
  /** The account key of a model list request: the folder's Project account, the global one without a folder. */
  const modelKey = (cwd?: string) => (cwd === undefined ? globalAccount() : accountKeyOf(cwd));
  // Sync copy for SessionInfo.permissionModes: every path that builds a SessionInfo for a folder awaits modelList(cwd) first.
  const knownModels = (cwd?: string) => {
    const own = modelCaches.get(modelKey(cwd));
    // Not read yet for this account: the global list stands in until it is.
    return own?.loaded ? own.known : (modelCaches.get(globalAccount())?.known ?? []);
  };
  const modelList = (cwd?: string) => {
    const key = modelKey(cwd);
    const entry = modelCaches.get(key) ?? (modelCaches.set(key, { known: [] }), modelCaches.get(key)!);
    return (entry.list ??= listModels(opts.query, claudeEnvOf(key)).then((l) => ((entry.known = l), (entry.loaded = true), l))).catch((e) => {
      if (modelCaches.get(key) === entry) entry.list = undefined;
      throw e;
    });
  };
  /** The Claude login or account changed: models, plan usage and live CLIs are read again. */
  const claudeLoginChanged = () => {
    modelCaches.clear();
    for (const s of sessions.values()) {
      if (!s.releaseQuery()) s.staleLogin = true;
      else console.log(`session ${s.id}: Claude login changed, CLI closed`);
    }
    // The meter of the old global account stays until the new one answers: an empty one now (never null: it hides the meter).
    const hadUsage = lastGlobalAccount !== undefined && plans.get(lastGlobalAccount)?.current() !== undefined;
    syncAccounts();
    if (hadUsage && plans.get(globalAccount())?.current() === undefined) broadcast({ type: "plan_usage", usage: { plan: null, windows: [], status: "allowed" } });
    void plans.reset();
    // GH-668: the ready Haiku process holds the old login (token in its env).
    warmCommit.stop();
    if (appSettings.get().git.commitMessageWarm) warmCommit.prewarm();
    broadcast({ type: "config.changed", kind: "models", cwd: "" });
  };
  const supportsAuto = (model: string, cwd?: string) => knownModels(cwd).some((m) => m.value === model && m.supportsAutoMode);
  const roots = opts.roots.map(real).filter((r) => r !== undefined);
  /** UNC roots (configured and canonical form): the only UNC paths that may reach the file system (GH-282: an SMB lookup sends the NTLM hash). */
  const uncRoots = [...opts.roots, ...roots].filter((r) => winPathKind(r) === "unc");
  const refused = (p: string) => refusedPath(p, uncRoots);
  const inRoots = (path: string) =>
    roots.some((r) => {
      const rel = relative(r, path);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    });
  /** Path callback of git.ts, git-write.ts and git-remote.ts: inside a root, symlinks resolved. */
  const inside = (p: string) => inRoots(real(p) ?? p);
  /** A repository (top, git dirs: GH-290) that is not entirely inside the roots: no git request may read it. */
  const gitOutside = (cwd: string) => gitEscapes(cwd, inside);
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
    const entry = { stamp, list: listWorktrees(cwd, inside).finally(() => sp.end()) };
    worktreeLists.set(cwd, entry);
    // A failed read of a git folder (spawn error, killed process) is not kept: the next list reads again.
    void entry.list.then((l) => l === null && stamp !== "-" && worktreeLists.get(cwd) === entry && worktreeLists.delete(cwd));
    return entry.list;
  };

  /**
   * The origin key of each repository, read once per git common dir and again when `<common>/config` changes (file stats only on a hit:
   * a list runs on every turn start and end, and a git process blocks the event loop on Windows).
   */
  const originKeys = new Map<string, { stamp: string; key: Promise<string | undefined> }>();
  const originOf = (cwd: string) => {
    const common = gitDirsOf(cwd)?.common;
    if (!common) return Promise.resolve(undefined);
    const config = join(common, "config");
    let stamp = "-";
    try {
      const st = statSync(config);
      stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {}
    const hit = originKeys.get(common);
    if (hit?.stamp === stamp) return hit.key;
    // A failed read (timeout, spawn error) is not kept: the next list reads again.
    const entry: { stamp: string; key: Promise<string | undefined> } = {
      stamp,
      key: originKeyOf(cwd).catch(() => {
        if (originKeys.get(common) === entry) originKeys.delete(common);
        return undefined;
      }),
    };
    originKeys.set(common, entry);
    return entry.key;
  };

  /**
   * git.status of a folder, shared by the requests that arrive while it runs: the web app asks up to three times for the same
   * folder when a session opens (status bar, header, changes), and every git process start blocks the event loop on Windows.
   */
  const statusReads = new Map<string, ReturnType<typeof gitStatus>>();
  const statusOf = (cwd: string) => {
    let read = statusReads.get(cwd);
    if (!read) statusReads.set(cwd, (read = gitStatus(cwd, { allowed: inside, ignoreSubmodules: appSettings.get().git.ignoreSubmodules }).finally(() => statusReads.delete(cwd))));
    return read;
  };

  /** New worktree of `cwd`'s repository (roots enforced); other clients refresh their list. */
  const createIn = async (cwd: string, o: Pick<CreateWorktreeOptions, "name" | "branch" | "base" | "checkout" | "onCreated"> = {}) => {
    // The new path is no project: a session created in it (worker_start) must not add it.
    const r = await createWorktree(cwd, { ...o, allowed: inside, claudeDir, onCreated: (r) => { worktreePaths.add(r.path); return o.onCreated?.(r); } });
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
      const result = await removeWorktree(cwd, path, inside, { ...o, mark: (w) => {
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
        for (const c of new Set(live.map((s) => catalogues.ownerOf(s.id, s)))) c?.settled?.();
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
          .then(withoutForkPrefix)
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
    // Per folder and Project account: the list the CLI of that account reads.
    const cacheKey = `${cwd}\0${accountKeyOf(cwd)}`;
    const hit = commandCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 60_000) return hit.list;
    const list = queuedQuery((q) => q.supportedCommands(), opts.query, { cwd, persistSession: false, env: claudeEnvFor(cwd) }).then(
      (l) => (createAdapter().commands(l)[0] as { commands: SlashCommand[] }).commands,
    );
    commandCache.set(cacheKey, { at: Date.now(), list });
    list.catch(() => commandCache.delete(cacheKey));
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
        if (t === "session_state" && (e.part as { state?: string }).state === "idle") (markWorktreeStale(s.cwd), catalogues.ownerOf(s.id, s)?.settled?.());
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
      if (s.prompt(text, images) === undefined && out) {
        out.local = true;
        const draft = await s.localDraft();
        if (draft) out.draft = draft;
      }
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

  /** The claude-ui MCP server (CONTEXT.md "Daemon MCP server"): the tool groups every session's agent gets from the daemon. */
  const daemonMcp = createDaemonMcp({
    session: (id) => {
      const s = sessions.get(id);
      return s && { cwd: s.cwd };
    },
    groups: [
      createAgentTerminals({
        terminals: terminalPort(terminals),
        worktrees: (cwd) => worktreesOf(cwd),
        real: (p) => real(p) ?? p,
        known: () => [opts.token, ...secrets.values()],
        enabled: () => appSettings.get().terminalAccess.enabled,
      }),
      createInlineTask({
        enabled: () => appSettings.get().inlineTask.enabled,
        settings: () => appSettings.get().inlineTask,
        real: (p) => real(p) ?? p,
        run: async (id, spec, signal, toolUseId, input) => {
          const s = sessions.get(id);
          if (!s) throw new ToolError("This engine cannot run inline tasks.");
          // Each Engine takes its own model from the setting when the spec names none.
          return s.run.inlineTask(spec, { signal, toolUseId, input, settings: inlineTaskSettings(appSettings.get(), s.cwd) });
        },
      }),
      ...createForkGroups(
        () => appSettings.get().fork.enabled,
        async (id, spec, signal, input) => {
          const s = sessions.get(id);
          if (!s?.run.forkRun) throw new ToolError("This engine cannot run forks.");
          return s.run.forkRun(spec, { signal: signal ?? new AbortController().signal, input });
        },
      ),
    ],
  });
  /** Orchestration reads OpenCode's agents and models for its own checks; fake catalogues without OpenCode have none. */
  const openCodeCatalogue = () => {
    const c = catalogues.byName("opencode");
    if (!c) throw new Error("This daemon has no OpenCode engine");
    return c;
  };
  const orchestration = createOrchestration({
    links: settings,
    held: (id) => !!holds.get(id),
    settings: () => appSettings.get().orchestration,
    sessions,
    find: findSession,
    create: async (cwd, initial, engine) => {
      if (isRemoving(cwd)) throw new Error("This worktree is being removed");
      const s = await catalogues.byName(engine ?? DEFAULT_ENGINE)?.create(cwd, initial);
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
    openCodeAgents: async (cwd) => (await openCodeCatalogue().agents(cwd)).map((a) => a.name),
    agents: (cwd) => queuedQuery((q) => q.supportedAgents(), opts.query, { cwd, persistSession: false, env: claudeEnvFor(cwd) }).then((l) => l.map((a) => a.name)),
    models: () => knownModels(),
    openCodeModels: () => openCodeCatalogue().models(),
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
  // A running session writes its transcript every turn: a transcript added, changed or removed is read alone or dropped
  // (patchScan in session-scan.ts); only a case the SDK's list rules need all files for (same session in two folders,
  // continued-in, read error, many files) scans all again.
  let scan: ReturnType<typeof listSessions> | undefined;
  let nextScan: ReturnType<typeof listSessions> | undefined;
  let lastScan: { stamp: Map<string, string>; result: Scanned } | undefined;
  const listCache = opts.listCache ?? !opts.history?.listSessions;
  function transcripts(): ReturnType<typeof listSessions> {
    if (!scan) {
      // Taken before the scan: a file written during it changes the next stamp.
      return (scan = (async () => {
        const stamp = listCache ? await transcriptStamp(projectsDir) : undefined;
        const last = lastScan;
        if (stamp && last) {
          const sp = perfMon.span("session.scan");
          const result = await patchScan(last, stamp, projectsDir, (id) => history.getSessionInfo(id));
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

  /** The Engine catalogues (engine-catalogue.ts): everything about the stored sessions of an Engine. `opts.catalogues` replaces the built-in pair (tests). */
  const catalogueCtx: CatalogueContext = {
    track,
    sessionOpts,
    settings,
    saveSettings,
    appSettings,
    allowed: (p) => allowed(p),
    isRemoving,
    addProject,
    broadcast,
    liveSessions: () => sessions.values(),
    session: (id) => sessions.get(id),
    restoreSlot,
    allowBypass: opts.allowBypass,
  };
  const catalogues = createCatalogues(
    opts.catalogues?.(catalogueCtx) ?? [
      createClaudeCatalogue(catalogueCtx, {
        history: history as never,
        claudeDir,
        projectsDir,
        transcripts,
        readTranscript,
        transcriptCwds,
        stamps,
        statStamp,
        transcriptCwd,
        sessionCwd,
        modelList: (cwd) => modelList(cwd),
        supportsAuto,
        localFiles,
        commandsOf,
        claimUpload: (draft) => uploads.claim(draft),
        deleting,
        dropGone,
        modelListWaitMs: opts.modelListWaitMs,
      }),
      createOpenCodeCatalogues(catalogueCtx, {
        server: opts.opencode,
        adaptersFile: opts.opencodeAdaptersFile,
        // The local OpenCode server always reaches the daemon on 127.0.0.1 (it listens there or on 0.0.0.0).
        mcp: {
          url: () => {
            const a = http.address();
            return a && typeof a === "object" ? `http://127.0.0.1:${a.port}/opencode-mcp` : undefined;
          },
          token: (id, server) => {
            for (const [t, r] of mcpRoutes) if (r.id === id && r.server === server) return t;
            const t = randomBytes(32).toString("base64url");
            mcpRoutes.set(t, { id, server });
            return t;
          },
          drop: (id) => {
            for (const [t, r] of mcpRoutes) if (r.id === id) dropMcp(t);
          },
        },
      }),
    ],
  );
  /** Requests only one Engine answers, by message type. */
  const engineRequests = new Map<string, EngineRequest>(catalogues.all.flatMap((c) => Object.entries(c.requests ?? {}) as [string, EngineRequest][]));

  /** A session's title as list() gives it: its Engine's title, "New session" without stored data. */
  async function titleOf(s: Session) {
    if (s.untitled()) return "New session";
    return (await catalogues.ownerOf(s.id, s)?.title(s)) ?? "New session";
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

  /** session.ids: what findSession could restore, without reading any stored session (each Engine's known ids). */
  async function sessionIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const c of catalogues.all) for (const id of await c.knownIds()) ids.add(id);
    for (const id of sessions.keys()) ids.add(id);
    for (const id of deleting) ids.delete(id);
    return [...ids];
  }

  async function listNow(): Promise<ListResult> {
    // One read of sessions.json per list (settings.get() reads the file again on every call, json-file.ts), made when the first catalogue asks.
    let snapshot: ReturnType<ListCtx["read"]> | undefined;
    const read = () =>
      (snapshot ??= (() => {
        const linked = new Map(settings.entries());
        // A coordinator is a session with a worker.
        const coordinators = new Set([...linked.values()].flatMap((l) => (l.coordinatorId && l.name ? [l.coordinatorId] : [])));
        const links = (id: string) => {
          const l = linked.get(id);
          return { ...(coordinators.has(id) && { coordinator: true as const }), ...(l?.coordinatorId && l.name && { coordinatorId: l.coordinatorId, workerName: l.name }) };
        };
        return { linked, links };
      })());
    const lists: CatalogueList[] = [];
    const items = new Map<string, SessionListItem>();
    // The Engines whose store is one global scan list first: their sessions seed the project list.
    for (const c of catalogues.all)
      if (c.listScope === "roots") {
        const l = await c.list({ read });
        lists.push(l);
        for (const i of l.items) items.set(i.id, i);
      }
    // Sessions whose stored data was never seen in this run (no prompt sent, or its first prompt failed before the CLI wrote one).
    for (const s of sessions.values())
      if (!items.has(s.id) && !read().linked.get(s.id)?.ownerId) items.set(s.id, { ...s.info(), title: "New session", lastActivity: s.createdAt, archived: false, transcript: false, ...(!s.live() && { live: false as const }), ...read().links(s.id) });
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
    const origins: Record<string, string> = {};
    await Promise.all(
      open.map(async (cwd) => {
        // The project's own folder: a linked worktree of a bare repository has no main entry, and every worktree shares the common dir.
        const key = await originOf(cwd);
        if (key) origins[cwd] = key;
      }),
    );
    worktreePaths = new Set(Object.values(worktrees).flatMap((l) => l.filter((w) => !w.outsideRoots).map((w) => w.path)));
    // Sessions of a project's worktrees show under the project (outside the roots there are none: `listed` has only allowed cwds).
    const shown = new Set([...open, ...worktreePaths]);
    const byId = new Map(listed.map((s) => [s.id, s]));
    // The Engines whose store is asked per folder list after the project list, for the shown folders.
    for (const c of catalogues.all)
      if (c.listScope === "folders") {
        const l = await c.list({ read, folders: [...shown] });
        lists.push(l);
        for (const i of l.items) byId.set(i.id, i);
      }
    const all2 = [...byId.values()];
    // Entries of sessions deleted outside this daemon (CLI, file removed): no stored data and not live (session-settings.ts prune).
    // Each Engine keeps the entries of what it listed, or of what it did not ask about.
    saveSettings(() => settings.prune((id) => sessions.has(id) || lists.some((l) => l.keep(id))));
    const topIds = new Set(all2.filter((s) => shown.has(trim(s.cwd))).map((s) => s.id));
    return {
      engines: catalogues.all.map((c) => c.entry()),
      projects: open,
      recentProjects: projects.recent(listed).filter((r) => !shown.has(r.cwd)),
      worktrees,
      origins,
      // A worker of a listed coordinator shows under it, also when the user removed the worker's project.
      sessions: all2.filter((s) => topIds.has(s.id) || (s.coordinatorId && topIds.has(s.coordinatorId))).sort((a, b) => b.lastActivity - a.lastActivity),
      permissionModes: catalogues.byName(DEFAULT_ENGINE)?.entry().permissionModes ?? [],
    };
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

  /** Why the last restore of a session was refused (the session exists but needs another binary); read right after `findSession` answered undefined. */
  const refusals = new Map<string, { code: string; message: string }>();
  /** A session of this daemon run, or one rebuilt from its SDK transcript (ADR 0001). Concurrent calls share one restore. */
  /** `background`: a follow without a hold; its restore waits behind foreground ones. */
  function findSession(id: string, background = false): Promise<Session | undefined> {
    refusals.delete(id);
    // Its transcript still exists until the delete ends; a restore now would bring the session back.
    if (deleting.has(id)) return Promise.resolve(undefined);
    const live = sessions.get(id);
    if (live) return Promise.resolve(live);
    // The ID becomes a transcript file name or a request path; only the shape of an Engine's own IDs may reach it.
    const owner = catalogues.ownerOf(id);
    if (!owner) return Promise.resolve(undefined);
    let p = restoring.get(id);
    // A foreground ask for a restore that waits in the queue moves it ahead of the background ones.
    if (p && !background) for (const q of restoreQueue) if (q.id === id) q.background = false;
    if (!p) {
      p = owner
        .restore(id, background)
        .catch((err) => {
          // A session of the other OpenCode version: the user is told, not shown "no session".
          if (err instanceof EngineError && err.code === "opencode_version_mismatch") refusals.set(id, { code: err.code, message: err.message });
          else console.error(`restoring session ${id} failed:`, err);
          return undefined;
        })
        .finally(() => restoring.delete(id));
      restoring.set(id, p);
    }
    return p;
  }

  /** Working directory and transcript of a listed session (live or inside the roots); undefined when unknown. */
  async function locate(id: string) {
    const live = sessions.get(id);
    const at = await catalogues.ownerOf(id, live)?.locate(id, live);
    return at && { ...at, live };
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
      await catalogues.ownerOf(id, at.live)?.delete(id, at);
    } catch (e) {
      return { code: "delete_failed", message: (e as Error).message };
    } finally {
      deleting.delete(id);
      // A refresh the Engine held back for this running session no longer waits for it.
      catalogues.ownerOf(id, at.live)?.settled?.();
    }
    caches.delete(id);
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
    catalogues.ownerOf(id, s)?.forget?.(id);
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

  const media = new Map<string, MediaEntry>();
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
  /** A theme's CSS file rewritten under its theme root (addon-css.ts). A file that does not scan (broken CSS) or is over the cap is replaced by an empty stylesheet, so a defect costs the theme its rules and never leaks them to other themes (the lint reports it). Cached per file content (a hash, so an edit that keeps size and mtime is seen). */
  const scopedCss = new Map<string, Buffer>();
  const EMPTY_CSS = Buffer.from("/* theme css not served: it is broken or over 512 KB (see the addon lint) */\n");
  const serveScopedCss = (req: IncomingMessage, res: ServerResponse, o: { fd: number; size: number }, path: string, scope: string, names: string | undefined, baseCss: string[] = []) => {
    let body: Buffer;
    try {
      const st = fstatSync(o.fd);
      if (st.size > MAX_THEME_CSS) body = EMPTY_CSS; // over the cap: the file is not read into memory
      else {
        const raw = readFileSync(o.fd);
        // Base css files of an extending theme (their names are shared): read with the cap, part of the cache key.
        const bases = baseCss.flatMap((p) => {
          try {
            return statSync(p).size <= MAX_THEME_CSS ? [readFileSync(p, "utf8")] : [];
          } catch {
            return [];
          }
        });
        const key = `${path}\0${scope}\0${createHash("sha1").update(raw).update(bases.join("\0")).digest("hex")}`;
        let hit = scopedCss.get(key);
        if (!hit) {
          try {
            hit = Buffer.from(scopeCss(raw.toString("utf8"), scope, names, bases));
          } catch {
            hit = EMPTY_CSS; // CssScanError, or any other failure of the scan; cached so a bad file costs one scan per version
          }
          for (const k of scopedCss.keys()) if (k.startsWith(`${path}\0${scope}\0`)) scopedCss.delete(k); // the older versions of this file under this scope
          scopedCss.set(key, hit);
          if (scopedCss.size > 64) scopedCss.delete(scopedCss.keys().next().value!);
        }
        body = hit;
      }
    } catch {
      closeSync(o.fd);
      return void res.writeHead(500).end();
    }
    closeSync(o.fd);
    res.writeHead(200, { ...addonAssetHeaders, "content-type": "text/css; charset=utf-8", "content-length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  /** GET /addon/<nonce>/<name>/<path> (GH-516): a file of an enabled addon. HTML only as a frame (addon CSP); other files as subresources. */
  const serveAddon = (req: IncomingMessage, res: ServerResponse, nonce: string, name: string, rest: string) => {
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405, { allow: "GET, HEAD" }).end();
    const theme = /^[a-z0-9]+(-[a-z0-9]+)*$/.exec(new URL(req.url ?? "/", "http://x").searchParams.get("theme") ?? "")?.[0];
    const as = new URL(req.url ?? "/", "http://x").searchParams.get("as") ?? undefined;
    const f = addons && nonce === addons.nonce ? addons.serve(name, rest, theme, as) : undefined;
    if (!f) return void res.writeHead(404).end();
    const h = req.headers;
    const dest = h["sec-fetch-dest"] as string | undefined;
    if (f.html) {
      if (!requestOk(req) || (dest && dest !== "iframe")) return void res.writeHead(403).end();
    } else if (!hostOk(req) || !assetRequestAllowed({ origin: h.origin, dest, mode: h["sec-fetch-mode"] as string | undefined }, isOwnOrigin(req, hostnames))) return void res.writeHead(403).end();
    const o = openArtifact(f.path, !f.html);
    if (!o) return void res.writeHead(404).end();
    if (f.scope) return serveScopedCss(req, res, o, f.path, f.scope, f.names, f.baseCss);
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
  // Local: live here, or stored here by the Engine the id's shape names (a Side holds the rest).
  const isLocalSession = async (id: string) => sessions.has(id) || !!(await catalogues.ownerOf(id)?.isLocal(id));

  // Ping each socket every interval; one that did not pong since the previous tick is half-open (phone asleep, wifi gone, no FIN):
  // terminate it so its close handler runs (focused tab, subscriptions, watches), else its stale "focused" entry mutes push.
  // A pong is not the only sign of life: the ping queues behind what the daemon already wrote (a resync burst on a slow link), so a socket
  // that takes data (buffer shrinks) or sends messages is alive; only silence on all three drops it, and a hard cap bounds a slow drip.
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
    const secs = (opts.pingMs ?? PING_MS) / 1000;
    for (const ws of [...connections]) {
      const st = connStats.get(ws);
      if (st) {
        const buffered = ws.bufferedAmount;
        if (!st.ponged) {
          st.silent++;
          const received = st.recvMsgs - st.recvAtTick;
          const draining = buffered < st.bufAtTick;
          const cap = st.silent >= PING_MAX_SILENT_TICKS;
          if (cap || (!received && !draining)) {
            const why = cap ? `no pong for ${st.silent} ticks (${st.silent * secs}s)` : `no pong in ${secs}s`;
            console.warn(`${new Date().toISOString()} ws: ${why}, dropped (${connections.size - 1} left); open ${Math.round((Date.now() - st.openedAt) / 1000)}s, ${statText(st, `buffered ${mbText(buffered)} (prev tick ${mbText(st.bufAtTick)})`)}`);
            drop(ws);
            continue;
          }
          console.warn(`${new Date().toISOString()} ws: no pong in ${secs}s, kept: ${received ? `${received} msgs received` : `draining ${mbText(st.bufAtTick)} -> ${mbText(buffered)}`}`);
        } else st.silent = 0;
        st.ponged = false;
        st.recvAtTick = st.recvMsgs;
        st.bufAtTick = buffered;
      }
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

  /** What the areas (area-*.ts) reach of this daemon. Built once, after every closure it names exists. */
  const ctx: DaemonContext = {
    findSession,
    restoreRefusal: (id: string) => refusals.get(id),
    locate,
    titleOf,
    list,
    listVersions,
    sessionIds,
    rememberEngine,
    addProject,
    projects,
    deleting,
    localFiles,
    localFilesCache,
    mirror,
    holds,
    unhold,
    queue,
    sendPrompt,
    runBash,
    briefDropped,
    briefFailed,
    startBrief,
    dropQueuedBrief,
    asideOf,
    settings,
    saveSettings,
    orchestration,
    deleteSessionById,
    broadcast,
    clock,
    logEpoch,
    checkArtifact,
    scratchpadRoot,
    within,
    transcripts,
    transcriptCwd,
    sessionCwd,
    projectsDir,
    port: () => (http.address() as AddressInfo | null)?.port,
    allowed,
    inside,
    refused,
    roots,
    missingInRoots,
    claudeDir,
    git: { allowed, inside, topOf: gitTopOf, markStale: markRepoStale },
    statusOf,
    reposOf,
    lastOpen,
    localHistory,
    netSlot,
    gitOutside,
    createIn,
    removeIn,
    isRemoving,
    inDir,
    appSettings,
    secrets,
    jira,
    settingsReply,
    broadcastSettings,
    testAccount,
    applyAccountToken: () => setClaudeToken(accountToken()),
    claudeLoginChanged,
    projectAccountsChanged,
    accountOf: (cwd: string) => ({ env: claudeEnvFor(cwd), global: accountKeyOf(cwd) === globalAccount() }),
    warmCommit,
    catalogues,
    autoContinue,
    sessions,
    perfMon,
    firstSend,
    syncRunning,
    addons,
    updater,
    focused,
    covered,
    media,
    fsOps,
    replaceUndo,
    uploads,
    terminals,
    config,
    plugins,
    commandCache,
    engineRequests,
    opts,
  };

  wss.on("connection", (ws: Conn, req?: IncomingMessage) => {
    const sameBrowser = sameMachine(req);
    // A WSL daemon's attached Hub is the Windows Hub of this machine, which checked its own browser (ADR 0011).
    const sameHost = sameBrowser || (virtual.has(ws) && !!opts.openExternal?.winPath);
    // Before `connections.add`: a sleep found now is broadcast to the others, then sent once to this connection below.
    sleepWatch?.check();
    connections.add(ws);
    const openedAt = Date.now();
    const stat: ConnStat = { openedAt, sentMsgs: 0, sentBytes: 0, recvMsgs: 0, lastRecvAt: undefined, ua: String(req?.headers["user-agent"] ?? "-").slice(0, 160), ponged: true, silent: 0, recvAtTick: 0, bufAtTick: 0 };
    connStats.set(ws, stat);
    ws.on("pong", () => (stat.ponged = true));
    ws.on("message", () => (stat.recvMsgs++, (stat.lastRecvAt = Date.now())));
    // First: the page reads the daemon's identity and epoch before anything else (GH-771).
    send(ws, { type: "daemon_hello", daemonId, logEpoch });
    syncAccounts();
    const global = plans.get(globalAccount())?.current();
    if (global !== undefined) send(ws, { type: "plan_usage", usage: global });
    for (const key of plans.keys()) {
      const t = plans.get(key)!;
      const usage = t.current();
      if (usage !== undefined) send(ws, { type: "account_usage", key, usage });
      if (t.age() > PLAN_STALE_MS) void t.reread();
    }
    updater?.messages().forEach((m) => send(ws, m));
    const stale = opts.buildInfo?.stale();
    if (stale) send(ws, { type: "daemon_stale", note: stale });
    if (slept && (opts.watchSleep?.now ?? Date.now)() - slept.at > SLEEP_KEEP_MS) slept = undefined;
    if (slept) send(ws, { type: "daemon_slept", ...slept });
    // fs.media: key (canonical path, "blob\0cwd\0hash\0path", "<side>\0cwd\0hash\0path") -> nonce issued to this connection.
    const mediaNonces = new Map<string, string>();
    const nonceFor = (key: string) => mediaNonces.get(key) ?? (mediaNonces.set(key, randomBytes(16).toString("hex")), mediaNonces.get(key)!);
    // Without a listener a socket error (e.g. a frame above maxPayload) is thrown and the daemon exits; ws closes the socket itself.
    ws.on("error", (err) => console.warn("ws:", err.message));
    ws.on("close", (code) => {
      console.log(`${new Date().toISOString()} ws: closed${code ? ` code ${code}` : ""} after ${Math.round((Date.now() - openedAt) / 1000)}s (${connections.size - 1} left); ${statText(stat)}`);
      router?.close();
      connections.delete(ws);
      mediaNonces.forEach((n) => (media.get(n)?.live?.forEach((r) => r.destroy()), media.delete(n)));
      areas.close();
      focused.delete(ws);
      covered.delete(ws);
    });
    const onMessage = async (data: RawData, receivedAt = 0) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return send(ws, { type: "error", code: "bad_json", message: "invalid JSON" });
      }
      if (typeof msg !== "object" || msg === null || Array.isArray(msg))
        return send(ws, { type: "error", code: "bad_message", message: "message must be a JSON object" });
      if (msg.type === "ping" && msg.note) console.warn(`${new Date().toISOString()} ws: page reconnected after: ${String(msg.note).slice(0, 600)}`);
      if (msg.type === "ping") return send(ws, { type: "reply", reqId: msg.reqId, result: {} });
      // Timed here, before the router, so a request a side serves or the router answers itself is attributed too.
      const end = perfMon.request(String(msg.type), typeof (msg as { cwd?: unknown }).cwd === "string" ? (msg as { cwd: string }).cwd : undefined, receivedAt);
      try {
        if (router) return await router.handle(msg as ClientMessage & Record<string, unknown>);
        return await local(msg, (m) => send(ws, m));
      } finally {
        end();
      }
    };
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
    const conn: Connection = { ws, send: (m) => send(ws, m), sameHost, sameBrowser, fromHub: virtual.has(ws), nonceFor };
    const areas = connectAreas(ctx, conn);
    /** Handles a message in this daemon; its reply or error goes to `out`, events and streams to this connection. */
    const local = areas.dispatch;
    const router =
      opts.sides &&
      createRouter({
        sides: opts.sides,
        send: (m) => send(ws, m),
        local: (msg) => local(msg, (m) => send(ws, m)),
        encodeList: (result, since) => listVersions.encode(result, since),
        localCall: (msg) =>
          new Promise<ServerMessage>((resolve) =>
            local(msg, resolve).catch((err) => (console.error("request handler failed:", err), resolve({ type: "error", reqId: msg.reqId, code: "internal_error", message: "request failed" }))),
          ),
        isLocalSession,
        localSessionIds: async () => new Set([...(await sessionIds()), ...sessions.keys()]),
        sameHost: sameBrowser,
        media: sideMedia,
        mediaTimeoutMs: opts.sideCallTimeoutMs,
      });
    // A handler that throws fails its request: a rejected promise nobody awaits would end the process (Node's default).
    ws.on("message", (data) =>
      onMessage(data, perfMon.stamp()).catch((err) => {
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
  http.on("close", () => (clearInterval(sleepTimer), addons?.close(), backReminders?.stop(), opts.keepAwake?.close(), orchestration.shutdown(), [...mcpRoutes.keys()].forEach(dropMcp), void Promise.all(catalogues.all.map((c) => c.close())), clearInterval(reaper), clearInterval(asideSweeper), clearTimeout(firstSweep), clearInterval(sweeper), perfMon.close(), warmCommit.stop()));
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


/** The options of `createDaemon` (the areas name the ones they read). */
export type DaemonOptions = Parameters<typeof createDaemon>[0];



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

/** What the keep-alive and the drop and close log lines know of one connection (docs/spec.md "Daemon WebSocket keep-alive"). */
interface ConnStat {
  openedAt: number;
  sentMsgs: number;
  sentBytes: number;
  recvMsgs: number;
  lastRecvAt: number | undefined;
  ua: string;
  /** A pong came since the previous tick. */
  ponged: boolean;
  /** Ticks in a row without a pong. */
  silent: number;
  /** `recvMsgs` and `bufferedAmount` at the previous tick. */
  recvAtTick: number;
  bufAtTick: number;
}
const connStats = new WeakMap<Conn, ConnStat>();
const mbText = (n: number) => `${(n / 2 ** 20).toFixed(1)}MB`;
/** Counters of the drop and close lines: `sent 412 msgs 3.1MB, ... recv 37 msgs, last recv 12s ago`. */
const statText = (st: ConnStat, buffered?: string) =>
  `sent ${st.sentMsgs} msgs ${mbText(st.sentBytes)}${buffered ? `, ${buffered}` : ""}, recv ${st.recvMsgs} msgs${buffered ? `, last recv ${st.lastRecvAt === undefined ? "never" : `${Math.round((Date.now() - st.lastRecvAt) / 1000)}s ago`}` : ""}, ua ${JSON.stringify(st.ua)}`;

function send(ws: Conn, m: ServerMessage) {
  if (ws.readyState !== ws.OPEN) return;
  const data = JSON.stringify(m);
  ws.send(data);
  const st = connStats.get(ws);
  if (st) (st.sentMsgs++, (st.sentBytes += Buffer.byteLength(data)));
}
