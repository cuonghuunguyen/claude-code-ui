// Shell of the config dialogs (MCP servers, plugins, skills; docs/spec.md "Config dialogs"): the "Open project" modal look
// (OpenCode dialog tokens), a full-height sheet below sm, Esc or Close returns the focus to the shown prompt box.
import type { ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { trapTab } from "./focus-trap.ts";

/** The prompt box of the shown tab (session or new-session tab); hidden tabs' boxes have no layout box. */
export const shownPrompt = () =>
  [...document.querySelectorAll<HTMLElement>('textarea[aria-label="Prompt"], textarea[aria-label="First prompt"]')].find((el) => el.offsetParent) ?? null;

/** `busy`: a write runs, Esc and Close do nothing (the extension's dialog stays open while adding or removing). */
export function ConfigDialog({ title, open, onClose, busy, footer, children, testId }: { title: string; open: boolean; onClose: () => void; busy?: boolean; footer?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Popup
          finalFocus={() => shownPrompt() ?? true}
          onKeyDown={trapTab}
          className="-translate-x-1/2 fixed top-[max(48px,calc((100dvh-560px)/2))] left-1/2 z-50 flex max-h-[min(100dvh-96px,560px)] w-[min(100vw-24px,640px)] flex-col rounded-xl bg-card text-foreground shadow-floating outline-none max-sm:top-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:rounded-none"
          data-testid={testId}
          // App shortcuts and Esc (stop turn) skip while an aria-modal dialog shows; Base UI does not set it.
          aria-modal="true"
        >
          <div className="flex items-center gap-2 py-2 pr-2 pl-4">
            <Dialog.Title className="flex-1 font-medium text-[15px] tracking-[-0.13px]">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close dialog"
              disabled={busy}
              className="grid size-7 place-items-center rounded-md text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 max-md:size-11"
            >
              <XIcon className="size-4" />
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-1 pb-4">{children}</div>
          {footer && <div className="flex items-center gap-2 border-t px-4 py-2 text-sm">{footer}</div>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Success or error line of a dialog action (the extension's successMessage / errorMessage). */
export function Banner({ kind, children }: { kind: "success" | "error"; children: ReactNode }) {
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className={`self-stretch rounded-md px-3 py-2 text-sm ${kind === "error" ? "bg-destructive/10 text-destructive" : "bg-success/10 text-foreground"}`}
      data-testid={`banner-${kind}`}
    >
      {children}
    </div>
  );
}
