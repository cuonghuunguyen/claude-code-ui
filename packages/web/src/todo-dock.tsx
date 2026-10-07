// Todo dock above the prompt box: the latest TodoWrite list (OpenCode session-todo-dock), on AI Elements `task`.
import type { SessionState, TodoItem } from "@claude-ui/protocol";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { Task, TaskItem, TaskTrigger } from "@/components/ai-elements/task";
import { CollapsibleContent } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * OpenCode shows the dock only while the session works or waits for an answer, and hides it once all items are done.
 * `blocked` = a permission or question panel is open: OpenCode hides the whole composer region then, dock included.
 */
export const showTodoDock = (state: SessionState, items: TodoItem[], blocked: boolean) =>
  !blocked && (state === "running" || state === "needs_input") && items.some((i) => i.status !== "completed");

// Collapsed or not, kept per browser across reloads.
const COLLAPSED_KEY = "claude-ui.todoDockCollapsed";
const loadOpen = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) !== "1";
  } catch {
    return true;
  }
};
const saveOpen = (open: boolean) => {
  try {
    if (open) localStorage.removeItem(COLLAPSED_KEY);
    else localStorage.setItem(COLLAPSED_KEY, "1");
  } catch {
    // Storage blocked: the state lasts until the page reloads.
  }
};
// Screen-reader status; the mark is aria-hidden and strikethrough is not announced.
const statusText = { completed: "Completed", in_progress: "In progress", pending: "Pending" } as const;

function Mark({ status }: { status: TodoItem["status"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-sm border bg-card text-muted-foreground",
        status !== "pending" && "bg-secondary",
      )}
    >
      {status === "completed" && <CheckIcon className="size-2.5" strokeWidth={3} />}
      {status === "in_progress" && (
        <span className="size-1.5 rounded-full bg-muted-foreground animate-[pulse-scale_1.2s_ease-in-out_infinite] motion-reduce:animate-none" />
      )}
    </span>
  );
}

export function TodoDock({ items, className }: { items: TodoItem[]; className?: string }) {
  const [open, setOpen] = useState(loadOpen);
  const done = items.filter((i) => i.status === "completed").length;
  const active = items.find((i) => i.status === "in_progress") ?? items.find((i) => i.status === "pending");
  return (
    <Task
      open={open}
      onOpenChange={(o) => (setOpen(o), saveOpen(o))}
      data-testid="todo-dock"
      className={cn("w-full overflow-hidden rounded-xl border-[0.5px] bg-muted", className)}
    >
      <TaskTrigger title="Todos" className="flex h-[42px] w-full cursor-pointer items-center gap-2 pr-3 pl-4 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset pointer-coarse:h-11">
        <span className="shrink-0 text-muted-foreground">
          {done} of {items.length} todos completed
        </span>
        {!open && active && (
          <span data-testid="todo-preview" className="ml-1 min-w-0 flex-1 truncate text-muted-foreground">
            {active.content}
          </span>
        )}
        <ChevronDownIcon
          aria-hidden
          // Down while open, up while collapsed (OpenCode).
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-300 motion-reduce:transition-none",
            !open && "rotate-180",
          )}
        />
      </TaskTrigger>
      <CollapsibleContent>
        <div role="list" className="flex max-h-[min(10.5rem,30dvh)] flex-col gap-1.5 overflow-y-auto overscroll-contain px-4 pb-3">
          {items.map((item, i) => (
            <TaskItem
              key={i}
              role="listitem"
              data-status={item.status}
              className={cn(
                "flex gap-2 break-words text-[14px]/[1.3]",
                item.status === "completed" ? "text-muted-foreground line-through" : "text-foreground",
              )}
            >
              <Mark status={item.status} />
              <span className="min-w-0">
                <span className="sr-only">{statusText[item.status]}: </span>
                {item.content}
              </span>
            </TaskItem>
          ))}
        </div>
      </CollapsibleContent>
    </Task>
  );
}
