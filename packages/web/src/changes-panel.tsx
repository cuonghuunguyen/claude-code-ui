// Changes tab (docs/spec.md "Layout"): files changed in the session, or in the working tree against HEAD or a branch, each with its diff, like OpenCode's review panel.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import { useNarrow } from "@/lib/use-narrow.ts";
import type { FsMediaResult, FsReadResult, GitDiff, GitDiffResult, GitLogResult, GitOperation, GitOperationResult, GitRepo, GitStatusResult } from "@claude-ui/protocol";
import { parseDiffFromFile, type DiffLineAnnotation, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff as PierreFileDiff } from "@pierre/diffs/react";
import { ArchiveIcon, ArrowLeftIcon, ArrowRightIcon, ChevronDownIcon, ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon, Columns2Icon, FileDiffIcon, ListIcon, ListTreeIcon, Maximize2Icon, MessageSquarePlusIcon, RotateCcwIcon, RotateCwIcon, Rows2Icon, SearchIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { connect, RequestError } from "./client.ts";
import { baseline, callStats, fileStats, sessionChanges, type FileChange, type Stats } from "./changes.ts";
import type { SessionView } from "./store.ts";
import { useColorTheme, useDark } from "./theme.ts";
import { diffThemes } from "./code-palette.ts";
import { DIFF_OPTIONS, InputDiff } from "./tool-card.tsx";
import { FileIcon } from "./file-icon.tsx";
import { inDir, isWinPath, joinPath, relPath } from "./paths.ts";
import { pathKey } from "./file-tree-model.ts";
import { repoDir } from "./repos.ts";
import { t, useT } from "./i18n.ts";
import { DIFF_MODES, loadDiffMode, loadDiffScope, repoRoot, saveDiffMode, saveDiffScope, sessionDiffChoice, useDefaultDiffMode, type DiffMode, type DiffScope } from "./diff-mode.ts";
import { count, offer, streak, tipOpenInFileManager } from "./recommendations.ts";
import { highlight, reopenMenu } from "./rec-highlight.ts";
import { commitable, commitPaths, eachLimited, gitEol, gitRows, type GitRow } from "./git-changes.ts";
import { fileMention, mediaKind, readFailure, textFailure } from "./files.ts";
import { ImageDiff, type ImagePane } from "./image-diff.tsx";
import { filePath } from "./tools.ts";
import { RepoIcon, RepoSelector } from "./repo-selector.tsx";
import { CommitBox } from "./commit-box.tsx";
import { usePanelAsk } from "./panel-ask.ts";
import { setChangesSelected, setDiffSelection } from "./changes-focus.ts";
import { ConflictBanner } from "./conflict-banner.tsx";
import { GitOpResult } from "./git-op-result.tsx";
import { ofRepo } from "./git-branch-menu.tsx";
import { runRemoteOp, useRemoteOp } from "./git-remote-ops.ts";
import { diffSelection, hunkAnchor, wireHunk } from "./hunk.ts";
import { RollbackDialog, RollbackMenu, type RowMenuItem } from "./rollback-dialog.tsx";
import { externalEntries, useOpenExternal } from "./open-external-menu.ts";
import { repoLabel, selectorVisible, useSelectedRepo, type RepoList } from "./repo-choice.ts";

type Client = ReturnType<typeof connect>;
export type DiffStyle = "unified" | "split";
/** Disk content of a changed file: "" once deleted. */
type Disk = { content?: string; deleted?: boolean; error?: string; notice?: boolean };
/** `kind`: OpenCode's file badge, A(dded) / D(eleted) / M(odified). */
/** `change`: the session's calls on the file (session mode only). `oldPath` (relative to the repository top) and `oldShown` (as the list names it): a renamed file's before side (git modes). */
type Row = { path: string; /** Relative to the repository top, as git names it (git modes). */ rel?: string; kind: Kind; /** Git modes: an added file not in the index. Shown as `U`; `kind` stays `A`. */ untracked?: boolean; before?: string; after?: string; error?: string; notice?: boolean; stats?: Stats; change?: FileChange; oldPath?: string; oldShown?: string;
  /** A gitlink row (git modes): no file to read or diff. */
  submodule?: { from?: string; to?: string };
  /** A submodule with uncommitted changes in tracked files (`git.status` of it): the files; `dirtyOnly`: its gitlink did not move, so the row exists for this. */
  dirty?: number;
  dirtyOnly?: boolean;
  /** An untracked folder that is a listed nested repository: one row, no files. */
  nested?: GitRepo;
  /** The listed, readable repository this row stands for (submodule or nested), `rel` relative to the session cwd: "Show changes in". */
  repoRel?: string;
  /** A changed image (git modes): shown as images, not a text diff. */
  image?: { before?: ImagePane; after?: ImagePane };
};
export type Kind = "A" | "D" | "M" | "R";
type HunkMeta = { index: number; first: number; last: number };
const OP_RESULT_IDS = { testId: "changes-op-result", errorId: "changes-op-error" };
const SUB_PROBES = 10;
const SUB_PARALLEL = 4;
const KIND_KEY = { A: "files.changes.added", D: "files.changes.deleted", M: "files.changes.modified", R: "files.changes.renamed", U: "files.changes.untracked" } as const;
const kindTitle = (k: keyof typeof KIND_KEY) => t(KIND_KEY[k]);
/** The badge letter of a row: untracked additions show `U`. */
const badgeOf = (r: { kind: Kind; untracked?: boolean }) => (r.kind === "A" && r.untracked ? "U" : r.kind);
const MODE_KEY = { session: "files.changes.modeSession", uncommitted: "files.changes.modeUncommitted", branch: "files.changes.modeBranch" } as const;
const KIND_COLOR = { A: "text-success", D: "text-destructive", M: "text-info", R: "text-warning", U: "text-destructive" } as const;

// Diff style like OpenCode's review panel: split by default, the choice kept per browser; below md always unified.
const STYLE_KEY = "claude-ui.diffStyle";
export function loadStyle(): DiffStyle {
  try {
    return localStorage.getItem(STYLE_KEY) === "unified" ? "unified" : "split";
  } catch {
    return "split";
  }
}
export function saveStyle(s: DiffStyle) {
  try {
    localStorage.setItem(STYLE_KEY, s);
  } catch {
    // Storage blocked: the choice lasts while the panel is open.
  }
}

// Wide file sidebar as a folder tree (default) or a flat list by path, per browser.
const LIST_VIEW_KEY = "claude-ui.changesListView";
type ListView = "tree" | "list";
function loadListView(): ListView {
  try {
    return localStorage.getItem(LIST_VIEW_KEY) === "list" ? "list" : "tree";
  } catch {
    return "tree";
  }
}
function saveListView(v: ListView) {
  try {
    localStorage.setItem(LIST_VIEW_KEY, v);
  } catch {
    // Storage blocked: the choice lasts while the panel is open.
  }
}

// File sidebar width after a drag, per browser; unset: OpenCode's 240px (200px in a narrow panel).
const LIST_WIDTH_KEY = "claude-ui.changesListWidth";
export function loadListWidth(key = LIST_WIDTH_KEY): number | undefined {
  try {
    const n = Number(localStorage.getItem(key));
    return n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
export function saveListWidth(w: number | undefined, key = LIST_WIDTH_KEY) {
  try {
    if (w) localStorage.setItem(key, String(w));
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: the width lasts while the panel is open.
  }
}

/** Drag handle (or arrow keys) between the file sidebar and the diff; double click restores the default width. */
export function ListResizer({
  list,
  width,
  onResize,
  label,
  testId = "changes-list-resizer",
}: {
  list: RefObject<HTMLDivElement | null>;
  width: number | undefined;
  onResize: (w: number | undefined) => void;
  label?: string;
  testId?: string;
}) {
  useT();
  // 160px up to the panel width less 240px for the diff.
  const clamp = (w: number) => {
    const room = list.current?.parentElement?.clientWidth || Infinity;
    return Math.round(Math.max(160, Math.min(w, room - 240)));
  };
  const now = () => width ?? (list.current?.offsetWidth || 240);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? t("files.changes.resizeList")}
      aria-valuenow={now()}
      tabIndex={0}
      className="-ml-1 w-1 shrink-0 cursor-col-resize touch-none hover:bg-primary/30 focus-visible:bg-primary/30"
      data-testid={testId}
      onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && list.current && onResize(clamp(e.clientX - list.current.getBoundingClientRect().left))}
      onDoubleClick={() => onResize(undefined)}
      onKeyDown={(e) => {
        const d = { ArrowLeft: -32, ArrowRight: 32 }[e.key];
        if (d) (e.preventDefault(), onResize(clamp(now() + d)));
      }}
    />
  );
}
export { useNarrow };
// List view and its sort: one separator whatever the daemon's OS (the tree view joins with "/" too).
const slashed = (s: string) => s.replaceAll("\\", "/");

/** A folder of OpenCode's review file tree: folders first, then files, each by name. */
type Folder = { name: string; path: string; folders: Folder[]; files: Row[] };
function fileTree(rows: Row[], cwd: string): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  for (const r of rows) {
    const { dir } = filePath(r.path, cwd);
    // A file outside cwd keeps its absolute directory as one top-level folder.
    let at = root;
    const win = isWinPath(r.path);
    for (const name of !dir ? [] : dir.startsWith("/") || (win && isWinPath(dir)) ? [dir] : dir.split(win ? /[\\/]/ : "/")) {
      let next = at.folders.find((f) => f.name === name);
      if (!next) at.folders.push((next = { name, path: at.path ? `${at.path}/${name}` : name, folders: [], files: [] }));
      at = next;
    }
    at.files.push(r);
  }
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name)).forEach(sort);
    f.files.sort((a, b) => a.path.localeCompare(b.path));
  };
  sort(root);
  // Compact folders (VS Code): a folder holding only one folder shows as one row "a/b", keyed by the inner path.
  const compact = (f: Folder): Folder => {
    let d = f;
    while (d.folders.length === 1 && !d.files.length) d = { ...d.folders[0]!, name: `${d.name}/${d.folders[0]!.name}` };
    return { ...d, folders: d.folders.map(compact) };
  };
  return { ...root, folders: root.folders.map(compact) };
}
/**
 * Rows per file by its last call: the disk reads come back one by one, and a session tab switch remounts the panel, so without it every
 * read re-parses every diff. Hit only for the same calls, results and disk content; `reading`: the rows while the file is being read.
 */
const rowCache = new WeakMap<object, { change: FileChange; reading?: Row[]; read?: { d: Disk; rows: Row[] } }>();
const same = <T,>(a: T[], b: T[]) => a.length === b.length && a.every((x, i) => x === b[i]);
function cachedRows(change: FileChange, d: Disk | undefined): Row[] {
  const last = change.calls.at(-1)!;
  let hit = rowCache.get(last);
  if (!hit || !same(hit.change.calls, change.calls) || !same(hit.change.results, change.results)) rowCache.set(last, (hit = { change }));
  if (!d) return (hit.reading ??= fileRows(change, d));
  const r = hit.read;
  if (r && r.d.content === d.content && r.d.deleted === d.deleted && r.d.error === d.error && r.d.notice === d.notice) return r.rows;
  hit.read = { d, rows: fileRows(change, d) };
  return hit.read.rows;
}

/** The list row of a changed file, none when it was created and deleted again; `d`: its disk content, undefined while being read. */
function fileRows(change: FileChange, d: Disk | undefined): Row[] {
  if (d?.content === undefined) {
    // Only show call stats while reading (no error); if read failed, show error only.
    return [{ change, path: change.path, error: d?.error, notice: d?.notice, stats: d?.error ? undefined : callStats(change), kind: "M" }];
  }
  const before = baseline(d.content, change);
  const old = before === undefined ? undefined : textFailure(before);
  // Added: the file did not exist (original null), or a restored transcript's Write created it. An existing empty file is M.
  const created = change.original === null || (change.original === undefined && before === "");
  // Created and deleted again: no net change, so no row (OpenCode's before/after list has none).
  if (d.deleted && created) return [];
  const kind = d.deleted ? "D" : created ? "A" : "M";
  // If before side failed, show error with correct kind, no stats.
  if (old) return [{ change, path: change.path, error: old.text, notice: old.notice, kind }];
  // A deleted file with an unknown before has no net stats; the per-call sums would not count the deletion.
  if (before === undefined) return [{ change, path: change.path, after: d.content, stats: d.deleted ? undefined : callStats(change), kind }];
  return [{ change, path: change.path, before, after: d.content, stats: fileStats(before, d.content, change.path), kind }];
}
const treeOrder = (f: Folder): Row[] => [...f.folders.flatMap(treeOrder), ...f.files];

/**
 * Re-reads the files whenever a call changes one, so the diffs follow Claude live, and on `fs.changed` (Bash or outside edits).
 * The files panel owns this connection's fs.watch list; App adds the changed files to it.
 */
/** `hidden`: mounted behind another pane, only to report `onCount` (the listed files) for the pane tab. */
export function ChangesPanel({
  client,
  view,
  cwd,
  onOpen,
  onCopy,
  hidden,
  onCount,
  sessionId,
  initialChoice,
  onPopOut,
  reveal,
  emptyText,
  repos,
  ignoreSubmodules,
  onReload,
  onGitWrite,
  onResolve,
  project,
  onSend,
}: {
  client: Client;
  view: SessionView;
  cwd: string;
  onOpen: (path: string) => void;
  /** GH-612: Copy path and Copy relative path in a row's menu. */
  onCopy?: (text: string, what: string) => void;
  hidden?: boolean;
  onCount?: (n: number) => void;
  /** Keys the panel's own diff mode choice (kept in memory while the page lives). */
  sessionId?: string;
  /** The starting mode choice when the session has none (the popup copies the side panel's without writing it back). */
  initialChoice?: { mode: DiffMode; ref?: string; refRepo?: string };
  /** Shows the "Open in popup" button. */
  onPopOut?: () => void;
  /** File tree "Show changes": switches to Uncommitted (the tree's git marks) and selects the file; a new `seq` repeats it. */
  reveal?: { path: string; seq: number };
  /** Replaces "No changes in this session yet." in session mode (the new-session tab has no session yet). */
  emptyText?: string;
  /**
   * `git.repos` of the pane's cwd (App) and the key of the remembered choice. The selected repository (selector, remembered per project) is where git requests
   * go (`exact`), rows lie under its top as `cwd` spells it; an empty list: no repository (Session changes only); undefined or `list` unknown: the cwd's own repository (`git.status` check), as before.
   */
  repos?: RepoList;
  /** Settings › Git › ignoreSubmodules: no "modified content" probes of submodules. */
  ignoreSubmodules?: boolean;
  /** Reload from disk also asks `git.repos` again. */
  onReload?: () => void;
  /** Add to prompt and Send selection to Claude: the text goes into the prompt box. Without it the panel offers neither. */
  onSend?: (text: string) => void;
  /** After a commit: files changed on disk's git state (the file tree marks). */
  onGitWrite?: () => void;
  /** "Resolve with Claude": gets the prompt to put into the session's prompt box (never sent). Absent: no button. */
  onResolve?: (prompt: string) => void;
  /** The project folder (key of the per-project commit message instruction). */
  project?: string;
}) {
  useT();
  const fresh = useMemo(() => sessionChanges(view), [view.parts, view.aux]);
  // Same calls and results per path: the previous list, so streamed text does not re-parse every diff.
  const key = fresh.map((c) => `${c.path}\n${c.calls.length}\n${c.results.filter(Boolean).length}`).join("\n");
  const changes = useMemo(() => fresh, [key]);
  const [disk, setDisk] = useState<Record<string, Disk>>({});
  const [reload, setReload] = useState(0);
  const openExt = useOpenExternal();
  const [selected, setSelected] = useState<string>();
  const [chosen, setChosen] = useState(loadStyle);
  const narrow = useNarrow();
  const style: DiffStyle = narrow ? "unified" : chosen;
  const choose = (s: DiffStyle) => (setChosen(s), saveStyle(s));

  useEffect(() => {
    let live = true;
    for (const { path } of changes)
      client
        .request<FsReadResult>({ type: "fs.read", path })
        .then((r): Disk => ({ content: r.content }))
        .catch((e: RequestError): Disk => {
          if (e.code === "not_found") return { content: "", deleted: true };
          const f = readFailure(e);
          return { error: f.text, notice: f.notice };
        })
        .then((d) => live && setDisk((x) => ({ ...x, [path]: d })));
    return () => void (live = false);
  }, [key, reload]);
  useEffect(() => client.onFsChanged((m) => changes.some((c) => c.path === m.path) && setReload((n) => n + 1)), [client, key]);

  const sessionRows = useMemo(() => changes.flatMap((change) => cachedRows(change, disk[change.path])), [changes, disk]);

  // The mode: the Settings default until this session's panel picked one.
  const def = useDefaultDiffMode();
  const [choice, setChoice] = useState<{ mode: DiffMode; ref?: string; refRepo?: string } | undefined>(() => (sessionId ? sessionDiffChoice.get(sessionId) : undefined) ?? initialChoice);
  const mode: DiffMode = choice?.mode ?? def;
  // The repository a mode choice's branch belongs to: after a switch the new repository's default branch applies.
  const { repo: selectedRepo, target: repo, choose: chooseRepo } = useSelectedRepo(repos, cwd);
  const gitCwd = repo?.path ?? cwd;
  const refChoice = choice?.refRepo === undefined || choice.refRepo === gitCwd ? choice?.ref : undefined;
  const pick = (m: DiffMode, ref?: string) => {
    const r = ref ?? refChoice;
    const c = { mode: m, ...(r && { ref: r, refRepo: gitCwd }) };
    setChoice(c);
    if (sessionId) sessionDiffChoice.set(sessionId, c);
  };
  // undefined while unknown: the git modes stay selectable until the daemon says otherwise.
  const [probed, setGit] = useState<boolean>();
  const git = repo !== undefined ? repo !== null : probed;
  const known = repo !== undefined;
  useEffect(() => {
    if (known) return;
    let live = true;
    client.request<GitStatusResult>({ type: "git.status", cwd }).then(
      (r) => live && setGit(r.status !== null),
      () => {},
    );
    return () => void (live = false);
  }, [client, cwd, known]);
  const ex = repo ? { exact: true as const } : {};
  const dir = repo?.dir ?? cwd;
  const effective: DiffMode = git === false ? "session" : mode;
  const gitMode = effective !== "session";
  const diffSeq = useRef(0);
  const [gd, setGd] = useState<{ mode?: DiffMode; repo?: string; diff?: GitDiff; error?: string }>({});
  const [branches, setBranches] = useState<string[]>([]);
  // Bumped by every git.diff reply: the before/after sides of the files on screen are read again.
  const [gen, setGen] = useState(0);
  useEffect(() => {
    // Read when the panel is shown; a panel behind another pane waits.
    if (!gitMode || hidden) return;
    let live = true;
    const seq = ++diffSeq.current;
    client.request<GitDiffResult>({ type: "git.diff", cwd: gitCwd, ...ex, base: effective === "uncommitted" ? "head" : "branch", ...(refChoice && { ref: refChoice }) }).then(
      (r) => {
        // A reply of an older read (another mode, branch or reload since) is dropped.
        if (!live || seq !== diffSeq.current) return;
        if (!r.diff) return known ? setGd({ mode: effective, repo: gitCwd, error: t("files.changes.notRepo") }) : setGit(false);
        setGd({ mode: effective, repo: gitCwd, diff: r.diff });
        if (r.diff.branches) setBranches(r.diff.branches);
        setGen((n) => n + 1);
      },
      (e: Error) => {
        if (!live || seq !== diffSeq.current) return;
        setGd({ mode: effective, repo: gitCwd, error: e.message });
        // No branch list without a diff ("No default branch: pick one"): the graph's first page has it.
        if (effective === "branch") client.request<GitLogResult>({ type: "git.log", cwd: gitCwd, ...ex, limit: 1 }).then((l) => live && l.log?.branches && setBranches(l.log.branches), () => {});
      },
    );
    return () => void (live = false);
  }, [client, gitCwd, known, effective, refChoice, reload, view.state, key, hidden]);
  // Session mode has no git.diff: the unfinished operation (the banner) is asked alone, skipped outside a repository.
  const [sessionOp, setSessionOp] = useState<{ repo: string; op?: GitOperation }>();
  useEffect(() => {
    if (gitMode || hidden || !git) return;
    let live = true;
    client.request<GitOperationResult>({ type: "git.operation", cwd: gitCwd, ...ex }).then(
      (r) => live && setSessionOp({ repo: gitCwd, op: r.operation ?? undefined }),
      () => live && setSessionOp(undefined),
    );
    return () => void (live = false);
  }, [client, gitCwd, gitMode, git, reload, view.state, key, hidden]);
  const gdNow = gd.mode === effective && gd.repo === gitCwd;
  const gitDiff = gdNow ? gd.diff : undefined;
  const operation = gitMode ? gitDiff?.operation : sessionOp?.repo === gitCwd ? sessionOp.op : undefined;
  const gitError = gitMode && gdNow ? gd.error : undefined;
  const gitLoading = gitMode && !gdNow;
  // Submodules of the selected repository with uncommitted changes in tracked files: `git.status` of each (git.diff of the superproject does not list them).
  const subs = useMemo(
    () => (repos?.list && selectedRepo ? repos.list.filter((r) => r.kind === "submodule" && r.parent === selectedRepo.path && !r.outsideRoots).slice(0, SUB_PROBES) : []),
    [repos?.list, selectedRepo],
  );
  const subsKey = subs.map((r) => r.path).join("\n");
  const [dirty, setDirty] = useState<{ repo: string; files: Record<string, number> }>({ repo: "", files: {} });
  const probeSeq = useRef(0);
  useEffect(() => {
    if (!gitMode || hidden || ignoreSubmodules || !subs.length) return;
    let live = true;
    const seq = ++probeSeq.current;
    void eachLimited(subs, SUB_PARALLEL, (sub) =>
      client.request<GitStatusResult>({ type: "git.status", cwd: sub.path, exact: true }).then(
        (r) => {
          if (!live || seq !== probeSeq.current) return;
          const n = r.status?.files ?? 0;
          setDirty((d) => ({ repo: gitCwd, files: { ...(d.repo === gitCwd ? d.files : {}), [sub.path]: n } }));
        },
        // The submodule cannot be read now (deinitialised, refused): its earlier count is stale.
        () => {
          if (live && seq === probeSeq.current) setDirty((d) => ({ repo: gitCwd, files: { ...(d.repo === gitCwd ? d.files : {}), [sub.path]: 0 } }));
        },
      ),
    );
    return () => void (live = false);
  }, [client, gitCwd, gitMode, hidden, ignoreSubmodules, subsKey, effective, refChoice, reload, view.state, key]);
  const gitList = useMemo<(GitRow & { dirty?: number; dirtyOnly?: boolean; repoRel?: string })[]>(() => {
    if (!gitDiff) return [];
    const list = repos?.list;
    const base: (GitRow & { dirty?: number; dirtyOnly?: boolean; repoRel?: string })[] = gitRows(gitDiff, dir, list ? { top: gitCwd, repos: list } : undefined);
    if (!list) return base;
    const listedAt = (path: string) => list.find((r) => !r.outsideRoots && pathKey(r.path) === pathKey(path));
    const out = base.map((r) => {
      const repo = r.nested ?? (r.submodule ? listedAt(joinPath(gitCwd, r.rel)) : undefined);
      return repo && !repo.outsideRoots ? { ...r, repoRel: repo.rel } : r;
    });
    if (ignoreSubmodules || dirty.repo !== gitCwd) return out;
    for (const sub of subs) {
      const n = dirty.files[sub.path] ?? 0;
      if (n <= 0) continue;
      const path = repoDir(cwd, sub.rel);
      const at = out.findIndex((r) => r.submodule && pathKey(r.path) === pathKey(path));
      if (at >= 0) out[at] = { ...out[at]!, dirty: n };
      else {
        const top = selectedRepo?.rel ?? "";
        out.push({ path, rel: top && sub.rel.startsWith(`${top}/`) ? sub.rel.slice(top.length + 1) : sub.rel, kind: "M", submodule: {}, dirty: n, dirtyOnly: true, repoRel: sub.rel });
      }
    }
    return out;
  }, [gitDiff, dir, gitCwd, repos?.list, subs, dirty, ignoreSubmodules, cwd, selectedRepo]);

  // Sides of the git modes, read for the files on screen only: the before side from the base commit, the after side from the disk.
  type Side = { base?: string; before?: string; after?: string; error?: string; notice?: boolean; stats?: Stats; image?: { before?: ImagePane; after?: ImagePane } };
  const [sides, setSides] = useState<Record<string, Side>>({});
  const asked = useRef(new Set<string>());
  // Another repository: nothing of the previous one (branches, file sides, selection) stays.
  const lastRepo = useRef(gitCwd);
  useEffect(() => {
    if (lastRepo.current === gitCwd) return;
    lastRepo.current = gitCwd;
    setBranches([]);
    setSides({});
    asked.current.clear();
    setSelected(undefined);
  }, [gitCwd]);
  const [scope, setScope] = useState<DiffScope>(loadDiffScope);
  const chooseScope = (s: DiffScope) => (setScope(s), saveDiffScope(s));
  const sessionShown = useMemo(() => (scope === "project" ? sessionRows.filter((r) => inDir(r.path, cwd)) : sessionRows), [sessionRows, scope, cwd]);
  const gitFull = useMemo<Row[]>(() => {
    const root = gitDiff ? repoRoot(dir, gitDiff.prefix) : dir;
    return gitList.map((r) => {
      const s = sides[r.path];
      const ok = s && s.base === gitDiff?.base;
      return {
        path: r.path,
        rel: r.rel,
        kind: r.kind,
        ...(r.untracked && { untracked: true }),
        ...(r.oldPath !== undefined && { oldPath: r.oldPath, oldShown: relPath(joinPath(root, r.oldPath), cwd) }),
        ...(r.submodule && { submodule: r.submodule }),
        ...(r.nested && { nested: r.nested }),
        ...(r.dirty && { dirty: r.dirty }),
        ...(r.dirtyOnly && { dirtyOnly: true }),
        ...(r.repoRel !== undefined && { repoRel: r.repoRel }),
        stats: r.stats ?? (ok && !r.submodule && !r.nested ? s.stats : undefined),
        ...(ok && !r.submodule && !r.nested && { before: s.before, after: s.after, error: s.error, notice: s.notice, image: s.image }),
      };
    });
  }, [gitList, sides, gitDiff, cwd, dir]);
  const rows = gitMode ? gitFull : sessionShown;
  const outside = gitMode ? 0 : sessionRows.length - sessionShown.length;
  const total = rows.reduce((t, r) => ({ added: t.added + (r.stats?.added ?? 0), removed: t.removed + (r.stats?.removed ?? 0) }), { added: 0, removed: 0 });
  // Commit checkboxes (Uncommitted mode): rows by `path`; rows that left the list drop out, another repository starts empty.
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const commitMode = effective === "uncommitted" && !!gitDiff;
  const commitRows = useMemo(() => (commitMode ? rows.filter(commitable) : []), [commitMode, rows]);
  useEffect(() => setChecked((c) => (c.size && [...c].some((p) => !commitRows.some((r) => r.path === p)) ? new Set([...c].filter((p) => commitRows.some((r) => r.path === p))) : c)), [commitRows]);
  useEffect(() => setChecked(new Set()), [gitCwd]);
  const toggle = (path: string) => setChecked((c) => (c.has(path) ? new Set([...c].filter((p) => p !== path)) : new Set(c).add(path)));
  // A commit, push or fetch of this repository ended: the list reads again.
  const { settled, running } = useRemoteOp(gitCwd);
  // Rollback (GH-558): the dialog of the checked rows or of one row's paths.
  const [rollbackPaths, setRollbackPaths] = useState<string[]>();
  const opRunning = running !== undefined;
  const lastSettled = useRef(settled);
  useEffect(() => {
    if (settled === lastSettled.current) return;
    lastSettled.current = settled;
    setReload((n) => n + 1);
  }, [settled]);
  const rowCheck = (r: Row, className?: string) =>
    commitMode && commitable(r) ? (
      <label className={cn("flex size-11 shrink-0 cursor-pointer items-center justify-center md:size-7", className)}>
        <input type="checkbox" className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={checked.has(r.path)} onChange={() => toggle(r.path)} aria-label={t("files.changes.checkFile", { path: relPath(r.path, cwd) })} data-testid="commit-check" data-path={r.path} />
      </label>
    ) : null;
  // Folder checkbox (tree view): checks or clears every commitable file under it; a mixed folder shows indeterminate.
  const folderCheck = (d: Folder) => {
    const paths = commitMode ? treeOrder(d).filter(commitable).map((r) => r.path) : [];
    if (!paths.length) return null;
    const n = paths.filter((p) => checked.has(p)).length;
    const all = n === paths.length;
    return (
      <label className="-mr-1 flex size-11 shrink-0 cursor-pointer items-center justify-center md:size-7">
        <input
          type="checkbox"
          className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring"
          checked={all}
          ref={(el) => void (el && (el.indeterminate = n > 0 && !all))}
          onChange={() => setChecked((c) => (all ? new Set([...c].filter((p) => !paths.includes(p))) : new Set([...c, ...paths])))}
          aria-label={t("files.changes.checkFolder", { path: d.path })}
          data-testid="commit-check-folder"
          data-path={d.path}
        />
      </label>
    );
  };
  const [filter, setFilter] = useState("");
  const [listWidth, setListWidth] = useState(loadListWidth);
  useEffect(() => saveListWidth(listWidth), [listWidth]);
  // No filter in the narrow accordion (OpenCode has none there).
  const q = narrow ? "" : filter.trim().toLowerCase();
  const matched = q ? rows.filter((r) => relPath(r.path, cwd).toLowerCase().includes(q)) : rows;
  const tree = useMemo(() => fileTree(matched, cwd), [rows, q, cwd]);
  const [listView, setListView] = useState(loadListView);
  const flat = narrow || listView === "list";
  // The order on screen: the tree's, or by path in the list view and the narrow accordion (OpenCode's mobile review).
  const shown = flat ? [...matched].sort((a, b) => slashed(relPath(a.path, cwd)).localeCompare(slashed(relPath(b.path, cwd)))) : treeOrder(tree);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Show changes (file tree menu): Uncommitted mode, no filter hiding the file, its folders open, the file selected and scrolled to.
  const scrollTo = useRef<string>(undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!reveal) return;
    if (git !== false) pick("uncommitted");
    setFilter("");
    setClosed((c) => Object.fromEntries(Object.entries(c).filter(([dir]) => !(reveal.path.startsWith(dir) && /[\\/]/.test(reveal.path[dir.length] ?? "")))));
    setSelected(reveal.path);
    setExpanded((e) => ({ ...e, [reveal.path]: true }));
    scrollTo.current = reveal.path;
  }, [reveal?.seq]);
  useEffect(() => {
    const p = scrollTo.current;
    const el = p && [...(panelRef.current?.querySelectorAll<HTMLElement>("[data-path]") ?? [])].find((x) => x.dataset.path === p);
    if (!el) return;
    scrollTo.current = undefined;
    el.scrollIntoView?.({ block: "nearest" });
  });
  const allExpanded = shown.length > 0 && shown.every((r) => expanded[r.path]);
  const active = shown.find((r) => r.path === selected) ?? shown[0];
  const index = active ? shown.indexOf(active) : -1;
  // GH-722: the palette's Add to prompt reads the selected row (changes-focus.ts); Rollback runs on the checked rows, else on that row.
  useEffect(() => {
    setChangesSelected(active ? { path: active.path, cwd, deleted: active.kind === "D" } : undefined);
    return () => setChangesSelected(undefined);
  }, [active?.path, active?.kind, cwd]);
  usePanelAsk("rollback", () => {
    const paths = commitPaths(commitRows, checked);
    const one = active && commitable(active) ? commitPaths([active], new Set([active.path])) : [];
    const list = paths.length ? paths : one;
    if (!commitMode || opRunning || !list.length) return false;
    setRollbackPaths(list);
  });
  const wanted = narrow ? shown.filter((r) => expanded[r.path]).map((r) => r.path) : active ? [active.path] : [];
  const wantedKey = wanted.join("\n");
  useEffect(() => {
    if (!gitDiff) return;
    const d = gitDiff;
    for (const r of gitList) {
      if (r.submodule || r.nested) continue;
      const id = `${gen}\n${d.base}\n${r.path}`;
      if (!wantedKey.split("\n").includes(r.path) || asked.current.has(id)) continue;
      asked.current.add(id);
      if (mediaKind(r.path) === "image") {
        const pane = (p: Promise<FsMediaResult>) =>
          p.then(
            (media): ImagePane => ({ media }),
            (e: RequestError): ImagePane => ({ error: readFailure(e).text, notice: readFailure(e).notice }),
          );
        Promise.all([
          r.kind === "A" || !d.base ? undefined : pane(client.request<FsMediaResult>({ type: "fs.media", cwd: gitCwd, ...ex, hash: d.base, path: r.oldPath ?? r.rel })),
          r.kind === "D" ? undefined : pane(client.request<FsMediaResult>({ type: "fs.media", path: r.path })),
        ]).then(([before, after]) => setSides((x) => ({ ...x, [r.path]: { base: d.base, image: { before, after } } })));
        continue;
      }
      const fileAt = (hash: string, path: string) => client.request<FsReadResult>({ type: "git.fileAt", cwd: gitCwd, ...ex, hash, path }).then((x) => x.content);
      Promise.all([
        r.kind === "A" || !d.base ? "" : fileAt(d.base, r.oldPath ?? r.rel),
        r.kind === "D" ? "" : client.request<FsReadResult>({ type: "fs.read", path: r.path }).then((x) => x.content),
      ]).then(
        ([before, rawAfter]) => {
          // A change that is only the line endings (git counted lines, LF against CRLF) stays visible.
          const norm = gitEol(before, rawAfter);
          const after = norm === before && rawAfter !== before && r.stats && r.stats.added + r.stats.removed > 0 ? rawAfter : norm;
          setSides((x) => ({ ...x, [r.path]: { base: d.base, before, after, stats: r.stats ? undefined : fileStats(before, after, r.path) } }));
        },
        (e: RequestError) => {
          const f = readFailure(e);
          setSides((x) => ({ ...x, [r.path]: { base: d.base, error: f.text, notice: f.notice } }));
        },
      );
    }
  }, [client, gitCwd, gitDiff, gitList, wantedKey, gen]);
  // A listed file changed on disk (Bash, another tool): the list and the sides are read again.
  useEffect(() => (gitMode ? client.onFsChanged((m) => gitList.some((r) => r.path === m.path) && setReload((n) => n + 1)) : undefined), [client, gitMode, gitList]);
  // Previous/next file like OpenCode's review toolbar: cycles the listed files, also on ←/→ while focus is not in a text field.
  const cycle = (step: number) => shown.length && setSelected(shown[(index + step + shown.length) % shown.length]!.path);
  const cycleRef = useRef(cycle);
  cycleRef.current = cycle;
  // Only while the file list is on screen: not behind another pane, a closed side panel or the new-session tab (display: none).
  const listRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef(false);
  keysRef.current = !hidden && !narrow;
  useEffect(() => onCount?.(rows.length), [rows.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!keysRef.current || listRef.current?.checkVisibility?.() === false || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      // The side panel's keys stop while the popup viewer (a modal dialog without this panel) shows.
      const modal = document.querySelector('[aria-modal="true"]');
      if (modal && !modal.contains(listRef.current)) return;
      const t = e.target;
      // Text fields keep their caret keys; widgets with their own arrow keys (tabs, the panel resizer, menus) keep theirs.
      if (t instanceof HTMLElement && (t.isContentEditable || t.closest("input, textarea, select, [role=tab], [role=separator], [role=menu], [role=listbox], [role=tree], [role=radiogroup]"))) return;
      e.preventDefault();
      cycleRef.current(e.key === "ArrowLeft" ? -1 : 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const label = (r: Row) =>
    r.nested
      ? t("files.changes.repoLabel", { path: relPath(r.path, cwd) })
      : `${kindTitle(badgeOf(r))} ${relPath(r.path, cwd)}${r.submodule ? `, ${t("files.changes.submodule")}${r.dirty ? `, ${t("files.changes.modifiedContent")}` : ""}` : r.stats ? `, +${r.stats.added} -${r.stats.removed}` : ""}`;
  const rowIcon = (r: Row) => (r.nested ? <RepoIcon kind="nested" /> : r.submodule ? <ArchiveIcon className="size-4 shrink-0" aria-hidden /> : <FileIcon path={r.path} className="size-4 shrink-0" />);
  const treeRow =
    "flex min-h-11 w-full cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset md:min-h-7";
  const pad = (depth: number) => ({ paddingLeft: `${depth * 16 + 8}px` });
  // OpenCode's FileTree: a folder row (chevron, open by default) above its files; a file row with its type icon and A/D.
  const branch = (f: Folder, depth: number): ReactNode => (
    <>
      {f.folders.map((d) => (
        <li key={d.path}>
          <div className={commitMode ? "flex items-center" : undefined} style={commitMode ? { paddingLeft: `${depth * 16}px` } : undefined}>
          {folderCheck(d)}
          <button
            className={treeRow}
            style={commitMode ? undefined : pad(depth)}
            aria-expanded={!closed[d.path]}
            onClick={() => setClosed((c) => ({ ...c, [d.path]: !c[d.path] }))}
            data-testid="changed-folder"
          >
            {closed[d.path] ? <ChevronRightIcon className="size-4 shrink-0 text-faint" aria-hidden /> : <ChevronDownIcon className="size-4 shrink-0 text-faint" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{d.name}</span>
          </button>
          </div>
          {!closed[d.path] && <ul className="mt-0.5 flex flex-col gap-0.5">{branch(d, depth + 1)}</ul>}
        </li>
      ))}
      {f.files.map((r) => (
        <Fragment key={r.path}>{rowMenu(r, (
        <li className={commitMode ? "flex items-center" : undefined} style={commitMode ? { paddingLeft: `${depth * 16}px` } : undefined}>
          {rowCheck(r, "-mr-1")}
          <button
            className={cn(treeRow, r === active && "bg-secondary text-foreground")}
            style={commitMode ? undefined : pad(depth)}
            aria-current={r === active}
            title={r.path}
            aria-label={label(r)}
            onClick={() => setSelected(r.path)}
            data-testid="changed-file"
            data-path={r.path}
          >
            {rowIcon(r)}
            <span className="min-w-0 flex-1 truncate">
              {flat && filePath(r.path, cwd).dir && <span className="text-faint">{slashed(filePath(r.path, cwd).dir.replace(/[\\/]$/, ""))}/</span>}
              {filePath(r.path, cwd).name}
            </span>
            {r.submodule && <SubmoduleBadge />}
            {r.nested && <RepoBadge />}
            {/* OpenCode's v2 tree marks added and deleted files; M shows in the diff header only. */}
            {r.kind !== "M" && !r.nested && <KindBadge kind={r.kind} untracked={r.untracked} />}
          </button>
        </li>
        ))}</Fragment>
      ))}
    </>
  );

  // Nothing until first shown; after that hidden with display: none, so switching back to this pane renders and highlights nothing again.
  const [shownOnce, setShownOnce] = useState(!hidden);
  if (!hidden && !shownOnce) setShownOnce(true);
  if (!shownOnce) return null;

  const short = (r: string) => r.replace(/^refs\/(heads|remotes)\//, "");
  const gitRef = refChoice ?? gitDiff?.ref;
  const empty = gitMode
    ? effective === "uncommitted"
      ? t("files.changes.noUncommitted")
      : t("files.changes.noAgainst", { ref: gitRef ? short(gitRef) : t("files.changes.theBranch") })
    : scope === "project" && sessionRows.length
      ? t("files.changes.noInProject")
      : (emptyText ?? t("files.changes.noInSession"));
  const message = gitError ? (
    <p role="alert" className="p-3 text-destructive" data-testid="changes-error">
      {gitError}
    </p>
  ) : gitLoading ? (
    <p className="p-3 text-muted-foreground" data-testid="changes-loading">
      {t("files.changes.loading")}
    </p>
  ) : !rows.length ? (
    <div className="m-auto flex flex-col items-center gap-2 p-4 text-muted-foreground" data-testid="changes-empty">
      <FileDiffIcon className="size-5 text-faint" aria-hidden />
      {empty}
    </div>
  ) : undefined;

  const modeSelect = (
    <Select value={mode} onValueChange={(v) => v && (pick(v as DiffMode), offer("diffMode", { mode: v as DiffMode, def: loadDiffMode(), streak: streak(v) }, () => saveDiffMode(v as DiffMode)))}>
      <SelectTrigger aria-label={t("files.changes.diffMode")} data-testid="diff-mode" className={cn("min-w-0", narrow ? "flex-1 data-[size=default]:h-11" : "w-40 shrink-0 data-[size=default]:h-7")}>
        <SelectValue>{(v: DiffMode) => t(MODE_KEY[v])}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="min-w-44">
        {DIFF_MODES.map((m) => (
          <SelectItem key={m.value} value={m.value} disabled={m.git && git === false} data-testid={`diff-mode-${m.value}`} className="max-md:min-h-11">
            <span className="flex flex-col">
              {t(MODE_KEY[m.value])}
              {m.git && git === false && <span className="text-muted-foreground text-xs">{t("files.changes.needsGit")}</span>}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const selectorShown = gitMode && !!repos?.list && selectorVisible(repos.list);
  const repoSelect = selectorShown && repos?.list && <RepoSelector list={repos.list} truncated={repos.truncated} selected={selectedRepo} onSelect={chooseRepo} />;
  // A hunk rolls back at once, no dialog.
  const repoName = selectorShown && selectedRepo ? repoLabel(selectedRepo) : undefined;
  const rollbackHunk = (row: Row, hunk: { newStart: number; lines: string[] }) =>
    void runRemoteOp(client, { type: "git.rollbackHunk", cwd: gitCwd, ...(repo && { exact: true as const }), path: row.rel!, hunk }, ofRepo(t("files.changes.rolledBackHunk", { name: filePath(row.path, cwd).name }), repoName), ofRepo(t("files.changes.rollingBack"), repoName), onGitWrite);
  const hunkProps = (r: Row) => (commitMode && (r.kind === "M" || r.kind === "R") && !r.submodule && !r.nested && r.rel !== undefined ? { onHunk: (h: { newStart: number; lines: string[] }) => rollbackHunk(r, h), hunkDisabled: opRunning } : {});
  /** GH-612: Open, Copy path, Copy relative path, then open in an app (not for a repository or submodule row; disabled once the file is deleted). */
  const rowSections = (r: Row): RowMenuItem[][] => {
    if (r.nested || r.submodule) return [];
    const local = openExt?.canOpen(cwd) ? openExt : undefined;
    return [
      [{ label: t("files.menu.open"), testId: "row-open", run: () => onOpen(r.path) }, ...(onCopy ? [{ label: t("files.menu.copyPath"), testId: "row-copyPath", run: () => (onCopy(r.path, "path"), tipOpenInFileManager(!!local && r.kind !== "D", () => reopenMenu(rowElOf(r.path), '[data-testid$="ext-menu-reveal"]'))) }, { label: t("files.menu.copyRel"), testId: "row-copyRel", run: () => onCopy(relPath(r.path, cwd), "relative path") }] : [])],
      local ? externalEntries({ isDir: false, editors: local.editors, local: local.isLocal(cwd), disabled: r.kind === "D" }).map((x) => ({ label: x.label, title: x.title, testId: `row-${x.testId}`, disabled: x.disabled, run: () => local.run(r.path, x.how, cwd) })) : [],
    ];
  };
  const rowElOf = (path: string) => [...document.querySelectorAll<HTMLElement>('[data-testid="changed-file"]')].find((e) => e.dataset.path === path);
  const rowMenu = (r: Row, node: ReactElement) => (
    <RollbackMenu sections={rowSections(r)} enabled={commitMode && commitable(r) && !opRunning} onRollback={() => setRollbackPaths(commitPaths([r], new Set([r.path])))} onMention={onSend && r.kind !== "D" ? () => onSend(fileMention(r.path, cwd)) : undefined}>
      {node}
    </RollbackMenu>
  );
  const branchList = gitRef && !branches.includes(gitRef) ? [gitRef, ...branches] : branches;
  const branchSelect = effective === "branch" && (
    <Select value={gitRef ?? null} onValueChange={(v) => v && pick("branch", v)} disabled={!branchList.length}>
      <SelectTrigger
        aria-label={t("files.changes.compare")}
        title={gitDiff?.base ? t("files.changes.mergeBase", { sha: gitDiff.base.slice(0, 8) }) : undefined}
        data-testid="diff-branch"
        className={cn("min-w-0", narrow ? "w-full data-[size=default]:h-11" : "w-44 shrink-0 data-[size=default]:h-7")}
      >
        <SelectValue>{(v: string | null) => (v ? short(v) : t("files.changes.pickBranch"))}</SelectValue>
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="min-w-44">
        {branchList.map((b) => (
          <SelectItem key={b} value={b} data-testid={`diff-branch-${b}`} className="max-md:min-h-11">
            {short(b)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  const scopeGroup = !gitMode && (
    <div className="flex rounded-md bg-secondary p-0.5" role="group" aria-label={t("files.changes.filesShown")}>
      {(["project", "all"] as const).map((s) => (
        <Button
          key={s}
          size="sm"
          variant="ghost"
          aria-pressed={scope === s}
          className={cn("h-6 px-2 text-xs max-md:h-11 max-md:px-3 max-md:text-sm", scope === s && "bg-card shadow-xs hover:bg-card")}
          onClick={() => chooseScope(s)}
          data-testid={`diff-scope-${s}`}
        >
          {s === "project" ? t("files.changes.project") : t("files.changes.all")}
        </Button>
      ))}
    </div>
  );
  const counts = rows.length > 0 && (
    <>
      <span className="truncate font-medium">
        {t("files.changes.count", { count: rows.length })}
      </span>
      {rows.some((r) => r.stats) && <StatsText stats={total} />}
    </>
  );
  const notGit = git === false && mode !== "session" && (
    <p role="status" className="border-b px-3 py-1.5 text-muted-foreground" data-testid="changes-not-git">
      {t("files.changes.notGit")}
    </p>
  );
  const hiddenNote = outside > 0 && (
    <span className="text-muted-foreground text-xs" data-testid="scope-hidden">
      {t("files.changes.outsideHidden", { count: outside })}
    </span>
  );

  return (
    <div ref={panelRef} className="flex min-h-0 flex-1 flex-col" hidden={hidden} data-testid="changes-panel">
      {narrow ? (
        <div className="shrink-0 border-b">
          <div className="flex h-14 items-center gap-2 px-3">
            {modeSelect}
            <div className="flex items-center gap-2 max-md:gap-2" data-testid="changes-actions">
              {rows.length > 0 && (
                <Button size="sm" variant="outline" className="h-11" onClick={() => setExpanded(allExpanded ? {} : Object.fromEntries(shown.map((r) => [r.path, true])))} data-testid="expand-all">
                  {allExpanded ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />} {allExpanded ? t("files.changes.collapseAll") : t("files.changes.expandAll")}
                </Button>
              )}
              {onPopOut && (
                <Button size="icon-sm" variant="ghost" className="size-11" onClick={onPopOut} title={t("files.changes.popup")} aria-label={t("files.changes.popupLong")} data-testid="changes-popout">
                  <Maximize2Icon />
                </Button>
              )}
              <Button size="icon-sm" variant="ghost" className="size-11" onClick={() => (setReload((n) => n + 1), onReload?.())} title={t("files.reloadFromDisk")} aria-label={t("files.reloadFromDisk")}>
                <RotateCwIcon />
              </Button>
            </div>
          </div>
          {repoSelect && <div className="flex min-h-11 items-center border-t px-3" data-testid="repo-row">{repoSelect}</div>}
          {branchSelect && <div className="flex min-h-11 items-center border-t px-3" data-testid="branch-row">{branchSelect}</div>}
          {(rows.length > 0 || scopeGroup) && (
            <div className="flex min-h-11 items-center gap-2 border-t px-3">
              {counts}
              {hiddenNote}
              <div className="ml-auto flex items-center">{scopeGroup}</div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1">
          {modeSelect}
          {repoSelect}
          {branchSelect}
          {counts}
          <div className="ml-auto flex items-center gap-1" data-testid="changes-actions">
            {shown.length > 0 && (
              <span className="font-mono text-muted-foreground text-xs" data-testid="file-position">
                {index + 1}/{shown.length}
              </span>
            )}
            <Button size="icon-sm" variant="ghost" disabled={!shown.length} onClick={() => cycle(-1)} title={t("files.changes.prevTitle")} aria-label={t("files.changes.prev")}>
              <ArrowLeftIcon />
            </Button>
            <Button size="icon-sm" variant="ghost" disabled={!shown.length} onClick={() => cycle(1)} title={t("files.changes.nextTitle")} aria-label={t("files.changes.next")}>
              <ArrowRightIcon />
            </Button>
            {onPopOut && (
              <Button size="icon-sm" variant="ghost" onClick={onPopOut} title={t("files.changes.popup")} aria-label={t("files.changes.popupLong")} data-testid="changes-popout">
                <Maximize2Icon />
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" onClick={() => (setReload((n) => n + 1), onReload?.())} title={t("files.reloadFromDisk")} aria-label={t("files.reloadFromDisk")}>
              <RotateCwIcon />
            </Button>
            <div className="flex rounded-md bg-secondary p-0.5" role="group" aria-label={t("files.diffView")}>
              {(["unified", "split"] as const).map((s) => (
                <Button
                  key={s}
                  size="icon-sm"
                  variant="ghost"
                  aria-pressed={style === s}
                  aria-label={s === "unified" ? t("files.diffUnified") : t("files.diffSplit")}
                  title={s === "unified" ? t("files.diffUnified") : t("files.diffSplit")}
                  className={cn(style === s && "bg-card shadow-xs hover:bg-card")}
                  onClick={() => choose(s)}
                  data-testid={`diff-${s}`}
                >
                  {s === "unified" ? <Rows2Icon /> : <Columns2Icon />}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
      {notGit}
      {operation && <ConflictBanner client={client} cwd={gitCwd} exact={!!repo} operation={operation} repoName={selectorShown && selectedRepo ? repoLabel(selectedRepo) : undefined} onOpen={onOpen} onResolve={onResolve} />}
      {commitMode && !operation && (
        <>
          <CommitBox client={client} cwd={gitCwd} project={project} exact={!!repo} repoName={selectorShown && selectedRepo ? repoLabel(selectedRepo) : undefined} rows={commitRows} checked={checked} onChecked={setChecked} base={gitDiff?.base} onCommitted={onGitWrite} onRollback={setRollbackPaths} />
          <RollbackDialog client={client} cwd={gitCwd} exact={!!repo} repoName={repoName} paths={rollbackPaths} onClose={() => setRollbackPaths(undefined)} onDone={(p) => (setChecked((c) => new Set([...c].filter((x) => !p.includes(commitRows.find((r) => r.path === x)?.rel ?? "")))), onGitWrite?.())} />
        </>
      )}
      {/* The result of a Continue or Abort stays after the banner is gone, in every mode. */}
      {git !== false && <GitOpResult cwd={gitCwd} {...OP_RESULT_IDS} />}
      {message ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {message}
          {/* A scope that hides every file still offers the way back. */}
          {scopeGroup && !narrow && <div className="mx-auto pb-4">{scopeGroup}</div>}
        </div>
      ) : narrow ? (
        // OpenCode's mobile review: an accordion of the files, each diff under its row.
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <ul className="overflow-hidden rounded-lg border" aria-label={t("files.changes.changedFiles")}>
            {shown.map((r) => {
              const path = r.path;
              const { name, dir } = filePath(path, cwd);
              const open = !!expanded[path];
              return (
                <li key={path} className="border-b last:border-b-0">
                  {rowMenu(r, (
                  <div className="flex items-center">
                  {rowCheck(r, "ml-1")}
                  <button
                    className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    aria-expanded={open}
                    title={path}
                    aria-label={label(r)}
                    onClick={() => setExpanded((x) => ({ ...x, [path]: !x[path] }))}
                    data-testid="changed-file"
                    data-path={path}
                  >
                    {rowIcon(r)}
                    <span className="min-w-0 flex-1 truncate">
                      {dir && <span className="text-muted-foreground">{slashed(dir.replace(/[\\/]$/, ""))}/</span>}
                      {name}
                    </span>
                    {r.submodule && <SubmoduleBadge />}
                    {r.nested && <RepoBadge />}
                    {r.kind !== "M" && !r.nested && <span className={cn("shrink-0 text-xs", KIND_COLOR[badgeOf(r)])}>{kindTitle(badgeOf(r))}</span>}
                    {r.stats && <StatsText stats={r.stats} />}
                    {open ? <ChevronDownIcon className="size-4 shrink-0 text-faint" aria-hidden /> : <ChevronRightIcon className="size-4 shrink-0 text-faint" aria-hidden />}
                  </button>
                  </div>
                  ))}
                  {open && <FileDiff row={r} cwd={cwd} style={style} onOpen={onOpen} inline git={gitMode} branchMode={effective === "branch"} onShowRepo={chooseRepo} {...hunkProps(r)} onSend={onSend} />}
                </li>
              );
            })}
          </ul>
          {gitDiff?.truncated && <p className="p-2 text-muted-foreground text-xs">{t("files.changes.listCut")}</p>}
        </div>
      ) : (
        // OpenCode's review file sidebar (240px, 200px in a narrow panel, resizable): filter and folder tree beside the diff.
        <div className="@container flex min-h-0 flex-1">
          <div ref={listRef} className={cn("flex shrink-0 flex-col border-r", !listWidth && "w-50 @2xl:w-60")} style={listWidth ? { width: `min(${listWidth}px, calc(100% - 240px))` } : undefined}>
            <label className="relative flex items-center px-2 pt-2 pb-1">
              <SearchIcon className="pointer-events-none absolute left-4 size-4 text-faint" aria-hidden />
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t("files.filter")}
                aria-label={t("files.filter")}
                className="h-8 w-full rounded-md bg-secondary/60 pr-2 pl-8 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="changes-filter"
              />
              <Button
                size="icon-sm"
                variant="ghost"
                className="ml-1 shrink-0"
                aria-pressed={listView === "list"}
                title={listView === "list" ? t("files.changes.viewTree") : t("files.changes.viewList")}
                aria-label={listView === "list" ? t("files.changes.viewTree") : t("files.changes.viewList")}
                onClick={() => {
                  const v = listView === "list" ? "tree" : "list";
                  setListView(v);
                  saveListView(v);
                }}
                data-testid="changes-list-view"
              >
                {listView === "list" ? <ListTreeIcon /> : <ListIcon />}
              </Button>
            </label>
            {scopeGroup && (
              <div className="flex items-center gap-2 px-2 pb-1">
                {scopeGroup}
                {hiddenNote}
              </div>
            )}
            {!shown.length && <p className="px-3 py-2 text-muted-foreground">{t("files.changes.noMatch")}</p>}
            <ul className="flex min-h-0 flex-col gap-0.5 overflow-auto p-1" aria-label={t("files.changes.changedFiles")}>
              {branch(flat ? { name: "", path: "", folders: [], files: shown } : tree, 0)}
            </ul>
            {gitDiff?.truncated && <p className="border-t p-2 text-muted-foreground text-xs">{t("files.changes.listCut")}</p>}
          </div>
          <ListResizer list={listRef} width={listWidth} onResize={setListWidth} />
          {active && <FileDiff key={active.path} row={active} cwd={cwd} style={style} onOpen={onOpen} git={gitMode} branchMode={effective === "branch"} onShowRepo={chooseRepo} {...hunkProps(active)} onSend={onSend} />}
        </div>
      )}
    </div>
  );
}

export function StatsText({ stats }: { stats: Stats }) {
  return (
    <span className="shrink-0 font-mono text-xs" data-testid="change-stats">
      <span className="text-success">+{stats.added}</span>
      <span className="ml-1 text-destructive">-{stats.removed}</span>
    </span>
  );
}

export function SubmoduleBadge() {
  useT();
  return (
    <span className="shrink-0 rounded bg-secondary px-1 text-[11px] text-muted-foreground" data-testid="submodule-badge">
      {t("files.changes.submodule")}
    </span>
  );
}

export function RepoBadge() {
  useT();
  return (
    <span className="shrink-0 rounded bg-secondary px-1 text-[11px] text-muted-foreground" data-testid="repo-badge">
      {t("files.changes.repository")}
    </span>
  );
}

export function KindBadge({ kind, untracked }: { kind: Kind; untracked?: boolean }) {
  useT();
  const k = badgeOf({ kind, untracked });
  return (
    <span className={cn("w-4 shrink-0 text-center font-[530] font-mono text-[11px]", KIND_COLOR[k])} title={kindTitle(k)} data-testid="change-badge">
      {k}
    </span>
  );
}

/** `git`: a git mode's file (sides from a commit and the disk, not from the session's calls). `inline`: under its accordion row, which already names the file: only Open in editor above the diff, and no own scroll. */
function FileDiff({ row, cwd, style, onOpen, inline, git, branchMode, onShowRepo, onHunk, hunkDisabled, onSend }: { onSend?: (text: string) => void; onHunk?: (hunk: { newStart: number; lines: string[] }) => void; hunkDisabled?: boolean; row: Row; cwd: string; style: DiffStyle; onOpen: (path: string) => void; inline?: boolean; git?: boolean; branchMode?: boolean; onShowRepo?: (rel: string) => void }) {
  useT();
  const { path } = row;
  const dark = useDark();
  const colorTheme = useColorTheme();
  // Drawn once the highlighter is loaded (seconds on a first load): until then a loading line.
  const [drawn, setDrawn] = useState(false);
  // One header per file, like OpenCode's (file header off in the library): the panel's own, with the relative path.
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const selecting = useRef(false);
  const selectable = onSend !== undefined;
  const options = useMemo(
    () => ({
      ...DIFF_OPTIONS,
      theme: diffThemes(colorTheme),
      diffStyle: style,
      themeType: dark ? ("dark" as const) : ("light" as const),
      disableFileHeader: true,
      onPostRender: () => setDrawn(true),
      // Line numbers: click, Shift+click or drag. The box takes focus so Alt+K works right after a click.
      enableLineSelection: selectable,
      onLineSelected: (r: SelectedLineRange | null) => {
        // GH-722: a new selection (not each change of its end) counts for the Send selection recommendation.
        if (r && !selecting.current) offer("sendSelection", { n: count("diffSelect") }, () => highlight('[data-testid="diff-send-selection"]'));
        selecting.current = r !== null;
        setRange(r);
        if (r) box.current?.focus({ preventScroll: true });
      },
    }),
    [style, dark, colorTheme, selectable],
  );
  const files = useMemo(
    () => (row.before === undefined || row.after === undefined ? undefined : { old: { name: row.oldPath ?? path, contents: row.before }, new: { name: path, contents: row.after } }),
    [path, row.oldPath, row.before, row.after],
  );
  const same = files !== undefined && row.before === row.after;
  // The library's own parse of the two sides: hunk Rollback (GH-558, one button after the last change of each hunk) and the line selection read it.
  const parsed = useMemo(() => (files && !same ? parseDiffFromFile(files.old, files.new) : undefined), [files, same]);
  // The annotation carries no data (the options type is not generic): the hunk is found again by its line.
  const anchors = useMemo(() => {
    if (!onHunk) return undefined;
    const at = new Map<string, HunkMeta>();
    parsed?.hunks.forEach((_, i) => {
      const a = hunkAnchor(parsed, i);
      if (a) at.set(`${a.side}:${a.lineNumber}`, { index: i, first: a.first, last: a.last });
    });
    return parsed && { at, lines: [...at.keys()].map((k): DiffLineAnnotation => ({ side: k.startsWith("a") ? "additions" : "deletions", lineNumber: Number(k.split(":")[1]) })) };
  }, [parsed, onHunk !== undefined]);
  // GH-722: the palette's Send selection (changes-focus.ts) knows whether lines are selected; its ask sends them.
  const focusId = useRef(Symbol("diff")).current;
  useEffect(() => {
    setDiffSelection(focusId, range !== null);
    return () => setDiffSelection(focusId, false);
  }, [range !== null]);
  const sub = row.submodule;
  const nested = row.nested;
  // Add to prompt for the file (nothing selected, like the Files tab; a deleted file is not on disk) or the selected diff lines.
  const send = () => {
    const rel = relPath(path, cwd).replace(/\\/g, "/");
    const text = (range && parsed && diffSelection(parsed, range, rel)) || (row.kind === "D" ? undefined : fileMention(path, cwd));
    if (text) onSend?.(text);
  };
  const canSend = !!onSend && !sub && !nested && !row.image && !row.error && !same && !!files;
  // The diff that has selected lines takes the palette's Send selection; the others leave the ask.
  usePanelAsk("sendSelection", () => {
    if (!range || !canSend) return false;
    send();
  });
  // `compact`: the header beside the file name is icon-only until it is wide (the name keeps truncate priority).
  const sendButton = (compact?: boolean) =>
    canSend && (
      <Button size={compact ? "icon-sm" : "sm"} variant="ghost" className={cn("max-md:h-11", compact && "shrink-0 max-md:w-11 @xl:w-auto @xl:px-2.5")} title={t("files.panel.sendSelectionTitle")} aria-label={t("files.panel.sendSelection")} onClick={send} data-testid="diff-send-selection">
        <MessageSquarePlusIcon />
        <span className={compact ? "hidden @xl:inline" : undefined}>{t("files.panel.sendSelection")}</span>
      </Button>
    );
  const dirtyText = row.dirty ? t("files.changes.dirtyText", { count: row.dirty }) : "";
  return (
    <div
      ref={box}
      tabIndex={-1}
      className={cn("outline-none", inline ? "flex flex-col border-t" : "flex min-h-0 min-w-0 flex-1 flex-col")}
      data-testid="file-diff"
      data-diff-style={style}
      onKeyDown={(e) => {
        // `code`: Option+K types "˚" on macOS.
        if (selectable && canSend && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyK") (e.preventDefault(), send());
      }}
    >
      {inline ? (
        (canSend || (!sub && !nested && inDir(path, cwd))) && (
          <div className="flex justify-end gap-1 px-2 pt-1">
            {sendButton()}
            {!sub && !nested && inDir(path, cwd) && (
              <Button size="sm" variant="ghost" className="h-11" onClick={() => onOpen(path)} data-testid="open-in-editor">
                <SquareArrowOutUpRightIcon /> {t("files.panel.openInEditor")}
              </Button>
            )}
          </div>
        )
      ) : (
        <div className="@container flex h-10 shrink-0 items-center gap-2 border-b px-3" data-testid="file-diff-header">
          {!nested && <KindBadge kind={row.kind} untracked={row.untracked} />}
          {nested ? <RepoIcon kind="nested" /> : sub ? <ArchiveIcon className="size-4 shrink-0" aria-hidden /> : <FileIcon path={path} className="size-4 shrink-0" />}
          <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground text-xs" title={path}>
            {row.oldShown ? `${row.oldShown} → ${relPath(path, cwd)}` : relPath(path, cwd)}
          </span>
          {sub && <SubmoduleBadge />}
          {nested && <RepoBadge />}
          {row.stats && <StatsText stats={row.stats} />}
          {sendButton(true)}
          {/* The files pane shows only tabs inside cwd, so a file outside it has no Open in editor (OpenCode lists only project files). */}
          {!sub && !nested && inDir(path, cwd) && (
            <Button size="sm" variant="ghost" className="@max-xl:size-8 @max-xl:shrink-0 @max-xl:px-0 max-md:size-11!" title={t("files.panel.openInEditor")} aria-label={t("files.panel.openInEditor")} onClick={() => onOpen(path)} data-testid="open-in-editor">
              <SquareArrowOutUpRightIcon /> <span className="hidden @xl:inline">{t("files.panel.openInEditor")}</span>
            </Button>
          )}
        </div>
      )}
      <div className={cn("text-xs", !inline && "min-h-0 flex-1 overflow-auto p-2")}>
        {sub && (
          <p className="p-2 text-muted-foreground" data-testid="submodule-detail">
            {row.dirtyOnly ? (
              <>{t("files.changes.sub", { path: relPath(path, cwd) })}</>
            ) : sub.from ? (
              <>
                {t("files.changes.subAt", { path: relPath(path, cwd) })} <span className="font-mono">{sub.from.slice(0, 7)}</span> {branchMode ? t("files.changes.atMergeBase") : t("files.changes.inHead")}
              </>
            ) : (
              <>{t("files.changes.subAdded", { path: relPath(path, cwd) })}</>
            )}
            {dirtyText && (
              <span data-testid="submodule-dirty">
                {row.dirtyOnly ? ": " : " · "}
                {dirtyText}
              </span>
            )}
          </p>
        )}
        {nested && (
          <p className="p-2 text-muted-foreground" data-testid="nested-detail">
            {t("files.changes.nested", { path: relPath(path, cwd) })}
            {nested.branch ? ` (${nested.branch})` : ""}
          </p>
        )}
        {row.repoRel !== undefined && onShowRepo && (
          <div className="px-2 pb-2">
            <Button size="sm" variant="outline" className="max-md:h-11" onClick={() => onShowRepo(row.repoRel!)} data-testid="show-repo-changes">
              {t("files.changes.showIn", { rel: row.repoRel })}
            </Button>
          </div>
        )}
        {!sub && !nested && row.error && <p role={row.notice ? "status" : undefined} className={cn("p-2", row.notice ? "text-muted-foreground" : "text-destructive")}>{row.error}</p>}
        {!sub && !nested && !row.error && !row.image && (row.after === undefined || (files && !same && !drawn)) && (
          <p className="p-2 text-muted-foreground" data-testid="diff-loading">
            {t("files.changes.loadingDiff")}
          </p>
        )}
        {row.image ? (
          <ImageDiff path={path} before={row.image.before} after={row.image.after} split={style === "split"} />
        ) : same ? (
          <p className="p-2 text-muted-foreground">{git ? (row.kind === "R" ? t("files.changes.renamedOnly") : t("files.changes.noContent")) : t("files.changes.noAgainstBefore")}</p>
        ) : files ? (
          parsed && (
            <PierreFileDiff
              fileDiff={parsed}
              options={options}
              lineAnnotations={anchors?.lines}
              renderAnnotation={(a) => {
                const m = anchors?.at.get(`${a.side}:${a.lineNumber}`);
                return m && (
                <div className="flex justify-end px-2 py-0.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 max-md:h-11"
                    disabled={hunkDisabled}
                    aria-label={t("files.changes.rollbackHunkLabel", { from: m.first, to: m.last })}
                    onClick={() => onHunk?.(wireHunk(parsed, m.index))}
                    data-testid="hunk-rollback"
                  >
                    <RotateCcwIcon /> {t("files.changes.rollbackHunk")}
                  </Button>
                </div>
                );
              }}
            />
          )
        ) : (
          !row.error &&
          row.after !== undefined && (
            <div className="flex flex-col gap-2">
              <p className="text-muted-foreground">{t("files.changes.beforeUnknown")}</p>
              {(row.change?.calls ?? []).map((c) => (
                <InputDiff key={c.id} tool={c.tool} input={c.input} diffStyle={style} fileHeader={false} />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
