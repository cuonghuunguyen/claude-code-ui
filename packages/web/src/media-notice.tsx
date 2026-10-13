// What an image a snapshot or page left out shows while it loads and when the load failed (GH-274).
import { cn } from "@/lib/utils";

/** A box of fixed size, so the layout does not jump when the image arrives: "Loading image", or the failure notice with Retry. */
export function MediaPlaceholder({ failed, retry, label, className }: { failed: boolean; retry: () => void; label: string; className: string }) {
  return (
    <div
      data-testid="media-placeholder"
      role="group"
      aria-busy={!failed}
      aria-label={label}
      className={cn("flex flex-col items-center justify-center gap-2 rounded-md border bg-muted p-2 text-center text-muted-foreground text-xs", className)}
    >
      {failed ? (
        <>
          <span role="alert">Image could not be loaded</span>
          <button
            type="button"
            aria-label={`Retry loading ${label}`}
            onClick={retry}
            className="min-h-11 rounded-md border bg-background px-3 text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring md:min-h-7"
          >
            Retry
          </button>
        </>
      ) : (
        <span>Loading image</span>
      )}
    </div>
  );
}
