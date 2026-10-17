// File dialog: the Files tab (tree, tabs, editor) in a large modal over the same editor store (docs/spec.md "Session view UX › File dialog").
// Opened by Pop out and from the timeline (Read cards, file references). Esc or Close closes it; focus is trapped and returns to the opener.
import { useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { connect, ConnectionStatus } from "./client.ts";
import type { EditorStore } from "./editor-store.ts";
import { shownPrompt } from "./config-dialog.tsx";
import { FilesPanel } from "./files-panel.tsx";
import { trapTab } from "./focus-trap.ts";
import { DialogClose } from "./viewer-dialog.tsx";

type Client = ReturnType<typeof connect>;

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
  onOpenInFiles,
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
  /** Open in editor: close the dialog and show the Files tab. */
  onOpenInFiles: () => void;
}) {
  // App clears the opener with the dialog, and Base UI asks finalFocus after that render.
  const lastOpener = useRef(opener);
  if (open) lastOpener.current = opener;
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
          finalFocus={() => (lastOpener.current?.isConnected ? lastOpener.current : (shownPrompt() ?? true))}
          onKeyDown={trapTab}
          // App shortcuts and Esc (stop turn) skip while an aria-modal dialog shows; Base UI does not set it.
          aria-modal="true"
          aria-label="Files"
          data-testid="file-dialog"
          className="fixed inset-0 z-50 m-auto flex h-[min(100dvh-32px,90dvh)] w-[min(100vw-32px,1200px)] flex-col overflow-hidden rounded-xl bg-card text-foreground shadow-floating outline-none max-sm:h-dvh max-sm:w-full max-sm:rounded-none"
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
              onOpenInFiles={onOpenInFiles}
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
