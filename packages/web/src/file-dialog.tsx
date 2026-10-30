// File dialog: the Files tab (tree, tabs, editor) in a large modal over the same editor store (docs/spec.md "Session view UX › File dialog").
// Opened by Pop out and from the timeline (Read cards, file references). Esc or Close closes it; focus is trapped and returns to the opener.
import { useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { connect, ConnectionStatus } from "./client.ts";
import type { EditorStore } from "./editor-store.ts";
import { shownPrompt } from "./config-dialog.tsx";
import { FilesPanel } from "./files-panel.tsx";
import { trapTab } from "./focus-trap.ts";
import { useT } from "./i18n.ts";
import { DialogClose } from "./viewer-dialog.tsx";
import type { RepoList } from "./repo-choice.ts";

type Client = ReturnType<typeof connect>;

/** The Files tab swaps its Pop out button for a status line while the dialog is open, so that opener is gone on close: its replacement gets the focus. */
const replacement = (opener: HTMLElement | null | undefined) => (opener?.dataset.testid === "files-popout" ? document.querySelector<HTMLElement>("[data-testid=files-popout]") : null);

/** Opened by the Files tab's Pop out button on a device with a mouse (not touch). */
const popOutByMouseOrKeys = (opener: HTMLElement | null | undefined) => opener?.dataset.testid === "files-popout" && !!window.matchMedia?.("(pointer: fine)").matches;

export function FileDialog({
  open,
  opener,
  client,
  status,
  cwd,
  store,
  gitStamp,
  onClose,
  onSend,
  onCopy,
  onShowChanges,
  repos,
  onShowGraph,
  onOpenInFiles,
  onOpenTab,
  onItem,
}: {
  open: boolean;
  /** The element focused when the dialog opened; focus returns to it on close, else to the prompt box. */
  opener?: HTMLElement | null;
  client: Client;
  status: ConnectionStatus;
  cwd: string;
  store: EditorStore;
  gitStamp?: string;
  onClose: () => void;
  /** An @mention for the prompt: the caller closes the dialog so the insertion is visible; the drafts stay in the store. */
  onSend: (mention: string) => void;
  onCopy?: (text: string, what: string) => void;
  onShowChanges?: (path: string) => void;
  repos?: RepoList;
  onShowGraph?: () => void;
  /** Open in editor: close the dialog and show the Files tab. */
  onOpenInFiles?: () => void;
  /** Open in tab (GH-399): the caller closes the dialog and opens the file as a main-area tab. */
  onOpenTab?: (path: string) => void;
  /** A path that is a file tab already: the caller closes the dialog and focuses that tab. */
  onItem?: (path: string) => void;
}) {
  const t = useT();
  // App clears the opener with the dialog, and Base UI asks finalFocus after that render.
  const lastOpener = useRef(opener);
  if (open) lastOpener.current = opener;
  // Open in tab: the caller focused the new tab's editor, so the close must not pull the focus back to the opener (GH-504).
  const keepFocus = useRef(false);
  if (open) keepFocus.current = false;
  const [showTree, setShowTree] = useState(true);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o, d) => {
        if (o) return;
        // Esc that CodeMirror's search panel already handled (it closes the panel) must not close the dialog.
        if (d.reason === "escape-key" && d.event.defaultPrevented) return d.cancel();
        onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay" />
        <Dialog.Popup
          // Pop out with a fine pointer: the editor (Ctrl+Z works at once). Touch (keeps the keyboard closed), a Read card and a file link: Base UI's default.
          initialFocus={() => (popOutByMouseOrKeys(opener) ? (store.view.current?.contentDOM ?? true) : true)}
          finalFocus={() => (keepFocus.current ? false : lastOpener.current?.isConnected ? lastOpener.current : (replacement(lastOpener.current) ?? shownPrompt() ?? true))}
          onKeyDown={trapTab}
          // App shortcuts and Esc (stop turn) skip while an aria-modal dialog shows; Base UI does not set it.
          aria-modal="true"
          aria-label={t("files.title")}
          data-testid="file-dialog"
          className="fixed inset-0 z-50 m-auto flex h-[min(100dvh-32px,90dvh)] w-[min(100vw-32px,1200px)] flex-col overflow-hidden rounded-2xl border bg-card text-foreground shadow-floating outline-none max-sm:h-dvh max-sm:w-full max-sm:rounded-none"
        >
          {/* Unmounted with `open`, not after the close transition: the Files tab's editor takes the parked state over in the same commit. */}
          {open && (
            <FilesPanel
              surface="dialog"
              editors={store}
              client={client}
              status={status}
              cwd={cwd}
              onSend={onSend}
              onCopy={onCopy}
              onShowChanges={onShowChanges}
              repos={repos}
              onShowGraph={onShowGraph}
              onOpenInFiles={onOpenInFiles}
              onOpenTab={onOpenTab && ((p) => ((keepFocus.current = true), onOpenTab(p)))}
              onItem={onItem}
              showTree={showTree}
              onToggleTree={() => setShowTree((v) => !v)}
              gitStamp={gitStamp}
              headerEnd={<DialogClose />}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
