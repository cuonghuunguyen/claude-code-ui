// What the areas (area-*.ts) may reach of the daemon: one object, built once in createDaemon, named after the closures it replaces.
// Type only. Each area narrows it with `Pick<DaemonContext, ...>`, so a test fakes only what its area reads.
import type { Session } from "./session.ts";
import type { Conn, DaemonOptions } from "./server.ts";
import type { ServerMessage, Settings } from "@claude-ui/protocol";
import type { createSettings } from "./settings.ts";
import type { createSecrets } from "./secrets.ts";
import type { createJira } from "./jira.ts";
import type { createWarmCommitMessage } from "./commit-message.ts";
import type { Catalogues, EngineRequest } from "./engine-catalogue.ts";
import type { createAutoContinue } from "./auto-continue.ts";
import type { PerfMonitor } from "./perf.ts";
import type { createAddons } from "./addons.ts";
import type { Updater } from "./update.ts";
import type { testOutcome } from "./claude-test.ts";
import type { GitRequestContext } from "./git-request.ts";
import type { CreateWorktreeOptions, gitEscapes, gitStatus, limiter, listRepos } from "./git.ts";
import type { createLocalHistory } from "./local-history.ts";
import type { MediaReadResult, SlashCommand, WorktreeRemoveResult } from "@claude-ui/protocol";
import type { ServerResponse } from "node:http";
import type { createReplaceUndo } from "./replace.ts";
import type { FsOpsContext } from "./fs-ops.ts";
import type { createUploads } from "./uploads.ts";
import type { FirstSend } from "./first-send.ts";
import type { createTerminals } from "./terminals.ts";
import type { createConfig } from "./config.ts";
import type { createPlugins } from "./plugins.ts";
import type { createListVersions } from "./list-versions.ts";
import type { createPromptQueue } from "./prompt-queue.ts";
import type { createSessionSettings } from "./session-settings.ts";
import type { createOrchestration } from "./orchestration.ts";
import type { Projects } from "./projects.ts";
import type { Engine as EngineName, ListResult, PromptResult } from "@claude-ui/protocol";
import type { listSessions } from "@anthropic-ai/claude-agent-sdk";

/** Piece of a media file: undefined when it can no longer be read (gone, outside the roots, side stopped). */
export type MediaRead = (offset: number, length: number) => Promise<MediaReadResult | undefined>;
/** fs.media capabilities: nonce -> a hub file (canonical path, streamed from disk) or bytes read in pieces (a file at a commit, a side's file), issuing connection, last use. */
export type MediaEntry = { src: { kind: "file"; path: string } | { kind: "artifact"; named: string; path: string; page: string; confine: string[]; assets: Map<string, { named: string; path: string; type: string }> } | { kind: "page"; named: string; path: string; key: string; root?: string } | { kind: "bytes"; read: MediaRead; mime: string; name: string } | { kind: "sidePage"; page: string; assets: boolean; read: (key: string, offset: number, length: number) => Promise<MediaReadResult | undefined> }; ws: Conn; used: number; live?: Set<ServerResponse> };

export type DaemonContext = {
  // Roots and paths
  /** The canonical path when it is an existing path inside a root. */
  allowed(path: unknown): string | undefined;
  /** Path callback of git.ts, git-write.ts and git-remote.ts: inside a root, symlinks resolved. */
  inside(p: string): boolean;
  /** A path a request must not reach (UNC outside the roots). */
  refused(p: string): boolean;
  /** The canonical roots. */
  roots: string[];
  /** A missing absolute path whose nearest existing ancestor is allowed: deleted inside the roots (outside them, existence stays hidden). */
  missingInRoots(path: unknown): boolean;
  /** `~/.claude`, or the configured Claude config directory. */
  claudeDir: string;
  // Git and worktrees
  /** What git requests need from this daemon (git-request.ts). */
  git: GitRequestContext;
  statusOf(cwd: string): ReturnType<typeof gitStatus>;
  /** git.repos of `cwd`, cached 10 s; fs.search uses it too. */
  reposOf(cwd: string, open: string[], fresh?: boolean): ReturnType<typeof listRepos>;
  /** Open files of each cwd's last git.repos. */
  lastOpen: Map<string, string[]>;
  localHistory: ReturnType<typeof createLocalHistory>;
  /** Network git calls: at most 2 at a time. */
  netSlot: ReturnType<typeof limiter>;
  /** A repository that is not entirely inside the roots: no git request may read it. */
  gitOutside(cwd: string): ReturnType<typeof gitEscapes>;
  createIn(cwd: string, o?: Pick<CreateWorktreeOptions, "name" | "branch" | "base" | "checkout" | "onCreated">): Promise<{ path: string; branch: string }>;
  removeIn(cwd: string, path: string, o: { expectSafe?: boolean; expect?: { uncommitted: number; ahead: number; ignored?: number }; deleteBranch?: boolean }): Promise<WorktreeRemoveResult>;
  /** A session or terminal may not start in a worktree being removed. */
  isRemoving(cwd: string): boolean;
  inDir(cwd: string, p: string): boolean;
  /** GH-663: the session or worker located in worktree `p` whose worker tree is busy (`name` = worker chain path, "" for a plain session); undefined when none. */
  workerHold(p: string): { id: string; name: string } | undefined;
  // Files, terminals and configuration
  /** Capabilities of fs.media: nonce -> source. */
  media: Map<string, MediaEntry>;
  fsOps: FsOpsContext;
  replaceUndo: ReturnType<typeof createReplaceUndo>;
  /** The upload folders; `fs.read` also reads a visualize file there. */
  uploads: ReturnType<typeof createUploads>;
  /** Draft and `once` keys of a first send, for an idempotent retry (first-send.ts). */
  firstSend: FirstSend;
  terminals: ReturnType<typeof createTerminals>;
  config: ReturnType<typeof createConfig>;
  plugins: ReturnType<typeof createPlugins>;
  /** Slash commands per cwd; cleared when the configuration changes. */
  commandCache: Map<string, { at: number; list: Promise<SlashCommand[]> }>;
  // Settings and accounts
  appSettings: ReturnType<typeof createSettings>;
  secrets: ReturnType<typeof createSecrets>;
  jira: ReturnType<typeof createJira>;
  /** The `settings.get` reply: the settings, the daemon, which Jira origins have a saved token (never a token). */
  settingsReply(settings?: Settings): object;
  broadcastSettings(settings?: Settings): void;
  /** `claude.account.test`: one CLI run per account at a time. */
  testAccount(id: string, token: string, env: NodeJS.ProcessEnv): Promise<ReturnType<typeof testOutcome>>;
  /** The CLI env takes the token of the settings' Claude account (`setClaudeToken(accountToken())`). */
  applyAccountToken(): void;
  /** The Claude login or account changed: models, plan usage and live CLIs are read again. */
  claudeLoginChanged(): void;
  /** An account a Project overrides changed (not the global one): trackers follow, the live CLI of each Session whose account changed is replaced. `before`: the settings before the change. */
  projectAccountsChanged(before: Settings): void;
  /** The Claude account of the CLI processes started for `cwd`: their env, and whether it is the global account. */
  accountOf(cwd: string): { env: NodeJS.ProcessEnv; global: boolean };
  warmCommit: ReturnType<typeof createWarmCommitMessage>;
  catalogues: Catalogues;
  autoContinue: ReturnType<typeof createAutoContinue>;
  sessions: ReadonlyMap<string, Session>;
  perfMon: PerfMonitor;
  syncRunning(): void;
  addons: ReturnType<typeof createAddons> | undefined;
  updater: Updater | undefined;
  /** Session a connection shows while its tab is focused and visible. */
  focused: Map<Conn, string>;
  /** Sessions a connection's page shows in-app notification cards for. */
  covered: Map<Conn, Set<string>>;
  // Sessions
  /** The live session, else restored from disk (`background`: a reconnect resubscribe, not a user's open). */
  findSession(id: string, background?: boolean): Promise<Session | undefined>;
  /** After `findSession` answered undefined: the refusal that explains it (the session needs an OpenCode binary of the other version), else undefined (no such session). */
  restoreRefusal(id: string): { code: string; message: string } | undefined;
  /** Where a session is: its folder and whether it is live (undefined: no such session). */
  locate(id: string): Promise<{ cwd: string; live: Session | undefined } | undefined>;
  titleOf(s: Session): Promise<string>;
  list(): Promise<ListResult>;
  listVersions: ReturnType<typeof createListVersions>;
  sessionIds(): Promise<string[]>;
  /** Remembers the Engine of the last new session. */
  rememberEngine(engine: EngineName, cwd: string): void;
  /** Records Engine, model and effort of a new session as its Project's last choice (Settings `projects.lastUsed`); `side` LOCAL_SIDE: a folder of this daemon. */
  rememberLastUsed(side: string, cwd: string, engine: EngineName, model: unknown, effort: unknown): void;
  addProject(cwd: string): void;
  projects: Projects;
  /** Sessions being deleted. */
  deleting: Set<string>;
  localFiles(cwd: string): Promise<string[]>;
  localFilesCache: Map<string, string[]>;
  /** Follows the session's transcript file for changes made by a terminal CLI; the function releases it. */
  mirror(s: Session): () => void;
  /** Subscribers per session that keep its CLI from idle close. */
  holds: Map<string, number>;
  unhold(id: string): void;
  queue: ReturnType<typeof createPromptQueue>;
  sendPrompt(s: Session, text: string, images?: string[], stillWanted?: () => boolean, out?: PromptResult): Promise<{ code: string; message: string } | undefined>;
  runBash(s: Session, command: string): Promise<{ code: string; message: string } | undefined>;
  briefDropped(sessionId: string, item: { brief?: string } | undefined): unknown;
  briefFailed(sessionId: string, partId: string, why: string, at?: number): unknown;
  startBrief(s: Session, partId: string, refresh: boolean): Promise<unknown>;
  dropQueuedBrief(sessionId: string, partId: string): void;
  /** The owner of an Aside, undefined for any other session. */
  asideOf(id: string): string | undefined;
  /** The links of sessions (sessions.json). */
  settings: ReturnType<typeof createSessionSettings>;
  saveSettings(change: () => void): void;
  orchestration: ReturnType<typeof createOrchestration>;
  deleteSessionById(id: string, force?: boolean): Promise<{ code: string; message: string } | undefined>;
  broadcast(m: ServerMessage): void;
  clock: () => number;
  logEpoch: string;
  checkArtifact(named: string, kind?: "page" | "asset", confine?: string[]): { path: string; size: number; mtime: number } | { code: string; message: string };
  /** One piece (`length` at most MEDIA_CHUNK, 0 for size and mtime only) of the page or a supporting file `key` of an artifact entry, checked again with the rules of /artifact; `not_found` for any mismatch. */
  readArtifactPiece(src: Extract<MediaEntry["src"], { kind: "artifact" | "page" }>, key: string, offset: number, length: number): MediaReadResult | { code: string; message: string };
  scratchpadRoot(cwd: string, sessionId: string): string | undefined;
  within(path: string, dir: string): boolean;
  transcripts(): ReturnType<typeof listSessions>;
  transcriptCwd(id: string, cwd: string): string;
  sessionCwd(cwd: string): string;
  projectsDir: string;
  /** The port this daemon listens on. */
  port(): number | undefined;
  // Engines
  /** Requests only one Engine answers (its provider login, its server restart), by message type. */
  engineRequests: ReadonlyMap<string, EngineRequest>;
  /** The options createDaemon was given that handlers read. */
  opts: Pick<DaemonOptions, "keepAwake" | "attached" | "replayMaxEvents" | "push" | "shortcut" | "query" | "openExternal" | "claudeBin">;
};
