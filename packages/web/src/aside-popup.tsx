// Floating Aside popup (docs/spec.md "Aside"): non-modal window over the owner session; full screen on a phone.
import { MinusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clampRect, type Rect } from "./aside.ts";
import { usePhone } from "./lib/use-narrow.ts";

type Props = {
  title: string;
  readOnly: boolean;
  minimized: boolean;
  rect: Rect;
  /** Stacking index: chips of minimized popups stack by it. */
  index: number;
  id: string;
  onRect: (r: Rect) => void;
  onMinimize: () => void;
  onRestore: () => void;
  onClose: () => void;
  onKeep: () => void;
  /** Pointer or focus entered the popup: raise it and make it the one Esc applies to. */
  onFocus: () => void;
  children: ReactNode;
};

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

export function AsidePopup({ title, readOnly, minimized, rect, index, id, onRect, onMinimize, onRestore, onClose, onKeep, onFocus, children }: Props) {
  const phone = usePhone();
  const section = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; from: Rect }>(undefined);
  const latest = useRef({ rect, onRect });
  latest.current = { rect, onRect };
  // Native `resize: both` changes the size; the observer keeps it in state so it survives a re-render.
  useEffect(() => {
    const el = section.current;
    if (!el || phone || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const { rect: r, onRect: set } = latest.current;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (w && h && (Math.abs(w - r.w) > 1 || Math.abs(h - r.h) > 1)) set({ ...r, w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [phone, minimized]);
  if (minimized)
    return (
      <Button type="button" variant="secondary" size="sm" data-aside-chip data-aside-id={id} className="fixed right-3 z-40 max-w-64 max-md:h-11" style={{ bottom: 12 + index * 40 }} onClick={onRestore}>
        <span className="truncate">Aside: {title}</span>
      </Button>
    );
  const btn = "max-md:size-11";
  return (
    <section
      ref={section}
      role="dialog"
      aria-modal="false"
      aria-label={`Aside: ${title}`}
      data-aside-popup
      data-aside-id={id}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
      className={phone ? "fixed inset-0 z-40 flex flex-col overflow-hidden bg-background" : "fixed z-40 flex min-h-60 min-w-80 resize flex-col overflow-hidden rounded-lg border bg-background shadow-lg"}
      style={phone ? undefined : { left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <header
        className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 max-md:flex-wrap ${phone ? "" : "cursor-move touch-none select-none"}`}
        data-aside-handle
        onPointerDown={(e) => {
          if (phone || (e.target as Element).closest("button")) return;
          drag.current = { x: e.clientX, y: e.clientY, from: rect };
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) onRect(clampRect({ ...d.from, x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }, viewport()));
        }}
        onPointerUp={() => (drag.current = undefined)}
        onPointerCancel={() => (drag.current = undefined)}
      >
        <span className="min-w-0 flex-1 truncate font-medium text-sm max-md:basis-full">Aside: {title}</span>
        {readOnly && <Badge variant="secondary">Read-only</Badge>}
        <Button type="button" variant="secondary" size="sm" className="max-md:ml-auto max-md:h-11" onClick={onKeep}>
          Keep as session
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" className={btn} aria-label="Minimize aside" title="Minimize" onClick={onMinimize}>
          <MinusIcon />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" className={btn} aria-label="Close aside" title="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
    </section>
  );
}
