// Queued messages (GH-77): chips above the prompt box. Each has Send now (steer), Edit (take back into the box) and Delete.
import { useEffect, useRef } from "react";
import { ArrowUpIcon, PencilIcon, XIcon } from "lucide-react";
import type { QueuedPrompt } from "@claude-ui/protocol";

type Held = { reason: "usage_limit" | "not_live"; until?: number };
type Action = "send" | "edit" | "delete";

const BTN =
  "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-info pointer-coarse:size-11 max-md:size-11 [&_svg]:size-4";

export function heldText(held: Held): string {
  if (held.reason === "not_live") return "Paused: the session stopped with an error";
  if (held.until === undefined) return "Paused until you send a message (usage limit)";
  return `Paused until ${new Date(held.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (usage limit)`;
}

export function QueueChips({
  items,
  held,
  bashWait,
  onSendNow,
  onEdit,
  onDelete,
  onEmpty,
}: {
  items: QueuedPrompt[];
  held?: Held;
  /** Why a bash item cannot run now (Send now is disabled with it as tooltip); undefined = it can. */
  bashWait?: string;
  onSendNow: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  /** Focus has nowhere to go: the last chip was removed by its own button. */
  onEmpty?: () => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  // After Send now or Delete the button is gone: focus the same button of the next row, else the previous one, else the caller.
  const focusAfter = useRef<{ action: Action; index: number }>(undefined);
  useEffect(() => {
    const f = focusAfter.current;
    if (!f) return;
    focusAfter.current = undefined;
    const row = list.current?.querySelectorAll("li")[Math.min(f.index, items.length - 1)];
    const button = row?.querySelector<HTMLElement>(`[data-action="${f.action}"]`);
    if (button) button.focus();
    else onEmpty?.();
  }, [items]);
  if (!items.length) return null;
  const run = (action: Action, index: number, id: string) => {
    if (action !== "edit") focusAfter.current = { action, index };
    (action === "send" ? onSendNow : action === "edit" ? onEdit : onDelete)(id);
  };
  return (
    // OpenCode composer dock anatomy (as the external-turn dock): rounded-xl, hairline border, layer-01 background.
    <section aria-label="Queued messages" data-testid="queue-chips" className="flex w-full min-w-0 flex-col gap-1 rounded-xl border-[0.5px] bg-muted px-2 py-2 text-sm">
      <h2 className="px-2 text-muted-foreground text-xs">Queued · {items.length}</h2>
      <span role="status" className="sr-only">
        {items.length} queued
      </span>
      <ul ref={list} className={`flex min-w-0 flex-col ${items.length > 3 ? "max-h-40 overflow-y-auto" : ""}`}>
        {items.map((item, i) => {
          const label = (item.bash ? "! " : "") + item.text.slice(0, 40);
          const waits = !!item.bash && !!bashWait;
          return (
            <li key={item.id} className="flex min-h-9 min-w-0 flex-wrap items-center gap-1 max-md:min-h-11 pointer-coarse:min-h-11">
              {item.bash && (
                <span aria-hidden className="shrink-0 pl-2 font-mono text-muted-foreground">
                  !
                </span>
              )}
              <span className={`min-w-0 flex-1 truncate ${item.bash ? "font-mono" : "px-2"}`} title={item.text}>
                {item.text}
              </span>
              {item.imageCount > 0 && <span className="shrink-0 rounded-md bg-secondary px-1.5 text-muted-foreground text-xs">+{item.imageCount} {item.imageCount === 1 ? "image" : "images"}</span>}
              <button
                type="button"
                data-action="send"
                className={`${BTN} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
                aria-label={`Send now: ${label}`}
                aria-disabled={waits || undefined}
                title={waits ? bashWait : item.bash ? "Run now" : "Send now (steer)"}
                onClick={() => !waits && run("send", i, item.id)}
              >
                <ArrowUpIcon aria-hidden />
              </button>
              <button type="button" data-action="edit" className={BTN} aria-label={`Edit: ${label}`} title="Edit (back into the prompt box)" onClick={() => run("edit", i, item.id)}>
                <PencilIcon aria-hidden />
              </button>
              <button type="button" data-action="delete" className={BTN} aria-label={`Delete: ${label}`} title="Delete" onClick={() => run("delete", i, item.id)}>
                <XIcon aria-hidden />
              </button>
              {item.error && (
                <p role="alert" className="basis-full px-2 pb-1 text-destructive text-xs">
                  Not run: {item.error}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {held && (
        <p data-testid="queue-held" className="px-2 text-muted-foreground text-xs">
          {heldText(held)}
        </p>
      )}
    </section>
  );
}
