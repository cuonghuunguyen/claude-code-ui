// Edit Commit Message of the Graph's commit menu (docs/spec.md "Layout", Graph tab; GH-667): a dialog with the full message and the exact git
// command(s). The argv builder lives in the protocol package: the daemon runs the request only when it computes the same argv.
import { useEffect, useRef, useState } from "react";
import { rewordArgv, type GitCommitMenu, type GitCommitResult } from "@claude-ui/protocol";
import type { connect, RequestError } from "./client.ts";
import { command, ofRepo, type RemoteRequest } from "./git-branch-menu.tsx";
import type { OpReply } from "./git-remote-ops.ts";
import { ConfirmDialog } from "./session-actions.tsx";
import { t, useT } from "./i18n.ts";

type Client = ReturnType<typeof connect>;
type Done = string | ((r: OpReply) => string);
type Run = (msg: RemoteRequest, done: Done, running: string, onFail?: (e: RequestError) => boolean, onDone?: () => void) => void;
export type RewordRequest = { type: "git.reword"; cwd: string; hash: string; message: string; headRef: string; headHash: string; argv: string[][]; exact?: true };

const short7 = (h: string) => h.slice(0, 7);
const branchOf = (ref?: string) => (ref ?? "").replace(/^refs\/heads\//, "");
const PRE = "max-h-32 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded bg-secondary p-2 font-mono text-muted-foreground text-xs";

/**
 * Message field (prefilled from `git.commit`) and the live command(s); mounted only while open. A signing edit (`target.signs`) keeps the
 * dialog open (the signer may wait for a passphrase) with a Cancel that stops it; a failure shows here, a success closes the dialog.
 * An unsigned edit closes at once and reports through the result line.
 */
export function RewordDialog({ client, cwd, exact = false, repoName, target, onRun, onClose }: { client: Client; cwd: string; exact?: boolean; repoName?: string; target: GitCommitMenu; onRun: Run; onClose: () => void }) {
  const tr = useT();
  const { hash, reword: mode } = target;
  const s = short7(hash);
  /** undefined: still loading. */
  const [orig, setOrig] = useState<string>();
  const [msg, setMsg] = useState("");
  const [loadError, setLoadError] = useState<string>();
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string>();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    client.request<GitCommitResult>({ type: "git.commit", cwd, ...(exact && { exact: true as const }), hash }).then(
      (r) => {
        if (!live.current) return;
        const m = r.commit.message.trimEnd();
        setOrig(m);
        setMsg(m);
      },
      (e: RequestError) => live.current && setLoadError(e.message || t("sidebar.git.failed")),
    );
    return () => void (live.current = false);
  }, [client, cwd, exact, hash]);
  const message = msg.trimEnd();
  const ready = orig !== undefined && !!mode && !!message.trim() && message !== orig && !waiting;
  const argv = mode ? rewordArgv(mode, hash, message, target.parent) : [];
  const cancel = () => {
    if (waiting) client.request({ type: "git.rewordCancel", cwd, ...(exact && { exact: true as const }) }).catch(() => {});
    onClose();
  };
  const go = () => {
    if (!ready || !mode) return;
    const req: RewordRequest = { type: "git.reword", cwd, ...(exact && { exact: true as const }), hash, message, headRef: target.headRef ?? "", headHash: target.headHash ?? "", argv };
    const done = (r: OpReply) => ofRepo(tr(r.written?.operation ? "sidebar.git.rewordStopped" : "sidebar.git.reworded", { hash: s }), repoName);
    const running = ofRepo(tr("sidebar.git.rewording", { hash: s }), repoName);
    if (!target.signs) {
      onClose();
      return onRun(req, done, running);
    }
    setError(undefined);
    setWaiting(true);
    onRun(
      req,
      done,
      running,
      (e) => {
        if (live.current && e.code !== "cancelled") (setError(e.message || t("sidebar.git.failed")), setWaiting(false));
        return true;
      },
      onClose,
    );
  };
  const description = mode === "rebase" ? tr("sidebar.git.rewordTextRebase", { hash: s, branch: branchOf(target.headRef) }) : tr("sidebar.git.rewordText", { hash: s });
  return (
    <ConfirmDialog open title={tr("sidebar.git.rewordTitle")} description={description} confirm={tr("sidebar.git.rewordSave")} confirmDisabled={!ready} onConfirm={go} onCancel={cancel} testId="git-reword">
      <label className="flex flex-col gap-1 text-sm">
        {tr("sidebar.git.rewordMessage")}
        <textarea
          autoFocus
          rows={6}
          value={orig === undefined ? "" : msg}
          disabled={orig === undefined || waiting}
          placeholder={orig === undefined && !loadError ? tr("sidebar.git.loading") : undefined}
          onChange={(e) => (setMsg(e.target.value), setError(undefined))}
          onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), go())}
          className="rounded-md border bg-transparent px-2 py-1.5 font-mono text-sm max-md:min-h-11 focus-visible:outline-2 focus-visible:outline-ring"
          data-testid="git-reword-message"
        />
      </label>
      {loadError && (
        <div role="alert" className="whitespace-pre-wrap text-destructive text-xs [overflow-wrap:anywhere]" data-testid="git-reword-load-error">
          {loadError}
        </div>
      )}
      {waiting && (
        <div role="status" className="text-muted-foreground text-xs" data-testid="git-reword-waiting">
          {tr("sidebar.git.rewordSigningWait")}
        </div>
      )}
      {error && (
        <div role="alert" className="whitespace-pre-wrap text-destructive text-xs [overflow-wrap:anywhere]" data-testid="git-reword-error">
          {error}
        </div>
      )}
      <pre className={PRE} data-testid="git-command">
        {argv.map(command).join("\n")}
      </pre>
    </ConfirmDialog>
  );
}
