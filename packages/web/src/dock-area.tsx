// Header and plumbing of a dock area (docs/spec.md "Layout", pane layout): pane tabs, area menu, stable pane hosts.
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AREA_LABEL, type DockArea, type DockSide, PANE_IDS, PANE_LABEL, type PaneId } from "./layout.ts";
import { ITEM, POPUP } from "./session-actions.tsx";

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
}: {
  area: DockArea;
  panes: PaneId[];
  active?: PaneId;
  changes: number;
  side?: DockSide;
  onSelect: (p: PaneId) => void;
  onMove: (p: PaneId, to: DockArea) => void;
  onFlipSide?: () => void;
  onReset: () => void;
  extra?: ReactNode;
}) {
  const other: DockArea = area === "side" ? "bottom" : "side";
  // The tab to focus when a menu closes: the pane that was just moved (its tab is in the other area by then).
  const moved = useRef<PaneId>(undefined);
  const finalFocus = () => (moved.current && document.querySelector<HTMLElement>(`[data-pane-tab="${moved.current}"]`)) || true;
  const move = (p: PaneId) => (moved.current = p, onMove(p, other));
  return (
    <div className="hidden items-center gap-1 border-b px-2 py-1 lg:flex">
      <div role="tablist" aria-label={AREA_LABEL[area]} className="flex min-w-0 gap-1 overflow-x-auto">
        {panes.map((p) => (
          <ContextMenu.Root key={p}>
            <ContextMenu.Trigger className="contents">
              <Button
                size="sm"
                variant={p === active ? "secondary" : "ghost"}
                className="pointer-coarse:h-11"
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
                <ContextMenu.Popup className={POPUP} finalFocus={finalFocus}>
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
        <Menu.Root>
          <Menu.Trigger aria-label={`${AREA_LABEL[area]} actions`} title={`${AREA_LABEL[area]} actions`} className={MENU_BUTTON} data-testid={`dock-menu-${area}`}>
            <EllipsisIcon aria-hidden />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="end" sideOffset={4} className="z-50">
              <Menu.Popup className={POPUP} finalFocus={finalFocus}>
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
