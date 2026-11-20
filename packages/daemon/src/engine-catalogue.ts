// The Engine catalogue (CONTEXT.md "Engine catalogue", ADR 0012): everything about the stored sessions of one Engine outside a live run.
// The `Engine` (engine.ts) is the live run; `catalogue.engine` reaches it. server.ts knows only this interface and the registry.
import type { ClientMessage, Engine as EngineName, EngineCapabilities, ModelInfo, PermissionMode, ServerMessage, SessionListItem, SlashCommand } from "@claude-ui/protocol";
import type { Engine } from "./engine.ts";
import type { Session, SessionSettings } from "./session.ts";
import type { Link, SessionSettingsStore } from "./session-settings.ts";
import type { AppSettings } from "./settings.ts";

/** The value of the app settings. */
export type Settings = ReturnType<AppSettings["get"]>;
/** A session's saved settings and its orchestration and Aside links (sessions.json). */
export type SavedSession = Partial<SessionSettings> & Link;

export const isModel = (m: unknown): m is string => typeof m === "string" && m.trim() !== "";

/** A failure of an Engine the user must see: `code` is the wire error code. */
export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** What a list read gives a catalogue: sessions.json links (read when asked, once per list) and the ids of the coordinators and workers among them. */
export type ListCtx = {
  /** The link store of the list: read when first asked and then kept for this list (a catalogue whose store is scanned asks after its scan). */
  read(): { linked: Map<string, SavedSession>; links: (id: string) => object };
  /** `listScope: "folders"` only: the folders shown (projects and their worktrees). */
  folders?: string[];
};
/** `keep(id)`: the settings entry of a session id of this Engine stays (it is known, or this list did not ask). */
export type CatalogueList = { items: SessionListItem[]; keep(id: string): boolean };
export type EngineEntry = { engine: EngineName; capabilities: EngineCapabilities; permissionModes: PermissionMode[] };
export type EngineRequest = (msg: ClientMessage, reply: (result: unknown) => void, fail: (code: string, message: string) => void) => Promise<void>;

/** The config dialogs of a non-Claude Engine (ADR 0012). `mcp` replies McpListResult, McpAuthResult or {} and takes every `mcp.*` request, `skills` every `skills.*` request; a missing control is a capability gap, never an emulation. Throws EngineError for a failure the user must see. */
export type EngineConfig = {
  mcp(msg: Extract<ClientMessage, { type: `mcp.${string}` }>, cwd: string, ctx: { /** The request comes from a browser on the daemon machine (ADR 0011). */ local: boolean }): Promise<unknown>;
  /** `skills.list` replies SkillsResult, `skills.setState` SkillsSetStateResult. */
  skills(msg: Extract<ClientMessage, { type: `skills.${string}` }>, cwd: string): Promise<unknown>;
};

export interface EngineCatalogue {
  /** The config dialogs of this Engine; absent = none (the request is refused with `config_unsupported`). */
  readonly config?: EngineConfig;
  /** The live run of this Engine's sessions. */
  readonly engine: Engine;
  /**
   * How the store is listed. `roots`: one global scan; its items come first and seed the project list.
   * `folders`: asked per folder, after the project list, for the shown folders.
   */
  readonly listScope: "roots" | "folders";
  /** The session id has this Engine's shape ("Engine of a session = its id"); it may reach a file name or a request path. */
  ownsId(id: string): boolean;
  /** This daemon has the session without asking a Side: a stored session inside the roots, or one listed, created or opened here. */
  isLocal(id: string): Promise<boolean>;
  /** The ids of the sessions this daemon could restore, without reading any of them. */
  knownIds(): Promise<Iterable<string>>;
  entry(): EngineEntry;
  /** The mode a session the user creates in `cwd` starts in; undefined = the Engine's own default. */
  startMode(cwd: string, model?: string): Promise<PermissionMode | undefined>;
  /** A new tracked session with its project added; undefined when the folder is being removed meanwhile. Throws EngineError for a failure the user must see. */
  create(cwd: string, initial: Partial<SessionSettings>, o?: { draft?: string }): Promise<Session | undefined>;
  list(ctx: ListCtx): Promise<CatalogueList>;
  /** A session rebuilt from the store; undefined when it is gone or outside the roots. `background`: waits behind foreground restores. */
  restore(id: string, background: boolean): Promise<Session | undefined>;
  /** Folder of the session and whether the Engine's store has it (rename, archive and delete write there). */
  locate(id: string, live?: Session): Promise<{ cwd: string; transcript: boolean } | undefined>;
  title(s: Session): Promise<string>;
  rename(id: string, cwd: string, title: string): Promise<void>;
  archive(id: string, cwd: string, archived: boolean): Promise<void>;
  /** Removes the session from the store and forgets what the catalogue keeps of it. */
  delete(id: string, at: { cwd: string; transcript: boolean }): Promise<void>;
  /** A fork of the session for an Aside, or the reason there is none. Throws when the fork failed. */
  forkForAside(owner: Session, title: string): Promise<{ id: string } | { unavailable: string }>;
  commands(cwd: string): Promise<SlashCommand[]>;
  agents(cwd: string): Promise<{ name: string; description?: string }[]>;
  models(cwd?: string): Promise<ModelInfo[]>;
  /** One of the Engine's sessions went idle, was closed by a worktree remove, or was deleted. */
  settled?(): void;
  /** The session left the daemon without a delete (its stored data was deleted outside). */
  forget?(id: string): void;
  /** The app settings changed (`settings.set`). */
  settingsChanged?(before: Settings, after: Settings): void;
  /** Requests only this Engine answers (its provider login, its server restart). */
  requests?: Partial<Record<ClientMessage["type"], EngineRequest>>;
  close(): Promise<void>;
}

/** What a catalogue needs of the server's internals. */
export type CatalogueContext = {
  track(s: Session): Session;
  sessionOpts(initial: Partial<SessionSettings>): Record<string, unknown>;
  /** Link store (sessions.json). */
  settings: Pick<SessionSettingsStore, "get" | "entries" | "set" | "delete">;
  /** Runs a change of `settings`: a failed save is logged and the change holds in memory (server.ts). */
  saveSettings(change: () => void): void;
  appSettings: Pick<AppSettings, "get">;
  /** The canonical path when inside the roots. */
  allowed(path: unknown): string | undefined;
  isRemoving(cwd: string): boolean;
  addProject(cwd: string): void;
  broadcast(m: ServerMessage): void;
  /** The sessions this daemon holds. */
  liveSessions(): Iterable<Session>;
  session(id: string): Session | undefined;
  /** Restores run a few at a time (a page reconnecting after a restart would starve the event loop). */
  restoreSlot<T>(id: string, background: boolean, fn: () => Promise<T>): Promise<T>;
  allowBypass?: boolean;
};

export type Catalogues = {
  all: EngineCatalogue[];
  byName(name: EngineName): EngineCatalogue | undefined;
  /** A live session: its Engine's catalogue; else the first catalogue that owns the id shape. None: the id is refused. */
  ownerOf(id: string, live?: Session): EngineCatalogue | undefined;
};

export function createCatalogues(all: EngineCatalogue[]): Catalogues {
  return {
    all,
    byName: (name) => all.find((c) => c.engine.name === name),
    ownerOf: (id, live) => {
      if (live) {
        const name = live.info().engine;
        const c = name && all.find((x) => x.engine.name === name);
        if (c) return c;
      }
      return typeof id === "string" ? all.find((c) => c.ownsId(id)) : undefined;
    },
  };
}
