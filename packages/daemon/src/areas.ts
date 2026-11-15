// The areas of one connection (CONTEXT.md "Area"): each owns the handlers of a set of client message types.
// A type set is a template-literal `Extract`, so a new type in wire.ts is a typecheck error until its area handles it.
import { createEngineArea } from "./area-engine.ts";
import { createGitArea } from "./area-git.ts";
import { createWorktreeArea } from "./area-worktree.ts";
import { createSettingsArea } from "./area-settings.ts";
import { createFilesArea } from "./area-files.ts";
import { createTerminalArea } from "./area-terminal.ts";
import { createConfigArea } from "./area-config.ts";
import { createSessionsArea } from "./area-sessions.ts";
import type { DaemonContext } from "./daemon-context.ts";
import { createDispatch, type ClientType, type Connection, type DispatchedType, type Handlers } from "./dispatch.ts";

export type GitTypes = Extract<ClientType, `git.${string}`>;
export type WorktreeTypes = Extract<ClientType, `worktree.${string}`>;
export type FilesTypes = Exclude<Extract<ClientType, `fs.${string}`>, "fs.upload"> | Extract<ClientType, `history.${string}` | "media.read">;
export type TerminalTypes = Extract<ClientType, `terminal.${string}`>;
export type ConfigTypes = Extract<ClientType, `mcp.${string}` | `plugins.${string}` | `marketplace.${string}` | `skills.${string}`>;
export type EngineTypes = Extract<ClientType, `opencode.${string}`>;
export type SettingsTypes = "settings.get" | "settings.set" | "launcher.shortcut" | Extract<ClientType, `jira.${string}` | `claude.account.${string}` | `perf.${string}` | `push.${string}` | `addons.${string}` | `update.${string}`>;

/** The sessions, the remainder of the dispatched types: every new type has exactly one home. */
export type SessionsTypes = Exclude<DispatchedType, EngineTypes | SettingsTypes | GitTypes | WorktreeTypes | FilesTypes | TerminalTypes | ConfigTypes>;

/** The areas of one connection and the one dispatch over them. */
export function connectAreas(ctx: DaemonContext, conn: Connection) {
  const engine = createEngineArea(ctx);
  const settings = createSettingsArea(ctx, conn);
  const git = createGitArea(ctx);
  const worktree = createWorktreeArea(ctx);
  const files = createFilesArea(ctx, conn);
  const terminal = createTerminalArea(ctx, conn);
  const config = createConfigArea(ctx);
  const sessions = createSessionsArea(ctx, conn);
  // Every dispatched type has a handler: a missing key is a typecheck error.
  ({ ...engine.handlers, ...settings.handlers, ...git.handlers, ...worktree.handlers, ...files.handlers, ...terminal.handlers, ...config.handlers, ...sessions.handlers }) satisfies Handlers<DispatchedType>;
  return createDispatch([engine, settings, git, worktree, files, terminal, config, sessions]);
}
export type { Handlers };
