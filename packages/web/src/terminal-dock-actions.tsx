// Controls at the right end of the terminal's tabs bar (docs/spec.md "Layout"): the dock menu, Maximize/Restore and Hide.
import { Menu } from "@base-ui/react/menu";
import { ChevronDownIcon, ChevronUpIcon, EllipsisIcon, XIcon } from "lucide-react";
import type { DockArea } from "./layout.ts";
import { ITEM, POPUP } from "./session-actions.tsx";
import { IconButton } from "./tabs-bar.tsx";

/** Wide screens only (below lg the terminal is a pane and its position has no effect). `onMaximize` and `onHide` are the bottom dock's. */
export function TerminalDockActions({
  dock,
  onMove,
  maximized,
  onMaximize,
  onHide,
  hideLabel,
}: {
  dock: DockArea;
  onMove: (d: DockArea) => void;
  maximized?: boolean;
  onMaximize?: () => void;
  onHide?: () => void;
  hideLabel?: string;
}) {
  const other: DockArea = dock === "bottom" ? "side" : "bottom";
  return (
    <div className="ml-auto hidden shrink-0 items-center gap-1 lg:flex" data-testid="terminal-dock-actions">
      <Menu.Root>
        <Menu.Trigger
          aria-label="Terminal actions"
          title="Terminal actions"
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-sm text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-accent aria-expanded:text-foreground [&_svg]:size-4"
          data-testid="terminal-menu"
        >
          <EllipsisIcon aria-hidden />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="end" sideOffset={4} className="z-50">
            <Menu.Popup className={POPUP}>
              <Menu.Item className={ITEM} onClick={() => onMove(other)} data-testid="terminal-move">
                {dock === "bottom" ? "Move terminal to side panel" : "Move terminal to bottom"}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {onMaximize && (
        <IconButton label={maximized ? "Restore terminal" : "Maximize terminal"} pressed={maximized} onClick={onMaximize} testId="terminal-maximize">
          {maximized ? <ChevronDownIcon /> : <ChevronUpIcon />}
        </IconButton>
      )}
      {onHide && (
        <IconButton label={hideLabel ?? "Hide terminal"} onClick={onHide} testId="terminal-hide">
          <XIcon />
        </IconButton>
      )}
    </div>
  );
}
