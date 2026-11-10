// The retry line (GH-683): while OpenCode waits to retry a failed model call it takes the place of the Thinking row: why it failed, and a countdown to the next try.
import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "./i18n.ts";

/** Whole seconds to `next` (rounded up, so "1s" shows until it starts), or "now" when it is due or unknown. */
export function retryCountdown(next: number | undefined, now: number): { seconds: number } | "now" {
  if (next === undefined) return "now";
  const seconds = Math.ceil((next - now) / 1000);
  return seconds > 0 ? { seconds } : "now";
}

/** 4 -> "4s", 65 -> "1m 05s", 3720 -> "1h 02m". */
export function retryTime(seconds: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${pad(Math.floor((seconds % 3600) / 60))}m`;
}

/** Re-renders each second while `on`. */
function useSecond(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

export function RetryRow({ retry, className }: { retry: { attempt: number; message: string; next?: number }; className?: string }) {
  const tr = useT();
  const left = retryCountdown(retry.next, useSecond(retry.next !== undefined));
  const countdown = left === "now" ? tr("app.timeline.retryNow", { attempt: retry.attempt }) : tr("app.timeline.retryIn", { time: retryTime(left.seconds), attempt: retry.attempt });
  return (
    // A screen reader hears each attempt once (the sr-only text); the ticking line is for the eyes.
    <div role="status" data-testid="retry-status" className={`space-y-0.5 ${className ?? ""}`}>
      <span className="sr-only">{tr("app.timeline.retrySr", { attempt: retry.attempt, message: retry.message })}</span>
      <div aria-hidden="true" className="flex items-start gap-1.5 text-warning text-xs">
        <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
        <span data-testid="retry-reason" title={retry.message} className="line-clamp-3 min-w-0 [overflow-wrap:anywhere]">
          {retry.message}
        </span>
      </div>
      <div aria-hidden="true" data-testid="retry-countdown" className="pl-5 text-muted-foreground text-xs tabular-nums">
        {countdown}
      </div>
    </div>
  );
}
