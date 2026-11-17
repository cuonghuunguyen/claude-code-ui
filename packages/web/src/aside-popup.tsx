// Floating Aside popup (docs/spec.md "Aside"): non-modal window over the owner session; full screen on a phone.
import { MinusIcon, XIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clampRect, resizeRect, type Rect, type ResizeEdge } from "./aside.ts";
import { usePhone } from "./lib/use-narrow.ts";
import { useT } from "./i18n.ts";

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

/** Resize handles: 6 px strips on the edges, 12 px squares on the corners (corners last: on top). */
const EDGES: [ResizeEdge, string][] = [
  ["n", "inset-x-0 top-0 h-1.5 cursor-ns-resize"],
  ["s", "inset-x-0 bottom-0 h-1.5 cursor-ns-resize"],
  ["e", "inset-y-0 right-0 w-1.5 cursor-ew-resize"],
  ["w", "inset-y-0 left-0 w-1.5 cursor-ew-resize"],
  ["nw", "top-0 left-0 size-3 cursor-nwse-resize"],
  ["se", "right-0 bottom-0 size-3 cursor-nwse-resize"],
  ["ne", "top-0 right-0 size-3 cursor-nesw-resize"],
  ["sw", "bottom-0 left-0 size-3 cursor-nesw-resize"],
];

const viewport = () => ({ w: window.innerWidth, h: window.innerHeight });

export function AsidePopup({ title, readOnly, minimized, rect, index, id, onRect, onMinimize, onRestore, onClose, onKeep, onFocus, children }: Props) {
  const t = useT();
  const phone = usePhone();
  const section = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; from: Rect }>(undefined);
  const resize = useRef<{ x: number; y: number; from: Rect; edge: ResizeEdge }>(undefined);
  if (minimized)
    return (
      <Button type="button" variant="secondary" size="sm" data-aside-chip data-aside-id={id} className="fixed right-3 z-40 max-w-64 max-md:h-11" style={{ bottom: 12 + index * 40 }} onClick={onRestore}>
        <span className="truncate">{t("session.asidePopup.title", { title })}</span>
      </Button>
    );
  const btn = "max-md:size-11";
  return (
    <section
      ref={section}
      role="dialog"
      aria-modal="false"
      aria-label={t("session.asidePopup.title", { title })}
      data-aside-popup
      data-aside-id={id}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
      className={phone ? "fixed inset-0 z-40 flex flex-col overflow-hidden bg-background" : "fixed z-40 flex min-h-60 min-w-80 flex-col overflow-hidden rounded-lg border bg-background shadow-lg"}
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
        <span className="min-w-0 flex-1 truncate font-medium text-sm max-md:basis-full">{t("session.asidePopup.title", { title })}</span>
        {readOnly && <Badge variant="secondary">{t("session.asidePopup.readOnly")}</Badge>}
        <Button type="button" variant="secondary" size="sm" className="max-md:ml-auto max-md:h-11" onClick={onKeep}>
          {t("session.asidePopup.keep")}
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" className={btn} aria-label={t("session.asidePopup.minimizeLabel")} title={t("session.asidePopup.minimize")} onClick={onMinimize}>
          <MinusIcon />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" className={btn} aria-label={t("session.asidePopup.closeLabel")} title={t("session.asidePopup.close")} onClick={onClose}>
          <XIcon />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      {!phone &&
        EDGES.map(([edge, cls]) => (
          <div
            key={edge}
            aria-hidden
            data-aside-resize={edge}
            className={`absolute z-10 touch-none ${cls}`}
            onPointerDown={(e) => {
              e.preventDefault();
              resize.current = { x: e.clientX, y: e.clientY, from: rect, edge };
              (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              const r = resize.current;
              if (r) onRect(resizeRect(r.from, r.edge, e.clientX - r.x, e.clientY - r.y));
            }}
            onPointerUp={() => (resize.current = undefined)}
            onPointerCancel={() => (resize.current = undefined)}
          />
        ))}
    </section>
  );
}
