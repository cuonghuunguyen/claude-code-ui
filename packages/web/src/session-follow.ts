// Which Sessions this page follows and how: views, hold/background intent, resync after a reconnect, paging, retries (docs/spec.md "Client state", "Idle close").
// Plain TypeScript on top of `Client`: no React, no DOM. App gives a host for what it knows (tabs, list, infos) and performs the effects `apply` returns.
import type { Event, PageResult, SessionListItem, SubscribeResult, EditsResult, ArtifactsResult } from "@claude-ui/protocol";
import type { DaemonHello, Request, RequestError } from "./client.ts";
import { createEventEffects, type Effect } from "./event-effects.ts";
import { FINISHED_MAX_AGE_MS } from "./focus.ts";
import { followed } from "./follow.ts";
import { applyEvent, emptySession, knownOf, MISSING_REFS, partOf, withArtifacts, withEdits, withPage, withSubscribe, type SessionView } from "./store.ts";

export type { Effect } from "./event-effects.ts";

/** Background views resubscribed at once after a reconnect (a restarted daemon is not asked to restore hundreds of transcripts in the same moment). */
export const RESUBSCRIBE_CONCURRENCY = 4;
/** The resync waits this long for the list and the shown Sessions before the background views and the repos go on. */
export const RESYNC_SETTLE_MS = 15_000;
/** A failed page cursor is retried by a scroll event at most this often. */
export const PAGE_RETRY_MS = 3000;

export type FollowHost = {
  client(): { request<T>(msg: Request): Promise<T> } | undefined;
  listed(id: string): SessionListItem | undefined;
  /** The side of the Session's cwd is the local side. */
  isLocal(id: string): boolean;
  shownAs(id: string): "hash" | "aside" | "tab" | undefined;
  hashId(): string | undefined;
  unread(id: string): boolean;
  pageVisible(): boolean;
  /** In the shown split, else the active tab. */
  onScreen(id: string): boolean;
  refreshList(): Promise<void>;
  /** Reads the view cache and seeds the view (App's `applyCachedView`). */
  readCached?(id: string): Promise<void>;
  /** A subscribe reply arrived: infos, titles, failed tabs, heir. */
  replied(id: string, r: SubscribeResult): void;
  /** No view any more: infos, failed tabs. */
  dropped(id: string): void;
  /** unknown_session: App's `forget`. */
  gone(id: string): void;
  /** One call per burst of failed subscribes. */
  failed(ids: string[], message: string): void;
  error(message: string): void;
  /** Test clock; default `Date.now`. */
  now?(): number;
};

type Intent = "hold" | "background";
type Subscribe = { addProject?: boolean; fresh?: boolean; background?: boolean; startAt?: string };

export function createSessionFollow(host: FollowHost) {
  const now = () => host.now?.() ?? Date.now();
  const effects = createEventEffects(
    {
      pageVisible: () => host.pageVisible(),
      onScreen: (id) => host.onScreen(id),
      untitled: (id) => {
        const s = host.listed(id);
        return !!s && !s.transcript;
      },
      replayedTo: (id) => replayedTo.get(id) ?? 0,
    },
    now,
  );

  let views: Record<string, SessionView> = {};
  let olderMap: Record<string, boolean> = {};
  let synced = false;
  let gen = 0;
  let listFresh = false;
  let hello: DaemonHello | undefined;
  const listeners = new Set<() => void>();

  /** What the page asked for each Session on this connection, set when the command is given (not when the reply arrives): a close's background subscribe still in flight must not win over the Undo. */
  const intent = new Map<string, Intent>();
  /** Follows asked for and not failed: one per Session until a view exists. */
  const requested = new Set<string>();
  /** Seq of each Session's last subscribe reply: events up to it are a replay of known changes, not new ones. */
  const replayedTo = new Map<string, number>();
  /** Subscribes in flight while the Session has a view (a reconnect resubscribe): the view may be of an earlier daemon run. */
  const resubscribing = new Set<string>();
  /** Follows that failed with side_not_ready: kept in `requested` so a list change does not ask again. */
  const failedFollow = new Set<string>();
  let readySides = new Set<string>();
  /** Sessions whose view came from the view cache and was not resubscribed yet. */
  const fromCache = new Set<string>();
  const failedBatch: string[] = [];
  let failedMessage = "";
  const loadingOlder = new Set<string>();
  const resnapshotting = new Set<string>();
  const editsAsked = new Set<string>();
  const artifactsAsked = new Set<string>();
  const runRequested = new Set<string>();
  /** Per Session, the epoch and cursor whose page request failed, and when: retried only by a scroll event. */
  const failedPage = new Map<string, { key: string; at: number }>();
  let tokens = 0;
  /** The latest subscribe command per Session: only it may undo its intent when it fails. */
  const intentToken = new Map<string, number>();

  const notify = () => listeners.forEach((l) => l());

  /** Sets the views, takes a fresh snapshot of every view that turned stale (a rewind into its unloaded region), tells the listeners. */
  function commit(next: Record<string, SessionView>) {
    views = next;
    for (const [id, v] of Object.entries(views))
      if (v.stale && !resnapshotting.has(id)) {
        resnapshotting.add(id);
        void subscribe(id, { fresh: true, background: intent.get(id) !== "hold" }).finally(() => resnapshotting.delete(id));
      }
    notify();
  }

  const clearAsks = (set: Set<string>, id: string) => {
    for (const k of set) if (k.startsWith(`${id}:`)) set.delete(k);
  };

  // Replays events after the view's last seq, or everything when the daemon restarted (new logEpoch).
  // A Session that is not live in the daemon is rebuilt from its transcript and resumes with the same id on the next prompt.
  async function subscribe(id: string, o: Subscribe = {}): Promise<void> {
    const { addProject = false, fresh = false, background = false, startAt } = o;
    const view = views[id];
    if (view) resubscribing.add(id);
    // A subscribe of a Session without a view is its follow: the list must not ask a second time while it is in flight.
    else requested.add(id);
    // After a daemon restart the snapshot starts at the oldest turn this view holds (transcript uuids are stable), so the scroll position survives.
    const from = fresh
      ? undefined
      : view?.order.find((x) => {
          const p = view.parts.get(x);
          return p?.type === "user_text" && !p.parentId;
        }) ?? startAt;
    // The daemon sends hashes back as refs instead of the parts the view holds when it answers with a snapshot anyway: another epoch (a daemon restart, here or while
    // the page was closed), a trimmed cached view (parts, no epoch), or a side Session from the cache (the hub's hello has no side epochs). Same epoch: only `sinceSeq`, no hashes.
    const hasParts = !!view && (view.order.length > 0 || view.aux.length > 0);
    const wantKnown = !fresh && hasParts && ((host.isLocal(id) && !!hello && view.logEpoch !== hello.logEpoch) || !view.logEpoch || (!host.isLocal(id) && fromCache.has(id)));
    const known = wantKnown ? knownOf(view) : [];
    const before = intent.get(id);
    const token = ++tokens;
    intentToken.set(id, token);
    intent.set(id, background ? "background" : "hold");
    try {
      const r = await host.client()!.request<SubscribeResult>({
        type: "session.subscribe",
        sessionId: id,
        sinceSeq: fresh ? 0 : view?.lastSeq ?? 0,
        logEpoch: view?.logEpoch,
        paged: true,
        ...(from && { from }),
        ...(known.length && { known }),
        ...(addProject && { addProject }),
        ...(background && { background }),
      });
      // A ref the view no longer holds (it was reset meanwhile): the same subscribe again as a plain snapshot.
      let merged: SessionView | undefined;
      if (r.snapshot?.refs) {
        const m = withSubscribe(views[id] ?? emptySession(), r);
        if (m === MISSING_REFS) return await subscribe(id, { addProject, fresh: true, background, startAt });
        merged = m;
      }
      // Runs before the replayed events: the reply precedes them on the socket and this continuation is a microtask.
      replayedTo.set(id, r.seq);
      // A snapshot replaces the view: its older edits and failed cursor are asked again.
      if (r.snapshot) {
        clearAsks(editsAsked, id);
        clearAsks(artifactsAsked, id);
        failedPage.delete(id);
        clearAsks(runRequested, id);
      }
      fromCache.delete(id);
      commit({ ...views, [id]: merged ?? (withSubscribe(views[id] ?? emptySession(), r) as SessionView) });
      host.replied(id, r);
    } catch (e) {
      // The request did not take: the next command asks again.
      if (intentToken.get(id) === token) before ? intent.set(id, before) : intent.delete(id);
      // Gone from the daemon, e.g. never prompted before a daemon restart (no transcript): drop it from this tab.
      if ((e as RequestError).code === "unknown_session") return host.gone(id);
      if ((e as Error).message !== "disconnected") {
        // One toast and one state update for a burst of failures (a stopped side fails every one of its Sessions at once).
        failedBatch.push(id);
        failedMessage = (e as Error).message;
        if (failedBatch.length === 1)
          setTimeout(() => {
            const ids = failedBatch.splice(0);
            host.failed(ids, failedMessage);
          });
        // A stopped side (side_not_ready) fails the same way again: asked again only after a reconnect or when a side becomes ready, not by every list change.
        // Another failure may be transient: asked again by the next follow instead of waiting for good.
        if (!views[id]) {
          if ((e as RequestError).code === "side_not_ready") failedFollow.add(id);
          else requested.delete(id);
        }
      } else if (!views[id]) requested.delete(id); // a dropped request: the next follow asks again; a view is resubscribed on reconnect
    } finally {
      resubscribing.delete(id);
    }
  }
  function retryFailedFollows() {
    for (const id of failedFollow) requested.delete(id);
    failedFollow.clear();
  }

  /** A follow of a Session that has no view: its cached view (a background one is not read at page load) is put in first, so the subscribe resumes from it. */
  async function followCached(id: string, hold?: boolean) {
    await host.readCached?.(id);
    return subscribe(id, { background: !(hold ?? host.shownAs(id) !== undefined) });
  }

  const setOlder = (id: string, on: boolean) => {
    olderMap = { ...olderMap, [id]: on };
    notify();
  };

  const follow = {
    /** The current views; always the latest. */
    views: () => views,
    /** Called after any change of views, the loading indicators or `synced`. */
    onChange(l: () => void) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    olderLoading: (id: string) => !!olderMap[id],
    /** The loading indicators as a map (replaced on every change, for state). */
    olderLoadingMap: () => olderMap,
    /** The resync of this connection settled (list and shown Sessions replied): what is not needed at once (repos, background views) waits for it. */
    synced: () => synced,
    resyncing: (id: string) => resubscribing.has(id),
    /** A session.list reply requested on the current connection arrived: before it the list (state, lastActivity) may be of before a daemon restart. */
    listFresh: () => listFresh,
    connection: () => gen,
    hello: () => hello,
    lastLive: effects.lastLive,
    takeHiddenNeed: effects.takeHiddenNeed,

    /** A tab, the hash or an Aside shows the Session: hold. Subscribes when the intent is not hold yet, or to add the project. */
    show(id: string, o: { addProject?: boolean; startAt?: string } = {}): Promise<void> {
      if (!o.addProject && intent.get(id) === "hold") return Promise.resolve();
      return subscribe(id, { addProject: o.addProject, startAt: o.startAt });
    },
    /** Follow without hold (the CLI may close after the idle time). */
    background(id: string): Promise<void> {
      if (intent.get(id) === "background") return Promise.resolve();
      return subscribe(id, { background: true });
    },
    /** Follow once when there is no view and nothing asked; hold when shown (or `hold`). */
    ensure(id: string, o: { hold?: boolean } = {}): void {
      if (views[id] || requested.has(id)) return;
      requested.add(id);
      void followCached(id, o.hold);
    },
    /** The Session has no view any more; `unsubscribe` also stops the daemon's events. */
    drop(id: string, { unsubscribe = true }: { unsubscribe?: boolean } = {}) {
      intent.delete(id);
      intentToken.delete(id); // a subscribe still in flight must not bring the intent back when it fails
      requested.delete(id);
      fromCache.delete(id);
      if (id in views) {
        const { [id]: _gone, ...rest } = views;
        commit(rest);
      }
      host.dropped(id);
      if (unsubscribe) host.client()?.request({ type: "session.unsubscribe", sessionId: id }).catch(() => {});
    },
    /** A cached view, only where none exists; it stays marked until its first subscribe. */
    seed(id: string, view: SessionView): boolean {
      if (views[id]) return false;
      fromCache.add(id);
      commit({ ...views, [id]: view });
      return true;
    },
    /** Loads the page of whole turns before the view's cursor (`until`: back to the turn holding that part or message). Prepended without moving the view. */
    async loadOlder(id: string, opts?: { until?: string; user?: boolean }) {
      const view = views[id];
      if (!view?.older || !view.logEpoch || loadingOlder.has(id)) return;
      const { before } = view.older;
      const epoch = view.logEpoch;
      const cursorKey = `${epoch}:${before}`;
      // A scroll event retries a failed cursor, at most every PAGE_RETRY_MS (measurements and the pinned follow fire scroll events too); layout passes do not.
      const failed = failedPage.get(id);
      if (failed?.key === cursorKey && (!opts?.user || now() - failed.at < PAGE_RETRY_MS)) return;
      loadingOlder.add(id);
      setOlder(id, true);
      try {
        const r = await host.client()!.request<PageResult>({ type: "session.page", sessionId: id, logEpoch: epoch, before, ...(opts?.until && { until: opts.until }) });
        failedPage.delete(id);
        const v = views[id];
        if (v?.logEpoch === epoch) commit({ ...views, [id]: withPage(v, before, r.page) });
      } catch (e) {
        const code = (e as RequestError).code;
        const background = intent.get(id) !== "hold";
        // The cursor is gone (rewound away): a fresh snapshot replaces the view.
        if (code === "unknown_cursor") await subscribe(id, { fresh: true, background });
        // The daemon restarted: the resubscribe (with `from`, so the position stays) takes the new epoch.
        else if (code === "stale_epoch") await subscribe(id, { background });
        else if ((e as Error).message !== "disconnected") {
          // One toast per cursor: a retry that fails again stays quiet.
          const again = failedPage.get(id)?.key === cursorKey;
          failedPage.set(id, { key: cursorKey, at: now() });
          if (!again) host.error((e as Error).message);
        }
      } finally {
        loadingOlder.delete(id);
        setOlder(id, false);
      }
    },
    /** The Edit/Write calls of the unloaded region, asked once per boundary (the cursor moves, aux keeps them). */
    loadEdits(id: string) {
      const v = views[id];
      if (!v?.older || v.auxEdits || !v.logEpoch) return;
      const { before } = v.older;
      const epoch = v.logEpoch;
      const key = `${id}:${epoch}:${before}`;
      if (editsAsked.has(key)) return;
      editsAsked.add(key);
      host.client()?.request<EditsResult>({ type: "session.edits", sessionId: id, logEpoch: epoch, before }).then(
        (r) => views[id]?.logEpoch === epoch && commit({ ...views, [id]: withEdits(views[id]!, before, r.parts) }),
        () => editsAsked.delete(key),
      );
    },
    /** The Artifact publishes of the unloaded region, asked once per boundary. */
    loadArtifacts(id: string) {
      const v = views[id];
      if (!v?.older || v.auxArtifacts || !v.logEpoch) return;
      const { before } = v.older;
      const epoch = v.logEpoch;
      const key = `${id}:${epoch}:${before}`;
      if (artifactsAsked.has(key)) return;
      artifactsAsked.add(key);
      host.client()?.request<ArtifactsResult>({ type: "session.artifacts", sessionId: id, logEpoch: epoch, before }).then(
        (r) => views[id]?.logEpoch === epoch && commit({ ...views, [id]: withArtifacts(views[id]!, before, r.parts) }),
        () => artifactsAsked.delete(key),
      );
    },
    /** A subagent view whose run is only known from aux: load back to its turn once. */
    revealRun(id: string, runId: string) {
      const v = views[id];
      if (!v || v.parts.has(runId) || !partOf(v, runId) || loadingOlder.has(id)) return;
      const key = `${id}:${runId}`;
      if (runRequested.has(key)) return;
      runRequested.add(key);
      void follow.loadOlder(id, { until: runId });
    },
    /** A real list reply of connection `at`: the list is fresh, a side that became ready is asked again, live Sessions are followed in the background. */
    listReplied(at: number, sessions: readonly SessionListItem[], readySideIds: readonly string[]) {
      if (at === gen) listFresh = true;
      // A side that became ready: its Sessions that failed to follow are asked again.
      const ready = new Set(readySideIds);
      if ([...ready].some((id) => !readySides.has(id))) retryFailedFollows();
      readySides = ready;
      // Live Sessions are followed so their unread markers update without opening them (background: no hold on the CLI).
      // A restored or cached Session (`live: false`, idle) has no CLI running: nothing new arrives, so it is not followed.
      for (const s of sessions)
        if (followed(s) && (s.state !== "error" || host.shownAs(s.id) !== undefined || now() - s.lastActivity <= FINISHED_MAX_AGE_MS) && !views[s.id] && !requested.has(s.id)) follow.ensure(s.id);
    },
    /** A connection is ready: per-connection state resets. Returns the connection's number. */
    opened(h: DaemonHello | undefined): number {
      gen++;
      listFresh = false;
      hello = h;
      effects.opened(gen);
      failedPage.clear();
      retryFailedFollows();
      synced = false; // the resync may wait for the daemon check: repos must not load meanwhile
      notify();
      return gen;
    },
    /** The resync of a reconnect: the list and the shown Sessions first; the background views and the repos follow once they settled (GH-760). */
    resync(): Promise<void> {
      synced = false;
      notify();
      const at = gen;
      const settle: Promise<unknown>[] = [host.refreshList()];
      const h = host.hashId();
      intent.clear();
      // The hash Session of a page load is only shown, not opened by the user: a removed project stays removed.
      if (h && !views[h]) settle.push(subscribe(h));
      // Shown Sessions at once; background views through a small queue.
      // A background view of a Session that is no longer live (idle, not live) is dropped, unless it is unread: the list does not follow it either.
      const live = (id: string) => {
        const s = host.listed(id);
        return !s || followed(s) || host.unread(id);
      };
      const background: string[] = [];
      // The visible tab goes first, then asides (an open popup), then the other open tabs: on a slow link the daemon sends their backlogs in this order (GH-767).
      const rank = (id: string) => (id === h ? 0 : host.shownAs(id) === "aside" ? 1 : 2);
      for (const id of Object.keys(views).sort((x, y) => rank(x) - rank(y))) {
        if (host.shownAs(id) !== undefined) settle.push(subscribe(id));
        else if (live(id)) background.push(id);
        else follow.drop(id, { unsubscribe: false });
      }
      const worker = async () => {
        for (let id = background.shift(); id !== undefined && at === gen; id = background.shift()) if (views[id] && intent.get(id) !== "hold") await subscribe(id, { background: true }); // opened while it waited: its hold stays
      };
      // Bounded wait: a request that never settles must not keep the background views and the repos from loading.
      let timer: ReturnType<typeof setTimeout>;
      const cap = new Promise<void>((r) => (timer = setTimeout(r, RESYNC_SETTLE_MS)));
      return Promise.race([Promise.allSettled(settle), cap]).then(() => {
        clearTimeout(timer);
        if (at !== gen) return;
        synced = true;
        notify();
        for (let i = 0; i < RESUBSCRIBE_CONCURRENCY; i++) void worker();
      });
    },
    /** The cache was of another daemon: views and requests are cleared. */
    reset() {
      fromCache.clear();
      requested.clear(); // a follow that drew a view of the other daemon must be asked again
      commit({});
    },
    /** One drained batch of events: applied to the views, classified; the caller performs the effects. */
    apply(events: Event[]): Effect[] {
      const next = { ...views };
      const out = effects.classify(events, (id) => views[id]?.state);
      for (const e of events) next[e.sessionId] = applyEvent(next[e.sessionId] ?? emptySession(), e);
      commit(next);
      return out;
    },
    /** A prompt was sent from this page. */
    sent: effects.sent,
    pageHidden: effects.pageHidden,
  };
  return follow;
}

export type SessionFollow = ReturnType<typeof createSessionFollow>;
