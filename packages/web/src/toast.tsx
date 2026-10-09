// One toast like OpenCode's toast-v2 in the corner region: bottom right (32px / 48px), 320px wide, 12px padding, radius 8, floating shadow, gone after 5 s.
// At 600px and below it is full width (16px offsets). It slides in and out (280ms transform, 160ms opacity; none under reduced motion).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";

/** Surface of a toast (Toast, UpdateToast, StaleToast, the notification card); the ToastRegion places it. */
export const TOAST_CARD = "pointer-events-auto rounded-lg bg-card p-3 text-foreground shadow-floating";

/** The one corner every toast stacks in (first child nearest the corner), so two at once never cover each other. Clicks pass through the gaps. */
export function ToastRegion({ children }: { children?: ReactNode }) {
  return (
    <div data-testid="toast-region" className="pointer-events-none fixed right-4 bottom-4 z-1000 flex w-[calc(100vw-2rem)] flex-col-reverse gap-2 min-[601px]:right-8 min-[601px]:bottom-12 min-[601px]:w-80">
      {children}
    </div>
  );
}

export function Toast({ message, action, onClose }: { message: string; /** A text button after the message (Undo); it runs, then the toast goes. */ action?: { label: string; onClick: () => void }; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  const exit = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A toast that is replaced while it leaves must not close its successor.
  useEffect(() => () => clearTimeout(exit.current), []);
  // Out: wait for the exit transition (none under reduced motion) before the owner drops the toast.
  const close = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return onClose();
    setOpen(false);
    exit.current = setTimeout(onClose, 280);
  };
  useEffect(() => {
    const show = setTimeout(() => setOpen(true), 16);
    const hide = setTimeout(close, 5000);
    return () => (clearTimeout(show), clearTimeout(hide));
  }, [message]);
  return (
    <div
      role="status"
      data-testid="toast"
      data-state={open ? "open" : "closed"}
      className={`${TOAST_CARD} grid grid-cols-[minmax(0,1fr)_20px] gap-3 transition-[transform,opacity] duration-[280ms,160ms] ease-[cubic-bezier(0.2,0,0,1),ease-out] data-[state=closed]:translate-y-4 data-[state=closed]:opacity-0 motion-reduce:transition-none`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3">
        <p className="min-w-0 break-words text-[13px] leading-5 font-medium tracking-[-0.04px]">{message}</p>
        {action && (
          <button
            type="button"
            onClick={() => (action.onClick(), close())}
            className="cursor-pointer rounded-sm px-1 text-[13px] leading-5 font-medium text-info outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-info pointer-coarse:min-h-11"
          >
            {action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={close}
        className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-info pointer-coarse:-m-3 pointer-coarse:size-11"
      >
        <XIcon className="size-4" />
      </button>
    </div>
  );
}
