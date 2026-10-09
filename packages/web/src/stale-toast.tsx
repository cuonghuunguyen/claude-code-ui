// "Daemon runs older code" notice (docs/spec.md "Updates"): the daemon sent `daemon_stale` on connect, so tools or permission
// modes the user expects may be missing until it restarts. Persistent until dismissed (per page load); the user restarts the daemon.
import { TriangleAlertIcon } from "lucide-react";
import { TOAST_CARD } from "./toast.tsx";

export function StaleToast({ note, onDismiss }: { note: string; onDismiss: () => void }) {
  return (
    <div role="status" data-testid="stale-toast" className={`${TOAST_CARD} flex items-start gap-2.5`}>
      <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="truncate text-[13px] leading-5 font-medium">The daemon runs older code</p>
        <p className="text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">{note}</p>
        <div className="mt-2 flex flex-wrap gap-4">
          <button
            type="button"
            onClick={onDismiss}
            className="cursor-pointer rounded-sm text-[13px] leading-5 font-medium text-foreground outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-info pointer-coarse:min-h-11"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
