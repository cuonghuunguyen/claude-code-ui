// Context menus of the sidebar rows (GH-358): one entry list per row, rendered as a right click / long press / key menu or as the kebab menu below md.
import type { ReactElement } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { CheckIcon, EllipsisIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useKeyContextMenu } from "./context-menu-key.ts";
import { ITEM, POPUP } from "./session-actions.tsx";
import type { MenuEntry } from "./sidebar-menus.ts";

export const CHECK_ITEM = cn(ITEM, "gap-2");
export const Tick = ({ on }: { on: boolean }) => <span className="grid size-4 shrink-0 place-items-center">{on && <CheckIcon className="size-4" aria-hidden />}</span>;

export function MenuEntries({ kind, entries }: { kind: "menu" | "context"; entries: MenuEntry[] }) {
  const P = kind === "menu" ? Menu : ContextMenu;
  const body = (list: MenuEntry[]) =>
    list.map((e, i) => {
      if (e.kind === "sep") return <P.Separator key={`sep${i}`} className="-mx-1 my-1 h-px bg-border" />;
      if (e.kind === "check")
        return (
          <P.CheckboxItem key={e.id} className={CHECK_ITEM} checked={e.checked} onCheckedChange={e.onChange} data-testid={e.id}>
            <Tick on={e.checked} />
            {e.label}
          </P.CheckboxItem>
        );
      if (e.kind === "item")
        return (
          <P.Item key={e.id} className={cn(ITEM, e.destructive && "text-destructive")} disabled={e.disabled} onClick={e.onSelect} data-testid={e.id}>
            {e.label}
          </P.Item>
        );
      return null;
    });
  // A label groups the items after it up to the next separator.
  const parts: ReactElement[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i]!;
    if (e.kind !== "label") {
      parts.push(...body([e]).map((x) => x!));
      i++;
      continue;
    }
    let j = i + 1;
    while (j < entries.length && entries[j]!.kind !== "sep" && entries[j]!.kind !== "label") j++;
    parts.push(
      <P.Group key={`group${i}`}>
        <P.GroupLabel className="px-2 py-1 text-muted-foreground text-xs">{e.label}</P.GroupLabel>
        {body(entries.slice(i + 1, j))}
      </P.Group>,
    );
    i = j;
  }
  return <>{parts}</>;
}

/** Right click, long press or Shift+F10 / the ContextMenu key on `children` (the trigger element) opens the menu of `entries`; computed only while it is open. */
export function RowContextMenu({ entries, children, testId }: { entries: () => MenuEntry[]; children: ReactElement; testId: string }) {
  const key = useKeyContextMenu();
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger render={children} {...key} />
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="z-50">
          <ContextMenu.Popup className={cn(POPUP, "max-w-[calc(100vw-2rem)]")} data-testid={testId}>
            <MenuEntries kind="context" entries={entries()} />
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** `...` menu of a project or worktree row below `md`: the same entries as the context menu, so the label keeps the room. */
export function RowMenu({ label, testId, entries, disabled }: { label: string; testId: string; entries: () => MenuEntry[]; disabled?: boolean }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Actions for ${label}`}
        disabled={disabled}
        title="Actions"
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring max-md:size-11 [&_svg]:size-4"
        data-testid={testId}
      >
        <EllipsisIcon aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner align="end" sideOffset={4} className="z-50">
          <Menu.Popup className={cn(POPUP, "max-w-[calc(100vw-2rem)]")}>
            <MenuEntries kind="menu" entries={entries()} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
