// Commit section of the Graph's context menu (docs/spec.md "Layout", Graph tab; GH-562): Copy Revision Number, Undo Commit, Revert Commit, Cherry-Pick and
// Reset Current Branch to Here for the row under the pointer. The daemon computes what is possible and the exact git command (`git.commitMenu`).
import { useEffect, useState } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import type { GitCommitMenu, GitCommitMenuResult } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import type { connect, RequestError } from "./client.ts";
import { command, ofRepo, type RemoteRequest } from "./git-branch-menu.tsx";
import type { OpReply } from "./git-remote-ops.ts";
import { ConfirmDialog, ITEM } from "./session-actions.tsx";
import { t, useT } from "./i18n.ts";
import { useLocalHistoryHint } from "./local-history-hint.tsx";

type Client = ReturnType<typeof connect>;
type Done = string | ((r: OpReply) => string);
type Run = (msg: RemoteRequest, done: Done, running: string) => void;
export type Mode = "soft" | "mixed" | "hard";
export type CommitActionRequest =
  | { type: "git.undoCommit" | "git.revert" | "git.cherryPick"; cwd: string; hash: string; headRef: string; headHash: string; argv: string[]; exact?: true }
  | { type: "git.reset"; cwd: string; hash: string; mode: Mode; headRef: string; headHash: string; argv: string[]; dirty?: string; exact?: true };
const short7 = (h: string) => h.slice(0, 7);
const branchOf = (ref?: string) => (ref ?? "").replace(/^refs\/heads\//, "");

/** `git.commitMenu` of `hash` (`hard`: with the lost-files preview); `menu` undefined while loading. */
function useCommitMenu(client: Client, cwd: string, exact: boolean, hash: string, hard: boolean, enabled = true) {
  const [state, setState] = useState<{ menu?: GitCommitMenu; error?: string }>({});
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState({});
    client.request<GitCommitMenuResult>({ type: "git.commitMenu", cwd, ...(exact && { exact: true as const }), hash, ...(hard && { hard: true as const }) }).then(
      (r) => live && setState(r.commitMenu ? { menu: r.commitMenu } : { error: t("sidebar.git.notRepo") }),
      (e: RequestError) => live && setState({ error: e.message || t("sidebar.git.failed") }),
    );
    return () => void (live = false);
  }, [client, cwd, exact, hash, hard, enabled]);
  return state;
}

/** The commit actions of `hash`: Copy Revision Number, Cherry-Pick, then Reset (red), Revert and Undo (HEAD's commit only). */
export function CommitItems({ client, cwd, exact = false, repoName, hash, busy, onRun, onReset }: { client: Client; cwd: string; exact?: boolean; repoName?: string; hash: string; busy: boolean; onRun: Run; onReset: (m: GitCommitMenu) => void }) {
  const tr = useT();
  const { menu, error } = useCommitMenu(client, cwd, exact, hash, false);
  const of = (text: string) => ofRepo(text, repoName);
  const s = short7(hash);
  const ex = exact ? { exact: true as const } : {};
  const go = (type: "git.undoCommit" | "git.revert" | "git.cherryPick", argv: string[], done: Done, running: string) =>
    onRun({ type, cwd, ...ex, hash, headRef: menu!.headRef ?? "", headHash: menu!.headHash ?? "", argv }, done, running);
  const stop = (stopped: string, ok: string) => (r: OpReply) => of(r.written?.operation ? stopped : ok);
  const row = (label: string, argv: string[] | undefined, why: string | undefined, id: string, pick: () => void, danger = false) => (
    <ContextMenu.Item className={cn(ITEM, "h-auto min-h-8 flex-col items-start justify-center py-1 max-md:min-h-11", danger && "text-destructive")} disabled={busy || !argv} onClick={pick} title={!argv ? why : undefined} data-testid={id}>
      <span>{label}</span>
      {!argv && why && <span className="text-muted-foreground text-xs">{why}</span>}
    </ContextMenu.Item>
  );
  return (
    <div role="group" aria-label={tr("sidebar.git.commitHead", { hash: s })}>
      <div className="px-2 pt-1 font-medium text-muted-foreground text-xs" data-testid="commit-menu-head">
        {tr("sidebar.git.commitHead", { hash: s })}
      </div>
      {/* navigator.clipboard is undefined on a non-secure origin (http://<LAN IP>): the item does nothing there, like other Copy items. */}
      <ContextMenu.Item className={cn(ITEM, "max-md:min-h-11")} disabled={busy} onClick={() => void navigator.clipboard?.writeText(hash).catch(() => {})} data-testid="commit-copy-hash">
        {tr("sidebar.git.commitCopyHash")}
      </ContextMenu.Item>
      {!menu ? (
        <ContextMenu.Item className={ITEM} disabled>
          {error ?? tr("sidebar.git.loading")}
        </ContextMenu.Item>
      ) : (
        <>
          {row(tr("sidebar.git.commitCherryPick"), menu.cherryPick, menu.why?.cherryPick, "commit-cherry-pick", () => go("git.cherryPick", menu.cherryPick!, stop(t("sidebar.git.commitPickStopped", { hash: s }), t("sidebar.git.commitPicked", { hash: s })), of(t("sidebar.git.commitPicking", { hash: s }))))}
          <ContextMenu.Separator className="-mx-1 my-1 h-px bg-border" />
          {row(tr("sidebar.git.commitReset"), menu.reset?.mixed, menu.why?.reset, "commit-reset", () => onReset(menu), true)}
          {row(tr("sidebar.git.commitRevert"), menu.revert, menu.why?.revert, "commit-revert", () => go("git.revert", menu.revert!, stop(t("sidebar.git.commitRevertStopped", { hash: s }), t("sidebar.git.commitReverted", { hash: s })), of(t("sidebar.git.commitReverting", { hash: s }))))}
          {menu.headHash === hash && row(tr("sidebar.git.commitUndo"), menu.undo, menu.why?.undo, "commit-undo", () => go("git.undoCommit", menu.undo!, of(t("sidebar.git.commitUndid", { hash: s })), of(t("sidebar.git.commitUndoing", { hash: s }))))}
        </>
      )}
    </div>
  );
}

/** Reset Current Branch to Here: the mode, the exact command and, for Hard, the files it would lose. Confirm sends `git.reset` with the shown argv. `target` undefined: closed. */
export function ResetDialog({ client, cwd, exact = false, repoName, target, onRun, onClose }: { client: Client; cwd: string; exact?: boolean; repoName?: string; target?: GitCommitMenu; onRun: Run; onClose: () => void }) {
  const tr = useT();
  const [mode, setMode] = useState<Mode>("mixed");
  useEffect(() => setMode("mixed"), [target?.hash]);
  const hard = mode === "hard";
  const { menu: preview, error } = useCommitMenu(client, cwd, exact, target?.hash ?? "", true, !!target && hard);
  const info = hard ? preview : target;
  const ready = !!info?.reset && (!hard || !!info.dirty);
  const s = short7(target?.hash ?? "");
  const branch = branchOf(target?.headRef);
  const run = () => {
    const d = target;
    onClose();
    if (!d || !info?.reset) return;
    onRun(
      { type: "git.reset", cwd, ...(exact && { exact: true as const }), hash: d.hash, mode, headRef: info.headRef ?? "", headHash: info.headHash ?? "", argv: info.reset[mode], ...(hard && { dirty: info.dirty }) },
      ofRepo(t("sidebar.git.commitResetDone", { branch, hash: s, mode }), repoName),
      ofRepo(t("sidebar.git.commitResetting", { hash: s }), repoName),
    );
  };
  const lose = info?.lose ?? [];
  const localHistory = useLocalHistoryHint(hard, !!target);
  return (
    <ConfirmDialog
      open={!!target}
      title={tr("sidebar.git.commitResetTitle", { branch, hash: s })}
      description={tr("sidebar.git.commitResetText")}
      confirm={tr(hard ? "sidebar.git.commitResetHardConfirm" : "sidebar.git.commitResetConfirm")}
      destructive={hard}
      confirmDisabled={!ready}
      onConfirm={run}
      onCancel={onClose}
      testId="git-reset"
    >
      <div role="radiogroup" className="flex flex-col gap-1">
        {(["soft", "mixed", "hard"] as const).map((m) => (
          <label key={m} className="flex cursor-pointer items-start gap-2 text-sm max-md:min-h-11 max-md:items-center">
            <input type="radio" name="reset-mode" className="mt-1 max-md:mt-0" checked={mode === m} onChange={() => setMode(m)} data-testid={`git-reset-${m}`} />
            <span>
              <span className="font-medium">{tr(`sidebar.git.commit${m === "soft" ? "Soft" : m === "mixed" ? "Mixed" : "Hard"}`)}</span>
              <span className="block text-muted-foreground text-xs">{tr(`sidebar.git.commit${m === "soft" ? "Soft" : m === "mixed" ? "Mixed" : "Hard"}Text`)}</span>
            </span>
          </label>
        ))}
      </div>
      {localHistory}
      {info?.reset && (
        <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded bg-secondary p-2 font-mono text-muted-foreground text-xs" data-testid="git-command">
          {command(info.reset[mode])}
        </pre>
      )}
      {hard && (
        <div className="text-xs" data-testid="git-reset-lose">
          {!preview ? (
            <span className="text-muted-foreground">{error ?? tr("sidebar.git.loading")}</span>
          ) : lose.length === 0 ? (
            <span className="text-muted-foreground">{tr("sidebar.git.commitLoseNone")}</span>
          ) : (
            <>
              <div className="text-destructive">{tr("sidebar.git.commitLose")}</div>
              <ul className="max-h-32 overflow-y-auto font-mono [overflow-wrap:anywhere]">
                {lose.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {(preview.loseCount ?? 0) > lose.length && <div className="text-muted-foreground">{tr("sidebar.git.commitLoseMore", { count: (preview.loseCount ?? 0) - lose.length })}</div>}
            </>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
