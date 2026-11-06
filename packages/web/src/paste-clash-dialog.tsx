// "<name> already exists" while pasting (GH-555): Replace, Skip or Keep both, for this item or, with "Apply to all", for the rest.
import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Button } from "@/components/ui/button";
import { trapTab } from "./focus-trap.ts";
import { useT } from "./i18n.ts";
import type { Clash } from "./transfer.ts";

export type ClashAsk = { name: string; folder: string; remaining: number; answer: (choice: Clash, all: boolean) => void };

/** Escape and a click outside answer Skip; focus starts on Keep both (the choice that loses nothing). */
export function PasteClashDialog({ ask }: { ask?: ClashAsk }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => setAll(false), [ask]);
  const answer = (c: Clash) => ask?.answer(c, all && ask.remaining > 0);
  const btn = "cursor-pointer max-md:h-11";
  return (
    <AlertDialog.Root open={!!ask} onOpenChange={(o) => !o && answer("skip")}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-overlay transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <AlertDialog.Popup
          className="-translate-x-1/2 -translate-y-1/2 fixed top-1/2 left-1/2 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-2xl border bg-popover p-4 text-popover-foreground shadow-floating outline-none"
          onKeyDown={trapTab}
          initialFocus={keep}
          data-testid="paste-clash-dialog"
          aria-modal="true"
        >
          <AlertDialog.Title className="break-words font-medium text-[15px] tracking-[-0.13px] [overflow-wrap:anywhere]">{ask && t("files.paste.clashText", { name: ask.name, folder: ask.folder })}</AlertDialog.Title>
          {ask && ask.remaining > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} data-testid="paste-clash-all" />
              {t("files.paste.applyAll", { count: ask.remaining })}
            </label>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" className={btn} onClick={() => answer("skip")} data-testid="paste-clash-skip">
              {t("files.paste.skip")}
            </Button>
            <Button variant="destructive" className={btn} onClick={() => answer("replace")} data-testid="paste-clash-replace">
              {t("files.paste.replace")}
            </Button>
            <Button ref={keep} className={btn} onClick={() => answer("keep")} data-testid="paste-clash-keep">
              {t("files.paste.keepBoth")}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
