import { CoffeeIcon } from "lucide-react";
import { IconButton } from "./tabs-bar.tsx";
import { wakeLockReason, type KeepAwakeStatus } from "./keep-awake.ts";

/** The tooltip for each state; the accessible name stays fixed and `aria-pressed` carries the state. */
export function keepAwakeTitle(status: KeepAwakeStatus, error?: string): string {
  switch (status) {
    case "off":
      return "Screen may sleep";
    case "held":
      return "Keep screen awake";
    case "idle":
      return "Keep screen awake (waits for a running session)";
    case "hidden":
      return "Keep screen awake (resumes when the page is visible)";
    case "refused":
      return `Keep screen awake: the browser refused (${error ?? "error"}), e.g. battery saver. Retries when you return to the page.`;
    case "unsupported":
      return `Keep screen awake is not available here: ${wakeLockReason()}`;
  }
}

export function KeepAwakeButton({ status, error, onToggle, className, testId }: { status: KeepAwakeStatus; error?: string; onToggle: () => void; className?: string; testId: string }) {
  return (
    <IconButton className={className} label="Keep screen awake" title={keepAwakeTitle(status, error)} pressed={status !== "off" && status !== "unsupported"} disabled={status === "unsupported"} onClick={onToggle} testId={testId} command="awake.toggle">
      <CoffeeIcon className={status === "refused" ? "text-warning" : undefined} />
    </IconButton>
  );
}
