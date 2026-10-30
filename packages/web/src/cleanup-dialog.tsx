// Clean up dialog (GH-377, docs/spec.md "Layout"): bulk removal of worktrees and workers with daemon-computed safety badges.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { SessionListItem, SessionState, Worktree, WorktreeCachedResult, WorktreeStatusResult } from "@claude-ui/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Request } from "./client.ts";
import { cleanupCandidates, cleanupItems, confirmLabel, defaultSelection, filterRows, ignoredText, rowLabel, rowSafety, runCleanup, summaryText, type CleanupResult, type CleanupScope, type Filter, type Row } from "./cleanup.ts";
import { trapTab } from "./focus-trap.ts";
import { stateName, timeAgo } from "./sessions.ts";
import { ARCHIVE_DAYS, daysLabel } from "./sidebar-menus.ts";
import { t, useT } from "./i18n.ts";
import { projectName } from "./tabs.ts";

type FetchState = { state: "fetching" } | { state: "done"; at: number } | { state: "failed"; reason: string };

type Props = {
  scope?: CleanupScope;
  list: SessionListItem[];
  worktrees: Record<string, Worktree[]>;
  state: (s: SessionListItem) => SessionState;
  request: <T>(m: Request) => Promise<T>;
  onClose: () => void;
  /** After a run (also when the dialog was closed meanwhile): the app refreshes its list and reports the result. */
  onDone: (result: CleanupResult) => void;
  /** A worktree's removal starts / ends: the sidebar shows its row as Removing…. */
  onRemoving: (path: string, on: boolean) => void;
};

export function CleanupDialog(p: Props) {
  // Esc and an outside press close it like Cancel, also during a run: the run goes on and the app reports the result.
  return (
    <Dialog.Root open={p.scope !== undefined} onOpenChange={(open) => !open && p.onClose()}>
      {p.scope && <Body {...p} scope={p.scope} />}
    </Dialog.Root>
  );
}

const describe = (scope: CleanupScope) => (scope.kind === "all" ? t("sidebar.cl.allProjects") : scope.kind === "project" ? projectName(scope.cwd) : t("sidebar.cl.workersOf", { title: scope.title }));

function Body({ scope, list, worktrees, state, request, onClose, onDone, onRemoving }: Props & { scope: CleanupScope }) {
  const t = useT();
  const id = useId();
  const cands = useMemo(() => cleanupCandidates(scope, list, worktrees, state), []); // eslint-disable-line react-hooks/exhaustive-deps -- frozen while open
  const [status, setStatus] = useState<Record<string, WorktreeStatusResult | { error: string }>>({});
  const [cached, setCached] = useState<Record<string, WorktreeStatusResult>>({});
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [deleteBranch, setDeleteBranch] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>({ olderThan: 0, onlySafe: false });
  const [ack, setAck] = useState<number | undefined>();
  const [phase, setPhase] = useState<"pick" | "run" | "done">("pick");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<CleanupResult>();
  const closeRef = useRef<HTMLButtonElement>(null);
  const now = useMemo(() => Date.now(), []);

  const repos = useMemo(() => [...new Set(cands.worktrees.map((w) => w.project))], [cands]);
  const [fetches, setFetches] = useState<Record<string, FetchState>>({});
  const [clock, setClock] = useState(() => Date.now());
  const fetched = Object.values(fetches).some((f) => f.state === "done");

  useEffect(() => {
    let live = true;
    // One scan id per run of this effect: the daemon queues its statuses behind the status bar and drops them on `worktree.cancel`, and keeps a cancelled id cancelled.
    const scan = crypto.randomUUID();
    const scanRepo = (repo: string) => {
      for (const w of cands.worktrees.filter((x) => x.project === repo))
        request<WorktreeStatusResult>({ type: "worktree.status", cwd: repo, path: w.path, scan }).then(
          (st) => live && setStatus((s) => ({ ...s, [w.key]: st })),
          (e) => live && setStatus((s) => ({ ...s, [w.key]: { error: (e as Error).message } })),
        );
    };
    // Per repository in parallel: fetch the default remote first (a failure only warns), then every status of it.
    for (const repo of repos) {
      // The last known statuses show at once (no git); the fresh ones replace them.
      request<WorktreeCachedResult>({ type: "worktree.cached", cwd: repo, paths: cands.worktrees.filter((x) => x.project === repo).map((x) => x.path) }).then(
        (r) => live && setCached((c) => ({ ...c, ...Object.fromEntries(cands.worktrees.flatMap((w) => (r.statuses?.[w.path] ? [[w.key, r.statuses[w.path]!] as const] : []))) })),
        () => {},
      );
      setFetches((f) => ({ ...f, [repo]: { state: "fetching" } }));
      request({ type: "git.fetch", cwd: repo, defaultRemote: true })
        .then(
          () => live && setFetches((f) => ({ ...f, [repo]: { state: "done", at: Date.now() } })),
          (e) => live && setFetches((f) => ({ ...f, [repo]: { state: "failed", reason: (e as Error).message } })),
        )
        .then(() => live && scanRepo(repo));
    }
    return () => {
      live = false;
      void request({ type: "worktree.cancel", scan }).catch(() => {});
    };
  }, [cands, repos, request]);

  useEffect(() => {
    if (!fetched) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [fetched]);

  const rows: Row[] = useMemo(
    () => [
      ...cands.worktrees.map((w): Row => {
        const s = status[w.key];
        return { kind: "worktree", ...w, ...(cached[w.key] && { cached: cached[w.key] }), ...(s && ("error" in s ? { error: s.error } : { status: s })) };
      }),
      ...cands.workers.map((w): Row => ({ kind: "worker", ...w })),
    ],
    [cands, status, cached],
  );
  const defaults = useMemo(() => defaultSelection(rows), [rows]);
  const safetyOf = (r: Row) => rowSafety(r).safety;
  const isOn = (r: Row) => {
    const s = safetyOf(r);
    if (s === "blocked" || s === "checking") return false;
    return r.key in override ? override[r.key]! : defaults.has(r.key);
  };
  const visible = filterRows(rows, filter, now);
  const ticked = visible.filter(isOn);
  const n = ticked.length;
  const m = ticked.filter((r) => r.kind === "worktree" && safetyOf(r) === "has_work").length;
  const acked = m === 0 || ack === m;
  const busy = phase === "run";
  const set = (key: string, on: boolean) => setOverride((o) => ({ ...o, [key]: on }));

  useEffect(() => {
    if (phase === "done") closeRef.current?.focus();
  }, [phase]);

  async function run() {
    setPhase("run");
    setProgress(0);
    // Every queued worktree shows Removing… in the sidebar from the start; each row clears when its own request ends.
    for (const r of ticked) if (r.kind === "worktree") onRemoving(r.path, true);
    const marked = (m: Parameters<typeof request>[0]) => (m.type === "worktree.remove" ? request(m).finally(() => onRemoving(m.path, false)) : request(m));
    const items = cleanupItems(ticked, new Set(ticked.map((r) => r.key)), { deleteBranch }, marked as never);
    const r = await runCleanup(items, setProgress);
    // A worktree ticked (by "Also remove its worktree" or by default) that the filter hides is not removed: say so.
    for (const w of ticked) {
      const wt = w.kind === "worker" && w.worktree ? rows.find((x) => x.kind === "worktree" && x.path === w.worktree) : undefined;
      if (wt && isOn(wt) && !visible.includes(wt)) r.notes.push(t("sidebar.cl.hiddenKept", { name: rowLabel(wt) }));
    }
    setResult(r);
    setPhase("done");
    onDone(r);
  }

  const sections = [
    { id: "worktrees", title: t("sidebar.cl.worktrees"), rows: visible.filter((r) => r.kind === "worktree") },
    { id: "workers", title: t("sidebar.cl.workers"), rows: visible.filter((r) => r.kind === "worker") },
  ];
  const total = rows.length;

  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
      <Dialog.Popup
        onKeyDown={trapTab}
        className="-translate-x-1/2 fixed top-[max(48px,calc((100dvh-640px)/2))] left-1/2 z-50 flex max-h-[min(100dvh-96px,640px)] w-[min(100vw-24px,720px)] flex-col rounded-2xl border bg-card text-foreground shadow-floating outline-none max-sm:top-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:rounded-none"
        data-testid="cleanup-dialog"
        aria-modal="true"
      >
        <div className="flex flex-col gap-0.5 px-4 pt-4 pb-2">
          <Dialog.Title className="font-medium text-[15px] tracking-[-0.13px]">{t("sidebar.cl.title")}</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-sm">{describe(scope)}</Dialog.Description>
          {repos.map((repo) => {
            const f = fetches[repo];
            if (!f) return null;
            const secs = f.state === "done" ? Math.max(0, Math.round((clock - f.at) / 1000)) : 0;
            const text = f.state === "fetching" ? t("sidebar.cl.fetching") : f.state === "done" ? t("sidebar.cl.fetched", { time: secs < 60 ? `${secs} s` : timeAgo(f.at, clock) }) : t("sidebar.cl.fetchFailed", { reason: f.reason });
            return (
              <p key={repo} role="status" data-testid="cleanup-fetch" className={cn("text-xs", f.state === "failed" ? "text-destructive" : "text-muted-foreground")}>
                {repos.length > 1 ? `${projectName(repo)}: ` : ""}
                {text}
              </p>
            );
          })}
        </div>
        {phase === "done" && result ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-2" data-testid="cleanup-summary">
            <p role="status" className="font-medium text-sm">
              {summaryText(result)}
            </p>
            {result.skipped.length > 0 && (
              <ul className="flex flex-col gap-1 text-sm">
                {result.skipped.map((s, i) => (
                  <li key={i}>
                    <span className="font-medium">{s.label}</span>: <span className="text-muted-foreground">{s.reason}</span>
                  </li>
                ))}
              </ul>
            )}
            {result.notes.length > 0 && (
              <ul className="flex flex-col gap-1 text-muted-foreground text-sm">
                {result.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            {total > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 text-sm">
                <label className="flex items-center gap-2 max-md:min-h-11">
                  <span>{t("sidebar.cl.olderThan")}</span>
                  <select
                    aria-label={t("sidebar.cl.olderThan")}
                    data-testid="cleanup-older"
                    disabled={busy}
                    value={filter.olderThan}
                    onChange={(e) => setFilter((f) => ({ ...f, olderThan: Number(e.target.value) as Filter["olderThan"] }))}
                    className="h-8 rounded-md border border-border bg-background px-2 max-md:h-11"
                  >
                    <option value={0}>{t("sidebar.cl.any")}</option>
                    {ARCHIVE_DAYS.map((d) => (
                      <option key={d} value={d}>
                        {daysLabel(d)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 max-md:min-h-11">
                  <input type="checkbox" data-testid="cleanup-only-safe" disabled={busy} checked={filter.onlySafe} onChange={(e) => setFilter((f) => ({ ...f, onlySafe: e.target.checked }))} />
                  <span>{t("sidebar.cl.onlySafe")}</span>
                </label>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
              {total === 0 && <p className="py-4 text-muted-foreground text-sm">{t("sidebar.cl.nothing")}</p>}
              {sections.map(
                (sec) =>
                  sec.rows.length > 0 && (
                    <section key={sec.id} className="mb-2">
                      <h3 className="py-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">{sec.title}</h3>
                      <ul className="flex flex-col">
                        {sec.rows.map((r) => (
                          <RowItem
                            key={r.key}
                            r={r}
                            ids={`${id}-${r.key}`}
                            now={now}
                            on={isOn(r)}
                            busy={busy}
                            rows={rows}
                            safetyOf={safetyOf}
                            isOn={(x) => isOn(x) && visible.includes(x)}
                            shown={(x) => visible.includes(x)}
                            set={set}
                            deleteBranch={deleteBranch.has(r.key)}
                            setDeleteBranch={(on) => setDeleteBranch((d) => (on ? new Set(d).add(r.key) : (d.delete(r.key), new Set(d))))}
                          />
                        ))}
                      </ul>
                    </section>
                  ),
              )}
              {total > 0 && visible.length === 0 && <p className="py-4 text-muted-foreground text-sm">{t("sidebar.cl.noRow")}</p>}
            </div>
          </>
        )}
        <div className="flex flex-col gap-2 border-border border-t px-4 py-3">
          {busy && (
            <p role="status" className="text-sm">
              {t("sidebar.cl.removingProgress", { current: Math.min(progress + 1, n), total: n })}
            </p>
          )}
          {phase === "pick" && m > 0 && (
            <label className="flex items-start gap-2 text-sm max-md:min-h-11">
              <input type="checkbox" data-testid="cleanup-ack" className="mt-1" checked={ack === m} onChange={(e) => setAck(e.target.checked ? m : undefined)} />
              <span>{t("sidebar.cl.ack", { count: m })}</span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            {phase === "done" ? (
              <Button ref={closeRef} onClick={onClose} className="max-md:h-11" data-testid="cleanup-close">
                {t("sidebar.close")}
              </Button>
            ) : (
              <>
                <Button variant="ghost" onClick={onClose} className="max-md:h-11" data-testid="cleanup-cancel">
                  {t(busy ? "sidebar.close" : "sidebar.cancel")}
                </Button>
                <Button variant="destructive" disabled={busy || n === 0 || !acked} onClick={() => void run()} className="max-md:h-11" data-testid="cleanup-confirm">
                  {confirmLabel(n, m)}
                </Button>
              </>
            )}
          </div>
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  );
}

const BADGE = { safe: "secondary", has_work: "outline", blocked: "destructive", checking: "ghost" } as const;

function RowItem({ r, ids, now, on, busy, rows, safetyOf, isOn, shown, set, deleteBranch, setDeleteBranch }: {
  r: Row;
  ids: string;
  now: number;
  on: boolean;
  busy: boolean;
  rows: Row[];
  safetyOf: (r: Row) => string;
  isOn: (r: Row) => boolean;
  shown: (r: Row) => boolean;
  set: (key: string, on: boolean) => void;
  deleteBranch: boolean;
  setDeleteBranch: (on: boolean) => void;
}) {
  const t = useT();
  const { safety, reason, cached } = rowSafety(r);
  const label = (s: string, why?: string) => (s === "safe" ? t("sidebar.cl.safe") : s === "has_work" ? t("sidebar.cl.hasWork", { why: why ?? "" }) : s === "blocked" ? t("sidebar.cl.blockedWhy", { why: why ?? "" }) : t("sidebar.cl.checking"));
  const text = cached ? t("sidebar.cl.checkingAgain", { label: label(cached.safety, cached.reason) }) : label(safety, reason);
  const checkedAt = r.kind === "worktree" ? (r.status ?? r.cached)?.checkedAt : undefined;
  const act = r.kind === "worker" ? r.lastActivity : Math.max(r.lastActivity ?? 0, r.status?.headTime ?? 0) || undefined;
  const meta = [
    r.kind === "worktree" ? t("sidebar.op.sessionCount", { count: r.sessions }) : undefined,
    act ? timeAgo(act, now) : undefined,
    checkedAt && now - checkedAt > 5000 ? t("sidebar.cl.checkedAgo", { time: timeAgo(checkedAt, now) }) : undefined,
    r.kind === "worktree" && r.status && r.status.ignored === undefined ? t("sidebar.cl.ignoredAtRemoval") : undefined,
    r.kind === "worktree" && r.status?.ignored ? t("sidebar.cl.willDelete", { ignored: ignoredText(r.status.ignored) }) : undefined,
    r.kind === "worktree" && r.status?.upstreamGone ? t("sidebar.cl.remoteGone") : undefined,
    safety === "safe" ? reason : undefined,
    r.kind === "worker" ? stateName(r.state) : r.outsideRoots ? t("sidebar.cl.outsideRoots") : r.locked ? t("sidebar.cl.lockedShort") : r.status ? t(r.status.safety === "has_work" ? "sidebar.cl.hasWorkShort" : "sidebar.cl.clean") : undefined,
  ].filter(Boolean);
  const wt = r.kind === "worker" && r.worktree ? rows.find((x) => x.kind === "worktree" && x.path === r.worktree) : undefined;
  const wtHidden = !!wt && !shown(wt);
  const wtOk = wt && !wtHidden && !["blocked", "checking"].includes(safetyOf(wt));
  const keptBranch = r.kind === "worktree" && r.branch && !r.status?.createdBranch && r.status?.branchMerged;
  return (
    <li className="flex min-h-8 flex-col justify-center py-1 max-md:min-h-11" data-testid="cleanup-row" data-key={r.key}>
      <div className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1 size-4 max-md:mt-3"
          aria-label={rowLabel(r)}
          aria-describedby={`${ids}-safety`}
          checked={on}
          disabled={busy || safety === "blocked" || safety === "checking"}
          onChange={(e) => set(r.key, e.target.checked)}
          data-testid="cleanup-check"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span className="truncate text-sm">{rowLabel(r)}</span>
            {r.kind === "worktree" && r.external && <Badge variant="outline">{t("sidebar.cl.external")}</Badge>}
            <Badge variant={BADGE[safety]} id={`${ids}-safety`} data-testid="cleanup-badge">
              {text}
            </Badge>
          </div>
          <span className="text-muted-foreground text-xs">{meta.join(" · ")}</span>
        </div>
      </div>
      {keptBranch && on && (
        <label className={cn("ml-6 flex items-center gap-2 text-sm max-md:min-h-11")}>
          <input type="checkbox" disabled={busy} checked={deleteBranch} onChange={(e) => setDeleteBranch(e.target.checked)} data-testid="cleanup-delete-branch" />
          <span>{t("sidebar.cl.alsoDeleteBranch", { name: r.branch ?? "" })}</span>
        </label>
      )}
      {wt && (
        <label className="ml-6 flex items-center gap-2 text-sm max-md:min-h-11">
          <input type="checkbox" disabled={busy || !wtOk} checked={isOn(wt)} onChange={(e) => set(wt.key, e.target.checked)} data-testid="cleanup-also-worktree" />
          <span>{t("sidebar.cl.alsoRemoveWt")}{wtHidden && <span className="text-muted-foreground">{t("sidebar.cl.hiddenByFilter")}</span>}</span>
        </label>
      )}
    </li>
  );
}
