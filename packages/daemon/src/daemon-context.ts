// What the areas (area-*.ts) may reach of the daemon: one object, built once in createDaemon, named after the closures it replaces.
// Type only. Each area narrows it with `Pick<DaemonContext, ...>`, so a test fakes only what its area reads.
import type { Session } from "./session.ts";
import type { Conn, DaemonOptions } from "./server.ts";
import type { Settings } from "@claude-ui/protocol";
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
import type { WorktreeRemoveResult } from "@claude-ui/protocol";

export type DaemonContext = {
  // Roots and paths
  /** The canonical path when it is an existing path inside a root. */
  allowed(path: unknown): string | undefined;
  /** Path callback of git.ts, git-write.ts and git-remote.ts: inside a root, symlinks resolved. */
  inside(p: string): boolean;
  /** A path a request must not reach (UNC outside the roots). */
  refused(p: string): boolean;
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
  // Settings and accounts
  appSettings: ReturnType<typeof createSettings>;
  secrets: ReturnType<typeof createSecrets>;
  jira: ReturnType<typeof createJira>;
  /** The `settings.get` reply: the settings, the daemon, whether a Jira token is saved (never the token). */
  settingsReply(settings?: Settings): object;
  broadcastSettings(settings?: Settings): void;
  /** `claude.account.test`: one CLI run per account at a time. */
  testAccount(id: string, token: string, env: NodeJS.ProcessEnv): Promise<ReturnType<typeof testOutcome>>;
  /** The CLI env takes the token of the settings' Claude account (`setClaudeToken(accountToken())`). */
  applyAccountToken(): void;
  /** The Claude login or account changed: models, plan usage and live CLIs are read again. */
  claudeLoginChanged(): void;
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
  // Engines
  /** Requests only one Engine answers (its provider login, its server restart), by message type. */
  engineRequests: ReadonlyMap<string, EngineRequest>;
  /** The options createDaemon was given that handlers read. */
  opts: Pick<DaemonOptions, "keepAwake" | "push" | "shortcut" | "query">;
};
