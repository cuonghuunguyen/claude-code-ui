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

export type DaemonContext = {
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
  opts: Pick<DaemonOptions, "keepAwake" | "push" | "shortcut">;
};
