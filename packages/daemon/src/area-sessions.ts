// Area: sessions and what hangs on them (`session.*`, `sessions.search`, `fs.upload`, `permission.respond`, `question.respond`, `models.list`,
// `project.*`, `back.*`, `aside.*`, `worker.*`, `artifact.preview`): the remainder of the dispatched types.
// Per-connection state: the session subscriptions and feeds and the running transcript search; `close` releases them.
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DEFAULT_ENGINE, ENGINES, EFFORTS, imageBlock, KNOWN_HASH_MAX, KNOWN_ID_MAX, KNOWN_MAX, MAX_SEARCH_CHARS, MIN_SEARCH_CHARS, MAX_UPLOAD_BYTES, PERMISSION_MODES, BACK_MARKS_MAX, type AsideOpenResult, type PromptResult, type RewindMode, type SessionIdsResult } from "@claude-ui/protocol";
import type { SessionsTypes } from "./areas.ts";
import type { DaemonContext } from "./daemon-context.ts";
import type { Area, Connection, Handlers, Msg, Respond } from "./dispatch.ts";
import type { ArtifactAsset } from "./artifact-preview.ts";
import { checkSet, find as findMark, total as marksTotal, upsert as upsertMark } from "./back-marks.ts";
import { transcriptFile } from "./claude-catalogue.ts";
import { searchTranscripts } from "./content-search.ts";
import { DeniedRetryError } from "./denied-retry.ts";
import { EngineError, isModel } from "./engine-catalogue.ts";
import { real } from "./fd-check.ts";
import { createFeeds } from "./feed.ts";
import { localSettingsFile } from "./local-settings.ts";
import { redact } from "./plugins.ts";
import { trim } from "./projects.ts";
import { clearSearchCache } from "./search.ts";
import type { Session } from "./session.ts";
import { SESSION_DIR } from "./uploads.ts";

const REWIND_MODES: RewindMode[] = ["code", "conversation", "both"];

/** A background resubscribe that is behind by more events than this gets the snapshot (last page) instead of the replay (GH-767). */
export const REPLAY_MAX_EVENTS = 500;

/** The reply field with the folders of the session's plan files (a side's own reply carries its own). */
const planDirsOf = (s: object) => {
  const dirs = (s as { planDirs?: () => string[] | undefined }).planDirs?.();
  return dirs ? { planDirs: dirs } : {};
};

/** `session.subscribe` `known` as a part id -> hash map; undefined when absent, null when malformed (GH-771). */
function parseKnown(v: unknown): Map<string, string> | undefined | null {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > KNOWN_MAX) return null;
  const out = new Map<string, string>();
  for (const e of v) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== "string" || typeof e[1] !== "string" || e[0].length > KNOWN_ID_MAX || e[1].length > KNOWN_HASH_MAX) return null;
    out.set(e[0], e[1]);
  }
  return out;
}

export type SessionsAreaContext = Pick<DaemonContext, "sessions" | "findSession" | "locate" | "titleOf" | "list" | "listVersions" | "sessionIds" | "catalogues" | "rememberEngine" | "addProject" | "projects" | "allowed" | "inside" | "refused" | "isRemoving" | "deleting" | "uploads" | "localFiles" | "localFilesCache" | "mirror" | "holds" | "unhold" | "queue" | "sendPrompt" | "runBash" | "autoContinue" | "briefDropped" | "briefFailed" | "startBrief" | "dropQueuedBrief" | "asideOf" | "settings" | "saveSettings" | "orchestration" | "deleteSessionById" | "appSettings" | "broadcast" | "broadcastSettings" | "clock" | "perfMon" | "logEpoch" | "media" | "checkArtifact" | "scratchpadRoot" | "within" | "transcripts" | "transcriptCwd" | "sessionCwd" | "projectsDir" | "port"> & { opts: Pick<DaemonContext["opts"], "attached" | "replayMaxEvents"> };

export function createSessionsArea(ctx: SessionsAreaContext, conn: Connection): Area<SessionsTypes> {
  const { sessions, findSession, locate, titleOf, list, listVersions, sessionIds, catalogues, rememberEngine, addProject, projects, allowed, inside, refused, isRemoving, deleting, uploads, localFiles, localFilesCache, mirror, holds, unhold, queue, sendPrompt, runBash, autoContinue, briefDropped, briefFailed, startBrief, dropQueuedBrief, asideOf, settings, saveSettings, orchestration, deleteSessionById, appSettings, broadcast, broadcastSettings, clock, perfMon, logEpoch, media, checkArtifact, scratchpadRoot, within, transcripts, transcriptCwd, sessionCwd, projectsDir, port, opts } = ctx;
  const unsubscribes = new Map<string, () => void>();
  /** This connection's session feeds: events go to the socket while its buffer allows, else from the log later (feed.ts). */
  const feeds = createFeeds(conn.ws, (e) => conn.send(e));
  let subscribeOrder = 0;
  let searching: AbortController | undefined;
  const find = async (r: Respond, id: string, background = false) => (await findSession(id, background)) ?? void r.fail("unknown_session", `no session ${id}`);

  const create = async (msg: Msg<"session.create">, r: Respond) => {
    if (typeof msg.cwd === "string" && refused(msg.cwd)) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    if (typeof msg.cwd !== "string" || !existsSync(msg.cwd) || !statSync(msg.cwd).isDirectory())
      return r.fail("bad_cwd", `not a directory: ${msg.cwd}`);
    if (msg.model !== undefined && !isModel(msg.model)) return r.fail("bad_model", "model must be a non-empty string");
    if (msg.engine !== undefined && !(ENGINES as readonly unknown[]).includes(msg.engine)) return r.fail("bad_request", `engine must be one of ${ENGINES.join(", ")}`);
    const cwd = allowed(msg.cwd);
    if (!cwd) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    if (isRemoving(cwd)) return r.fail("worktree_removing", "This worktree is being removed");
    const catalogue = catalogues.byName(msg.engine ?? DEFAULT_ENGINE);
    if (!catalogue) return r.fail("bad_request", `no engine ${msg.engine}`);
    let s: Session | undefined;
    try {
      // The new-session tab's draft uploads are claimed only by an Engine that lets us choose the session id (OpenCode chooses its own).
      const permissionMode = await catalogue.startMode(cwd, msg.model);
      s = await catalogue.create(cwd, { model: msg.model, permissionMode }, { draft: msg.draft });
    } catch (err) {
      if (err instanceof EngineError) return r.fail(err.code, err.message);
      throw err;
    }
    // A removal may have started during the awaits: no live session in a deleted directory.
    if (!s) return r.fail("worktree_removing", "This worktree is being removed");
    rememberEngine(catalogue.engine.name);
    return r.reply({ session: s.info() });
  };
  const defaultMode = async (msg: Msg<"session.defaultMode">, r: Respond) => {
    const cwd = typeof msg.cwd === "string" && allowed(msg.cwd);
    if (!cwd) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    return r.reply({ mode: (await catalogues.byName(DEFAULT_ENGINE)?.startMode(cwd)) ?? "default" });
  };
  const commands = async (msg: Msg<"session.commands">, r: Respond) => {
    const cwd = typeof msg.cwd === "string" && allowed(msg.cwd);
    if (!cwd) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    try {
      const catalogue = catalogues.byName(msg.engine ?? DEFAULT_ENGINE);
      if (!catalogue) return r.fail("bad_request", `no engine ${msg.engine}`);
      return r.reply({ commands: await catalogue.commands(cwd) });
    } catch (e) {
      return r.fail("commands_failed", (e as Error).message);
    }
  };
  const agents = async (msg: Msg<"session.agents">, r: Respond) => {
    const cwd = typeof msg.cwd === "string" && allowed(msg.cwd);
    if (!cwd) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
    try {
      if (typeof msg.sessionId === "string") void (await find(r, msg.sessionId))?.refreshAgents();
      const catalogue = catalogues.byName(msg.engine ?? DEFAULT_ENGINE);
      if (!catalogue) return r.fail("bad_request", `no engine ${msg.engine}`);
      return r.reply({ agents: await catalogue.agents(cwd) });
    } catch (e) {
      return r.fail("agents_failed", (e as Error).message);
    }
  };
  const subscribe = async (msg: Msg<"session.subscribe">, r: Respond) => {
    // Before the first await: the page's order of asking, for the feed order (the lookups below finish in any order).
    const order = ++subscribeOrder;
    const known = parseKnown(msg.known);
    if (known === null) return r.fail("bad_request", `known must be an array of at most ${KNOWN_MAX} [part id, hash] string pairs (id <= ${KNOWN_ID_MAX}, hash <= ${KNOWN_HASH_MAX} characters)`);
    const span = perfMon.span("session.open");
    try {
      const s = await find(r, msg.sessionId, msg.background === true);
      const title = s && (await titleOf(s));
      if (!s || conn.ws.readyState !== conn.ws.OPEN) return;
      // The snapshot below is synchronous and reads the plan folders: warm the local settings files first.
      if (!localFilesCache.has(s.cwd)) await localFiles(s.cwd);
      if (conn.ws.readyState !== conn.ws.OPEN) return;
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
      // Same epoch but ahead of the log: the session was dropped and restored in this run (its seq restarted); the client's seq means nothing, so snapshot.
      const since = msg.logEpoch === logEpoch && msg.sinceSeq <= s.seq() ? msg.sinceSeq : 0;
      // A shown tab (plain subscribe) is sent first when the link is slow.
      const shown = msg.background !== true;
      const from = typeof msg.from === "string" ? msg.from : undefined;
      // Paged, first subscribe or new epoch: a snapshot (last page) instead of the replay; reply, snapshot and subscribe in one synchronous step.
      // `known` (part hashes the page holds) only shrinks a snapshot reply: refs for the parts it already has (GH-771).
      const snapshotOf = (f: string | undefined) => (known ? s.snapshot(f, known) : s.snapshot(f));
      let snap = msg.paged === true && since === 0 ? snapshotOf(from) : undefined;
      // A background view far behind (a reconnect after a long gap) takes the snapshot too when the page is clearly smaller than the gap (GH-767; a page is at
      // most PAGE_PARTS parts, but one giant turn comes whole, where the replay is the cheaper one). A shown tab keeps the replay (its scroll position).
      if (!snap && msg.paged === true && !shown && since > 0) {
        const gap = s.countAfter(since);
        if (gap > (opts.replayMaxEvents ?? REPLAY_MAX_EVENTS)) {
          const page = snapshotOf(from);
          if (page.snapshot.page.parts.length * 2 < gap) snap = page;
        }
      }
      if (snap) {
        r.reply({ logEpoch, seq: snap.seq, session: s.info(), title: title!, snapshot: snap.snapshot, ...planDirsOf(s) });
        const stop = feeds.follow(s, snap.seq, shown, order);
        return keep(stop, mirror(s));
      }
      r.reply({ logEpoch, seq: s.seq(), session: s.info(), title: title!, ...planDirsOf(s) });
      const stop = feeds.follow(s, since, shown, order);
      return keep(stop, mirror(s));
    } finally {
      span.end();
    }
  };
  const pageOrEdits = async (msg: Msg<"session.page" | "session.edits" | "session.artifacts">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    if (msg.logEpoch !== logEpoch) return r.fail("stale_epoch", "the daemon restarted since this view was loaded");
    if (typeof msg.before !== "string") return r.fail("bad_request", "before must be a part id");
    if (msg.type === "session.edits" || msg.type === "session.artifacts") {
      const parts = msg.type === "session.edits" ? s.edits(msg.before) : s.artifacts(msg.before);
      return parts ? r.reply({ parts }) : r.fail("unknown_cursor", `no part ${msg.before}`);
    }
    if (msg.until !== undefined && (typeof msg.until !== "string" || msg.until.length > 200)) return r.fail("bad_request", "until must be a string of at most 200 characters");
    const page = s.page(msg.before, msg.until);
    return page ? r.reply({ page }) : r.fail("unknown_cursor", `no part ${msg.before}`);
  };
  const sessionMedia = async (msg: Msg<"session.media">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    if (typeof msg.partId !== "string" || msg.partId.length > 200 || !Number.isInteger(msg.index) || msg.index < 0) return r.fail("bad_request", "partId must be a part id and index a non-negative integer");
    const dataUrl = s.media(msg.partId, msg.index);
    return dataUrl ? r.reply({ dataUrl }) : r.fail("unknown_media", `no media ${msg.index} in part ${msg.partId}`);
  };
  const artifactPreview = async (msg: Msg<"artifact.preview">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    if (typeof msg.partId !== "string" || msg.partId.length > 200) return r.fail("bad_request", "partId must be a part id");
    const f = s.artifactFile(msg.partId);
    if ("code" in f) return r.fail(f.code, f.message);
    const c = checkArtifact(f.path);
    if ("code" in c) return r.fail(c.code, c.message);
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
    const nonce = conn.nonceFor(`artifact\0${msg.sessionId}\0${msg.partId}`);
    media.set(nonce, { src: { kind: "artifact", named: f.path, path: c.path, page, confine, assets }, ws: conn.ws, used: Date.now() });
    return r.reply({ url: `/artifact/${nonce}/${encodeURIComponent(page)}?v=${c.mtime}`, size: c.size, mtime: c.mtime, title: f.title, ...(unavailable.length > 0 && { unavailable }) });
  };
  const unsubscribe = async (msg: Msg<"session.unsubscribe">, r: Respond) => {
    // No find(): this must not restore a session.
    unsubscribes.get(msg.sessionId)?.();
    unsubscribes.delete(msg.sessionId);
    return r.reply({});
  };
  const prompt = async (msg: Msg<"session.prompt">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    autoContinue.cancel(s.id);
    const images = msg.images ?? [];
    if (!Array.isArray(images) || !images.every((i) => imageBlock(i)))
      return r.fail("bad_images", "images must be base64 data URLs of type png, jpeg, gif or webp");
    if (typeof msg.text !== "string" || (!msg.text.trim() && !images.length)) return r.fail("bad_prompt", "empty prompt");
    const out: PromptResult = {};
    const err = await sendPrompt(s, msg.text, images, undefined, out);
    // A refused prompt keeps a usage-limit pause.
    if (!err) queue.release(s.id);
    return err ? r.fail(err.code, err.message) : r.reply(out);
  };
  const enqueue = async (msg: Msg<"session.enqueue">, res: Respond) => {
    const s = await find(res, msg.sessionId);
    if (!s) return;
    const images = msg.images ?? [];
    if (!Array.isArray(images) || !images.every((i) => imageBlock(i)))
      return res.fail("bad_images", "images must be base64 data URLs of type png, jpeg, gif or webp");
    if (typeof msg.text !== "string" || (!msg.text.trim() && !images.length)) return res.fail("bad_prompt", "empty prompt");
    if (!s.isLive()) return res.fail("session_not_live", `session ${s.id} is ${s.info().state}`);
    const r = queue.enqueue(s.id, { text: msg.text, images });
    return typeof r === "string" ? res.reply({ itemId: r }) : res.fail(r.code, r.message);
  };
  const dequeue = async (msg: Msg<"session.dequeue">, r: Respond) => {
    // In memory only: a session not loaded has no queue, and find() would restore it from disk.
    const s = sessions.get(msg.sessionId);
    if (!s) return r.fail("unknown_item", "queued message not found (already sent?)");
    const item = queue.take(s.id, msg.itemId);
    briefDropped(s.id, item);
    return item ? r.reply({ text: item.text, images: item.images, ...(item.bash && { bash: true }) }) : r.fail("unknown_item", "queued message not found (already sent?)");
  };
  const sendQueued = async (msg: Msg<"session.sendQueued">, r: Respond) => {
    const s = sessions.get(msg.sessionId);
    if (!s || !queue.items(s.id).some((i) => i.id === msg.itemId)) return r.fail("unknown_item", "queued message not found (already sent?)");
    const queued = queue.items(s.id).find((i) => i.id === msg.itemId);
    const bash = queued?.bash;
    // A brief turn never steers into a running turn: Send now only while the session takes a prompt.
    if (queued?.brief && !s.takesQueued()) return r.fail("session_busy", "The brief waits for the current turn to end");
    const err = await queue.sendNow(s.id, msg.itemId);
    // A refused Send now (any reason) leaves a scheduled auto-continue alone.
    if (err) return r.fail(err.code, err.message);
    // A shell command does not end a usage-limit pause; only a prompt does (runBash cancelled the auto-continue).
    if (!bash) {
      autoContinue.cancel(s.id);
      queue.release(s.id);
    }
    return r.reply({});
  };
  const bash = async (msg: Msg<"session.bash">, res: Respond) => {
    const s = await find(res, msg.sessionId);
    if (!s) return;
    if (typeof msg.command !== "string" || !msg.command.trim()) return res.fail("bad_command", "empty command");
    // A send of the queue is in flight (a prompt awaiting its sync): the command goes behind it, in submit order.
    const err = queue.sending(s.id) ? { code: "session_busy", message: "queue sending" } : await runBash(s, msg.command);
    if (err?.code === "session_busy" || err?.code === "external_turn") {
      const r = queue.enqueue(s.id, { text: msg.command.trim(), images: [], bash: true });
      return typeof r === "string" ? res.reply({ itemId: r }) : res.fail(r.code, r.message);
    }
    return err ? res.fail(err.code, err.message) : res.reply({});
  };
  const setModel = async (msg: Msg<"session.setModel">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    if (!isModel(msg.model)) return r.fail("bad_model", "model must be a non-empty string");
    if (!s.isLive()) return r.fail("session_not_live", `session ${s.id} is ${s.info().state}`);
    try {
      await s.setModel(msg.model);
    } catch (e) {
      return r.fail("set_model_failed", (e as Error).message);
    }
    return r.reply({ session: s.info() });
  };
  const setAgent = async (msg: Msg<"session.setAgent">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    if (typeof msg.agent !== "string" || !msg.agent || msg.agent.length > 200) return r.fail("bad_agent", "agent must be a non-empty string");
    if (!s.isLive()) return r.fail("session_not_live", `session ${s.id} is ${s.info().state}`);
    try {
      await s.setAgent(msg.agent);
    } catch (e) {
      return r.fail("set_failed", (e as Error).message);
    }
    return r.reply({ session: s.info() });
  };
  const setModeOrEffort = async (msg: Msg<"session.setPermissionMode" | "session.setEffort">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    if (msg.type === "session.setPermissionMode" && !PERMISSION_MODES.includes(msg.mode) && !catalogues.all.some((c) => c.engine.capabilities.permissionModes.includes(msg.mode))) return r.fail("bad_mode", `unknown permission mode ${msg.mode}`);
    if (msg.type === "session.setEffort" && !EFFORTS.includes(msg.effort)) return r.fail("bad_effort", `unknown effort ${msg.effort}`);
    try {
      await (msg.type === "session.setPermissionMode" ? s.setPermissionMode(msg.mode) : s.setEffort(msg.effort));
    } catch (e) {
      return r.fail("set_failed", (e as Error).message);
    }
    // An Aside stops being read-only with a mode change; the next CLI start has the editing tools.
    if (msg.type === "session.setPermissionMode" && settings.get(s.id)?.readOnly) {
      saveSettings(() => settings.set(s.id, { readOnly: undefined }, ["readOnly"]));
      // shortcut: while a turn runs the edits stay off until its CLI ends (idle close, restart); restart at turn end if users ask.
      if (s.info().state === "idle" && s.live()) s.restartQuery();
    }
    return r.reply({ session: s.info() });
  };
  const upload = async (msg: Msg<"fs.upload">, r: Respond) => {
    if (typeof msg.data !== "string" || typeof msg.name !== "string") return r.fail("bad_upload", "name and data (base64) required");
    let owner: string | undefined;
    if (msg.sessionId !== undefined) {
      if (typeof msg.sessionId !== "string" || !SESSION_DIR.test(msg.sessionId) || deleting.has(msg.sessionId) || !(await locate(msg.sessionId)))
        return r.fail("unknown_session", "no such session");
      // After /clear the heir's CLI still reads its parent's folder: the file goes where the CLI can read it.
      owner = sessions.get(msg.sessionId)?.uploadOwner ?? msg.sessionId;
    } else if (msg.draft !== undefined) {
      owner = uploads.ownerOfDraft(msg.draft);
      if (!owner) return typeof msg.draft === "string" && uploads.draftClaimed(msg.draft) ? r.fail("draft_claimed", "draft already used; use a new draft or the sessionId") : r.fail("bad_upload", "draft must be 64 hex characters");
    } else return r.fail("bad_upload", "sessionId or draft required; reload the page");
    const buf = Buffer.from(msg.data, "base64");
    if (buf.length > MAX_UPLOAD_BYTES) return r.fail("too_large", `larger than ${MAX_UPLOAD_BYTES} bytes: ${msg.name}`);
    try {
      const path = uploads.store(owner, msg.name, buf);
      clearSearchCache();
      return r.reply({ path });
    } catch (err) {
      return r.fail("fs_error", String(err));
    }
  };
  const cancelContinue = async (msg: Msg<"session.cancelContinue">, r: Respond) => {
    // No find(): a cancel must not restore a session.
    autoContinue.cancel(msg.sessionId);
    return r.reply({});
  };
  const interrupt = async (msg: Msg<"session.interrupt">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    try {
      await s.interrupt();
    } catch (e) {
      return r.fail("interrupt_failed", (e as Error).message);
    }
    return r.reply({});
  };
  const stopSubagent = async (msg: Msg<"session.stopSubagent">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    try {
      if (!(await s.stopSubagent(msg.subagentId))) return r.fail("unknown_subagent", "no running subagent run with that ID");
    } catch (e) {
      return r.fail("stop_failed", (e as Error).message);
    }
    return r.reply({});
  };
  const backgroundShell = async (msg: Msg<"session.backgroundShell">, r: Respond) => {
    if (typeof msg.toolUseId !== "string") return r.fail("bad_request", "toolUseId required");
    const s = await find(r, msg.sessionId);
    if (!s) return;
    try {
      if (!(await s.backgroundShell(msg.toolUseId))) return r.fail("unknown_shell", "no foreground Bash call with that ID runs");
    } catch (e) {
      return r.fail("background_failed", (e as Error).message);
    }
    return r.reply({});
  };
  const allowDenied = async (msg: Msg<"session.allowDenied">, r: Respond) => {
    if (typeof msg.toolUseId !== "string") return r.fail("bad_request", "toolUseId required");
    const s = await find(r, msg.sessionId);
    if (!s) return;
    if (!s.isLive()) return r.fail("session_not_live", `session ${s.id} is ${s.info().state}`);
    // Like sendPrompt: the follow-up continues after the terminal CLI's turns.
    if (s.info().state === "idle") await s.sync();
    if (s.externalTurnRunning()) return r.fail("external_turn", "A terminal CLI turn is running in this session");
    try {
      s.allowDenied(msg.toolUseId);
    } catch (e) {
      return e instanceof DeniedRetryError ? r.fail(e.code, e.message) : r.fail("prompt_failed", (e as Error).message);
    }
    autoContinue.cancel(s.id);
    queue.release(s.id);
    return r.reply({});
  };
  const localSettingsFileOf = async (msg: Msg<"session.localSettingsFile">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    return r.reply({ file: await localSettingsFile(s.cwd) });
  };
  const alwaysAllowDenied = async (msg: Msg<"session.alwaysAllowDenied">, r: Respond) => {
    if (typeof msg.toolUseId !== "string") return r.fail("bad_request", "toolUseId required");
    if (msg.scope !== "session" && msg.scope !== "local") return r.fail("bad_request", "scope must be session or local");
    const s = await find(r, msg.sessionId);
    if (!s) return;
    if (!s.isLive()) return r.fail("session_not_live", `session ${s.id} is ${s.info().state}`);
    if (s.info().state === "idle") await s.sync();
    if (s.externalTurnRunning()) return r.fail("external_turn", "A terminal CLI turn is running in this session");
    try {
      await s.alwaysAllowDenied(msg.toolUseId, msg.scope);
    } catch (e) {
      return e instanceof DeniedRetryError ? r.fail(e.code, e.message) : r.fail("prompt_failed", (e as Error).message);
    }
    autoContinue.cancel(s.id);
    queue.release(s.id);
    return r.reply({});
  };
  const shellOutput = async (msg: Msg<"session.shellOutput">, res: Respond) => {
    if (typeof msg.toolUseId !== "string") return res.fail("bad_request", "toolUseId required");
    const s = await find(res, msg.sessionId);
    if (!s) return;
    let r;
    try {
      r = await s.shellOutput(msg.toolUseId);
    } catch (e) {
      return res.fail("no_output", (e as Error).message);
    }
    return r ? res.reply(r) : res.fail("no_output", "Output is not available");
  };
  const stopShell = async (msg: Msg<"session.stopShell">, r: Respond) => {
    if (typeof msg.toolUseId !== "string") return r.fail("bad_request", "toolUseId required");
    const s = await find(r, msg.sessionId);
    if (!s) return;
    try {
      if (!(await s.stopShell(msg.toolUseId))) return r.fail("unknown_shell", "no running shell with that ID");
    } catch (e) {
      return r.fail("stop_failed", (e as Error).message);
    }
    return r.reply({});
  };
  const permissionRespond = async (msg: Msg<"permission.respond">, r: Respond) => {
    if (typeof msg.requestId !== "string" || !["allow", "allow_always", "deny"].includes(msg.decision))
      return r.fail("bad_request", "requestId and decision (allow, allow_always, deny) required");
    if (msg.ruleIndex !== undefined && !Number.isInteger(msg.ruleIndex)) return r.fail("bad_request", "ruleIndex must be an integer");
    if (msg.message !== undefined && typeof msg.message !== "string") return r.fail("bad_request", "message must be a string");
    const u = msg.updatedInput as unknown;
    if (u !== undefined && (typeof u !== "object" || u === null || Array.isArray(u))) return r.fail("bad_request", "updatedInput must be an object");
    // requestIds are UUIDs unique across sessions; the first answer from any tab wins.
    const settled = [...sessions.values()].some((s) => s.respond(msg.requestId, msg));
    return r.reply({ settled });
  };
  const questionRespond = async (msg: Msg<"question.respond">, r: Respond) => {
    const { answers } = msg;
    if (typeof msg.requestId !== "string" || typeof answers !== "object" || !answers || Object.values(answers).some((v) => typeof v !== "string"))
      return r.fail("bad_request", "requestId and answers (question text -> string) required");
    const { choices } = msg;
    // Each list is the chosen labels and the Other text: bounded like the answers a user can type.
    if (choices !== undefined && (typeof choices !== "object" || !choices || Array.isArray(choices) || Object.values(choices).some((l) => !Array.isArray(l) || l.length > 50 || l.some((v) => typeof v !== "string" || v.length > 10_000))))
      return r.fail("bad_request", "choices must map a question text to at most 50 strings");
    const settled = [...sessions.values()].some((s) => s.answer(msg.requestId, answers, undefined, choices));
    return r.reply({ settled });
  };
  const modelsList = async (msg: Msg<"models.list">, r: Respond) => {
    try {
      const catalogue = catalogues.byName(msg.engine ?? DEFAULT_ENGINE);
      if (!catalogue) return r.fail("bad_request", `no engine ${msg.engine}`);
      const cwd = msg.cwd === undefined ? undefined : allowed(msg.cwd);
      if (msg.cwd !== undefined && !cwd) return r.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
      return r.reply({ models: await catalogue.models(cwd) });
    } catch (e) {
      return r.fail("models_failed", (e as Error).message);
    }
  };
  const listSessions = async (msg: Msg<"session.list">, r: Respond) => {
    // `since` (even empty) = the page understands versions; the hub's own calls send none and get the plain list.
    return r.reply(typeof msg.since === "string" ? listVersions.encode(await list(), msg.since) : await list());
  };
  const idsOf = async (_msg: Msg<"session.ids">, r: Respond) => {
    return r.reply({ ids: await sessionIds() } satisfies SessionIdsResult);
  };
  const projectOpen = async (msg: Msg<"project.open">, r: Respond) => {
    const cwd = allowed(msg.cwd);
    if (!cwd || !statSync(cwd).isDirectory()) return r.fail("cwd_not_allowed", `not a directory inside the allowlisted roots: ${msg.cwd}`);
    try {
      projects.open(cwd);
    } catch (err) {
      return r.fail("fs_error", String(err));
    }
    // Other connected clients refresh their project list.
    broadcast({ type: "sessions.changed" });
    return r.reply({ cwd });
  };
  const projectRemove = async (msg: Msg<"project.remove">, r: Respond) => {
    if (typeof msg.cwd !== "string" || !isAbsolute(msg.cwd)) return r.fail("bad_cwd", "cwd must be an absolute path");
    try {
      projects.remove(msg.cwd);
    } catch (err) {
      return r.fail("fs_error", String(err));
    }
    broadcast({ type: "sessions.changed" });
    return r.reply({});
  };
  const back = async (msg: Msg<"back.set" | "back.done" | "back.brief">, res: Respond) => {
    if (opts.attached) return res.fail("back_unsupported", "Back marks are kept by the Hub; mark this reply on the Hub");
    if (typeof msg.sessionId !== "string" || typeof msg.partId !== "string") return res.fail("bad_request", "sessionId and partId must be strings");
    const s = await find(res, msg.sessionId);
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
        return res.fail("save_failed", (e as Error).message);
      }
      broadcastSettings();
      return res.reply({});
    }
    if (msg.type === "back.brief") {
      const m = findMark(marks, s.id, msg.partId);
      if (!m) return res.fail("unknown_mark", "no such mark");
      if (m.briefState === "queued" || m.briefState === "running") return res.fail("brief_busy", "a brief is already being written");
      await startBrief(s, msg.partId, !!m.brief);
      return res.reply({});
    }
    const bad = checkSet(msg);
    if (bad) return res.fail("bad_request", bad);
    const exists = !!findMark(marks, s.id, msg.partId);
    if (!exists && marksTotal(marks) >= BACK_MARKS_MAX) return res.fail("too_many_marks", `at most ${BACK_MARKS_MAX} marks`);
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
      return res.fail("save_failed", (e as Error).message);
    }
    broadcastSettings();
    if (isNew) void startBrief(s, msg.partId, false).catch((e) => briefFailed(s.id, msg.partId, (e as Error).message));
    return res.reply({});
  };
  const renameOrArchive = async (msg: Msg<"session.rename" | "session.archive">, r: Respond) => {
    const title = msg.type === "session.rename" && typeof msg.title === "string" ? msg.title.trim() : "";
    // 200: the web title input's maxLength.
    if (msg.type === "session.rename" && (!title || title.length > 200)) return r.fail("bad_title", "title must be 1 to 200 characters");
    if (msg.type === "session.archive" && typeof msg.archived !== "boolean") return r.fail("bad_request", "archived must be a boolean");
    const at = await locate(msg.sessionId);
    if (!at) return r.fail("unknown_session", `no session ${msg.sessionId}`);
    try {
      const owner = catalogues.ownerOf(msg.sessionId, at.live);
      if (msg.type === "session.rename") await owner?.rename(msg.sessionId, at.cwd, title);
      else await owner?.archive(msg.sessionId, at.cwd, msg.archived);
    } catch (e) {
      // A session with no prompt yet has no transcript to write to.
      return r.fail(`${msg.type.slice("session.".length)}_failed`, (e as Error).message);
    }
    broadcast({ type: "sessions.changed" });
    return r.reply({});
  };
  const del = async (msg: Msg<"session.delete">, r: Respond) => {
    const err = await deleteSessionById(msg.sessionId);
    return err ? r.fail(err.code, err.message) : r.reply({});
  };
  const asideOpen = async (msg: Msg<"aside.open">, r: Respond) => {
    if (typeof msg.text !== "string" || !msg.text.trim()) return r.fail("bad_prompt", "text must be a non-empty string");
    const owner = await find(r, msg.sessionId);
    if (!owner) return;
    const text = msg.text.trim();
    const title = text.split("\n")[0]!.trim().slice(0, 80);
    const catalogue = catalogues.ownerOf(owner.id, owner);
    if (!catalogue) return r.fail("aside_failed", `no engine for session ${owner.id}`);
    let id: string | undefined;
    try {
      const fork = await catalogue.forkForAside(owner, title);
      if ("unavailable" in fork) return r.fail("aside_unavailable", fork.unavailable);
      id = fork.id;
      const oi = owner.info();
      // Right after the fork, no await between: a list scan reads the link after its transcript scan.
      saveSettings(() => settings.set(id!, { ownerId: owner.id, readOnly: true, port: port(), model: oi.model, permissionMode: "default", effort: oi.effort }));
      const s = await findSession(id);
      if (!s) throw new Error("the fork could not be restored");
      const from = s.prompt(text) ?? "";
      return r.reply({ session: s.info(), title, from } satisfies AsideOpenResult);
    } catch (e) {
      if (id) {
        const err = await deleteSessionById(id, true).catch(() => undefined);
        if (err?.code === "unknown_session" || !(await locate(id))) saveSettings(() => settings.delete([id!]));
      }
      return r.fail("aside_failed", (e as Error).message);
    }
  };
  const asideClose = async (msg: Msg<"aside.close">, r: Respond) => {
    if (typeof msg.sessionId !== "string" || !asideOf(msg.sessionId)) return r.fail("not_an_aside", "this session is not an aside");
    const err = await deleteSessionById(msg.sessionId, true);
    if (err?.code === "unknown_session") return saveSettings(() => settings.delete([msg.sessionId])), r.reply({});
    return err ? r.fail(err.code, err.message) : r.reply({});
  };
  const asideKeep = async (msg: Msg<"aside.keep">, r: Respond) => {
    if (typeof msg.sessionId !== "string" || !asideOf(msg.sessionId)) return r.fail("not_an_aside", "this session is not an aside");
    saveSettings(() => settings.set(msg.sessionId, { ownerId: undefined }, ["ownerId"]));
    broadcast({ type: "sessions.changed" });
    return r.reply({});
  };
  const worker = async (msg: Msg<"worker.close" | "worker.remove">, r: Respond) => {
    if (typeof msg.sessionId !== "string") return r.fail("bad_request", "sessionId must be a string");
    const err = await orchestration.userOp(msg.type === "worker.close" ? "close" : "remove", msg.sessionId);
    return err ? r.fail(err.code, err.message) : r.reply({});
  };
  const rewind = async (msg: Msg<"session.rewindPreview" | "session.rewind">, r: Respond) => {
    const s = await find(r, msg.sessionId);
    if (!s) return;
    if (msg.type === "session.rewind" && !REWIND_MODES.includes(msg.mode)) return r.fail("bad_mode", `unknown rewind mode ${msg.mode}`);
    if (msg.type === "session.rewind") autoContinue.cancel(s.id);
    try {
      return r.reply(msg.type === "session.rewind" ? (await s.rewind(msg.userMessageId, msg.mode), {}) : await s.previewRewind(msg.userMessageId));
    } catch (err) {
      return r.fail("rewind_failed", (err as Error).message);
    }
  };
  const search = async (msg: Msg<"sessions.search">, res: Respond) => {
    // One search per connection: a newer query (or an empty one, the palette closing) stops the running scan.
    searching?.abort();
    searching = undefined;
    if (typeof msg.query !== "string" || (msg.cwd !== undefined && typeof msg.cwd !== "string")) return res.fail("bad_query", "query must be a string");
    const query = msg.query.trim();
    if (query.length < MIN_SEARCH_CHARS) return res.reply({ scannedFiles: 0, scannedBytes: 0, ms: 0 });
    if (query.length > MAX_SEARCH_CHARS) return res.fail("bad_query", `query longer than ${MAX_SEARCH_CHARS} characters`);
    const cwd = msg.cwd === undefined ? undefined : allowed(msg.cwd);
    if (msg.cwd !== undefined && !cwd) return res.fail("cwd_not_allowed", `outside the allowlisted roots: ${msg.cwd}`);
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
    const done = await searchTranscripts(files, query, (r) => conn.send({ type: "sessions.search.result", reqId: msg.reqId, ...r }), { signal: ctl.signal });
    if (searching === ctl) searching = undefined;
    // No query text in the log (it may hold a secret).
    console.log(`sessions.search: ${done.scannedFiles} files, ${Math.round(done.scannedBytes / 1e6)} MB, ${done.ms} ms, first result ${done.firstMs ?? "-"} ms${done.stopped ? `, stopped: ${done.stopped}` : ""}`);
    return res.reply(done);
  };

  const handlers = {
    "session.create": create,
    "session.defaultMode": defaultMode,
    "session.commands": commands,
    "session.agents": agents,
    "session.subscribe": subscribe,
    "session.page": pageOrEdits,
    "session.edits": pageOrEdits,
    "session.artifacts": pageOrEdits,
    "session.media": sessionMedia,
    "artifact.preview": artifactPreview,
    "session.unsubscribe": unsubscribe,
    "session.prompt": prompt,
    "session.enqueue": enqueue,
    "session.dequeue": dequeue,
    "session.sendQueued": sendQueued,
    "session.bash": bash,
    "session.setModel": setModel,
    "session.setAgent": setAgent,
    "session.setPermissionMode": setModeOrEffort,
    "session.setEffort": setModeOrEffort,
    "fs.upload": upload,
    "session.cancelContinue": cancelContinue,
    "session.interrupt": interrupt,
    "session.stopSubagent": stopSubagent,
    "session.backgroundShell": backgroundShell,
    "session.allowDenied": allowDenied,
    "session.localSettingsFile": localSettingsFileOf,
    "session.alwaysAllowDenied": alwaysAllowDenied,
    "session.shellOutput": shellOutput,
    "session.stopShell": stopShell,
    "permission.respond": permissionRespond,
    "question.respond": questionRespond,
    "models.list": modelsList,
    "session.list": listSessions,
    "session.ids": idsOf,
    "project.open": projectOpen,
    "project.remove": projectRemove,
    "back.set": back,
    "back.done": back,
    "back.brief": back,
    "session.rename": renameOrArchive,
    "session.archive": renameOrArchive,
    "session.delete": del,
    "aside.open": asideOpen,
    "aside.close": asideClose,
    "aside.keep": asideKeep,
    "worker.close": worker,
    "worker.remove": worker,
    "session.rewindPreview": rewind,
    "session.rewind": rewind,
    "sessions.search": search,
  } satisfies Handlers<SessionsTypes>;
  return {
    handlers,
    close() {
      unsubscribes.forEach((u) => u());
      searching?.abort();
    },
  };
}
