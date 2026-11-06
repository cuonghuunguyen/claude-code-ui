// Rollback of the Changes tab, Uncommitted mode (docs/spec.md "Layout"): the confirmation dialog of the checked files or one row, and the row menu.
import { useEffect, useRef, useState, type ReactElement } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import type { GitRollbackPreview, GitRollbackPreviewResult } from "@claude-ui/protocol";
import { cn } from "@/lib/utils";
import type { connect } from "./client.ts";
import { useKeyContextMenu } from "./context-menu-key.ts";
import { ofRepo } from "./git-branch-menu.tsx";
import { runRemoteOp } from "./git-remote-ops.ts";
import { useT } from "./i18n.ts";
import { ConfirmDialog, ITEM, POPUP } from "./session-actions.tsx";

type Client = ReturnType<typeof connect>;
type Loaded = { preview?: GitRollbackPreview; error?: string };

/** Open while `paths` is set: asks the daemon what a rollback of them does (`git.rollbackPreview`), lists it, and on Confirm sends `git.rollback` with the token. */
export function RollbackDialog({ client, cwd, exact, repoName, paths, onClose, onDone }: {
  client: Client;
  cwd: string;
  exact?: boolean;
  repoName?: string;
  paths: string[] | undefined;
  onClose: () => void;
  /** After a successful rollback of `paths`. */
  onDone: (paths: string[]) => void;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded>({});
  const [deleteAdded, setDeleteAdded] = useState(false);
  const gen = useRef(0);
  useEffect(() => {
    const id = ++gen.current;
    setLoaded({});
    setDeleteAdded(false);
    if (!paths) return;
    client.request<GitRollbackPreviewResult>({ type: "git.rollbackPreview", cwd, ...(exact && { exact: true as const }), paths }).then(
      (r) => id === gen.current && setLoaded(r.preview ? { preview: r.preview } : { error: t("files.changes.rollbackNothing") }),
      (e: Error) => id === gen.current && setLoaded({ error: e.message }),
    );
  }, [paths]);
  const files = loaded.preview?.files ?? [];
  const confirm = () => {
    if (!paths || !loaded.preview) return;
    const n = files.length;
    runRemoteOp(
      client,
      { type: "git.rollback", cwd, ...(exact && { exact: true as const }), paths, token: loaded.preview.token, ...(deleteAdded && { deleteAdded: true }) },
      ofRepo(t("files.changes.rolledBack", { count: n }), repoName),
      ofRepo(t("files.changes.rollingBack"), repoName),
      () => onDone(paths),
    );
    onClose();
  };
  const hasAdded = files.some((f) => f.kind === "A");
  return (
    <ConfirmDialog
      open={!!paths}
      title={t("files.changes.rollbackTitle")}
      description={loaded.error ?? t("files.changes.rollbackBody")}
      confirm={t("files.changes.rollback")}
      destructive
      confirmDisabled={!files.length}
      hideConfirm={!!loaded.error}
      onConfirm={confirm}
      onCancel={onClose}
      testId="rollback"
    >
      {files.length > 0 && (
        <ul className="flex max-h-60 flex-col gap-0.5 overflow-auto font-mono text-xs" aria-label={t("files.changes.rollbackFiles")} data-testid="rollback-files">
          {files.map((f) => (
            <li key={f.path} className="flex min-w-0 gap-2" data-testid="rollback-file">
              <span className="w-4 shrink-0 text-center text-muted-foreground">{f.kind}</span>
              <span className="min-w-0 break-all">{f.oldPath !== undefined ? `${f.oldPath} → ${f.path}` : f.path}</span>
            </li>
          ))}
        </ul>
      )}
      {hasAdded && (
        <label className="flex min-h-11 items-center gap-2 text-sm md:min-h-7">
          <input type="checkbox" className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-ring" checked={deleteAdded} onChange={(e) => setDeleteAdded(e.target.checked)} data-testid="rollback-delete-added" />
          {t("files.changes.rollbackDeleteAdded")}
        </label>
      )}
    </ConfirmDialog>
  );
}

/** Right click, long press or Shift+F10 on `children` (one row) offers Rollback… for its paths; `children` becomes the trigger element. */
export function RollbackMenu({ children, enabled, onRollback, className }: { children: ReactElement; enabled: boolean; onRollback: () => void; className?: string }) {
  const t = useT();
  const key = useKeyContextMenu();
  if (!enabled) return children;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} {...key} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className={cn(POPUP, "max-w-[calc(100vw-2rem)]", className)}>
            <ContextMenu.Item className={ITEM} onClick={onRollback} data-testid="row-rollback">
              {t("files.changes.rollbackMenu")}
            </ContextMenu.Item>
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
