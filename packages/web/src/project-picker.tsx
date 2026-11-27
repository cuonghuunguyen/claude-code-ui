import { use, useState, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, FolderPlusIcon, SearchIcon } from "lucide-react";
import { useT } from "./i18n.ts";
import { SideBadge, SideLabel } from "./sides.tsx";
import { ProjectAvatar } from "./tabs-bar.tsx";
import { GHOST } from "./toolbar.tsx";
import { projectName } from "./tabs.ts";

/** New-session project chip (GH-1017): the chip, and a popup with a search field (focused on open) over project name, path and Side label, the rows, and "Open project…" pinned below the list so it stays when nothing matches. */
export function ProjectPicker({ projects, value, onChange, onOpenProject, trigger }: { projects: string[]; value: string; onChange: (cwd: string) => void; onOpenProject: () => void; /** The chip's content. */ trigger: ReactNode }) {
  const t = useT();
  const side = use(SideLabel);
  const [open, setOpen] = useState(false);
  const matches = (p: string, q: string) => {
    const n = q.trim().toLowerCase();
    const s = side(p);
    return !n || [projectName(p), p, s?.label ?? "", s?.short ?? ""].some((x) => x.toLowerCase().includes(n));
  };
  return (
    <Combobox.Root open={open} onOpenChange={setOpen} items={projects} value={value} onValueChange={(v: string | null) => v && v !== value && onChange(v)} itemToStringLabel={projectName} filter={matches} autoHighlight>
      <Combobox.Trigger aria-label={t("app.main.project")} title={value} data-testid="project-chip" className={`${GHOST} flex min-w-0 max-w-full items-center gap-1.5 max-md:h-11! text-foreground hover:bg-secondary`}>
        {trigger}
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner side="bottom" align="start" sideOffset={4} collisionPadding={16} className="isolate z-50">
          <Combobox.Popup className="flex max-h-[min(24rem,var(--available-height))] w-auto min-w-64 max-w-[calc(100vw-2rem)] origin-(--transform-origin) flex-col overflow-hidden rounded-2xl border bg-popover p-0.5 text-popover-foreground text-sm shadow-floating outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <div className="flex shrink-0 items-center gap-2 border-b px-3">
              <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <Combobox.Input type="search" autoComplete="off" aria-label={t("app.main.projectSearch")} placeholder={t("app.main.projectSearch")} data-testid="project-search" className="h-9 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground md:h-8 md:text-sm pointer-coarse:h-11" />
            </div>
            <Combobox.Empty className="px-3 py-3 text-muted-foreground empty:hidden">{t("app.main.projectSearchEmpty")}</Combobox.Empty>
            <Combobox.List className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">
              {(p: string) => (
                <Combobox.Item key={p} value={p} className="relative flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-sm py-1 pr-8 pl-3 font-normal outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-[selected]:font-medium pointer-coarse:min-h-11">
                  <ProjectAvatar cwd={p} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{projectName(p)}</span>
                    <span className="truncate text-muted-foreground text-xs" title={p}>{p}</span>
                  </span>
                  <SideBadge cwd={p} />
                  <Combobox.ItemIndicator className="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
                    <CheckIcon aria-hidden className="size-4" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
            <div data-slot="select-footer" className="shrink-0 border-t bg-popover pt-0.5">
              <button type="button" data-testid="open-project" onClick={() => (setOpen(false), onOpenProject())} className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-sm px-3 text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent pointer-coarse:h-11">
                <FolderPlusIcon aria-hidden className="size-4" />
                {t("app.main.openProjectEllipsis")}
              </button>
            </div>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
