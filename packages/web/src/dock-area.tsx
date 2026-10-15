// Header and plumbing of a dock area (docs/spec.md "Layout", pane layout): pane tabs, area menu, stable pane hosts.
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AREA_LABEL, type DockArea, type DockSide, PANE_IDS, PANE_LABEL, type PaneId } from "./layout.ts";
import { ITEM, POPUP } from "./session-actions.tsx";

export const PANE_DRAG_TYPE = "application/x-claude-ui-pane";
/** Where a dragged pane would land: the end of `area`, or before the tab `before`. */
export type DropAt = { area: DockArea; before?: PaneId };
/** Only drags that carry a pane (a session tab's drag has another type). */
export const isPaneDrag = (e: { dataTransfer: DataTransfer | null }) => !!e.dataTransfer?.types.includes(PANE_DRAG_TYPE);
/** The pane a drop carries, when it is one. */
export const droppedPane = (e: { dataTransfer: DataTransfer | null }): PaneId | undefined => {
  const p = e.dataTransfer?.getData(PANE_DRAG_TYPE) as PaneId;
  return PANE_IDS.includes(p) ? p : undefined;
};

type DropHandlers = { over: (e: DragEvent) => void; leave: (e: DragEvent) => void; drop: (e: DragEvent) => void };
/**
 * Ref callback for an area section: native listeners, because React events from the pane contents (portaled into a host
 * that sits in this section's DOM) bubble to the portal's React parent, not to the section. Drags over a pane tab are the tab's.
 */
export function useAreaDrop(on: DropHandlers) {
  const latest = useRef(on);
  latest.current = on;
  return useCallback((n: HTMLElement | null) => {
    if (!n) return;
    const f = (k: keyof DropHandlers) => (e: Event) => !(e.target as Element).closest?.("[data-pane-tab]") && latest.current[k](e as DragEvent);
    const fs = { dragover: f("over"), dragleave: f("leave"), drop: f("drop") };
    for (const [t, h] of Object.entries(fs)) n.addEventListener(t, h);
    return () => {
      for (const [t, h] of Object.entries(fs)) n.removeEventListener(t, h);
    };
  }, []);
}

/** Menus opened from the keyboard (Enter, Space, Shift+F10) put the focus on the first item, so Enter works at once. */
function useKeyboardOpen() {
  const kb = useRef(false);
  const popup = useRef<HTMLDivElement | null>(null);
  // Shift+F10 / the Menu key: browsers differ in the contextmenu event they send after it (button, coordinates), so the key itself is the sign.
  const hint = useRef(false);
  return {
    popup,
    /** Spread on the element the menu opens from. */
    trigger: {
      onKeyDown: (e: { key: string; shiftKey: boolean }) => void (hint.current = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)),
      onPointerDown: () => void (hint.current = false),
    },
    root: {
      onOpenChange: (open: boolean, details: { event: Event }) => {
        const e = details.event as MouseEvent;
        kb.current = open && (hint.current || e.type === "keydown" || (e.type === "click" && e.detail === 0) || (e.type === "contextmenu" && e.button === 0));
      },
      onOpenChangeComplete: (open: boolean) => {
        const first = () => popup.current?.querySelector<HTMLElement>('[role="menuitem"]');
        if (open && kb.current) {
          first()?.focus();
          // The focus manager may put the focus on the popup after this; take it back once.
          requestAnimationFrame(() => document.activeElement !== first() && popup.current?.contains(document.activeElement) !== false && first()?.focus());
        }
        kb.current = false;
        hint.current = false;
      },
    },
  };
}

/** One stable element per pane: its content is portaled into it once and the element moves between slots, so a move never remounts the pane. */
export function usePaneHosts(): Record<PaneId, HTMLDivElement> {
  const [hosts] = useState(() =>
    Object.fromEntries(
      PANE_IDS.map((p) => {
        const d = document.createElement("div");
        d.style.display = "contents";
        d.dataset.paneHost = p;
        return [p, d];
      }),
    ),
  ) as [Record<PaneId, HTMLDivElement>, unknown];
  return hosts;
}

/** Empty element that holds the pane's host while it is rendered (React never renders children into it). */
export function PaneSlot({ host }: { host: HTMLElement }) {
  return <div className="contents" ref={(n) => void (n && host.parentNode !== n && n.appendChild(host))} />;
}

const MENU_BUTTON =
  "grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground pointer-coarse:size-11 [&_svg]:size-4";

/** Wide screens only (below lg the panes are the pane switcher). `extra`: area buttons left of the menu. */
export function DockHeader({
  area,
  panes,
  active,
  changes,
  side,
  onSelect,
  onMove,
  onFlipSide,
  onReset,
  extra,
  drag,
  dropAt,
  onDrag,
  onDropAt,
}: {
  area: DockArea;
  panes: PaneId[];
  active?: PaneId;
  changes: number;
  side?: DockSide;
  onSelect: (p: PaneId) => void;
  onMove: (p: PaneId, to: DockArea, before?: PaneId) => void;
  onFlipSide?: () => void;
  onReset: () => void;
  extra?: ReactNode;
  /** The pane being dragged, and where it would land (App state: browsers hide drag data until the drop). */
  drag?: PaneId;
  dropAt?: DropAt;
  onDrag: (p?: PaneId) => void;
  onDropAt: (d?: DropAt) => void;
}) {
  const other: DockArea = area === "side" ? "bottom" : "side";
  // A menu that moved a pane does not return the focus (Base UI `finalFocus` false): App focuses the moved tab once the move is
  // rendered. The menu's own return runs when its popup unmounts, which can be in the move's commit (the tab's context menu, or an
  // area that empties), before the moved tab exists; its fallback (the trigger, else an earlier focused element such as the
  // prompt box) would win over the moved tab.
  const moved = useRef(false);
  const finalFocus = () => !moved.current;
  const move = (p: PaneId) => ((moved.current = true), onMove(p, other));
  const ctxKb = useKeyboardOpen();
  const menuKb = useKeyboardOpen();
  // A menu that closes without a move returns the focus to its trigger: forget the previous move when one opens.
  const opening = (root: ReturnType<typeof useKeyboardOpen>["root"]) => ({ ...root, onOpenChange: (o: boolean, d: { event: Event }) => (o && (moved.current = false), root.onOpenChange(o, d)) });
  return (
    <div className="hidden items-center gap-1 border-b px-2 py-1 lg:flex">
      <div role="tablist" aria-label={AREA_LABEL[area]} className="flex min-w-0 gap-1 overflow-x-auto">
        {panes.map((p) => (
          <ContextMenu.Root key={p} {...opening(ctxKb.root)}>
            <ContextMenu.Trigger className="contents">
              <Button
                size="sm"
                variant={p === active ? "secondary" : "ghost"}
                className="pointer-coarse:h-11 relative data-drop-before:before:absolute data-drop-before:before:inset-y-1 data-drop-before:before:-left-1 data-drop-before:before:w-0.5 data-drop-before:before:rounded-full data-drop-before:before:bg-primary"
                draggable
                {...ctxKb.trigger}
                data-drop-before={drag && dropAt?.area === area && dropAt.before === p ? "" : undefined}
                // Dragging a tab onto another inserts before it; the area section ignores it (stopPropagation).
                onDragStart={(e) => {
                  e.dataTransfer.setData(PANE_DRAG_TYPE, p);
                  e.dataTransfer.effectAllowed = "move";
                  onDrag(p);
                }}
                onDragEnd={() => (onDrag(undefined), onDropAt(undefined))}
                onDragOver={(e) => {
                  if (!isPaneDrag(e)) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  if (dropAt?.area !== area || dropAt.before !== p) onDropAt({ area, before: p });
                }}
                onDrop={(e) => {
                  const d = droppedPane(e);
                  if (!d) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onDrag(undefined);
                  onDropAt(undefined);
                  onMove(d, area, p);
                }}
                role="tab"
                aria-selected={p === active}
                onClick={() => onSelect(p)}
                data-testid={`pane-${p}`}
                data-pane-tab={p}
                data-command={p === "files" || p === "changes" || p === "graph" ? `pane.${p}` : undefined}
              >
                {p}
                {p === "changes" && changes > 0 && <span className="text-muted-foreground tabular-nums">{changes}</span>}
              </Button>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Positioner className="z-50">
                <ContextMenu.Popup ref={ctxKb.popup} className={POPUP} finalFocus={finalFocus}>
                  <ContextMenu.Item className={ITEM} onClick={() => move(p)} data-testid="pane-move">
                    Move to {AREA_LABEL[other].toLowerCase()}
                  </ContextMenu.Item>
                  <ContextMenu.Item className={ITEM} onClick={onReset} data-testid="pane-reset">
                    Reset layout
                  </ContextMenu.Item>
                </ContextMenu.Popup>
              </ContextMenu.Positioner>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        ))}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {extra}
        <Menu.Root {...opening(menuKb.root)}>
          <Menu.Trigger aria-label={`${AREA_LABEL[area]} actions`} title={`${AREA_LABEL[area]} actions`} className={MENU_BUTTON} data-testid={`dock-menu-${area}`}>
            <EllipsisIcon aria-hidden />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="end" sideOffset={4} className="z-50">
              <Menu.Popup ref={menuKb.popup} className={POPUP} finalFocus={finalFocus}>
                {active && (
                  <Menu.Item className={ITEM} onClick={() => move(active)} data-testid="dock-move">
                    Move {PANE_LABEL[active]} to {AREA_LABEL[other].toLowerCase()}
                  </Menu.Item>
                )}
                {area === "side" && onFlipSide && (
                  <Menu.Item className={ITEM} onClick={onFlipSide} data-testid="dock-side-flip">
                    Move side panel to {side === "left" ? "right" : "left"}
                  </Menu.Item>
                )}
                <Menu.Item className={ITEM} onClick={onReset} data-testid="dock-reset">
                  Reset layout
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </div>
  );
}

/** Shown while dragging in place of an area that is not visible (closed or empty): drop here to open it with the pane. */
export function DropStrip({ area, over, onOver, onLeave, onDrop }: { area: DockArea; over: boolean; onOver: () => void; onLeave: () => void; onDrop: (p: PaneId) => void }) {
  return (
    <div
      data-testid={`drop-${area}`}
      className={`grid shrink-0 place-items-center rounded-xl border-2 border-dashed text-muted-foreground text-sm ${over ? "border-primary bg-primary/5" : "border-primary/50"} ${area === "bottom" ? "mt-2 h-16" : "w-40"}`}
      onDragOver={(e) => {
        if (!isPaneDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) onOver();
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && onLeave()}
      onDrop={(e) => {
        const p = droppedPane(e);
        if (!p) return;
        e.preventDefault();
        onDrop(p);
      }}
    >
      {AREA_LABEL[area]}
    </div>
  );
}
