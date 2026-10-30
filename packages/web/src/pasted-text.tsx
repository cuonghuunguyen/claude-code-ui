// Pasted text: prompt-box chips, a full-text viewer and the collapsed block in a user message (GH-441).
import { Dialog } from "@base-ui/react/dialog";
import { ChevronRightIcon, EyeIcon, FileTextIcon, XIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { trapTab } from "./focus-trap.ts";
import { t as tr, useT } from "./i18n.ts";
import { newlineCount, type Pastes, pasteRefs } from "./pasted-text.ts";

const BTN =
  "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-info pointer-coarse:size-11 max-md:size-11 [&_svg]:size-4";
const PRE = "m-0 overflow-auto whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]";

const lines = (body: string) => {
  const k = newlineCount(body);
  return k === 0 ? "" : tr("session.pasted.lines", { count: k });
};

function PasteViewer({ id, body }: { id: number; body: string }) {
  const t = useT();
  const title = `${t("session.pasted.title", { id })}${lines(body)}`;
  return (
    <Dialog.Root>
      <Dialog.Trigger aria-label={t("session.pasted.view", { id })} className={BTN}>
        <EyeIcon />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Popup
          onKeyDown={trapTab}
          aria-label={title}
          aria-modal="true"
          data-testid="paste-viewer"
          className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 flex w-[min(90vw,48rem)] flex-col gap-2 rounded-xl border bg-background p-3 outline-none"
        >
          <div className="flex items-center justify-between gap-2">
            <Dialog.Title className="font-medium text-sm">{title}</Dialog.Title>
            <Dialog.Close aria-label={t("session.pasted.close")} className={BTN}>
              <XIcon />
            </Dialog.Close>
          </div>
          <pre className={`${PRE} max-h-[80vh]`}>{body}</pre>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One chip per token present in `text`, in text order. */
export function PasteChips({ text, pastes, onRemove }: { text: string; pastes: Pastes; onRemove: (id: number) => void }) {
  const t = useT();
  const ids = pasteRefs(text)
    .map((r) => r.id)
    .filter((id, i, all) => pastes[id] !== undefined && all.indexOf(id) === i);
  if (!ids.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="paste-chips">
      {ids.map((id) => (
        <div key={id} data-testid="paste-chip" className="flex min-w-0 items-center gap-1 rounded-md bg-secondary pl-2 text-xs">
          <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{`${t("session.pasted.title", { id })}${lines(pastes[id])}`}</span>
          <PasteViewer id={id} body={pastes[id]} />
          <button type="button" aria-label={t("session.pasted.remove", { id })} className={BTN} onClick={() => onRemove(id)}>
            <XIcon />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Expanded blocks by id: the open state outlives a remount of the bubble (pending prompt replaced by its echo, a row scrolled out of the window). */
const expanded = new Set<string>();

/** Id of block `index` of a user message: its text, not the part id, because the pending bubble and its echo have different part ids and the same text. */
export function pastedBlockId(text: string, index: number): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) + text.charCodeAt(i)) | 0;
  return `${text.length}:${h >>> 0}:${index}`;
}

/** A pasted block inside a user message: collapsed, expands on click. `id`: pastedBlockId of the message and the block index. */
export function PastedBlock({ body, id }: { body: string; id: string }) {
  const t = useT();
  return (
    <Collapsible defaultOpen={expanded.has(id)} onOpenChange={(open) => void (open ? expanded.add(id) : expanded.delete(id))} className="my-1 w-full min-w-0 rounded-md border-[0.5px] bg-secondary text-sm">
      <CollapsibleTrigger
        data-testid="pasted-block"
        className="group flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-xs outline-none focus-visible:outline-2 focus-visible:outline-info pointer-coarse:min-h-11 max-md:min-h-11"
      >
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90" />
        <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span>{`${t("session.pasted.titleNoId")}${lines(body)}`}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre data-testid="pasted-block-body" className={`${PRE} max-h-96 border-t px-2 py-1.5`}>
          {body}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
