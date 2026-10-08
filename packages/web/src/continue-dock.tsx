// Scheduled continue after a usage limit (GH-164): composer dock above the prompt box, OpenCode followup-dock anatomy like the external-turn dock.
import { TimerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clockText } from "./plan-meter.tsx";

export function ContinueDock({ at, onCancel }: { at: number; onCancel: () => void }) {
  return (
    <div role="status" data-testid="auto-continue" className="flex min-h-[42px] w-full items-center gap-2 rounded-xl border-[0.5px] bg-muted py-1 pr-1 pl-4 text-sm">
      <TimerIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">Continuing at {clockText(at)} after the usage limit resets</span>
      <Button variant="ghost" size="sm" onClick={onCancel} aria-label="Cancel automatic continue" data-testid="auto-continue-cancel" className="max-md:min-h-11 max-md:min-w-11">
        Cancel
      </Button>
    </div>
  );
}
