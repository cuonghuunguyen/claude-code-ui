// Commit box of the Changes tab, Uncommitted mode (docs/spec.md "Layout"): the message, Amend, Commit and Commit and Push of the checked files.
import { useEffect, useRef, useState } from "react";
import { SparklesIcon, SquareIcon } from "lucide-react";
import type { GitBranchInfo, GitBranchResult, GitCommitMessageResult, GitCommitResult, GitLogResult } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import type { connect } from "./client.ts";
import { commitPaths } from "./git-changes.ts";
import { BranchDialog, ofRepo } from "./git-branch-menu.tsx";
import { runRemoteOp, useRemoteOp } from "./git-remote-ops.ts";
import { useT } from "./i18n.ts";
import { cn } from "@/lib/utils";
import { IS_MAC } from "./shortcuts.ts";
import { COMMIT_ASK_EVENT, takeCommitAsk } from "./commit-ask.ts";

// Keys scoped to the box: Mod+Enter commit, Alt+M amend (IntelliJ). The app keys Commit and Push are in shortcuts.ts.
const KEYS = IS_MAC ? { commit: "⌘↩", amend: "⌥M" } : { commit: "Ctrl+Enter", amend: "Alt+M" };

type Client = ReturnType<typeof connect>;
type Row = { path: string; rel?: string; oldPath?: string; nested?: unknown; dirtyOnly?: boolean };

export function CommitBox({ client, cwd, exact, repoName, project, rows, checked, onChecked, base, onCommitted, onRollback }: {
  client: Client;
  /** The repository the commit goes to. */
  cwd: string;
  exact?: boolean;
  repoName?: string;
  /** The project folder: the key of the per-project commit message instruction. */
  project?: string;
  /** Every listed row that can have a checkbox. */
  rows: Row[];
  /** Checked rows, by `path`. */
  checked: ReadonlySet<string>;
  onChecked: (next: Set<string>) => void;
  /** HEAD's full hash (`git.diff` `base`); none before the first commit: no Amend. */
  base?: string;
  /** After a successful commit (the file tree and the status refresh). */
  onCommitted?: () => void;
  /** Rollback of the checked rows' paths (the panel opens the dialog). */
  onRollback?: (paths: string[]) => void;
}) {
  const t = useT();
  const { running } = useRemoteOp(cwd);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  // What the user typed before Amend replaced it with HEAD's message.
  const typed = useRef("");
  const [push, setPush] = useState<GitBranchInfo>();
  const gen = useRef(0);
  // Claude is writing the message: the box is read-only, so a reply never replaces text typed meanwhile.
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState("");
  const write = useRef(0);
  const writingNow = useRef(false);
  const paths = commitPaths(rows, checked);
  const busy = running !== undefined;
  const ready = !busy && !writing && !!message.trim() && (paths.length > 0 || amend);
  const of = (x: string) => ofRepo(x, repoName);
  /** Ignores the running generation's reply and tells the daemon to stop it. */
  const stopWriting = () => {
    write.current++;
    if (!writingNow.current) return;
    writingNow.current = false;
    setWriting(false);
    client.request({ type: "git.commitMessageCancel" }).catch(() => {});
  };
  // A message belongs to one repository.
  useEffect(() => {
    setMessage("");
    setAmend(false);
    setPush(undefined);
    setWriteError("");
    gen.current++;
    stopWriting();
  }, [cwd]);
  useEffect(() => () => stopWriting(), []);
  const boxEl = useRef<HTMLDivElement>(null);
  const messageEl = useRef<HTMLTextAreaElement>(null);
  // App keys Commit (focus the message) and Push (the push dialog of HEAD's branch); only a shown box answers.
  useEffect(() => {
    const ex = exact ? { exact: true as const } : {};
    const take = () => {
      if (!boxEl.current?.isConnected || boxEl.current.checkVisibility?.() === false) return;
      const what = takeCommitAsk();
      if (what === "commit") messageEl.current?.focus();
      if (what !== "push") return;
      client
        .request<GitLogResult>({ type: "git.log", cwd, ...ex, limit: 1 })
        .then((l) => (l.log?.head ? client.request<GitBranchResult>({ type: "git.branch", cwd, ...ex, ref: l.log.head }) : undefined))
        .then(
          (r) => {
            const info = r?.branch;
            if (info?.push) setPush(info);
            else setWriteError(info?.why?.push ?? t("files.changes.noBranchToPush"));
          },
          (e: Error) => setWriteError(e.message),
        );
    };
    take();
    addEventListener(COMMIT_ASK_EVENT, take);
    return () => removeEventListener(COMMIT_ASK_EVENT, take);
  }, [client, cwd, exact, t]);
  const generate = () => {
    const id = ++write.current;
    writingNow.current = true;
    setWriting(true);
    setWriteError("");
    client.request<GitCommitMessageResult>({ type: "git.commitMessage", cwd, ...(exact && { exact: true as const }), paths, ...(project && { project }) }).then(
      (r) => {
        if (id !== write.current) return;
        writingNow.current = false;
        setWriting(false);
        setMessage(r.message);
      },
      (e: Error & { code?: string }) => {
        if (id !== write.current) return;
        writingNow.current = false;
        setWriting(false);
        if (e.code !== "cancelled") setWriteError(e.message);
      },
    );
  };

  const toggleAmend = (on: boolean) => {
    const id = ++gen.current;
    if (!on) {
      setAmend(false);
      setMessage(typed.current);
      return;
    }
    typed.current = message;
    setAmend(true);
    if (!base) return;
    client.request<GitCommitResult>({ type: "git.commit", cwd, ...(exact && { exact: true as const }), hash: base }).then(
      (r) => id === gen.current && setMessage(r.commit.message.replace(/\s+$/, "")),
      () => {},
    );
  };
  const commit = (andPush: boolean) => {
    if (!ready) return;
    const text = (r: { committed?: { hash: string; push?: GitBranchInfo } | null }) => {
      const done = of(t("files.changes.committed", { hash: (r.committed?.hash ?? "").slice(0, 7) }));
      const why = r.committed?.push && !r.committed.push.push ? r.committed.push.why?.push : undefined;
      return why ? t("files.changes.commitNoPush", { text: done, why }) : done;
    };
    runRemoteOp(
      client,
      { type: "git.commitFiles", cwd, ...(exact && { exact: true as const }), paths, message, ...(amend && { amend: true }), ...(andPush && { push: true }) },
      text,
      `${of(t("files.changes.committing"))}`,
      (r) => {
        setMessage("");
        setAmend(false);
        onChecked(new Set());
        onCommitted?.();
        if (andPush && r.committed?.push?.push) setPush(r.committed.push);
      },
    );
  };
  const all = rows.length > 0 && rows.every((r) => checked.has(r.path));
  const some = rows.some((r) => checked.has(r.path));
  const box = "size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring";
  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-b px-3 py-2"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
          e.preventDefault();
          commit(false);
        } else if (e.code === "KeyM" && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
          e.preventDefault();
          if (base && !busy && !writing) toggleAmend(!amend);
        }
      }}
      ref={boxEl}
      data-testid="commit-box"
    >
      <div className="relative">
        <textarea
          ref={messageEl}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          readOnly={writing}
          aria-busy={writing}
          placeholder={t("files.changes.commitMessage")}
          aria-label={t("files.changes.commitMessage")}
          className="max-h-40 min-h-14 w-full resize-y rounded-md bg-secondary/60 py-1.5 pr-12 pl-2 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring md:pr-9"
          data-testid="commit-message"
        />
        <Button
          size="icon"
          variant="ghost"
          className="absolute top-0.5 right-0.5 size-11 md:size-7"
          disabled={writing ? false : paths.length === 0 || busy}
          onClick={writing ? stopWriting : generate}
          aria-label={writing ? t("files.changes.generateStop") : t("files.changes.generate")}
          title={writing ? t("files.changes.generateStop") : t("files.changes.generate")}
          data-testid="commit-generate"
        >
          {writing ? <SquareIcon className="size-3.5 animate-pulse" /> : <SparklesIcon className="size-4" />}
        </Button>
      </div>
      {writeError && (
        <p role="alert" className="text-destructive text-xs" data-testid="commit-generate-error">
          {writeError}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-7">
          <input
            type="checkbox"
            className={box}
            checked={all}
            ref={(el) => void (el && (el.indeterminate = some && !all))}
            disabled={rows.length === 0 || busy}
            onChange={() => onChecked(all ? new Set() : new Set(rows.map((r) => r.path)))}
            aria-label={t("files.changes.checkAll")}
            data-testid="commit-check-all"
          />
          <span className="text-muted-foreground" data-testid="commit-count">
            {t("files.changes.checkedCount", { n: rows.filter((r) => checked.has(r.path)).length, m: rows.length })}
          </span>
        </label>
        <label className={cn("flex min-h-11 items-center gap-2 text-sm md:min-h-7", !base && "opacity-50")} title={`${t("files.changes.amend")} (${KEYS.amend})`}>
          <input type="checkbox" className={box} checked={amend} disabled={!base || busy || writing} onChange={(e) => toggleAmend(e.target.checked)} aria-keyshortcuts="Alt+M" data-testid="commit-amend" />
          {t("files.changes.amend")}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" className="max-md:h-11" disabled={busy || !paths.length} onClick={() => onRollback?.(paths)} data-testid="rollback-button">
            {t("files.changes.rollback")}
          </Button>
          <Button size="sm" variant="outline" className="max-md:h-11" disabled={!ready} onClick={() => commit(true)} data-testid="commit-and-push">
            {t("files.changes.commitAndPush")}
          </Button>
          <Button size="sm" className="max-md:h-11" disabled={!ready} onClick={() => commit(false)} title={`${t("files.changes.commit")} (${KEYS.commit})`} aria-keyshortcuts={IS_MAC ? "Meta+Enter" : "Control+Enter"} data-testid="commit-button">
            {t("files.changes.commit")}
          </Button>
        </div>
      </div>
      <span role="status" className="sr-only">
        {running ?? ""}
      </span>
      <BranchDialog dialog={push && { kind: "push", info: push }} cwd={cwd} exact={exact} repoName={repoName} onRun={(msg, done, running) => void runRemoteOp(client, msg, done, running)} onClose={() => setPush(undefined)} />
    </div>
  );
}
