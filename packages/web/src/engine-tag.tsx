import type { Engine } from "@claude-ui/protocol";
import { SparklesIcon, SquareTerminalIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Product names: not translated. */
export const ENGINE_NAME: Record<Engine, string> = { claude: "Claude", opencode: "OpenCode" };
export const ENGINE_ICON = { claude: SparklesIcon, opencode: SquareTerminalIcon } satisfies Record<Engine, unknown>;

/** The Engine a session runs on (absent = claude): static, icon shape and text tell it apart, never color. */
export function EngineTag({ engine = "claude" }: { engine?: Engine }) {
  const Icon = ENGINE_ICON[engine];
  return (
    <Badge variant="outline" className="whitespace-nowrap text-muted-foreground" data-testid="engine-tag" data-engine={engine}>
      <Icon aria-hidden />
      {ENGINE_NAME[engine]}
    </Badge>
  );
}
