// One toast like OpenCode's toast-v2: bottom right (32px / 48px), 320px wide, 12px padding, radius 8, floating shadow, gone after 5 s.
// At 600px and below it is full width (16px offsets). It slides in and out (280ms transform, 160ms opacity; none under reduced motion).
import { useEffect, useState } from "react";
import { XIcon } from "lucide-react";

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  const [open, setOpen] = useState(false);
  // Out: wait for the exit transition (none under reduced motion) before the owner drops the toast.
  const close = () => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return onClose();
    setOpen(false);
    setTimeout(onClose, 280);
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
      className="fixed right-4 bottom-4 z-1000 grid w-[calc(100vw-2rem)] grid-cols-[minmax(0,1fr)_20px] gap-3 rounded-lg bg-card p-3 text-foreground shadow-floating transition-[transform,opacity] duration-[280ms,160ms] ease-[cubic-bezier(0.2,0,0,1),ease-out] data-[state=closed]:translate-y-4 data-[state=closed]:opacity-0 motion-reduce:transition-none min-[601px]:right-8 min-[601px]:bottom-12 min-[601px]:w-80"
    >
      <p className="text-[13px] leading-5 font-medium tracking-[-0.04px]">{message}</p>
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
