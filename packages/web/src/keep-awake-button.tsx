import { CoffeeIcon } from "lucide-react";
import { IconButton } from "./tabs-bar.tsx";
import { wakeLockReason, type KeepAwakeStatus } from "./keep-awake.ts";
import { t, useT } from "./i18n.ts";

/** The tooltip for each state; the accessible name stays fixed and `aria-pressed` carries the state. */
export function keepAwakeTitle(status: KeepAwakeStatus, error?: string): string {
  switch (status) {
    case "off":
      return t("awake.off");
    case "held":
    case "pending":
      return t("awake.label");
    case "idle":
      return t("awake.idle");
    case "hidden":
      return t("awake.hidden");
    case "refused":
      return t("awake.refused", { error: error ?? "error" });
    case "unsupported":
      return t("awake.unsupported", { reason: wakeLockReason() });
  }
}

export function KeepAwakeButton({ status, error, onToggle, className, testId }: { status: KeepAwakeStatus; error?: string; onToggle: () => void; className?: string; testId: string }) {
  const t = useT();
  return (
    <IconButton className={className} label={t("awake.label")} title={keepAwakeTitle(status, error)} pressed={status !== "off" && status !== "unsupported"} disabled={status === "unsupported"} onClick={onToggle} testId={testId} command="awake.toggle">
      <CoffeeIcon className={status === "refused" ? "text-warning" : undefined} />
    </IconButton>
  );
}
