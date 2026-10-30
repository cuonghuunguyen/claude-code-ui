// Settings > Help & about (docs/spec.md "First-use guide"): per browser, nothing here reaches the daemon.
import { Button } from "@/components/ui/button";
import { useT } from "./i18n.ts";

export function GuideSection({ onRestart }: { onRestart: () => void }) {
  const t = useT();
  return (
    <section aria-labelledby="settings-guide" className="flex flex-col" data-testid="settings-guide">
      <h3 id="settings-guide" className="pb-1 font-medium text-[13px] text-muted-foreground">
        {t("guide.title")}
      </h3>
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-guide-tour-label" className="block text-sm">{t("guide.tour")}</span>
          <span id="settings-guide-tour-hint" className="block text-muted-foreground text-xs">{t("guide.tourHint")}</span>
        </div>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={onRestart} aria-describedby="settings-guide-tour-hint" data-testid="settings-guide-restart">
          {t("guide.restart")}
        </Button>
      </div>
    </section>
  );
}
