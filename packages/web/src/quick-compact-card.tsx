// The first message of a quick-compacted session (docs/spec.md "Quick compact"): the digest folded in a card with a link to the source session.
import { createContext, useContext, useState } from "react";
import { quickCompactOf } from "@claude-ui/protocol";
import { ChevronDownIcon, ChevronRightIcon, ScrollTextIcon } from "lucide-react";
import { useT } from "./i18n.ts";

/** What the card needs of the app: opening the source session and its title (from the session list). */
export type QuickCompactSource = { open: (id: string) => void; title: (id: string) => string | undefined };
export const QuickCompactSourceContext = createContext<QuickCompactSource | undefined>(undefined);

export function QuickCompactCard({ text }: { text: string }) {
  const t = useT();
  const source = useContext(QuickCompactSourceContext);
  const [shown, setShown] = useState(false);
  const info = quickCompactOf(text);
  if (!info) return null;
  const title = source?.title(info.sourceId) ?? info.sourceId;
  return (
    <div className="my-3 rounded-lg border bg-card text-card-foreground text-sm" data-testid="quick-compact-card">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2">
        <ScrollTextIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">{t("app.quickCompact.label")}</span>
        <button type="button" className="min-w-0 cursor-pointer truncate text-primary underline-offset-2 hover:underline max-md:min-h-11" onClick={() => source?.open(info.sourceId)} data-testid="quick-compact-source">
          {t("app.quickCompact.from", { title })}
        </button>
        <span className="text-muted-foreground text-xs">{t("app.quickCompact.tokens", { n: Math.round(text.length / 4) })}</span>
        {info.summarised && <span className="text-muted-foreground text-xs">{t("app.quickCompact.summarised")}</span>}
        <button
          type="button"
          className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-2 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:min-h-11"
          aria-expanded={shown}
          onClick={() => setShown((v) => !v)}
          data-testid="quick-compact-toggle"
        >
          {shown ? <ChevronDownIcon className="size-3.5" aria-hidden /> : <ChevronRightIcon className="size-3.5" aria-hidden />}
          {t(shown ? "app.quickCompact.hide" : "app.quickCompact.show")}
        </button>
      </div>
      {shown && <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap border-t px-3 py-2 text-xs [overflow-wrap:anywhere]" data-testid="quick-compact-text">{text}</pre>}
    </div>
  );
}
