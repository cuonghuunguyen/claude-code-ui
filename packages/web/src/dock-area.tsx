// Header and plumbing of a dock area (docs/spec.md "Layout", pane layout): pane tabs, area menu, stable pane hosts.
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AREA_LABEL, type Area, type DockArea, type DockSide, PANE_IDS, PANE_LABEL, type PaneId, canMain } from "./layout.ts";
import { useT } from "./i18n.ts";
import { ITEM, POPUP } from "./session-actions.tsx";
import { STATUS_LABEL, TabIcon, type TabInfo, status, useTouchPrimary } from "./tabs-bar.tsx";

export const PANE_DRAG_TYPE = "application/x-claude-ui-pane";
/** GH-402: a docked session tab being dragged (its data is the session id). */
export const DOCKED_DRAG_TYPE = "application/x-claude-ui-docked";
type DragEv = { dataTransfer: DataTransfer | null };
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

/** GH-401: what a dock session tab's menu asks for: the other panel, the main area, or closing the tab. */
export type DockedCommand = "moveSide" | "moveBottom" | "main" | "close";
export type DockedSession = TabInfo & { id: string };

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
  accepts,
  onDropTab,
  onDragDocked,
  sessions,
  activeSession,
  onSelectSession,
  onSessionCommand,
}: {
  area: DockArea;
  panes: PaneId[];
  active?: PaneId;
  changes: number;
  side?: DockSide;
  onSelect: (p: PaneId) => void;
  onMove: (p: PaneId, to: Area, before?: PaneId) => void;
  onFlipSide?: () => void;
  onReset: () => void;
  extra?: ReactNode;
  /** The pane being dragged, and where it would land (App state: browsers hide drag data until the drop). */
  drag?: PaneId;
  dropAt?: DropAt;
  onDrag: (p?: PaneId) => void;
  onDropAt: (d?: DropAt) => void;
  /** GH-402: drags other than a dock pane tab (a strip tab, a docked session tab) that a pane tab accepts, and what dropping one before pane tab `before` does. `"before"`: the drop honours the position (marks the tab); `true`: it lands in the area (the whole area is the target). Absent: only dock pane tabs. */
  accepts?: (e: DragEv) => boolean | "before";
  onDropTab?: (e: DragEv, before: PaneId) => void;
  /** GH-402: a docked session tab starts (id) or ends (undefined) a drag. */
  onDragDocked?: (id?: string) => void;
  /** GH-401: sessions docked here, in strip order: a tab each after the pane tabs; `activeSession` is the selected one (no pane tab is then). */
  sessions?: DockedSession[];
  activeSession?: string;
  onSelectSession?: (id: string) => void;
  onSessionCommand?: (id: string, c: DockedCommand) => void;
}) {
  const other: DockArea = area === "side" ? "bottom" : "side";
  // A menu that moved a pane does not return the focus (Base UI `finalFocus` false): App focuses the moved tab once the move is
  // rendered. The menu's own return runs when its popup unmounts, which can be in the move's commit (the tab's context menu, or an
  // area that empties), before the moved tab exists; its fallback (the trigger, else an earlier focused element such as the
  // prompt box) would win over the moved tab.
  const t = useT();
  const moved = useRef(false);
  const finalFocus = () => !moved.current;
  const move = (p: PaneId) => ((moved.current = true), onMove(p, other));
  const moveTo = (p: PaneId, to: Area) => ((moved.current = true), onMove(p, to));
  const coarse = useTouchPrimary();
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
                variant={p === active && !activeSession ? "secondary" : "ghost"}
                className="pointer-coarse:h-11 relative data-drop-before:before:absolute data-drop-before:before:inset-y-1 data-drop-before:before:-left-1 data-drop-before:before:w-0.5 data-drop-before:before:rounded-full data-drop-before:before:bg-primary"
                draggable
                {...ctxKb.trigger}
                data-drop-before={(drag || accepts) && dropAt?.area === area && dropAt.before === p ? "" : undefined}
                // Dragging a tab onto another inserts before it; the area section ignores it (stopPropagation).
                onDragStart={(e) => {
                  e.dataTransfer.setData(PANE_DRAG_TYPE, p);
                  e.dataTransfer.effectAllowed = "move";
                  onDrag(p);
                }}
                onDragEnd={() => (onDrag(undefined), onDropAt(undefined))}
                onDragOver={(e) => {
                  const ok = isPaneDrag(e) ? "before" : accepts?.(e);
                  if (!ok) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  const before = ok === "before" ? p : undefined;
                  if (dropAt?.area !== area || dropAt.before !== before) onDropAt({ area, before });
                }}
                onDrop={(e) => {
                  const d = droppedPane(e);
                  const other = !d && onDropTab && accepts?.(e);
                  if (!d && !other) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onDrag(undefined);
                  onDropAt(undefined);
                  if (d) onMove(d, area, p);
                  else onDropTab!(e, p);
                }}
                role="tab"
                aria-selected={p === active && !activeSession}
                onClick={() => onSelect(p)}
                data-testid={`pane-${p}`}
                data-pane-tab={p}
                data-command={p === "files" || p === "changes" || p === "graph" ? `pane.${p}` : undefined}
              >
                {t(`app.dock.tab.${p}`)}
                {p === "changes" && changes > 0 && <span className="text-muted-foreground tabular-nums">{changes}</span>}
              </Button>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Positioner className="z-50">
                <ContextMenu.Popup ref={ctxKb.popup} className={POPUP} finalFocus={finalFocus}>
                  <ContextMenu.Item className={ITEM} onClick={() => move(p)} data-testid="pane-move">
                    {t("app.dock.moveTo", { area: AREA_LABEL[other].toLowerCase() })}
                  </ContextMenu.Item>
                  {canMain(p) && (
                    <ContextMenu.Item className={ITEM} onClick={() => moveTo(p, "main")} data-testid="pane-move-main">
                      {t("app.dock.moveToMain")}
                    </ContextMenu.Item>
                  )}
                  <ContextMenu.Item className={ITEM} onClick={onReset} data-testid="pane-reset">
                    {t("app.dock.reset")}
                  </ContextMenu.Item>
                </ContextMenu.Popup>
              </ContextMenu.Positioner>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        ))}
        {sessions?.map((tab) => {
          const label = STATUS_LABEL[status(tab.id, tab)];
          return (
            <ContextMenu.Root key={tab.id} {...opening(ctxKb.root)}>
              <ContextMenu.Trigger className="contents">
                <Button
                  size="sm"
                  variant={tab.id === activeSession ? "secondary" : "ghost"}
                  className="pointer-coarse:h-11 max-w-48 shrink-0"
                  draggable={!coarse}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DOCKED_DRAG_TYPE, tab.id);
                    e.dataTransfer.effectAllowed = "move";
                    onDragDocked?.(tab.id);
                  }}
                  onDragEnd={() => (onDragDocked?.(undefined), onDropAt(undefined))}
                  {...ctxKb.trigger}
                  role="tab"
                  aria-selected={tab.id === activeSession}
                  onClick={() => onSelectSession?.(tab.id)}
                  data-testid="docked-tab"
                  data-docked-tab={tab.id}
                  title={tab.title}
                >
                  <TabIcon s={status(tab.id, tab)} cwd={tab.cwd} />
                  <span className="truncate">{tab.title}</span>
                  {label && <span className="sr-only">{label}</span>}
                </Button>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Positioner className="z-50">
                  <ContextMenu.Popup ref={ctxKb.popup} className={POPUP} finalFocus={finalFocus}>
                    <ContextMenu.Item className={ITEM} onClick={() => ((moved.current = true), onSessionCommand?.(tab.id, other === "side" ? "moveSide" : "moveBottom"))} data-testid="docked-move">
                      {t("app.dock.moveTo", { area: AREA_LABEL[other].toLowerCase() })}
                    </ContextMenu.Item>
                    <ContextMenu.Item className={ITEM} onClick={() => ((moved.current = true), onSessionCommand?.(tab.id, "main"))} data-testid="docked-move-main">
                      {t("app.dock.moveToMain")}
                    </ContextMenu.Item>
                    <ContextMenu.Item className={ITEM} onClick={() => onSessionCommand?.(tab.id, "close")} data-testid="docked-close">
                      {t("app.dock.closeTab")}
                    </ContextMenu.Item>
                  </ContextMenu.Popup>
                </ContextMenu.Positioner>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          );
        })}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {extra}
        <Menu.Root {...opening(menuKb.root)}>
          <Menu.Trigger aria-label={t("app.dock.actions", { area: AREA_LABEL[area] })} title={t("app.dock.actions", { area: AREA_LABEL[area] })} className={MENU_BUTTON} data-testid={`dock-menu-${area}`}>
            <EllipsisIcon aria-hidden />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="end" sideOffset={4} className="z-50">
              <Menu.Popup ref={menuKb.popup} className={POPUP} finalFocus={finalFocus}>
                {active && (
                  <Menu.Item className={ITEM} onClick={() => move(active)} data-testid="dock-move">
                    {t("app.dock.movePane", { pane: PANE_LABEL[active], area: AREA_LABEL[other].toLowerCase() })}
                  </Menu.Item>
                )}
                {active && canMain(active) && (
                  <Menu.Item className={ITEM} onClick={() => moveTo(active, "main")} data-testid="dock-move-main">
                    {t("app.dock.movePaneMain", { pane: PANE_LABEL[active] })}
                  </Menu.Item>
                )}
                {area === "side" && onFlipSide && (
                  <Menu.Item className={ITEM} onClick={onFlipSide} data-testid="dock-side-flip">
                    {t(side === "left" ? "app.cmd.flipRight" : "app.cmd.flipLeft")}
                  </Menu.Item>
                )}
                <Menu.Item className={ITEM} onClick={onReset} data-testid="dock-reset">
                  {t("app.dock.reset")}
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
export function DropStrip({ area, over, onOver, onLeave, onDrop, accepts, onDropTab }: { area: DockArea; over: boolean; onOver: () => void; onLeave: () => void; onDrop: (p: PaneId) => void; /** GH-402: other drags the strip takes (a strip tab, a docked session tab) and what dropping one does. */ accepts?: (e: DragEv) => boolean; onDropTab?: (e: DragEv) => void }) {
  return (
    <div
      data-testid={`drop-${area}`}
      className={`grid shrink-0 place-items-center rounded-xl border-2 border-dashed text-muted-foreground text-sm ${over ? "border-primary bg-primary/5" : "border-primary/50"} ${area === "bottom" ? "mt-2 h-16" : "w-40"}`}
      onDragOver={(e) => {
        if (!isPaneDrag(e) && !accepts?.(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) onOver();
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && onLeave()}
      onDrop={(e) => {
        const p = droppedPane(e);
        if (!p && !(onDropTab && accepts?.(e))) return;
        e.preventDefault();
        if (p) onDrop(p);
        else onDropTab!(e);
      }}
    >
      {AREA_LABEL[area]}
    </div>
  );
}
