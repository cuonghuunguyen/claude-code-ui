// Signal only (GH-159): the folded row of a run of tool cards.
import type { ReactNode } from "react";
import { Tool, ToolChevron, ToolContent, toolRowClass } from "@/components/ai-elements/tool";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { foldLabel } from "./signal.ts";
import type { ToolCall } from "./store.ts";
import { useExpanded } from "./tool-card.tsx";

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
