// Conflict banner of the Changes tab (docs/spec.md "Layout"): an unfinished merge, rebase, cherry-pick, revert or am, or unmerged files
// alone. Shows the conflicted files; Resolve with Claude fills the prompt box (never sends), Continue and Abort run in the daemon.
import { useState } from "react";
import { GitMergeIcon } from "lucide-react";
import type { GitOperation } from "@claude-ui/protocol";
import { Button } from "@/components/ui/button";
import type { connect } from "./client.ts";
import { ofRepo } from "./git-branch-menu.tsx";
import { runRemoteOp, useRemoteOp } from "./git-remote-ops.ts";
import { useT } from "./i18n.ts";
import { joinPath } from "./paths.ts";
import { ConfirmDialog } from "./session-actions.tsx";

type Client = ReturnType<typeof connect>;
const SHOWN = 10;
/** The prompt "Resolve with Claude" inserts: the conflicted files (at most 50) and what Claude must not do. */
const PROMPT_FILES = 50;

export function ConflictBanner({ client, cwd, exact, operation, repoName, onOpen, onResolve }: {
  client: Client;
  /** The repository the operation belongs to. */
  cwd: string;
  exact?: boolean;
  operation: GitOperation;
  repoName?: string;
  /** Opens a conflicted file (absolute path). */
  onOpen: (path: string) => void;
  /** Gets the prompt text; absent: no Resolve button (the popup viewer has no prompt box). */
  onResolve?: (prompt: string) => void;
}) {
  const t = useT();
  const { running } = useRemoteOp(cwd);
  const [abort, setAbort] = useState(false);
  const { kind, conflicted } = operation;
  const busy = running !== undefined;
  const of = (x: string) => ofRepo(x, repoName);
  const ex = exact ? { exact: true as const } : {};
  const resolve = () =>
    onResolve?.(t(kind === "conflict" ? "files.changes.resolvePromptConflict" : "files.changes.resolvePrompt", { kind, repo: cwd, files: conflicted.slice(0, PROMPT_FILES).join(", ") + (conflicted.length > PROMPT_FILES ? ` (+${conflicted.length - PROMPT_FILES})` : "") }));
  const next = () =>
    void runRemoteOp(
      client,
      { type: "git.continue", cwd, kind, ...ex },
      (r) => of(r.written?.operation ? t("files.changes.opStopped", { kind: r.written.operation.kind }) : kind === "conflict" ? t("files.changes.opMarked") : t("files.changes.opContinued", { kind })),
      of(kind === "conflict" ? t("files.changes.opMarking") : t("files.changes.opContinuing", { kind })),
    );
  const doAbort = () => {
    setAbort(false);
    // shortcut: no "snapshot before" yet; Local history and Timeline is the place to hook it in, before this request.
    runRemoteOp(client, { type: "git.abort", cwd, kind, ...ex }, of(t("files.changes.opAborted", { kind })), of(t("files.changes.opAborting", { kind })));
  };
  const btn = "max-md:h-11";
  return (
    <div role="status" className="flex shrink-0 flex-col gap-2 border-b bg-secondary/40 px-3 py-2" data-testid="conflict-banner" data-kind={kind}>
      <div className="flex items-center gap-2 font-medium text-sm">
        <GitMergeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span data-testid="conflict-title">{t(`files.changes.op.${kind}`)}</span>
      </div>
      {conflicted.length > 0 && (
        <ul className="flex flex-wrap gap-1" data-testid="conflict-files">
          {conflicted.slice(0, SHOWN).map((f) => (
            <li key={f} className="min-w-0 max-w-full">
              <Button size="sm" variant="ghost" className="h-7 max-w-full justify-start px-2 font-mono text-xs max-md:h-11" title={t("files.changes.opOpen", { path: f })} onClick={() => onOpen(joinPath(cwd, f))}>
                <span className="truncate">{f}</span>
              </Button>
            </li>
          ))}
          {conflicted.length > SHOWN && <li className="self-center text-muted-foreground text-xs">{t("files.changes.opMore", { count: conflicted.length - SHOWN })}</li>}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {conflicted.length > 0 && onResolve && (
          <Button size="sm" variant="outline" className={btn} disabled={busy} onClick={resolve} data-testid="conflict-resolve">
            {t("files.changes.resolveWithClaude")}
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" className={btn} disabled={busy} onClick={() => setAbort(true)} data-testid="conflict-abort">
            {t("files.changes.opAbort")}
          </Button>
          <Button size="sm" className={btn} disabled={busy} onClick={next} data-testid="conflict-continue">
            {kind === "conflict" ? t("files.changes.opMarkResolved") : t("files.changes.opContinue")}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={abort}
        title={t("files.changes.opAbortTitle", { kind })}
        description={kind === "conflict" ? t("files.changes.opAbortConflictText") : t("files.changes.opAbortText", { kind })}
        confirm={t("files.changes.opAbort")}
        destructive
        onConfirm={doAbort}
        onCancel={() => setAbort(false)}
        testId="conflict-abort"
      />
    </div>
  );
}
