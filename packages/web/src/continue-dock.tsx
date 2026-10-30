// Scheduled continue after a usage limit (GH-164): composer dock above the prompt box, OpenCode followup-dock anatomy like the external-turn dock.
import { TimerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clockText } from "./plan-meter.tsx";
import { useT } from "./i18n.ts";

export function ContinueDock({ at, onCancel }: { at: number; onCancel: () => void }) {
  const t = useT();
  return (
    <div role="status" data-testid="auto-continue" className="flex min-h-[42px] w-full items-center gap-2 rounded-xl border-[0.5px] bg-muted py-1 pr-1 pl-4 text-sm">
      <TimerIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">{t("session.continueDock.text", { time: clockText(at) })}</span>
      <Button variant="ghost" size="sm" onClick={onCancel} aria-label={t("session.continueDock.cancelLabel")} data-testid="auto-continue-cancel" className="max-md:min-h-11 max-md:min-w-11">
        {t("session.continueDock.cancel")}
      </Button>
    </div>
  );
}
