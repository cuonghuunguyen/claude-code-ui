// Graph tab (docs/spec.md "Layout"): the commit history of the selected repository: lanes, filters, Fetch, details, per-file diff.
import { memo, useCallback, type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { GitCommit, GitRepo, GitCommitDetail, GitCommitResult, GitFileChange, GitLogResult, GitRefsResult, FsReadResult } from "@claude-ui/protocol";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";
import { MultiFileDiff } from "@pierre/diffs/react";
import { ArchiveIcon, ArrowLeftIcon, CloudDownloadIcon, GitCommitHorizontalIcon, LoaderCircleIcon, RotateCwIcon, SearchIcon, TagIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { connect, RequestError } from "./client.ts";
import { KindBadge, StatsText, useNarrow } from "./changes-panel.tsx";
import { FileIcon } from "./file-icon.tsx";
import { pathKey } from "./file-tree-model.ts";
import { readFailure } from "./files.ts";
import { emptyGraph, layoutPage, type GraphRow, type GraphState } from "./git-graph.ts";
import { BranchMenu, ofRepo, type RemoteRequest } from "./git-branch-menu.tsx";
import { runRemoteOp, dismissRemoteResult, useRemoteOp } from "./git-remote-ops.ts";
import { joinPath } from "./paths.ts";
import { RepoSelector } from "./repo-selector.tsx";
import { repoLabel, selectorVisible, useSelectedRepo, type RepoList } from "./repo-choice.ts";
import { noteRefs } from "./git-refs.ts";
import { timeAgo } from "./sessions.ts";
import { useDark } from "./theme.ts";
import { DIFF_OPTIONS } from "./tool-card.tsx";

type Client = ReturnType<typeof connect>;
const PAGE = 200;
const LANE_W = 14;
const ALL = "all";
const HEAD = "HEAD";
const short = (ref: string) => ref.replace(/^refs\/(heads|remotes|tags)\//, "");
const when = (c: { time: number }) => (Date.now() / 1000 - c.time < 7 * 86400 ? timeAgo(c.time * 1000) : new Date(c.time * 1000).toLocaleDateString());
// Same as the changes pane's diff style choice (no toggle here).
const storedStyle = (): "unified" | "split" => {
  try {
    return localStorage.getItem("claude-ui.diffStyle") === "unified" ? "unified" : "split";
  } catch {
    return "split";
  }
};

// Tinted chips (tokens in index.css, 4.5:1 text in both themes): local branch green, remote purple, HEAD yellow; tags keep the neutral border.
const REF_LOCAL = "border-transparent bg-[color-mix(in_srgb,var(--ref-local)_18%,transparent)] text-ref-local";
const REF_REMOTE = "border-transparent bg-[color-mix(in_srgb,var(--ref-remote)_18%,transparent)] text-ref-remote";
const REF_HEAD = "border-transparent bg-[color-mix(in_srgb,var(--ref-head)_18%,transparent)] text-ref-head";

function RefChips({ refs }: { refs: string[] }) {
  // refs[0] === "HEAD": attached, the branch after it is HEAD's; HEAD later in the list: detached.
  const head = refs[0] === "HEAD";
  const names = refs.filter((r) => r !== "HEAD");
  return (
    <>
      {refs.includes("HEAD") && (!head || !names.length) && <Chip className={cn(REF_HEAD, "font-semibold")}>HEAD</Chip>}
      {names.map((r, i) => (
        <Chip key={r} data-ref={r} className={cn(head && i === 0 ? REF_HEAD : r.startsWith("refs/heads/") ? REF_LOCAL : r.startsWith("refs/remotes/") && REF_REMOTE, head && i === 0 && "font-semibold")}>
          {r.startsWith("refs/tags/") && <TagIcon className="size-3" aria-hidden />}
          {short(r)}
        </Chip>
      ))}
    </>
  );
}
const Chip = ({ children, className, "data-ref": ref }: { children: React.ReactNode; className?: string; "data-ref"?: string }) => (
  <span className={cn("inline-flex max-w-40 shrink-0 items-center gap-0.5 truncate rounded border px-1 text-xs", className)} data-testid="commit-ref" data-ref={ref}>
    {children}
  </span>
);

/** The lanes of one row, drawn with SVG: input lines from the top, parent lines to the bottom, the node. One path per lane color. */
const GraphCell = memo(function GraphCell({ row, head, h }: { row: GraphRow; head: boolean; h: number }) {
  const x = (i: number) => LANE_W / 2 + i * LANE_W;
  const col = (n: number) => `var(--graph-${n + 1})`;
  const mid = h / 2;
  const curve = (i: number, j: number) => `M ${x(i)} 0 C ${x(i)} ${mid}, ${x(j)} ${mid}, ${x(j)} ${h} `;
  const width = Math.max(row.input.length, row.output.length, row.col + 1) * LANE_W;
  const byColor: Record<number, string> = {};
  const add = (color: number, d: string) => void (byColor[color] = (byColor[color] ?? "") + d);
  // A lane waiting for this commit ends at its node; any other lane goes on, to its index in `output`.
  row.input.forEach((l, i) => add(l.color, row.through[i]! < 0 ? `M ${x(i)} 0 L ${x(row.col)} ${mid} ` : curve(i, row.through[i]!)));
  for (const j of row.edges) add(row.output[j]!.color, `M ${x(row.col)} ${mid} L ${x(j)} ${h} `);
  return (
    <svg width={width} height={h} className="shrink-0" aria-hidden fill="none" strokeWidth={1.5} data-testid="commit-graph">
      {Object.entries(byColor).map(([c, d]) => (
        <path key={c} d={d} stroke={col(Number(c))} />
      ))}
      <circle cx={x(row.col)} cy={mid} r={head ? 4.5 : 3.5} fill={head ? "var(--card)" : col(row.color)} stroke={col(row.color)} />
      {head && <circle cx={x(row.col)} cy={mid} r={2} fill={col(row.color)} stroke="none" />}
    </svg>
  );
});

type RowProps = { c: GitCommit; row: GraphRow; start: number; on: boolean; filtered: boolean; h: number; setsize: number; posinset: number; onPick: (hash: string) => void };
const CommitRow = memo(function CommitRow({ c, row, start, on, filtered, h, setsize, posinset, onPick }: RowProps) {
  return (
    <div
      id={`commit-${c.hash}`}
      role="option"
      aria-selected={on}
      aria-setsize={setsize}
      aria-posinset={posinset}
      onClick={() => onPick(c.hash)}
      className={cn("absolute top-0 left-0 flex w-full cursor-pointer items-center gap-2 px-2 text-sm hover:bg-accent", on && "bg-secondary")}
      style={{ height: h, transform: `translateY(${start}px)` }}
      data-testid="commit-row"
      data-local-refs={c.refs.filter((r) => r.startsWith("refs/heads/")).join("\n")}
    >
      {!filtered && <GraphCell row={row} head={c.refs.includes("HEAD")} h={h} />}
      <RefChips refs={c.refs} />
      <span className="min-w-0 flex-1 truncate">{c.subject}</span>
      <span className="hidden max-w-32 shrink-0 truncate text-muted-foreground @md:inline">{c.author}</span>
      <span className="shrink-0 text-muted-foreground text-xs" title={new Date(c.time * 1000).toLocaleString()}>
        {when(c)}
      </span>
      <span className="shrink-0 font-mono text-muted-foreground text-xs">{c.hash.slice(0, 7)}</span>
    </div>
  );
});

type Page = { commits: GitCommit[]; rows: GraphRow[]; state: GraphState };
const NO_PAGE: Page = { commits: [], rows: [], state: emptyGraph() };

/** `hidden`: the tab is not showing; the panel stays mounted and keeps its list (docs/spec.md "Layout", Graph tab). */
/** `exact`: `cwd` is a repository top from `git.repos` (every request carries `exact: true`); `onRefresh`: Refresh also re-reads the repository list. `repoName`: names the repository in remote result and running texts. `toolbar`: first in the filter row (the repository selector). `repos`, `onShowRepo`: a submodule entry of a commit that the list holds offers "Show graph of <path>". */
export function GraphPanel({ client, cwd, hidden = false, exact = false, onRefresh, repoName, toolbar, repos, onShowRepo }: { client: Client; cwd: string; hidden?: boolean; exact?: boolean; onRefresh?: () => void; repoName?: string; toolbar?: ReactNode; repos?: GitRepo[]; onShowRepo?: (rel: string) => void }) {
  const ex = exact ? { exact: true as const } : {};
  const narrow = useNarrow();
  const dark = useDark();
  const ROW = narrow ? 44 : 28;
  const [text, setText] = useState("");
  const [author, setAuthor] = useState("");
  const [ref, setRef] = useState(HEAD);
  const [q, setQ] = useState({ text: "", author: "" });
  useEffect(() => {
    const t = setTimeout(() => {
      const tx = text.trim();
      const au = author.trim();
      // The same filter keeps the same object: the fetch effect does not run again (one git.log per open).
      setQ((p) => (p.text === tx && p.author === au ? p : { text: tx, author: au }));
    }, 300);
    return () => clearTimeout(t);
  }, [text, author]);
  const [page, setPage] = useState<Page>(NO_PAGE);
  const { commits, rows } = page;
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notGit, setNotGit] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  // The branch HEAD points to, from the first page (absent when detached: no branch in the list).
  const [head, setHead] = useState<string>();
  // The refs stamp of the loaded first page. On return to the tab, a fresh stamp (git.refs: file stats, no git process) is
  // compared with it: the list reloads when they differ, or when either is unknown (an older daemon, a failed request).
  const [loadedRefs, setLoadedRefs] = useState<string>();
  const wasHidden = useRef(hidden);
  // A panel that mounts hidden (a repository switch made elsewhere) reads nothing until it shows.
  const started = useRef(false);
  useEffect(() => {
    const returned = wasHidden.current && !hidden;
    wasHidden.current = hidden;
    if (!returned) return;
    let live = true;
    client.request<GitRefsResult>({ type: "git.refs", cwd, ...ex }).then(
      (r) => {
        if (!live) return;
        noteRefs(cwd, r.refs ?? undefined);
        if (!r.refs || !loadedRefs || r.refs !== loadedRefs) setReload((n) => n + 1);
      },
      () => live && setReload((n) => n + 1),
    );
    return () => void (live = false);
  }, [hidden]);
  // Set by the Refresh button: that read skips the daemon's caches.
  const freshNext = useRef(false);
  const gen = useRef(0);
  // A remote operation (Fetch, Push, Pull) of this repository: one at a time; its result line shows under the filter row until the next one or Dismiss. Kept per repository path, not in this panel.
  const { running: op, result, settled } = useRemoteOp(cwd);
  const runRemote = (msg: RemoteRequest, done: string, running: string) => void (!notGit && runRemoteOp(client, msg, done, running));
  // Success or failure, the list reloads.
  const lastSettled = useRef(settled);
  useEffect(() => {
    if (settled === lastSettled.current) return;
    lastSettled.current = settled;
    freshNext.current = true;
    setReload((n) => n + 1);
  }, [settled]);
  const of = (x: string) => ofRepo(x, repoName);
  const filter = (skip: number) => ({ type: "git.log" as const, cwd, ...ex, skip, limit: PAGE, ...(ref !== ALL && { ref }), ...(q.author && { author: q.author }), ...(q.text && { text: q.text }) });

  useEffect(() => {
    if (hidden && !started.current) return;
    started.current = true;
    const id = ++gen.current;
    setLoading(true);
    setError(undefined);
    const fresh = freshNext.current;
    freshNext.current = false;
    client.request<GitLogResult>({ ...filter(0), ...(fresh && { fresh: true }) }).then(
      (r) => {
        if (id !== gen.current) return;
        setLoading(false);
        setNotGit(r.log === null);
        const cs = r.log?.commits ?? [];
        const l = layoutPage(cs, emptyGraph());
        setPage({ commits: cs, rows: l.rows, state: l.state });
        setMore(r.log?.more ?? false);
        if (r.log?.branches) {
          setBranches(r.log.branches);
          setHead(r.log.head);
          setLoadedRefs(r.log.refs);
          noteRefs(cwd, r.log.refs);
        }
      },
      (e: RequestError) => id === gen.current && (setLoading(false), setError(e.message), setPage(NO_PAGE), setMore(false)),
    );
  }, [cwd, ref, q, reload]);
  const loadMore = () => {
    const id = gen.current;
    setLoading(true);
    client.request<GitLogResult>(filter(commits.length)).then(
      (r) => {
        if (id !== gen.current) return;
        setLoading(false);
        // Only the new commits are laid out, continuing the lanes of the loaded ones.
        setPage((p) => {
          const have = new Set(p.commits.map((c) => c.hash));
          const add = (r.log?.commits ?? []).filter((x) => !have.has(x.hash));
          const l = layoutPage(add, p.state);
          return { commits: [...p.commits, ...add], rows: [...p.rows, ...l.rows], state: l.state };
        });
        setMore(r.log?.more ?? false);
      },
      (e: RequestError) => id === gen.current && (setLoading(false), setError(e.message), setMore(false)),
    );
  };

  const filtered = !!(q.text || q.author);
  const [selected, setSelected] = useState<string>();
  const index = commits.findIndex((c) => c.hash === selected);
  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW, overscan: 10, useFlushSync: false, initialRect: { width: 0, height: window.innerHeight },
    // Zero size (jsdom, a hidden tab) keeps the last size.
    observeElementRect: (inst, cb) => observeElementRect(inst, (r) => void (r.height && cb(r))),
  });
  useEffect(() => v.measure(), [ROW]);
  const items = v.getVirtualItems();
  const last = items.at(-1)?.index ?? -1;
  useEffect(() => {
    if (more && !loading && last >= rows.length - 20) loadMore();
  }, [last, more, loading, rows.length]);
  const pick = useCallback((hash: string) => setSelected(hash), []);
  const select = (i: number) => {
    const c = commits[Math.max(0, Math.min(i, commits.length - 1))];
    if (!c) return;
    setSelected(c.hash);
    v.scrollToIndex(commits.indexOf(c), { align: "auto" });
  };
  const onKey = (e: React.KeyboardEvent) => {
    const next = { ArrowDown: index + 1, ArrowUp: index < 0 ? 0 : index - 1, Home: 0, End: commits.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    select(next);
  };

  // Details of the selected commit and, once a file is clicked, its diff.
  const [detail, setDetail] = useState<GitCommitDetail>();
  const [detailError, setDetailError] = useState<string>();
  const [file, setFile] = useState<GitFileChange>();
  useEffect(() => {
    setDetail(undefined);
    setDetailError(undefined);
    setFile(undefined);
    if (!selected) return;
    let live = true;
    client.request<GitCommitResult>({ type: "git.commit", cwd, ...ex, hash: selected }).then(
      (r) => live && setDetail(r.commit),
      (e: RequestError) => live && setDetailError(e.message),
    );
    return () => void (live = false);
  }, [selected, cwd]);

  const row = ROW;
  const headLabel = head && branches.includes(head) ? `HEAD (${short(head)})` : "HEAD";
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className={cn("@container min-h-0 flex-1 flex-col", hidden ? "hidden" : "flex")} data-testid="graph-panel">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5 max-md:py-2">
        {toolbar}
        <label className="relative flex min-w-32 flex-1 items-center">
          <SearchIcon className="pointer-events-none absolute left-2 size-4 text-faint" aria-hidden />
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Text or hash" aria-label="Text or hash" className={cn(INPUT, "pl-8")} data-testid="graph-filter-text" />
        </label>
        <Select value={ref} open={menuOpen} onOpenChange={setMenuOpen} onValueChange={(v) => v && setRef(v)}>
          <SelectTrigger aria-label="Branch" className="h-8 max-w-44 max-md:h-11!" data-testid="graph-filter-branch">
            <span className="truncate">{ref === ALL ? "All branches" : ref === HEAD ? headLabel : short(ref)}</span>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false} align="start" className="w-auto min-w-44 max-w-[calc(100vw-2rem)]">
            {menuOpen && (
              <>
                <SelectItem value={ALL}>All branches</SelectItem>
                <SelectItem value={HEAD}>{headLabel}</SelectItem>
                {branches.map((b) => (
                  <SelectItem key={b} value={b}>
                    {short(b)}
                  </SelectItem>
                ))}
              </>
            )}
          </SelectContent>
        </Select>
        <input type="search" value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Author" aria-label="Author" className={cn(INPUT, "w-32 flex-none")} data-testid="graph-filter-author" />
        <Button size="icon-sm" variant="ghost" className="max-md:size-11 aria-disabled:pointer-events-none aria-disabled:opacity-50" aria-disabled={!!op || notGit} onClick={() => runRemote({ type: "git.fetch", cwd, ...ex }, of("Fetched all remotes"), `${of("Fetching all remotes")}…`)} title="Fetch all remotes" aria-label="Fetch" aria-busy={!!op} data-testid="graph-fetch">
          {op ? <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" /> : <CloudDownloadIcon />}
        </Button>
        <Button size="icon-sm" variant="ghost" className="max-md:size-11" onClick={() => ((freshNext.current = true), setReload((n) => n + 1), onRefresh?.())} title="Refresh" aria-label="Refresh">
          <RotateCwIcon />
        </Button>
      </div>
      <span role="status" className="sr-only">
        {op ?? ""}
      </span>
      {result && (
        <div className="flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-sm" data-testid="graph-remote-result">
          {result.ok ? (
            <div role="status" className="min-w-0 flex-1 text-muted-foreground">
              {result.text}
              {result.output && (
                <details>
                  <summary className="cursor-pointer">Output</summary>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{result.output}</pre>
                </details>
              )}
            </div>
          ) : (
            <div role="alert" className="min-w-0 flex-1 text-destructive">
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs" data-testid="graph-remote-error">
                {result.text}
              </pre>
            </div>
          )}
          <Button size="icon-sm" variant="ghost" className="max-md:size-11" aria-label="Dismiss" onClick={() => dismissRemoteResult(cwd)}>
            <XIcon />
          </Button>
        </div>
      )}
      {notGit ? (
        <p className="m-auto p-4 text-muted-foreground">Not a git repository</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col @2xl:flex-row">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {error && (
              <p className="p-3 text-destructive" role="alert">
                {error}
              </p>
            )}
            {!error && !commits.length && !loading && <p className="m-auto p-4 text-muted-foreground">{filtered || (ref !== ALL && ref !== HEAD) ? "No commits match." : "No commits yet."}</p>}
            <BranchMenu client={client} cwd={cwd} exact={exact} repoName={repoName} busy={!!op} onRun={runRemote} fallback={() => commits[index]?.refs.filter((r) => r.startsWith("refs/heads/")) ?? []}>
            <div
              ref={scroller}
              role="listbox"
              aria-label="Commits"
              tabIndex={0}
              aria-activedescendant={selected && index >= 0 ? `commit-${selected}` : undefined}
              onKeyDown={onKey}
              className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              data-testid="commit-list"
            >
              <div className="relative w-full" style={{ height: v.getTotalSize() }}>
                {items.map((it) => {
                  const c = commits[it.index]!;
                  return <CommitRow key={c.hash} c={c} row={rows[it.index]!} start={it.start} on={c.hash === selected} filtered={filtered} h={row} setsize={more ? -1 : commits.length} posinset={it.index + 1} onPick={pick} />;
                })}
              </div>
            </div>
            </BranchMenu>
            {loading && <p className="absolute right-3 bottom-2 rounded bg-card px-2 text-muted-foreground text-xs">Loading…</p>}
          </div>
          {selected && (
            <div className={cn("flex min-h-0 min-w-0 flex-col overflow-auto @max-2xl:border-t @2xl:border-l", file ? "@max-2xl:max-h-3/4 @2xl:w-3/5" : "@max-2xl:max-h-1/2 @2xl:w-80", "shrink-0")} data-testid="commit-details">
              {detailError && <p className="p-3 text-destructive">{detailError}</p>}
              {!detail && !detailError && <p className="p-3 text-muted-foreground">Loading…</p>}
              {detail && (file ? <FileView detail={detail} file={file} client={client} cwd={cwd} ex={ex} dark={dark} narrow={narrow} onBack={() => setFile(undefined)} /> : <Details showRepo={(f) => repos?.find((r) => !r.outsideRoots && pathKey(r.path) === pathKey(joinPath(cwd, f.path)))?.rel} onShowRepo={onShowRepo} wrap={(el, refs) => <BranchMenu client={client} cwd={cwd} exact={exact} repoName={repoName} busy={!!op} onRun={runRemote} fallback={() => refs.filter((r) => r.startsWith("refs/heads/"))}>{el}</BranchMenu>} detail={detail} refs={commits.find((c) => c.hash === detail.hash)?.refs ?? detail.refs} loaded={commits} onSelect={(h) => select(commits.findIndex((c) => c.hash === h))} onFile={setFile} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Graph pane (docs/spec.md "Layout", Graph tab): the selected repository of the project (repository selector shared with Changes); one GraphPanel per repository path.
 * `repos`: undefined while the repository list or the project key is not known yet (nothing is read, "Loading graph…"); null when the daemon has no list (an older one: the cwd is read as is).
 */
export function GraphPane({ client, cwd, hidden = false, repos, onRefresh }: { client: Client; cwd: string; hidden?: boolean; repos?: RepoList | null; onRefresh?: () => void }) {
  const { repo, target, choose } = useSelectedRepo(repos ?? undefined, cwd);
  const list = repos?.list ?? undefined;
  if (repos === undefined) return <p className={cn("m-auto text-muted-foreground text-sm", hidden && "hidden")}>Loading graph…</p>;
  const shown = !!list && selectorVisible(list);
  const at = target?.path ?? cwd;
  return (
    <GraphPanel
      key={at}
      client={client}
      cwd={at}
      exact={!!target}
      hidden={hidden}
      onRefresh={onRefresh}
      repoName={shown && repo ? repoLabel(repo) : undefined}
      toolbar={shown && list ? <RepoSelector list={list} truncated={repos?.truncated} selected={repo} onSelect={choose} className="h-8" /> : undefined}
      repos={list}
      onShowRepo={list ? choose : undefined}
    />
  );
}

const INPUT =
  "h-8 w-full rounded-md bg-secondary/60 pr-2 pl-2 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring max-md:h-11";

function Details({ detail: d, refs, loaded, onSelect, onFile, wrap, showRepo, onShowRepo }: { showRepo?: (f: GitFileChange) => string | undefined; onShowRepo?: (rel: string) => void; wrap: (el: ReactElement<{ onContextMenuCapture?: (e: React.MouseEvent) => void; onPointerDownCapture?: (e: React.SyntheticEvent) => void; onTouchStartCapture?: (e: React.SyntheticEvent) => void; onKeyDownCapture?: (e: React.SyntheticEvent) => void }>, refs: string[]) => ReactElement; detail: GitCommitDetail; refs: string[]; loaded: GitCommit[]; onSelect: (h: string) => void; onFile: (f: GitFileChange) => void }) {
  const body = d.message.split("\n").slice(1).join("\n").trim();
  return (
    <div className="flex flex-col gap-2 p-3 text-sm">
      <p className="font-medium">{d.subject}</p>
      {body && <p className="whitespace-pre-wrap text-muted-foreground">{body}</p>}
      <p>
        {d.author} <span className="text-muted-foreground">&lt;{d.email}&gt;</span>
      </p>
      <p className="text-muted-foreground text-xs">{new Date(d.time * 1000).toLocaleString()}</p>
      <p className="select-all break-all font-mono text-xs">{d.hash}</p>
      {d.parents.length > 0 && (
        <p className="flex flex-wrap items-center gap-1 text-muted-foreground text-xs">
          Parents:
          {d.parents.map((p) => (
            <button key={p} disabled={!loaded.some((c) => c.hash === p)} onClick={() => onSelect(p)} className="rounded px-1 font-mono underline-offset-2 hover:underline disabled:no-underline max-md:min-h-11" data-testid="commit-parent">
              {p.slice(0, 7)}
            </button>
          ))}
        </p>
      )}
      {refs.length > 0 && wrap(<div className="flex flex-wrap gap-1"><RefChips refs={refs} /></div>, refs)}
      <p className="font-medium">
        {d.files.length} {d.files.length === 1 ? "file" : "files"} changed
      </p>
      <ul className="flex flex-col">
        {d.files.map((f) => {
          const target = f.submodule ? showRepo?.(f) : undefined;
          return f.submodule ? (
          <li key={f.path}>
            <div className="flex min-h-11 flex-wrap items-center gap-1.5 px-1 md:min-h-7" title={f.path} data-testid="commit-submodule">
              <KindBadge kind={f.status} />
              <ArchiveIcon className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                Submodule {f.path}
                {f.submodule.to && (
                  <>
                    {" → "}
                    <span className="font-mono">{f.submodule.to.slice(0, 7)}</span>
                  </>
                )}
              </span>
              {onShowRepo && target !== undefined && (
                <Button size="sm" variant="outline" className="max-md:h-11" onClick={() => onShowRepo(target)} data-testid="show-repo-graph">
                  Show graph of {target}
                </Button>
              )}
            </div>
          </li>
        ) : (
          <li key={f.path}>
            <button
              onClick={() => onFile(f)}
              className="flex min-h-11 w-full cursor-pointer items-center gap-1.5 rounded-md px-1 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:min-h-7"
              title={f.path}
              data-testid="commit-file"
            >
              <KindBadge kind={f.status} />
              <FileIcon path={f.path} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
              {f.added !== undefined && <StatsText stats={{ added: f.added, removed: f.removed ?? 0 }} />}
            </button>
          </li>
        );
        })}
      </ul>
      {d.truncated && <p className="text-muted-foreground text-xs">List cut at 3000 files</p>}
    </div>
  );
}

/** The diff of one file of a commit: parent side and commit side from git.fileAt (an added file asks only the commit side). */
function FileView({ detail: d, file: f, client, cwd, ex, dark, narrow, onBack }: { detail: GitCommitDetail; file: GitFileChange; client: Client; cwd: string; ex: { exact?: true }; dark: boolean; narrow: boolean; onBack: () => void }) {
  const [sides, setSides] = useState<{ before: string; after: string }>();
  const [err, setErr] = useState<{ text: string; notice: boolean }>();
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let live = true;
    const read = (hash: string, path: string) => client.request<FsReadResult>({ type: "git.fileAt", cwd, ...ex, hash, path }).then((r) => r.content);
    Promise.all([f.status === "A" || !d.parents[0] ? "" : read(d.parents[0], f.oldPath ?? f.path), f.status === "D" ? "" : read(d.hash, f.path)]).then(
      ([before, after]) => live && setSides({ before, after }),
      (e: RequestError) => live && setErr(readFailure(e)),
    );
    return () => void (live = false);
  }, [d.hash, f.path]);
  const options = useMemo(
    () => ({ ...DIFF_OPTIONS, diffStyle: narrow ? ("unified" as const) : storedStyle(), themeType: dark ? ("dark" as const) : ("light" as const), disableFileHeader: true, onPostRender: () => setDrawn(true) }),
    [narrow, dark],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="commit-file-diff">
      <div className="flex shrink-0 items-center gap-2 border-b px-2 py-1">
        <Button size="sm" variant="ghost" className="max-md:h-11" onClick={onBack} data-testid="commit-back">
          <ArrowLeftIcon /> Commit
        </Button>
        <KindBadge kind={f.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs" title={f.path}>
          {f.path}
        </span>
        {f.added !== undefined && <StatsText stats={{ added: f.added, removed: f.removed ?? 0 }} />}
      </div>
      <div className="min-h-0 flex-1 overflow-auto text-xs">
        {err && <p role={err.notice ? "status" : undefined} className={cn("p-2", err.notice ? "text-muted-foreground" : "text-destructive")}>{err.text}</p>}
        {!err && (!sides || (sides.before !== sides.after && !drawn)) && <p className="p-2 text-muted-foreground">Loading diff…</p>}
        {sides && sides.before === sides.after && <p className="p-2 text-muted-foreground">{f.status === "R" ? "Renamed without changes" : "No content changes"}</p>}
        {sides && sides.before !== sides.after && (
          <MultiFileDiff oldFile={{ name: f.oldPath ?? f.path, contents: sides.before }} newFile={{ name: f.path, contents: sides.after }} options={options} />
        )}
      </div>
    </div>
  );
}
