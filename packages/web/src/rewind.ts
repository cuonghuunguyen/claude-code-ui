// Rewind menu of a user message: Claude Code `/rewind` modes, code ones only when the checkpoint has tracked file changes.
import type { RewindMode, RewindPreview } from "@claude-ui/protocol";
import { t } from "./i18n.ts";

export function rewindOptions(p: RewindPreview): { mode: RewindMode; label: string }[] {
  const code = p.filesChanged.length > 0;
  return [
    ...(code && p.conversation ? [{ mode: "both" as const, label: t("session.rewind.both") }] : []),
    ...(p.conversation ? [{ mode: "conversation" as const, label: t("session.rewind.conversation") }] : []),
    ...(code ? [{ mode: "code" as const, label: t("session.rewind.code") }] : []),
  ];
}
