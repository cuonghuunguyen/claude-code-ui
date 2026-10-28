// Clean up dialog (GH-377, docs/spec.md "Layout"): bulk removal of worktrees and workers with daemon-computed safety badges.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { SessionListItem, SessionState, Worktree, WorktreeStatusResult } from "@claude-ui/protocol";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Request } from "./client.ts";
import { cleanupCandidates, cleanupItems, confirmLabel, defaultSelection, filterRows, rowLabel, rowSafety, runCleanup, summaryText, type CleanupResult, type CleanupScope, type Filter, type Row } from "./cleanup.ts";
import { trapTab } from "./focus-trap.ts";
import { timeAgo } from "./sessions.ts";
import { ARCHIVE_DAYS, daysLabel } from "./sidebar-menus.ts";
import { projectName } from "./tabs.ts";

/** At most this many `worktree.status` requests in flight (the daemon's git queue runs 4). */
const STATUS_PARALLEL = 4;

type Props = {
  scope?: CleanupScope;
  list: SessionListItem[];
  worktrees: Record<string, Worktree[]>;
  state: (s: SessionListItem) => SessionState;
  request: <T>(m: Request) => Promise<T>;
  onClose: () => void;
  /** After a run: the app refreshes its list. */
  onDone: () => void;
};

export function CleanupDialog(p: Props) {
  // Esc and an outside press close it like Cancel, except during a run: it stays open until the summary.
  const running = useRef(false);
  return (
    <Dialog.Root open={p.scope !== undefined} onOpenChange={(open) => !open && !running.current && p.onClose()}>
      {p.scope && <Body {...p} scope={p.scope} running={running} />}
    </Dialog.Root>
  );
}

const describe = (scope: CleanupScope) => (scope.kind === "all" ? "All projects" : scope.kind === "project" ? projectName(scope.cwd) : `Workers of “${scope.title}”`);

function Body({ scope, list, worktrees, state, request, onClose, onDone, running }: Props & { scope: CleanupScope; running: { current: boolean } }) {
  const id = useId();
  const cands = useMemo(() => cleanupCandidates(scope, list, worktrees, state), []); // eslint-disable-line react-hooks/exhaustive-deps -- frozen while open
  const [status, setStatus] = useState<Record<string, WorktreeStatusResult | { error: string }>>({});
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const [deleteBranch, setDeleteBranch] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>({ olderThan: 0, onlySafe: false });
  const [ack, setAck] = useState<number | undefined>();
  const [phase, setPhase] = useState<"pick" | "run" | "done">("pick");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<CleanupResult>();
  const closeRef = useRef<HTMLButtonElement>(null);
  const now = useMemo(() => Date.now(), []);

  useEffect(() => {
    let live = true;
    const queue = [...cands.worktrees];
    const next = async (): Promise<void> => {
      const w = queue.shift();
      if (!w || !live) return;
      try {
        const st = await request<WorktreeStatusResult>({ type: "worktree.status", cwd: w.project, path: w.path });
        if (live) setStatus((s) => ({ ...s, [w.key]: st }));
      } catch (e) {
        if (live) setStatus((s) => ({ ...s, [w.key]: { error: (e as Error).message } }));
      }
      return next();
    };
    for (let i = 0; i < STATUS_PARALLEL; i++) void next();
    return () => void (live = false);
  }, [cands, request]);

  const rows: Row[] = useMemo(
    () => [
      ...cands.worktrees.map((w): Row => {
        const s = status[w.key];
        return { kind: "worktree", ...w, ...(s && ("error" in s ? { error: s.error } : { status: s })) };
      }),
      ...cands.workers.map((w): Row => ({ kind: "worker", ...w })),
    ],
    [cands, status],
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
  running.current = busy;
  const set = (key: string, on: boolean) => setOverride((o) => ({ ...o, [key]: on }));

  useEffect(() => {
    if (phase === "done") closeRef.current?.focus();
  }, [phase]);

  async function run() {
    running.current = true;
    setPhase("run");
    setProgress(0);
    const items = cleanupItems(ticked, new Set(ticked.map((r) => r.key)), { deleteBranch }, request as never);
    const r = await runCleanup(items, setProgress);
    // A worktree ticked (by "Also remove its worktree" or by default) that the filter hides is not removed: say so.
    for (const w of ticked) {
      const wt = w.kind === "worker" && w.worktree ? rows.find((x) => x.kind === "worktree" && x.path === w.worktree) : undefined;
      if (wt && isOn(wt) && !visible.includes(wt)) r.notes.push(`Worktree ${rowLabel(wt)} kept: hidden by the filter`);
    }
    running.current = false;
    setResult(r);
    setPhase("done");
    onDone();
  }

  const sections = [
    { title: "Worktrees", rows: visible.filter((r) => r.kind === "worktree") },
    { title: "Workers", rows: visible.filter((r) => r.kind === "worker") },
  ];
  const total = rows.length;

  return (
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
      <Dialog.Popup
        onKeyDown={(e) => {
          if (e.key === "Escape" && busy) e.stopPropagation();
          trapTab(e);
        }}
        className="-translate-x-1/2 fixed top-[max(48px,calc((100dvh-640px)/2))] left-1/2 z-50 flex max-h-[min(100dvh-96px,640px)] w-[min(100vw-24px,720px)] flex-col rounded-xl bg-card text-foreground shadow-floating outline-none max-sm:top-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:w-screen max-sm:rounded-none"
        data-testid="cleanup-dialog"
        aria-modal="true"
      >
        <div className="flex flex-col gap-0.5 px-4 pt-4 pb-2">
          <Dialog.Title className="font-medium text-[15px] tracking-[-0.13px]">Clean up</Dialog.Title>
          <Dialog.Description className="text-muted-foreground text-sm">{describe(scope)}</Dialog.Description>
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
                {result.notes.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <>
            {total > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2 text-sm">
                <label className="flex items-center gap-2 max-md:min-h-11">
                  <span>Older than</span>
                  <select
                    aria-label="Older than"
                    data-testid="cleanup-older"
                    disabled={busy}
                    value={filter.olderThan}
                    onChange={(e) => setFilter((f) => ({ ...f, olderThan: Number(e.target.value) as Filter["olderThan"] }))}
                    className="h-8 rounded-md border border-border bg-background px-2 max-md:h-11"
                  >
                    <option value={0}>Any</option>
                    {ARCHIVE_DAYS.map((d) => (
                      <option key={d} value={d}>
                        {daysLabel(d)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 max-md:min-h-11">
                  <input type="checkbox" data-testid="cleanup-only-safe" disabled={busy} checked={filter.onlySafe} onChange={(e) => setFilter((f) => ({ ...f, onlySafe: e.target.checked }))} />
                  <span>Only safe</span>
                </label>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-2">
              {total === 0 && <p className="py-4 text-muted-foreground text-sm">Nothing to clean up</p>}
              {sections.map(
                (sec) =>
                  sec.rows.length > 0 && (
                    <section key={sec.title} className="mb-2">
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
              {total > 0 && visible.length === 0 && <p className="py-4 text-muted-foreground text-sm">No row matches the filter</p>}
            </div>
          </>
        )}
        <div className="flex flex-col gap-2 border-border border-t px-4 py-3">
          {busy && (
            <p role="status" className="text-sm">
              Removing {Math.min(progress + 1, n)} of {n}…
            </p>
          )}
          {phase === "pick" && m > 0 && (
            <label className="flex items-start gap-2 text-sm max-md:min-h-11">
              <input type="checkbox" data-testid="cleanup-ack" className="mt-1" checked={ack === m} onChange={(e) => setAck(e.target.checked ? m : undefined)} />
              <span>Discard uncommitted files and unpushed commits in {m} {m === 1 ? "worktree" : "worktrees"}</span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            {phase === "done" ? (
              <Button ref={closeRef} onClick={onClose} className="max-md:h-11" data-testid="cleanup-close">
                Close
              </Button>
            ) : (
              <>
                <Button variant="ghost" disabled={busy} onClick={onClose} className="max-md:h-11" data-testid="cleanup-cancel">
                  Cancel
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
  const { safety, reason } = rowSafety(r);
  const text = safety === "safe" ? "Safe" : safety === "has_work" ? `Has work: ${reason}` : safety === "blocked" ? `Blocked: ${reason}` : "Checking…";
  const act = r.kind === "worker" ? r.lastActivity : Math.max(r.lastActivity ?? 0, r.status?.headTime ?? 0) || undefined;
  const meta = [
    r.kind === "worktree" ? `${r.sessions} ${r.sessions === 1 ? "session" : "sessions"}` : undefined,
    act ? timeAgo(act, now) : undefined,
    r.kind === "worktree" && r.status?.ignored ? `${r.status.ignored >= 1000 ? "1000+" : r.status.ignored} ignored ${r.status.ignored === 1 ? "file" : "files"} will be deleted` : undefined,
    r.kind === "worker" ? r.state : r.outsideRoots ? "outside roots" : r.locked ? "locked" : r.status ? (r.status.safety === "has_work" ? "has work" : "clean") : undefined,
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
            {r.kind === "worktree" && r.external && <Badge variant="outline">External</Badge>}
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
          <span>Also delete branch {r.branch}</span>
        </label>
      )}
      {wt && (
        <label className="ml-6 flex items-center gap-2 text-sm max-md:min-h-11">
          <input type="checkbox" disabled={busy || !wtOk} checked={isOn(wt)} onChange={(e) => set(wt.key, e.target.checked)} data-testid="cleanup-also-worktree" />
          <span>Also remove its worktree{wtHidden && <span className="text-muted-foreground"> (hidden by the filter)</span>}</span>
        </label>
      )}
    </li>
  );
}
