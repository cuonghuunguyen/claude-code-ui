// GH-722: the one-time Local history hint in the confirm of Reset hard, stash drop and rollback (recommendation `localHistory`, inline).
import { useEffect, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { t, useT } from "./i18n.ts";
import { offer } from "./recommendations.ts";

/** `trigger`: the confirm shows the replacing action; `open`: the dialog is open (closing clears the hint). Returns the hint to render as a child of the dialog. */
export function useLocalHistoryHint(trigger: boolean, open: boolean): ReactNode {
  useT();
  const [hint, setHint] = useState(false);
  useEffect(() => {
    if (!open) setHint(false);
    else if (trigger && offer("localHistory", {})) setHint(true);
  }, [trigger, open]);
  if (!hint) return null;
  return (
    <p className="flex items-center gap-2 text-sm" data-testid="rec-local-history">
      <span className="min-w-0 flex-1">{t("rec.localHistory")}</span>
      <button type="button" onClick={() => setHint(false)} aria-label={t("app.toast.dismiss")} className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:size-11" data-testid="rec-local-history-close">
        <XIcon className="size-4" aria-hidden />
      </button>
    </p>
  );
}
