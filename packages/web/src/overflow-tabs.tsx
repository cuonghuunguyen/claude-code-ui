import { Menu } from "@base-ui/react/menu";
import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useT } from "./i18n.ts";
import { useContainerWidth } from "./lib/use-container-width.ts";
import { cn } from "@/lib/utils";
import { MENU_BUTTON, useKeyboardOpen } from "./menu-keyboard.ts";
import { fitTabs } from "./overflow-tabs.ts";
import { ITEM, POPUP } from "./session-actions.tsx";

export type OverflowItem = {
  label: ReactNode;
  onSelect: () => void;
  testId?: string;
  command?: string;
};

/**
 * GH-512: a tab row that shows the tabs that fit and puts the rest in a `…` menu (no horizontal scroll); the selected tab always
 * shows. Generic over string keys. `renderTab` must put `data-overflow-key={key}` on the tab element (its width is measured).
 */
export function OverflowTabs({
  keys,
  selected,
  label,
  renderTab,
  menuItem,
  className,
  testId = "pane-overflow",
  moreLabel,
}: {
  keys: string[];
  selected?: string;
  label: string;
  renderTab: (key: string) => ReactNode;
  menuItem: (key: string) => OverflowItem;
  className?: string;
  /** The more button's data-testid and its label for a count of hidden tabs (defaults: panes). */
  testId?: string;
  moreLabel?: (count: number) => string;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const avail = useContainerWidth(box);
  const widths = useRef(new Map<string, number>());
  const [shown, setShown] = useState<string[]>(keys);
  const seen = useRef(keys); // the keys of the last layout pass: a key new since then (a pane moved in) shows at once, so the move can focus its tab
  const kb = useKeyboardOpen();
  const moreText = (n: number) => (moreLabel ?? ((c) => t("app.dock.morePanes", { count: c })))(n);
  // Runs after every render: measures what shows, then decides what shows (setState only on a change, so it settles).
  useLayoutEffect(() => {
    const cache = widths.current;
    list.current?.querySelectorAll<HTMLElement>("[data-overflow-key]").forEach((n) => cache.set(n.dataset.overflowKey!, n.offsetWidth));
    const trigger = box.current?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    const coarse = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
    const more = trigger?.offsetWidth || (coarse ? 44 : 32);
    const gap = (list.current && Number.parseFloat(getComputedStyle(list.current).columnGap)) || 4;
    // A tab never measured renders once with all, so every width is known.
    const next = keys.every((k) => cache.has(k))
      ? fitTabs(
          keys.map((k) => cache.get(k)!),
          avail,
          gap,
          more,
          selected === undefined ? -1 : keys.indexOf(selected),
        ).map((i) => keys[i]!)
      : keys;
    seen.current = keys;
    if (next.length !== shown.length || next.some((k, i) => k !== shown[i])) setShown(next);
  });
  // `shown` can hold keys that are gone (a pane closed) until the effect above runs: render only live keys.
  const visible = keys.filter((k) => shown.includes(k) || !seen.current.includes(k) || !widths.current.has(k));
  const hidden = keys.filter((k) => !visible.includes(k));
  return (
    <div ref={box} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      <div ref={list} role="tablist" aria-label={label} className={cn("flex min-w-0 gap-1", className)}>
        {visible.map((k) => renderTab(k))}
      </div>
      {hidden.length > 0 && (
        <Menu.Root {...kb.root}>
          <Menu.Trigger
            aria-label={moreText(hidden.length)}
            title={moreText(hidden.length)}
            className={MENU_BUTTON}
            data-testid={testId}
            {...kb.trigger}
          >
            <EllipsisIcon aria-hidden />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner align="end" sideOffset={4} className="z-50">
              <Menu.Popup ref={kb.popup} className={POPUP}>
                {hidden.map((k) => {
                  const m = menuItem(k);
                  return (
                    <Menu.Item key={k} className={cn(ITEM, "pointer-coarse:min-h-11")} onClick={m.onSelect} data-testid={m.testId} data-command={m.command}>
                      {m.label}
                    </Menu.Item>
                  );
                })}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
    </div>
  );
}
