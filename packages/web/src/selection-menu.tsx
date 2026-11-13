import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useT } from "./i18n.ts";
import { menuPosition } from "./selection-menu.ts";

export type SelectionAction = { id: string; label: string; icon: ReactNode; title?: string; disabled?: boolean; onSelect: () => void };

const same = (a?: DOMRect, b?: DOMRect) => a === b || (!!a && !!b && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height);

/**
 * Floating menu next to a selection (a Quote-style button row). It knows nothing about the selection source: the caller shows it while a selection exists,
 * supplies the anchor rect and the actions, and drops it on `onDismiss` (Escape, a pointerdown outside, focus leaving the source, the scroll in "hide" mode, an action).
 */
export function SelectionMenu({ anchor, actions, source, onDismiss, onScroll = "follow", testId = "selection-menu" }: {
  /** Re-read on every render, scroll and resize; undefined hides the menu (anchor outside the visible area). */
  anchor: () => DOMRect | undefined;
  actions: SelectionAction[];
  /** The element holding the selection: Escape and focus inside it do not dismiss the menu. */
  source: () => Element | null;
  onDismiss: () => void;
  /** "hide": any scroll dismisses. "follow": the menu moves with the anchor. */
  onScroll?: "hide" | "follow";
  testId?: string;
}) {
  const t = useT();
  const [rect, setRect] = useState<DOMRect | undefined>(anchor);
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const live = useRef({ anchor, source, onDismiss });
  live.current = { anchor, source, onDismiss };
  useLayoutEffect(() => {
    const next = anchor();
    setRect((r) => (same(r, next) ? r : next));
    setWidth(root.current?.offsetWidth ?? 0);
  });
  useEffect(() => {
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = live.current.anchor();
        setRect((r) => (same(r, next) ? r : next));
      });
    };
    const scroll = () => (onScroll === "hide" ? live.current.onDismiss() : update());
    // Escape stops the turn only from the body or the source; elsewhere (dialog, prompt box) it keeps its own meaning.
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const f = document.activeElement;
      if (!f || f === document.body || live.current.source()?.contains(f) || root.current?.contains(f)) e.preventDefault();
      live.current.onDismiss();
    };
    const inside = (e: Event) => {
      const el = e.target instanceof Element ? e.target : null;
      return !!el && (!!root.current?.contains(el) || !!live.current.source()?.contains(el));
    };
    const down = (e: Event) => !root.current?.contains(e.target as Node | null) && live.current.onDismiss();
    const focus = (e: Event) => !inside(e) && live.current.onDismiss();
    document.addEventListener("scroll", scroll, { capture: true, passive: true });
    window.addEventListener("resize", update);
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("focusin", focus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", update);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("focusin", focus);
    };
  }, [onScroll]);
  if (!rect) return null;
  const coarse = !!window.matchMedia?.("(pointer: coarse)").matches;
  const place = menuPosition(rect, { width: window.innerWidth, height: window.innerHeight }, coarse, width);
  return createPortal(
    <div
      ref={root}
      role="toolbar"
      aria-label={t("common.selection.label")}
      data-testid={testId}
      className={`fixed z-50 flex rounded-lg bg-popover p-0.5 shadow-md ring-1 ring-border ${coarse ? "gap-2" : "gap-0.5"}`}
      style={place}
    >
      {actions.map((a) => (
        <Button
          key={a.id}
          size="sm"
          variant="secondary"
          title={a.title}
          disabled={a.disabled}
          data-testid={`${testId}-${a.id}`}
          className={`pointer-coarse:min-h-11 ${coarse ? "min-h-11 px-4" : ""}`}
          // The editor keeps focus and the selection stays visible.
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (a.onSelect(), live.current.onDismiss())}
        >
          {a.icon}
          {a.label}
        </Button>
      ))}
    </div>,
    document.body,
  );
}

/**
 * `shown` turns true `ms` after `key` last changed while `active` (a drag does not flash the menu); `dismiss` hides it until the key changes again; `show` brings it back at once.
 */
export function useMenuGate(key: string, active: boolean, ms = 150) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(false);
    if (!active) return;
    const id = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(id);
  }, [key, active, ms]);
  return [shown && active, () => setShown(false), () => setShown(true)] as const;
}
