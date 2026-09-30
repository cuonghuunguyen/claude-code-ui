// Rewind menu of a user message: Claude Code `/rewind` modes, code ones only when the checkpoint has tracked file changes.
import type { RewindMode, RewindPreview } from "@claude-ui/protocol";

export function rewindOptions(p: RewindPreview): { mode: RewindMode; label: string }[] {
  const code = p.filesChanged.length > 0;
  return [
    ...(code && p.conversation ? [{ mode: "both" as const, label: "Restore code and conversation" }] : []),
    ...(p.conversation ? [{ mode: "conversation" as const, label: "Restore conversation" }] : []),
    ...(code ? [{ mode: "code" as const, label: "Restore code" }] : []),
  ];
}
