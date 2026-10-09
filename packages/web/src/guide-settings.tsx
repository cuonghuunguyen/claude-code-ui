// Settings > Guide (docs/spec.md "First-use guide"): per browser, nothing here reaches the daemon.
import { Button } from "@/components/ui/button";

export function GuideSection({ onRestart }: { onRestart: () => void }) {
  return (
    <section aria-labelledby="settings-guide" className="flex flex-col" data-testid="settings-guide">
      <h3 id="settings-guide" className="pb-1 font-medium text-[13px] text-muted-foreground">
        Guide
      </h3>
      <div className="flex items-center gap-3 border-t py-2 max-md:min-h-11">
        <div className="min-w-0 flex-1">
          <span id="settings-guide-tour-label" className="block text-sm">Guided tour</span>
          <span id="settings-guide-tour-hint" className="block text-muted-foreground text-xs">A short tour of projects, tabs, files, changes, git graph and terminal. Kept in this browser.</span>
        </div>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={onRestart} aria-describedby="settings-guide-tour-hint" data-testid="settings-guide-restart">
          Restart guide
        </Button>
      </div>
    </section>
  );
}
