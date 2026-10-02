// One toast like OpenCode's toast-v2: bottom right (32px / 48px), 320px wide, 12px padding, radius 8, floating shadow, gone after 5 s.
import { useEffect } from "react";
import { XIcon } from "lucide-react";

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 5000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  return (
    <div
      role="status"
      data-testid="toast"
      className="fixed right-4 bottom-4 z-1000 grid w-80 max-w-[calc(100vw-2rem)] grid-cols-[minmax(0,1fr)_20px] gap-3 rounded-lg bg-card p-3 text-foreground shadow-floating md:right-8 md:bottom-12"
    >
      <p className="text-[13px] leading-5 font-medium tracking-[-0.04px]">{message}</p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-info pointer-coarse:-m-3 pointer-coarse:size-11"
      >
        <XIcon className="size-4" />
      </button>
    </div>
  );
}
