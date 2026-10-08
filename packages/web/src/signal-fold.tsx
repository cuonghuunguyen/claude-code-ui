// Signal only (GH-159): the header switch and the folded row of a run of tool cards.
import type { ReactNode } from "react";
import { Tool, ToolChevron, ToolContent, toolRowClass } from "@/components/ai-elements/tool";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { Switch } from "./plugins-dialog.tsx";
import { foldLabel } from "./signal.ts";
import type { ToolCall } from "./store.ts";
import { useExpanded } from "./tool-card.tsx";

/** "Signal only" with its key chip, in the session header. */
export function SignalSwitch({ on, onChange, keys }: { on: boolean; onChange: (on: boolean) => void; keys?: string }) {
  return (
    <label className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
      <span>Signal only</span>
      {keys && <kbd className="rounded border px-1 font-mono text-[10px]">{keys}</kbd>}
      <Switch on={on} label="Signal only" held={false} onToggle={onChange} title={on ? "Show every tool call" : "Fold tool calls into one line"} testId="signal-switch" />
    </label>
  );
}

/** A run of tool calls as one line; clicking it shows the cards in place. */
export function FoldRow({ id, calls, children }: { id: string; calls: ToolCall[]; children: ReactNode }) {
  return (
    <Tool data-testid="signal-fold" {...useExpanded(id)}>
      <CollapsibleTrigger className={toolRowClass}>
        <span className="truncate font-mono text-muted-foreground text-xs">{foldLabel(calls)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <ToolChevron />
        </span>
      </CollapsibleTrigger>
      <ToolContent className="space-y-1 pl-3">{children}</ToolContent>
    </Tool>
  );
}
