// Session actions like OpenCode's session menu: Rename, Archive, Delete (with confirmation). Share is skipped: no public server.
import { useRef, useState, type ReactElement } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { EllipsisIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useKeyContextMenu } from "./context-menu-key.ts";
import { trapTab } from "./focus-trap.ts";
import { isImeKey } from "./ime.ts";
import { useT } from "./i18n.ts";

export type SessionAction = "rename" | "rename-inline" | "archive" | "unarchive" | "delete" | "copy-id" | "close-tab" | "close-worker" | "remove-worker" | "close-finished" | "remove-closed" | "cleanup-workers";

/**
 * `busy`: running or needs input; it must be stopped before it can be deleted. `transcript`: false before the first prompt, nothing to rename or archive.
 * `copyId`: offers Copy session ID (the tab menu has its own). `tab`: the session has an open tab. `worker`: a worker row (Close worker / Remove worker… instead of Delete…); `closed`: it has no CLI process.
 * `coordinator`: a session with listed workers; counts of the bulk actions.
 */
export type ActionTarget = { title: string; archived: boolean; busy: boolean; transcript: boolean; copyId?: boolean; tab?: boolean; worker?: { closed: boolean }; coordinator?: { finished: number; closed: number; cleanUp?: boolean } };

export const POPUP =
  "z-50 min-w-40 rounded-2xl border bg-popover p-1 text-popover-foreground text-sm shadow-floating outline-none origin-(--transform-origin) transition-[scale,opacity] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none";
export const ITEM =
  "flex h-8 cursor-pointer select-none items-center rounded-md px-2 outline-none data-disabled:cursor-not-allowed data-disabled:text-muted-foreground data-highlighted:bg-secondary max-md:h-11";

export function Items({ kind, target, onAction }: { kind: "menu" | "context"; target: ActionTarget; onAction: (a: SessionAction) => void }) {
  const Item = kind === "menu" ? Menu.Item : ContextMenu.Item;
  const Separator = kind === "menu" ? Menu.Separator : ContextMenu.Separator;
  const t = useT();
  return (
    <>
      <Item className={ITEM} disabled={!target.transcript} onClick={() => onAction("rename")} data-testid="action-rename">
        {t("sidebar.action.rename")}
      </Item>
      <Item className={ITEM} disabled={!target.transcript} onClick={() => onAction(target.archived ? "unarchive" : "archive")} data-testid="action-archive">
        {t(target.archived ? "sidebar.action.unarchive" : "sidebar.action.archive")}
      </Item>
      {(target.copyId || target.tab) && <Separator className="-mx-1 my-1 h-px bg-border" />}
      {target.copyId && (
        <Item className={ITEM} onClick={() => onAction("copy-id")} data-testid="action-copy-id">
          {t("sidebar.action.copySessionId")}
        </Item>
      )}
      {target.tab && (
        <Item className={ITEM} onClick={() => onAction("close-tab")} data-testid="action-close-tab">
          {t("sidebar.action.closeTab")}
        </Item>
      )}
      {target.coordinator && (
        <>
          <Separator className="-mx-1 my-1 h-px bg-border" />
          <Item className={ITEM} disabled={!target.coordinator.finished} onClick={() => onAction("close-finished")} data-testid="action-close-finished">
            {t("sidebar.action.closeFinished", { count: target.coordinator.finished })}
          </Item>
          <Item className={cn(ITEM, "text-destructive")} disabled={!target.coordinator.closed} onClick={() => onAction("remove-closed")} data-testid="action-remove-closed">
            {t("sidebar.action.removeClosed", { count: target.coordinator.closed })}
          </Item>
          {target.coordinator.cleanUp && (
            <Item className={ITEM} onClick={() => onAction("cleanup-workers")} data-testid="action-cleanup">
              {t("sidebar.action.cleanUpWorkers")}
            </Item>
          )}
        </>
      )}
      <Separator className="-mx-1 my-1 h-px bg-border" />
      {target.worker ? (
        <>
          <Item className={ITEM} disabled={target.worker.closed} onClick={() => onAction("close-worker")} data-testid="action-close-worker">
            {t(target.worker.closed ? "sidebar.action.closeWorkerClosed" : "sidebar.action.closeWorker")}
          </Item>
          <Item className={cn(ITEM, "text-destructive")} disabled={target.busy} onClick={() => onAction("remove-worker")} data-testid="action-remove-worker">
            {t(target.busy ? "sidebar.action.removeWorkerFirst" : "sidebar.action.removeWorker")}
          </Item>
        </>
      ) : (
        <Item className={cn(ITEM, "text-destructive")} disabled={target.busy} onClick={() => onAction("delete")} data-testid="action-delete">
          {t(target.busy ? "sidebar.action.deleteFirst" : "sidebar.action.delete")}
        </Item>
      )}
    </>
  );
}

/** `...` button that opens the session menu. Revealed on row hover or focus; always shown on touch screens. */
export function SessionMenu({ target, onAction, className }: { target: ActionTarget; onAction: (a: SessionAction) => void; className?: string }) {
  const t = useT();
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={t("sidebar.actionsFor", { name: target.title })}
        title={t("sidebar.actions")}
        className={cn(
          "grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:size-11 [&_svg]:size-4",
          className,
        )}
        data-testid="session-menu"
      >
        <EllipsisIcon aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={cn(POPUP, "max-w-[calc(100vw-2rem)]")}>
            <Items kind="menu" target={target} onAction={onAction} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Right click (or long press) on `children` opens the session menu. `children` becomes the trigger element. */
export function SessionContextMenu({ target, onAction, children }: { target: ActionTarget; onAction: (a: SessionAction) => void; children: ReactElement }) {
  const key = useKeyContextMenu();
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} {...key} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className={cn(POPUP, "max-w-[calc(100vw-2rem)]")}>
            <Items kind="context" target={target} onAction={onAction} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** A blur this soon after the editor opened is the closing menu's focus return, not the user. */
const RENAME_GRACE_MS = 500;

/** Inline title editor: Enter or blur saves, Escape cancels (`undefined`). An empty or unchanged title is a cancel. */
/** `fromMenu`: opened by a menu item, whose closing returns the focus (a blur right away is that, not the user); a double-click edit ends on any blur. */
export function RenameInput({ title, onDone, className, fromMenu }: { title: string; onDone: (title: string | undefined) => void; className?: string; fromMenu?: boolean }) {
  const t = useT();
  const [value, setValue] = useState(title);
  // Enter unmounts the input, whose blur would then save a second time.
  const done = useRef(false);
  const mountedAt = useRef(performance.now());
  const finish = (text: string | undefined) => {
    if (done.current) return;
    done.current = true;
    const v = text?.trim();
    onDone(v && v !== title ? v : undefined);
  };
  return (
    <input
      // Opened by the Rename action, which expects the caret here.
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !isImeKey(e.nativeEvent)) finish(value);
        if (e.key === "Escape" && !isImeKey(e.nativeEvent)) finish(undefined);
      }}
      onBlur={(e) => {
        // The menu that opened this editor returns focus to its trigger while it closes (a context menu, GH-358): that is no wish to leave.
        if (fromMenu && performance.now() - mountedAt.current < RENAME_GRACE_MS && !done.current) {
          const input = e.currentTarget;
          return void setTimeout(() => input.isConnected && !done.current && input.focus(), 0);
        }
        finish(value);
      }}
      aria-label={t("sidebar.sessionTitle")}
      maxLength={200}
      className={cn("h-6 min-w-0 flex-1 rounded-sm bg-background px-1 text-foreground text-sm outline-none ring-2 ring-ring max-md:h-9", className)}
      data-testid="rename-input"
    />
  );
}

export function DeleteDialog({ title, onConfirm, onCancel }: { title?: string; onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  return (
    <ConfirmDialog
      open={title !== undefined}
      title={t("sidebar.deleteSession.title")}
      description={t("sidebar.deleteSession.body", { title: title ?? "" })}
      confirm={t("sidebar.delete")}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
      testId="delete"
    />
  );
}

/** Asks before an action; `testId`: prefix of the `-dialog`, `-cancel` and `-confirm` test ids. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirm,
  destructive,
  onConfirm,
  onCancel,
  testId,
  finalFocus,
  children,
  confirmDisabled,
  hideConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirm: string;
  destructive?: boolean;
  /** Between the text and the buttons (a name field). */
  children?: React.ReactNode;
  confirmDisabled?: boolean;
  /** Only Cancel stays (nothing to confirm: the action is refused). */
  hideConfirm?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  testId: string;
  /** Where focus goes on close (Base UI finalFocus); default: the trigger. */
  finalFocus?: () => HTMLElement | boolean | null;
}) {
  const t = useT();
  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <AlertDialog.Popup
          className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-2xl border bg-popover p-4 text-popover-foreground shadow-floating outline-none"
          onKeyDown={trapTab}
          finalFocus={finalFocus}
          data-testid={`${testId}-dialog`}
        >
          <div className="flex flex-col gap-1">
            <AlertDialog.Title className="break-words font-medium text-[15px] tracking-[-0.13px] [overflow-wrap:anywhere]">{title}</AlertDialog.Title>
            <AlertDialog.Description className="break-words text-muted-foreground text-sm [overflow-wrap:anywhere]">{description}</AlertDialog.Description>
          </div>
          {children}
          <div className="flex justify-end gap-2">
            <AlertDialog.Close render={<Button variant="ghost" className="cursor-pointer max-md:h-11" />} data-testid={`${testId}-cancel`}>
              {t("sidebar.cancel")}
            </AlertDialog.Close>
            {!hideConfirm && (
              <Button variant={destructive ? "destructive" : "default"} className="cursor-pointer max-md:h-11" onClick={onConfirm} disabled={confirmDisabled} data-testid={`${testId}-confirm`}>
                {confirm}
              </Button>
            )}
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
