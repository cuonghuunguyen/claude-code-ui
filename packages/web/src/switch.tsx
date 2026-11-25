// Own module so the first load (key-tip) does not pull the lazy plugins dialog.
import { cn } from "@/lib/utils";
import { useT } from "./i18n.ts";

/** The extension's plugin switch: `role="switch"`, Enter/Space toggle; OpenCode's 28×16 switch look, 44 px hit area on touch. */
export function Switch({ on, label, held, onToggle, title, describedBy, testId = "plugin-switch", text }: { on: boolean; label: string; held: boolean; onToggle: (on: boolean) => void; title?: string; describedBy?: string; testId?: string; text?: string }) {
  const t = useT();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-describedby={describedBy}
      aria-disabled={held}
      title={title ?? (on ? t("session.pluginsDialog.switchOff") : t("session.pluginsDialog.switchOn"))}
      onClick={() => !held && onToggle(!on)}
      className={cn("group rounded-md outline-none", text ? "flex h-7 items-center gap-1.5 px-1 max-md:h-11" : "grid size-7 place-items-center max-md:size-11")}
      data-testid={testId}
    >
      <span
        className={cn(
          "flex h-4 w-7 items-center rounded-[3px] border transition-colors group-focus-visible:ring-2 group-focus-visible:ring-ring",
          on ? "border-foreground bg-foreground" : "border-border bg-secondary group-hover:bg-accent",
          held && "opacity-50",
        )}
      >
        <span className={cn("size-3.5 rounded-[2px] bg-background shadow-sm transition-transform", on ? "translate-x-[12px]" : "-translate-x-px ring-1 ring-border")} />
      </span>
      {text && <span className="text-muted-foreground text-xs">{text}</span>}
    </button>
  );
}
