// The Claude Engine catalogue (ADR 0001: the SDK transcript is the store): listing, restoring, locating, renaming, archiving, deleting and forking Claude sessions, moved out of server.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ALL_CAPABILITIES, createAdapter, EFFORTS, permissionModesFor, type ModelInfo, type PermissionMode, type SessionListItem, type SlashCommand } from "@claude-ui/protocol";
import { deleteSession, forkSession, getSessionInfo, listSessions, renameSession, tagSession, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { asideForkPoint } from "./aside.ts";
import { claudeEngine } from "./claude-engine.ts";
import { readDefaultMode } from "./default-mode.ts";
import { projectOverrides } from "./project-overrides.ts";
import { isModel, type CatalogueContext, type CatalogueList, type EngineCatalogue, type ListCtx } from "./engine-catalogue.ts";
import { lastEntryTime, mapLimit } from "./session-scan.ts";
import { Session, transcriptModel, type SessionSettings, type Transcript } from "./session.ts";
import { interleaveRuns } from "./transcript.ts";

/** A Claude session id is a UUID: it becomes a transcript file name, so only this shape does. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** SDK title of a transcript whose only prompt is /clear (or its aliases /reset, /new). */
const CLEARED = /^\/(clear|reset|new)$/;
/** SDK session tag that marks an archived session (no archive flag of its own; ADR 0001: no store of ours). */
export const ARCHIVED_TAG = "archived";
/** session.list waits this long for the model list (auto mode of new sessions) before it replies without it. */
export const MODEL_LIST_WAIT_MS = 2000;
/** Bytes read from a transcript's end to find its last message; more than a few large tool results. */
const TAIL_BYTES = 256 * 1024;
/** Transcript path → last message time for the file version (mtime, size) it was read from. */
/** `listed`: the transcript scan's mtime and size when the file was read (lastMessageAt skips the open while they hold). */
const lastMessageCache = new Map<string, { version: string; listed?: string; at: number | undefined }>();

// ponytail: the SDK's project folder name for cwds up to 200 chars; longer ones get a hash suffix and are not found.
export const transcriptFile = (projectsDir: string, cwd: string, sessionId: string) => join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);

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

export type History = {
  listSessions: typeof listSessions;
  getSessionInfo: typeof getSessionInfo;
  getSessionMessages: typeof import("@anthropic-ai/claude-agent-sdk").getSessionMessages;
  /** Subagent run transcripts (`<session>/subagents/agent-<id>.jsonl`); not in getSessionMessages(). */
  listSubagents?: typeof import("@anthropic-ai/claude-agent-sdk").listSubagents;
  getSubagentMessages?: typeof import("@anthropic-ai/claude-agent-sdk").getSubagentMessages;
  renameSession?: typeof renameSession;
  tagSession?: typeof tagSession;
  deleteSession?: typeof deleteSession;
  /** Aside (docs/spec.md "Aside"): copies the owner transcript up to a message into a new session. */
  forkSession?: typeof forkSession;
};
type Scanned = Awaited<ReturnType<typeof listSessions>>;

/** What the Claude catalogue needs beyond CatalogueContext: the transcript machinery that session.search and the live mirror share. */
export type ClaudeDeps = {
  history: Required<Pick<History, "getSessionInfo" | "renameSession" | "tagSession" | "deleteSession" | "forkSession">>;
  claudeDir: string;
  projectsDir: string;
  /** The cached transcript scan. */
  transcripts(): Promise<Scanned>;
  readTranscript(id: string, listedCwd: string): Promise<Transcript>;
  /** Transcript folders by session id, and the transcript stamps of the live mirror (set when a restore starts). */
  transcriptCwds: Map<string, string>;
  stamps: Map<string, string>;
  statStamp(file: string): string;
  transcriptCwd(id: string, cwd: string): string;
  sessionCwd(cwd: string): string;
  /** The model list of the Claude account of `cwd`'s Project (the global account without a folder). */
  modelList(cwd?: string): Promise<ModelInfo[]>;
  supportsAuto(model: string, cwd?: string): boolean;
  localFiles(cwd: string): Promise<string[]>;
  commandsOf(cwd: string): Promise<SlashCommand[]>;
  /** The draft token of a new-session tab's uploads: the session gets their id (one claim per token). */
  claimUpload(draft: string): string | undefined;
  /** Sessions whose delete is in progress. */
  deleting: Set<string>;
  /** Unloads a session whose transcript was deleted outside the daemon; false when it started again or is being deleted. */
  dropGone(id: string): Promise<boolean>;
  modelListWaitMs?: number;
};

export function createClaudeCatalogue(ctx: CatalogueContext, d: ClaudeDeps): EngineCatalogue {
  const { history } = d;
  /** Claude sessions whose transcript this run has seen (listed or restored): one that is gone later was deleted outside the daemon. */
  const hadTranscript = new Set<string>();
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
    const main = await d.readTranscript(id, cwd).then((t) => t.main, () => []);
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

  /**
   * The Project's `mode` override, else `permissions.defaultMode` of the Claude settings for `cwd`, else Settings `sessions.defaultMode`,
   * when this daemon offers it for `model` (bypass needs the daemon flag, auto a model with support): an override never widens that list.
   */
  const defaultModeFor = async (cwd: string, model = "default") => {
    const settings = ctx.appSettings.get();
    const mode = projectOverrides(settings, cwd).mode ?? readDefaultMode(d.claudeDir, cwd, await d.localFiles(cwd)) ?? settings.sessions.defaultMode;
    return permissionModesFor({ allowBypass: ctx.allowBypass, supportsAuto: d.supportsAuto(model, cwd) }).find((m) => m === mode);
  };

  async function list(lctx: ListCtx): Promise<CatalogueList> {
    // The model list starts a CLI: not waiting longer than this offers no auto mode until it is there.
    await new Promise<void>((done) => {
      const t = setTimeout(done, d.modelListWaitMs ?? MODEL_LIST_WAIT_MS);
      d.modelList().catch(() => {}).then(() => (clearTimeout(t), done()));
    });
    const items = new Map<string, SessionListItem>();
    const all = await d.transcripts();
    // One read of sessions.json per list (read after the scan: an Aside's link is written right after its fork, so a scan that sees the fork finds the link).
    const { linked, links } = lctx.read();
    const known = new Set(all.map((t) => t.sessionId));
    // One realpath per distinct cwd per list, not two per transcript: each is a blocking call (slow on Windows), and hundreds of
    // transcripts share a few dozen cwds.
    const canonical = new Map<string, string | undefined>();
    const allowedCwd = (cwd: string) => (canonical.has(cwd) ? canonical.get(cwd) : (canonical.set(cwd, ctx.allowed(cwd)), canonical.get(cwd)));
    const lastAt = new Map(await mapLimit(all, 8, async (t) => [t.sessionId, t.cwd && allowedCwd(t.cwd) ? await lastMessageAt(d.projectsDir, t.cwd, t.sessionId, t) : undefined] as const));
    for (const t of all) {
      // An Aside is not a session of the list until Keep as session.
      if (!t.cwd || !allowedCwd(t.cwd) || linked.get(t.sessionId)?.ownerId) continue;
      const loaded = ctx.session(t.sessionId);
      const live = loaded?.info() ?? { state: "closed" as const, model: "default", permissionMode: "default" as const, effort: "default" as const, permissionModes: [], capabilities: ALL_CAPABILITIES, engine: claudeEngine.name };
      const title = CLEARED.test(t.summary) ? (loaded?.untitled() ? "New session" : await clearedTitle(t.sessionId, t.cwd, t)) : t.summary;
      if (loaded) hadTranscript.add(t.sessionId);
      items.set(t.sessionId, { ...live, id: t.sessionId, cwd: (process.platform === "win32" && allowedCwd(t.cwd)) || t.cwd, title, lastActivity: lastAt.get(t.sessionId) ?? t.lastModified, archived: t.tag === ARCHIVED_TAG, transcript: true, ...(!loaded?.live() && { live: false as const }), ...links(t.sessionId) });
    }
    // A loaded session whose transcript existed and is gone, with no CLI process: deleted outside the daemon (docs/spec.md "Sessions").
    for (const s of [...ctx.liveSessions()])
      if (hadTranscript.has(s.id) && !known.has(s.id) && !s.live() && !linked.get(s.id)?.ownerId && !d.deleting.has(s.id) && !(await history.getSessionInfo(s.id).catch(() => undefined))) await d.dropGone(s.id);
    return { items: [...items.values()], keep: (id) => known.has(id) };
  }

  /** A session's title as list() gives it: the SDK summary, a cleared session's first prompt. */
  async function title(s: Session) {
    const info = await history.getSessionInfo(s.id).catch(() => undefined);
    if (!info) return "New session";
    return CLEARED.test(info.summary) ? clearedTitle(s.id, info.cwd ?? s.cwd) : info.summary;
  }

  return {
    engine: claudeEngine,
    listScope: "roots",
    ownsId: (id) => UUID.test(id),
    isLocal: async (id) => UUID.test(id) && !!ctx.allowed((await history.getSessionInfo(id).catch(() => undefined))?.cwd),
    knownIds: async () => {
      const ok = new Map<string, boolean>();
      const inRootsCwd = (cwd: string) => (ok.has(cwd) ? ok.get(cwd)! : (ok.set(cwd, !!ctx.allowed(cwd)), ok.get(cwd)!));
      return (await d.transcripts()).filter((t) => t.cwd && inRootsCwd(t.cwd)).map((t) => t.sessionId);
    },
    entry: () => ({ engine: claudeEngine.name, capabilities: ALL_CAPABILITIES, permissionModes: permissionModesFor({ allowBypass: ctx.allowBypass, supportsAuto: d.supportsAuto("default") }) }),
    startMode: async (cwd, model) => {
      await d.modelList(cwd).catch(() => {});
      return defaultModeFor(cwd, model) as Promise<PermissionMode | undefined>;
    },
    create: async (cwd, initial, o) => {
      // No await before this check and the new Session: a removal may have started during the caller's awaits (no live session in a deleted directory).
      if (ctx.isRemoving(cwd) || !existsSync(cwd)) return undefined;
      // The draft token of the new-session tab's uploads: the session gets their id, and with it their folder (one claim per token).
      const claimed = typeof o?.draft === "string" ? d.claimUpload(o.draft) : undefined;
      if (o?.draft !== undefined && !claimed) console.log("session.create: draft uploads not claimed");
      const s = ctx.track(new Session(cwd, ctx.sessionOpts(initial), claimed ? { id: claimed } : undefined));
      ctx.addProject(cwd);
      return s;
    },
    list,
    restore: (id, background) =>
      ctx.restoreSlot(id, background, async () => {
        const info = await history.getSessionInfo(id);
        if (!info?.cwd || !ctx.allowed(info.cwd)) return undefined;
        d.transcriptCwds.set(id, info.cwd);
        hadTranscript.add(id);
        // Before the read: a write during it changes the stamp, so the first subscriber syncs it.
        d.stamps.set(id, d.statStamp(transcriptFile(d.projectsDir, info.cwd, id)));
        const { main: messages, runs, entries } = await d.readTranscript(id, info.cwd);
        await d.modelList(info.cwd).catch(() => {});
        // Its worktree is being removed: no live session in a directory about to go.
        if (ctx.isRemoving(info.cwd)) return undefined;
        // The model row whose resolved ID the transcript last used ("default" first); the ID itself when none matches.
        const used = transcriptModel(messages);
        // No entry (sessions.json lost, a session of the terminal CLI): mode and effort the transcript last recorded.
        const saved = ctx.settings.get(id) ?? { model: undefined, ...transcriptSettings(entries ?? []) };
        const model = isModel(saved?.model) ? saved.model : used && ((await d.modelList(info.cwd).catch(() => [])).find((m) => m.resolvedModel === used)?.value ?? used);
        // A mode the daemon does not enable now (bypass without CLAUDE_UI_ALLOW_BYPASS) falls back to the default.
        const modes = permissionModesFor({ allowBypass: ctx.allowBypass, supportsAuto: d.supportsAuto(model ?? "default", info.cwd) });
        const permissionMode = modes.includes(saved.permissionMode as never) ? (saved.permissionMode as SessionSettings["permissionMode"]) : undefined;
        const effort = EFFORTS.includes(saved.effort as never) ? (saved.effort as SessionSettings["effort"]) : undefined;
        // Each run's messages name the Agent call that started it (parent_tool_use_id): they go right after that call's result, inside its turn.
        // A run whose call was compacted away renders nowhere: only its edits are kept (for the changes tab). Every message read stays known,
        // so the first sync does not log the pruned ones after all.
        const read = [...messages, ...runs.flat()].map((m) => m.uuid);
        return ctx.track(Session.restore(id, d.sessionCwd(info.cwd), interleaveRuns(messages, runs, { pruneOrphans: true }), ctx.sessionOpts({ model, permissionMode, effort }), read));
      }),
    locate: async (id, live) => {
      const info = await history.getSessionInfo(id).catch(() => undefined);
      const cwd = live?.cwd ?? (info?.cwd && ctx.allowed(info.cwd));
      return cwd ? { cwd, transcript: !!info } : undefined;
    },
    title,
    rename: async (id, cwd, name) => void (await history.renameSession(id, name, { dir: cwd })),
    archive: async (id, cwd, archived) => void (await history.tagSession(id, archived ? ARCHIVED_TAG : null, { dir: cwd })),
    delete: async (id, at) => {
      if (at.transcript) await history.deleteSession(id, { dir: at.cwd });
    },
    forkForAside: async (owner, name) => {
      let main: Awaited<ReturnType<typeof d.readTranscript>>["main"] = [];
      try {
        if (!owner.untitled()) main = (await d.readTranscript(owner.id, owner.cwd)).main;
      } catch (e) {
        throw new Error(`Could not read the session: ${(e as Error).message}`);
      }
      const at = asideForkPoint(main);
      if (!at) return { unavailable: "An aside needs a reply in this session first" };
      const dir = d.transcriptCwd(owner.id, owner.cwd);
      // The owner's transcript is only read: a running owner turn and an external turn are not touched.
      return { id: (await history.forkSession(owner.id, { dir, upToMessageId: at, title: name })).sessionId };
    },
    commands: (cwd) => d.commandsOf(cwd),
    agents: async () => [],
    models: (cwd) => d.modelList(cwd),
    forget: (id) => void hadTranscript.delete(id),
    close: async () => {},
  };
}
