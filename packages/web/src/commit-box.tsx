// Commit box of the Changes tab, Uncommitted mode (docs/spec.md "Layout"): the message, Amend, Commit and Commit and Push of the checked files.
import { useEffect, useRef, useState } from "react";
import type { GitBranchInfo, GitCommitResult } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import type { connect } from "./client.ts";
import { commitPaths } from "./git-changes.ts";
import { BranchDialog, ofRepo } from "./git-branch-menu.tsx";
import { runRemoteOp, useRemoteOp } from "./git-remote-ops.ts";
import { useT } from "./i18n.ts";
import { cn } from "@/lib/utils";

type Client = ReturnType<typeof connect>;
type Row = { path: string; rel?: string; oldPath?: string; nested?: unknown; dirtyOnly?: boolean };

export function CommitBox({ client, cwd, exact, repoName, rows, checked, onChecked, base, onCommitted }: {
  client: Client;
  /** The repository the commit goes to. */
  cwd: string;
  exact?: boolean;
  repoName?: string;
  /** Every listed row that can have a checkbox. */
  rows: Row[];
  /** Checked rows, by `path`. */
  checked: ReadonlySet<string>;
  onChecked: (next: Set<string>) => void;
  /** HEAD's full hash (`git.diff` `base`); none before the first commit: no Amend. */
  base?: string;
  /** After a successful commit (the file tree and the status refresh). */
  onCommitted?: () => void;
}) {
  const t = useT();
  const { running } = useRemoteOp(cwd);
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  // What the user typed before Amend replaced it with HEAD's message.
  const typed = useRef("");
  const [push, setPush] = useState<GitBranchInfo>();
  const gen = useRef(0);
  const paths = commitPaths(rows, checked);
  const busy = running !== undefined;
  const ready = !busy && !!message.trim() && (paths.length > 0 || amend);
  const of = (x: string) => ofRepo(x, repoName);
  // A message belongs to one repository.
  useEffect(() => {
    setMessage("");
    setAmend(false);
    setPush(undefined);
    gen.current++;
  }, [cwd]);

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
    <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-2" data-testid="commit-box">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit(false);
          }
        }}
        rows={2}
        placeholder={t("files.changes.commitMessage")}
        aria-label={t("files.changes.commitMessage")}
        className="max-h-40 min-h-14 w-full resize-y rounded-md bg-secondary/60 px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground hover:bg-secondary focus-visible:bg-secondary focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="commit-message"
      />
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
        <label className={cn("flex min-h-11 items-center gap-2 text-sm md:min-h-7", !base && "opacity-50")}>
          <input type="checkbox" className={box} checked={amend} disabled={!base || busy} onChange={(e) => toggleAmend(e.target.checked)} data-testid="commit-amend" />
          {t("files.changes.amend")}
        </label>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" className="max-md:h-11" disabled={!ready} onClick={() => commit(true)} data-testid="commit-and-push">
            {t("files.changes.commitAndPush")}
          </Button>
          <Button size="sm" className="max-md:h-11" disabled={!ready} onClick={() => commit(false)} data-testid="commit-button">
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
