import { Suspense, useState, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The frame of ConfigDialog (config-dialog.tsx: backdrop, panel size and position) with skeleton rows, shown while the
 * chunk of a lazy dialog loads: the panel is already at its final size when the dialog's own content replaces it.
 */
export function DialogFallback({ size = "config" }: { size?: "config" | "settings" | "worktree" | "cleanup" | "large" }) {
  const box =
    size === "large"
      ? // ViewerDialog and FileDialog.
        "fixed inset-0 z-50 m-auto flex h-[min(100dvh-32px,90dvh)] w-[min(100vw-32px,1200px)] flex-col overflow-hidden rounded-2xl border bg-card shadow-floating max-sm:h-dvh max-sm:w-full max-sm:rounded-none"
      : size === "cleanup"
        ? "-translate-x-1/2 fixed top-[max(48px,calc((100dvh-640px)/2))] left-1/2 z-50 flex max-h-[min(100dvh-96px,640px)] w-[min(100vw-24px,720px)] flex-col rounded-2xl border bg-card shadow-floating max-sm:top-0 max-sm:h-dvh max-sm:w-full max-sm:rounded-none"
        : `-translate-x-1/2 fixed top-[max(48px,calc((100dvh-560px)/2))] left-1/2 z-50 flex max-h-[min(100dvh-96px,560px)] w-[min(100vw-24px,640px)] flex-col rounded-2xl border bg-card shadow-floating max-sm:top-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:rounded-none${size === "worktree" ? " sm:h-[408px]" : size === "settings" ? " sm:h-[546px]" : ""}`;
  return (
    <>
      <div className="fixed inset-0 z-50 bg-overlay" />
      <div aria-hidden="true" data-testid="dialog-skeleton" className={box}>
        <div className="py-3 pr-2 pl-4"><Skeleton className="h-5 w-40" /></div>
        <div className="flex flex-col gap-3 px-4 pt-1">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-3/4" />
        </div>
      </div>
    </>
  );
}

/**
 * A lazy dialog, mounted from its first open on (it stays mounted after, so its close animation and state are kept): until then
 * its chunk is not fetched. `open` false before the first open renders nothing.
 */
export function OnFirstOpen({ open, children, fallback = <DialogFallback /> }: { open: boolean; children: ReactNode; fallback?: ReactNode }) {
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return seen ? <Suspense fallback={open ? fallback : null}>{children}</Suspense> : null;
}

/** Fallback of a lazy pane (Files, Changes, Artifacts, the pairing form): fills the pane's flex slot with skeleton rows, so the pane does not resize when its content arrives. */
export function PaneFallback() {
  return (
    <div aria-hidden="true" data-testid="pane-skeleton" className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
